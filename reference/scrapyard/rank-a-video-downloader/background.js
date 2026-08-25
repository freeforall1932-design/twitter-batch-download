const DEFAULT_SETTINGS = {
  createUsernameFolder: true,
  createTweetFolder: true,
  skipDuplicateDownloads: true,
  filenameTemplate: "{username}_{tweetId}_{date}_{type}_{index}.{ext}",
  downloadConcurrency: 3
};

const downloadTasks = new Map();
const downloadIdToTaskId = new Map();

chrome.runtime.onMessage.addListener(function(message, sender, sendResponse) {
  if (!message || typeof message !== "object") {
    return false;
  }

  if (message.type === "XMV_GET_DOWNLOAD_TASKS") {
    sendResponse({ ok: true, tasks: getVisibleTasks() });
    return true;
  }

  if (message.type === "XMV_CLEAR_COMPLETED_TASKS") {
    clearCompletedTasks();
    sendResponse({ ok: true, tasks: getVisibleTasks() });
    return true;
  }

  if (message.type === "XMV_RETRY_DOWNLOAD_TASK") {
    retryDownloadTask(message.taskId)
      .then(function(result) {
        sendResponse({ ok: result.ok, error: result.error, tasks: getVisibleTasks() });
      })
      .catch(function(error) {
        sendResponse({ ok: false, error: String(error && error.message ? error.message : error), tasks: getVisibleTasks() });
      });
    return true;
  }

  if (message.type === "XMV_RETRY_FAILED_TASKS") {
    retryFailedTasks()
      .then(function(result) {
        sendResponse({ ok: true, retriedCount: result.retriedCount, tasks: getVisibleTasks() });
      })
      .catch(function(error) {
        sendResponse({ ok: false, error: String(error && error.message ? error.message : error), tasks: getVisibleTasks() });
      });
    return true;
  }

  if (message.type !== "XMV_DOWNLOAD_MEDIA") {
    return false;
  }

  const items = Array.isArray(message.items) ? message.items : [];
  if (!items.length) {
    sendResponse({ ok: false, error: "No media items received." });
    return true;
  }

  handleDownloadMedia(items)
    .then(function(result) {
      sendResponse({
        ok: true,
        tasks: result.tasks,
        skippedCount: result.skippedCount || 0
      });
    })
    .catch(function(error) {
      sendResponse({
        ok: false,
        error: String(error && error.message ? error.message : error)
      });
    });

  return true;
});

async function getSettings() {
  try {
    const stored = await chrome.storage.sync.get(DEFAULT_SETTINGS);
    return Object.assign({}, DEFAULT_SETTINGS, stored || {});
  } catch (error) {
    return DEFAULT_SETTINGS;
  }
}

async function handleDownloadMedia(items) {
  const settings = await getSettings();

  const normalized = items.map(function(raw, index) {
    return normalizeItem(raw, index, settings);
  });
  const filtered = filterDuplicateItems(normalized, settings);

  const tasks = filtered.items.map(function(item) {
    const taskId = createTaskId();
    const task = {
      taskId: taskId,
      downloadId: null,
      url: item.url,
      filename: item.filename,
      username: item.username,
      tweetId: item.tweetId,
      type: item.type,
      ext: item.ext,
      status: "queued",
      progress: 0,
      error: "",
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    downloadTasks.set(taskId, task);
    return task;
  });

  await runWithConcurrency(tasks, settings.downloadConcurrency, function(task, index) {
    return startTaskDownload(task, index);
  });

  return {
    tasks: tasks.map(toPublicTask),
    skippedCount: filtered.skippedCount
  };
}

function startTaskDownload(task, index) {
  return new Promise(function(resolve) {
    chrome.downloads.download(
      {
        url: task.url,
        filename: task.filename,
        saveAs: false,
        conflictAction: "uniquify"
      },
      function(downloadId) {
        if (chrome.runtime.lastError) {
          task.status = "failed";
          task.error = chrome.runtime.lastError.message;
          task.updatedAt = Date.now();
          resolve(task);
          return;
        }

        task.downloadId = downloadId;
        task.status = "downloading";
        task.progress = 0;
        task.updatedAt = Date.now();

        downloadIdToTaskId.set(downloadId, task.taskId);
        resolve(task);
      }
    );
  });
}

function normalizeItem(raw, index, settings) {
  const url = String((raw && raw.url) || "").trim();
  if (!url) {
    throw new Error("Missing media URL at index " + index);
  }

  let username = sanitize((raw && raw.username) || "");
  let tweetId = sanitize((raw && raw.tweetId) || "");
  let type = sanitize((raw && raw.type) || "media");
  let ext = sanitize((raw && raw.ext) || "");

  if (!username) username = "unknown";
  if (!tweetId) tweetId = "tweet";
  if (!type) type = "media";

  ext = ext || guessExt(url, type);

  const filename = buildFilename({
    username: username,
    tweetId: tweetId,
    type: type,
    ext: ext,
    url: url
  }, index, settings);

  return {
    url: url,
    filename: filename,
    username: username,
    tweetId: tweetId,
    type: type,
    ext: ext
  };
}

function createTaskId() {
  return "xmv_" + Date.now() + "_" + Math.random().toString(16).slice(2);
}

function toPublicTask(task) {
  return {
    taskId: task.taskId,
    downloadId: task.downloadId,
    url: task.url,
    filename: task.filename,
    username: task.username,
    tweetId: task.tweetId,
    type: task.type,
    ext: task.ext,
    status: task.status,
    progress: task.progress,
    error: task.error,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt
  };
}

function getVisibleTasks() {
  return Array.from(downloadTasks.values())
    .sort(function(a, b) {
      return b.createdAt - a.createdAt;
    })
    .slice(0, 50)
    .map(toPublicTask);
}

function clearCompletedTasks() {
  const now = Date.now();
  for (const [taskId, task] of downloadTasks.entries()) {
    const shouldDeleteCompleted = task.status === "completed";
    const shouldDeleteOldFailed = task.status === "failed" && now - task.createdAt > 60 * 60 * 1000;
    if (shouldDeleteCompleted || shouldDeleteOldFailed) {
      if (typeof task.downloadId === "number") {
        downloadIdToTaskId.delete(task.downloadId);
      }
      downloadTasks.delete(taskId);
    }
  }
}

function filterDuplicateItems(items, settings) {
  const skipDuplicates = !settings || settings.skipDuplicateDownloads !== false;
  if (!skipDuplicates) {
    return { items: items, skippedCount: 0 };
  }

  const seen = new Set();
  for (const task of downloadTasks.values()) {
    if (task && task.url) {
      seen.add(normalizeDownloadUrlKey(task.url));
    }
  }

  const filtered = [];
  let skippedCount = 0;
  for (const item of items) {
    if (!item || !item.url) {
      continue;
    }
    const key = normalizeDownloadUrlKey(item.url);
    if (seen.has(key)) {
      skippedCount++;
      continue;
    }
    seen.add(key);
    filtered.push(item);
  }

  return { items: filtered, skippedCount: skippedCount };
}

function normalizeDownloadUrlKey(rawUrl) {
  try {
    const url = new URL(String(rawUrl || ""));
    url.hash = "";
    url.searchParams.delete("name");
    if (url.searchParams.has("format")) {
      url.searchParams.set("format", String(url.searchParams.get("format") || "").toLowerCase());
    }
    return url.origin + url.pathname + (url.search ? url.search : "");
  } catch (error) {
    return String(rawUrl || "");
  }
}

async function retryDownloadTask(taskId) {
  const task = downloadTasks.get(taskId);

  if (!task) {
    return { ok: false, error: "Task not found." };
  }

  if (task.status !== "failed") {
    return { ok: false, error: "Only failed tasks can be retried." };
  }

  if (typeof task.downloadId === "number") {
    downloadIdToTaskId.delete(task.downloadId);
  }

  task.downloadId = null;
  task.status = "queued";
  task.progress = 0;
  task.error = "";
  task.updatedAt = Date.now();
  task.retryCount = (task.retryCount || 0) + 1;

  await startTaskDownload(task, 0);

  return { ok: true, task: toPublicTask(task) };
}

async function retryFailedTasks() {
  const settings = await getSettings();
  const failedTasks = [];

  for (const [taskId, task] of downloadTasks.entries()) {
    if (task.status !== "failed") continue;

    if (typeof task.downloadId === "number") {
      downloadIdToTaskId.delete(task.downloadId);
    }

    task.downloadId = null;
    task.status = "queued";
    task.progress = 0;
    task.error = "";
    task.updatedAt = Date.now();
    task.retryCount = (task.retryCount || 0) + 1;

    failedTasks.push(task);
  }

  await runWithConcurrency(failedTasks, settings.downloadConcurrency, function(task, index) {
    return startTaskDownload(task, index);
  });

  return { retriedCount: failedTasks.length };
}

async function runWithConcurrency(items, limit, iterator) {
  const queue = Array.isArray(items) ? items.slice() : [];
  const max = Math.max(1, Number(limit) || 1);
  const workers = [];

  for (let workerIndex = 0; workerIndex < max; workerIndex++) {
    workers.push((async function() {
      while (queue.length) {
        const item = queue.shift();
        if (!item) {
          continue;
        }
        await iterator(item, workerIndex);
      }
    })());
  }

  await Promise.all(workers);
}

function updateProgressFromDownload(downloadId) {
  chrome.downloads.search({ id: downloadId }, function(items) {
    const item = items && items[0];
    if (!item) return;

    const taskId = downloadIdToTaskId.get(downloadId);
    const task = downloadTasks.get(taskId);
    if (!task) return;

    if (item.totalBytes && item.totalBytes > 0) {
      task.progress = Math.max(0, Math.min(100, Math.round((item.bytesReceived / item.totalBytes) * 100)));
      task.updatedAt = Date.now();
    }
  });
}

chrome.downloads.onChanged.addListener(function(delta) {
  if (!delta || typeof delta.id !== "number") {
    return;
  }

  const taskId = downloadIdToTaskId.get(delta.id);
  if (!taskId) return;

  const task = downloadTasks.get(taskId);
  if (!task) return;

  if (delta.state && delta.state.current === "complete") {
    task.status = "completed";
    task.progress = 100;
    task.error = "";
    task.updatedAt = Date.now();
    return;
  }

  if (delta.state && delta.state.current === "interrupted") {
    task.status = "failed";
    task.error = "Download interrupted";
    task.updatedAt = Date.now();
    return;
  }

  updateProgressFromDownload(delta.id);
});

function sanitize(value) {
  return String(value || "")
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 120);
}

function padIndex(index) {
  return String(index + 1).padStart(2, "0");
}

function getDateString() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return yyyy + "-" + mm + "-" + dd;
}

function guessExt(url, type) {
  if (type === "video" || type === "animated_gif") {
    return "mp4";
  }
  if (url.includes("format=png")) {
    return "png";
  }
  if (url.includes("format=webp")) {
    return "webp";
  }
  return "jpg";
}

function buildFilename(item, index, settings) {
  const username = sanitize(item.username || "unknown") || "unknown";
  const tweetId = sanitize(item.tweetId || "tweet") || "tweet";
  const type = sanitize(item.type || "media") || "media";
  const ext = sanitize(item.ext || guessExt(item.url || "", type)) || "bin";
  const date = getDateString();
  const order = padIndex(index);
  const template = String((settings && settings.filenameTemplate) || DEFAULT_SETTINGS.filenameTemplate);
  const createUsernameFolder = settings ? settings.createUsernameFolder !== false : DEFAULT_SETTINGS.createUsernameFolder;
  const createTweetFolder = settings ? settings.createTweetFolder !== false : DEFAULT_SETTINGS.createTweetFolder;

  const filename = template
    .replace(/\{username\}/g, username)
    .replace(/\{tweetId\}/g, tweetId)
    .replace(/\{date\}/g, date)
    .replace(/\{type\}/g, type)
    .replace(/\{index\}/g, order)
    .replace(/\{ext\}/g, ext);

  const parts = ["XTwitterDownloader"];
  if (createUsernameFolder) {
    parts.push(username);
  }
  if (createTweetFolder) {
    parts.push(tweetId);
  }
  parts.push(filename);

  return parts.join("/");
}
