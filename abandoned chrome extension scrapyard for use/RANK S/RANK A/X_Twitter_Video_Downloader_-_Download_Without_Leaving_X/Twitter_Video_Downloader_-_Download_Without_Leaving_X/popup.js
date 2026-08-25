const DEFAULT_SETTINGS = {
  createUsernameFolder: true,
  createTweetFolder: true,
  skipDuplicateDownloads: true,
  filenameTemplate: "{username}_{tweetId}_{date}_{type}_{index}.{ext}",
  downloadConcurrency: 3
};

const FILENAME_PRESETS = {
  organized: "{username}_{tweetId}_{date}_{type}_{index}.{ext}",
  short: "{username}_{type}_{index}.{ext}",
  dateFirst: "{date}_{username}_{type}_{index}.{ext}"
};

const PREVIEW_DATA = {
  username: "latestinspace",
  tweetId: "2056813394812948950",
  date: "2026-05-20",
  type: "video",
  index: "01",
  ext: "mp4"
};

const BULK_QUEUE_STORAGE_KEY = "xmvBulkQueueItems";

let presetLockedToCustom = false;
let queueRefreshTimer = null;
let statusHideTimer = null;
let currentDownloadTasks = [];
let currentBatchQueueItems = [];

function normalizeBatchQueueKey(item) {
  const raw = String(item && item.url ? item.url : "");
  if (!raw) {
    return "";
  }

  try {
    const url = new URL(raw, window.location.origin);
    const host = String(url.hostname || "").toLowerCase();
    const path = url.pathname || "";
    if (host.includes("pbs.twimg.com") && path.includes("/media/")) {
      return url.origin + path;
    }
    if (host.includes("video.twimg.com")) {
      return url.origin + path;
    }
    return url.origin + path + (url.search ? url.search : "");
  } catch (error) {
    return raw;
  }
}

// ── i18n ──────────────────────────────────────────────────────────────────────

function t(key) {
  try {
    const msg = chrome.i18n.getMessage(key);
    return msg || key;
  } catch (e) {
    return key;
  }
}

function applyI18n(root) {
  var r = root || document;
  r.querySelectorAll("[data-i18n]").forEach(function(el) {
    el.textContent = t(el.getAttribute("data-i18n"));
  });
  r.querySelectorAll("[data-i18n-placeholder]").forEach(function(el) {
    el.setAttribute("placeholder", t(el.getAttribute("data-i18n-placeholder")));
  });
  r.querySelectorAll("[data-i18n-title]").forEach(function(el) {
    el.setAttribute("title", t(el.getAttribute("data-i18n-title")));
  });
  r.querySelectorAll("[data-i18n-option]").forEach(function(el) {
    el.textContent = t(el.getAttribute("data-i18n-option"));
  });
}

function populateConcurrencySelect() {
  var sel = document.getElementById("concurrencySelect");
  if (!sel) return;
  sel.innerHTML = "";
  [
    { value: "1", key: "concurrencySafe" },
    { value: "3", key: "concurrencyRecommended" },
    { value: "5", key: "concurrencyFast" }
  ].forEach(function(item) {
    var opt = document.createElement("option");
    opt.value = item.value;
    opt.textContent = t(item.key);
    sel.appendChild(opt);
  });
}

// ── Element helpers ──────────────────────────────────────────────────────────

function getElements() {
  return {
    usernameFolderCheckbox: document.getElementById("usernameFolderCheckbox"),
    skipDuplicateDownloadsCheckbox: document.getElementById("skipDuplicateDownloadsCheckbox"),
    tweetFolderCheckbox: document.getElementById("tweetFolderCheckbox"),
    concurrencySelect: document.getElementById("concurrencySelect"),
    filenamePresetSelect: document.getElementById("filenamePresetSelect"),
    filenameTemplateInput: document.getElementById("filenameTemplateInput"),
    filenamePreview: document.getElementById("filenamePreview"),
    pathPreview: document.getElementById("pathPreview"),
    batchQueueCard: document.getElementById("batchQueueCard"),
    batchQueueSummary: document.getElementById("batchQueueSummary"),
    batchQueueList: document.getElementById("batchQueueList"),
    refreshBatchQueueButton: document.getElementById("refreshBatchQueueButton"),
    clearBatchQueueButton: document.getElementById("clearBatchQueueButton"),
    downloadBatchQueueButton: document.getElementById("downloadBatchQueueButton"),
    saveButton: document.getElementById("saveButton"),
    statusMessage: document.getElementById("statusMessage")
  };
}

// ── Tab switching ─────────────────────────────────────────────────────────────

function showTab(tab) {
  const queuePanel = document.getElementById("queuePanel");
  const settingsPanel = document.getElementById("settingsPanel");
  const queueBtn = document.getElementById("queueTabButton");
  const settingsBtn = document.getElementById("settingsTabButton");
  const settingsScroll = settingsPanel ? settingsPanel.querySelector(".settings-scroll") : null;
  const advancedCard = settingsPanel ? settingsPanel.querySelector(".advanced-card") : null;

  if (tab === "queue") {
    queuePanel.classList.remove("hidden");
    settingsPanel.classList.add("hidden");
    queueBtn.classList.add("active");
    settingsBtn.classList.remove("active");
    queuePanel.scrollTop = 0;
    startQueuePolling();
  } else {
    settingsPanel.classList.remove("hidden");
    queuePanel.classList.add("hidden");
    settingsBtn.classList.add("active");
    queueBtn.classList.remove("active");
    if (settingsScroll) {
      settingsScroll.scrollTop = 0;
    }
    if (advancedCard) {
      advancedCard.open = false;
    }
    stopQueuePolling();
  }
}

// ── Queue polling ─────────────────────────────────────────────────────────────

function startQueuePolling() {
  stopQueuePolling();
  loadDownloadTasks();
  loadBatchQueue();
  queueRefreshTimer = setInterval(function() {
    loadDownloadTasks();
    loadBatchQueue();
  }, 1000);
}

function stopQueuePolling() {
  if (queueRefreshTimer) {
    clearInterval(queueRefreshTimer);
    queueRefreshTimer = null;
  }
}

// ── Runtime messaging ─────────────────────────────────────────────────────────

function sendRuntimeMessage(message) {
  return new Promise(function(resolve, reject) {
    if (!chrome || !chrome.runtime || !chrome.runtime.sendMessage) {
      reject(new Error("chrome.runtime.sendMessage unavailable"));
      return;
    }
    chrome.runtime.sendMessage(message, function(response) {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(response);
    });
  });
}

// ── Queue rendering ───────────────────────────────────────────────────────────

async function loadDownloadTasks() {
  try {
    const response = await sendRuntimeMessage({ type: "XMV_GET_DOWNLOAD_TASKS" });
    if (!response || !response.ok) {
      currentDownloadTasks = [];
      renderQueue([]);
      return;
    }
    currentDownloadTasks = Array.isArray(response.tasks) ? response.tasks : [];
    renderQueue(currentDownloadTasks);
  } catch (error) {
    console.error("[XMV] could not load download tasks:", error);
    currentDownloadTasks = [];
    renderQueue([]);
  }
}

async function loadBatchQueue() {
  try {
    if (!chrome || !chrome.storage || !chrome.storage.local) {
      currentBatchQueueItems = [];
      renderBatchQueue([]);
      return;
    }

    const stored = await chrome.storage.local.get({ [BULK_QUEUE_STORAGE_KEY]: [] });
    const items = Array.isArray(stored[BULK_QUEUE_STORAGE_KEY]) ? stored[BULK_QUEUE_STORAGE_KEY] : [];
    const seen = new Set();
    currentBatchQueueItems = items.filter(function(item) {
      if (!item || !item.url) {
        return false;
      }
      const key = normalizeBatchQueueKey(item);
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
    renderBatchQueue(currentBatchQueueItems);
  } catch (error) {
    console.error("[XMV] could not load batch queue:", error);
    currentBatchQueueItems = [];
    renderBatchQueue([]);
  }
}

function shortenFilename(filename) {
  if (!filename) return "file";
  const base = filename.split("/").pop() || filename;
  if (base.length <= 40) return base;
  const dot = base.lastIndexOf(".");
  if (dot > 0) {
    return base.slice(0, 28) + "\u2026" + base.slice(dot);
  }
  return base.slice(0, 37) + "\u2026";
}

function formatTaskStatus(task) {
  const map = {
    queued: "queueStatusWaiting",
    downloading: "queueStatusDownloading",
    completed: "queueStatusDone",
    failed: "queueStatusFailed"
  };
  return t(map[task.status] || "queueStatusWaiting");
}

function getQueueSummary(tasks) {
  if (!tasks || !tasks.length) return "";
  const counts = { downloading: 0, queued: 0, completed: 0, failed: 0 };
  for (const task of tasks) {
    if (counts[task.status] !== undefined) counts[task.status]++;
  }
  const parts = [];
  if (counts.downloading) parts.push(counts.downloading + " " + t("queueSummaryDownloading"));
  if (counts.queued) parts.push(counts.queued + " " + t("queueSummaryWaiting"));
  if (counts.completed) parts.push(counts.completed + " " + t("queueSummaryDone"));
  if (counts.failed) parts.push(counts.failed + " " + t("queueSummaryFailed"));
  return parts.join(" \u00b7 ");
}

function updateQueueViewMode() {
  const emptyCard = document.getElementById("emptyStateCard");
  const batchQueueCard = document.getElementById("batchQueueCard");
  const queueCard = document.getElementById("queueCard");
  const hasDownloadTasks = currentDownloadTasks.length > 0;
  const hasBatchItems = currentBatchQueueItems.length > 0;
  if (emptyCard) {
    emptyCard.classList.toggle("hidden", hasDownloadTasks || hasBatchItems);
  }
  if (batchQueueCard) {
    batchQueueCard.classList.toggle("hidden", !hasBatchItems);
  }
  if (queueCard) {
    queueCard.classList.toggle("hidden", !hasDownloadTasks);
  }
}

function renderQueue(tasks) {
  const summaryEl = document.getElementById("queueSummary");
  const listEl = document.getElementById("queueList");
  if (!summaryEl || !listEl) return;

  const summary = getQueueSummary(tasks);
  summaryEl.textContent = summary || "";

  listEl.innerHTML = "";

  const recent = (tasks || []).slice(0, 8);
  updateQueueViewMode();

  if (!recent.length) {
    return;
  }

  for (const task of recent) {
    const item = document.createElement("div");
    item.className = "queue-item";
    if (task.error) {
      item.title = task.error;
    }

    const fileDiv = document.createElement("div");
    fileDiv.className = "queue-file";
    fileDiv.title = (task.filename || "").split("/").pop() || task.filename || "";
    fileDiv.textContent = shortenFilename(task.filename);

    const metaDiv = document.createElement("div");
    metaDiv.className = "queue-meta";

    const statusSpan = document.createElement("span");
    statusSpan.className = "queue-status-" + task.status;
    statusSpan.textContent = formatTaskStatus(task);
    metaDiv.appendChild(statusSpan);

    const progress = typeof task.progress === "number" ? task.progress : null;
    if (progress !== null && (task.status === "downloading" || task.status === "completed")) {
      const pctSpan = document.createElement("span");
      pctSpan.textContent = progress + "%";
      metaDiv.appendChild(pctSpan);
    }

    if (task.status === "failed") {
      const retryBtn = document.createElement("button");
      retryBtn.className = "popup-retry-btn";
      retryBtn.type = "button";
      retryBtn.textContent = t("queueRetry");
      retryBtn.dataset.action = "retry-task";
      retryBtn.dataset.taskId = task.taskId;
      console.log("[XMV] rendering failed task:", task.taskId, task.filename);
      metaDiv.appendChild(retryBtn);
    }

    item.appendChild(fileDiv);
    item.appendChild(metaDiv);

    if (task.status === "downloading" || task.status === "completed") {
      const barWrap = document.createElement("div");
      barWrap.className = "queue-progress";
      const fill = document.createElement("div");
      fill.className = "queue-progress-fill" + (task.status === "completed" ? " done" : "");
      fill.style.width = (progress !== null ? progress : 0) + "%";
      barWrap.appendChild(fill);
      item.appendChild(barWrap);
    }

    listEl.appendChild(item);
  }
}

function getBatchQueueSummary(items) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) {
    return "";
  }

  const tweetIds = new Set();
  list.forEach(function(item) {
    if (item && item.tweetId) {
      tweetIds.add(item.tweetId);
    }
  });

  return list.length + " items from " + tweetIds.size + " posts ready to download.";
}

function renderBatchQueue(items) {
  const elements = getElements();
  const list = Array.isArray(items) ? items : [];

  if (elements.batchQueueSummary) {
    elements.batchQueueSummary.textContent = getBatchQueueSummary(list);
  }

  if (!elements.batchQueueList) {
    return;
  }

  elements.batchQueueList.innerHTML = "";
  updateQueueViewMode();

  if (!list.length) {
    const emptyDiv = document.createElement("div");
    emptyDiv.className = "queue-empty";
    emptyDiv.textContent = t("batchQueueEmpty");
    elements.batchQueueList.appendChild(emptyDiv);
    return;
  }

  list.forEach(function(item, index) {
    const row = document.createElement("div");
    row.className = "queue-item batch-queue-item";

    const textWrap = document.createElement("div");
    textWrap.style.minWidth = "0";
    textWrap.style.flex = "1 1 auto";

    const fileDiv = document.createElement("div");
    fileDiv.className = "queue-file";
    fileDiv.textContent = shortenFilename(item && item.filename ? item.filename : item && item.url ? item.url : "file");
    fileDiv.title = (item && item.filename ? item.filename : item && item.url ? item.url : "");

    const sourceDiv = document.createElement("div");
    sourceDiv.className = "batch-queue-source";
    const sourceParts = [];
    if (item && item.username) {
      sourceParts.push("@" + item.username);
    }
    if (item && item.tweetId) {
      sourceParts.push(item.tweetId);
    }
    if (item && item.type) {
      sourceParts.push(item.type);
    }
    sourceDiv.textContent = sourceParts.join(" · ");

    textWrap.appendChild(fileDiv);
    textWrap.appendChild(sourceDiv);

    const actions = document.createElement("div");
    actions.className = "batch-queue-item-actions";

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "batch-remove-btn";
    removeBtn.textContent = t("batchQueueRemoveItem", "Remove");
    removeBtn.dataset.action = "remove-batch-item";
    removeBtn.dataset.index = String(index);
    actions.appendChild(removeBtn);

    row.appendChild(textWrap);
    row.appendChild(actions);
    elements.batchQueueList.appendChild(row);
  });
}

// ── Settings ──────────────────────────────────────────────────────────────────

function applySettingsToUI(settings) {
  const elements = getElements();
  elements.usernameFolderCheckbox.checked = Boolean(settings.createUsernameFolder);
  elements.skipDuplicateDownloadsCheckbox.checked = settings.skipDuplicateDownloads !== false;
  elements.tweetFolderCheckbox.checked = Boolean(settings.createTweetFolder);
  elements.concurrencySelect.value = String(settings.downloadConcurrency || DEFAULT_SETTINGS.downloadConcurrency);
  elements.filenameTemplateInput.value = settings.filenameTemplate || DEFAULT_SETTINGS.filenameTemplate;
  updatePresetFromTemplate();
}

function readSettingsFromUI() {
  const elements = getElements();
  return {
    createUsernameFolder: Boolean(elements.usernameFolderCheckbox.checked),
    skipDuplicateDownloads: Boolean(elements.skipDuplicateDownloadsCheckbox.checked),
    createTweetFolder: Boolean(elements.tweetFolderCheckbox.checked),
    filenameTemplate: String(elements.filenameTemplateInput.value || "").trim(),
    downloadConcurrency: Number(elements.concurrencySelect.value || DEFAULT_SETTINGS.downloadConcurrency)
  };
}

function setStatus(message, type) {
  const elements = getElements();
  if (statusHideTimer) {
    clearTimeout(statusHideTimer);
    statusHideTimer = null;
  }

  if (!message) {
    elements.statusMessage.textContent = "";
    elements.statusMessage.className = "status is-hidden";
    return;
  }

  elements.statusMessage.textContent = message;
  elements.statusMessage.className = "status" + (type ? " " + type : "");

  if (type === "success") {
    statusHideTimer = setTimeout(function() {
      setStatus("", "");
    }, 2200);
  }
}

function updatePresetFromTemplate() {
  const elements = getElements();
  const template = String(elements.filenameTemplateInput.value || "").trim();

  if (presetLockedToCustom) {
    elements.filenamePresetSelect.value = "custom";
    return;
  }

  if (template === FILENAME_PRESETS.organized) {
    elements.filenamePresetSelect.value = "organized";
    return;
  }

  if (template === FILENAME_PRESETS.short) {
    elements.filenamePresetSelect.value = "short";
    return;
  }

  if (template === FILENAME_PRESETS.dateFirst) {
    elements.filenamePresetSelect.value = "dateFirst";
    return;
  }

  elements.filenamePresetSelect.value = "custom";
}

function applyPresetToTemplate() {
  const elements = getElements();
  const preset = elements.filenamePresetSelect.value;

  if (preset === "custom") {
    presetLockedToCustom = true;
    updateFilenamePreview();
    return;
  }

  presetLockedToCustom = false;
  const template = FILENAME_PRESETS[preset] || DEFAULT_SETTINGS.filenameTemplate;
  elements.filenameTemplateInput.value = template;
  updateFilenamePreview();
}

function updateFilenamePreview() {
  const elements = getElements();
  const settings = readSettingsFromUI();
  const template = settings.filenameTemplate || DEFAULT_SETTINGS.filenameTemplate;

  const filename = template
    .replace(/\{username\}/g, PREVIEW_DATA.username)
    .replace(/\{tweetId\}/g, PREVIEW_DATA.tweetId)
    .replace(/\{date\}/g, PREVIEW_DATA.date)
    .replace(/\{type\}/g, PREVIEW_DATA.type)
    .replace(/\{index\}/g, PREVIEW_DATA.index)
    .replace(/\{ext\}/g, PREVIEW_DATA.ext);

  const pathParts = ["XTwitterDownloader"];
  if (settings.createUsernameFolder) {
    pathParts.push(PREVIEW_DATA.username);
  }
  if (settings.createTweetFolder) {
    pathParts.push(PREVIEW_DATA.tweetId);
  }

  elements.filenamePreview.textContent = filename;
  elements.pathPreview.textContent = pathParts.join("/") + "/";
  updatePresetFromTemplate();
}

async function loadSettings() {
  if (typeof chrome === "undefined" || !chrome.storage || !chrome.storage.sync) {
    applySettingsToUI(DEFAULT_SETTINGS);
    updateFilenamePreview();
    setStatus(t("settingsLoadFailed"), "warning");
    return;
  }

  try {
    const stored = await chrome.storage.sync.get(DEFAULT_SETTINGS);
    const settings = Object.assign({}, DEFAULT_SETTINGS, stored || {});
    applySettingsToUI(settings);
    updateFilenamePreview();
    setStatus(t("settingsReady"), "success");
  } catch (error) {
    console.error("[XMV] could not load settings:", error);
    applySettingsToUI(DEFAULT_SETTINGS);
    updateFilenamePreview();
    setStatus(t("settingsLoadFailed"), "warning");
  }
}

async function saveSettings() {
  if (typeof chrome === "undefined" || !chrome.storage || !chrome.storage.sync) {
    setStatus(t("settingsLoadFailed"), "warning");
    return;
  }

  try {
    const settings = readSettingsFromUI();

    if (!settings.filenameTemplate) {
      setStatus(t("filenameTemplateEmpty"), "error");
      return;
    }

    if (!settings.filenameTemplate.includes("{ext}")) {
      setStatus(t("filenameTemplateMissingExt"), "error");
      return;
    }

    await chrome.storage.sync.set(settings);
    updateFilenamePreview();

    if (!settings.filenameTemplate.includes("{tweetId}")) {
      setStatus(t("filenameTemplateTipTweetId"), "warning");
      return;
    }

    setStatus(t("settingsSaved"), "success");
  } catch (error) {
    console.error("[XMV] could not save settings:", error);
    setStatus(t("settingsSaveFailed"), "error");
  }
}

// ── Event binding ─────────────────────────────────────────────────────────────

function bindEvents() {
  const elements = getElements();

  document.getElementById("queueTabButton").addEventListener("click", function() {
    showTab("queue");
  });

  document.getElementById("settingsTabButton").addEventListener("click", function() {
    showTab("settings");
  });

  document.getElementById("clearCompletedButton").addEventListener("click", async function() {
    try {
      const response = await sendRuntimeMessage({ type: "XMV_CLEAR_COMPLETED_TASKS" });
      if (response && response.ok) {
        renderQueue(response.tasks || []);
      }
    } catch (error) {
      console.error("[XMV] clear completed failed:", error);
    }
  });

  document.getElementById("retryAllFailedButton").addEventListener("click", async function() {
    console.log("[XMV] popup retry all failed clicked");
    const btn = document.getElementById("retryAllFailedButton");
    btn.disabled = true;
    btn.textContent = t("queueRetrying");
    try {
      const response = await sendRuntimeMessage({ type: "XMV_RETRY_FAILED_TASKS" });
      console.log("[XMV] popup retry all failed response:", response);
      if (response && response.ok) {
        renderQueue(response.tasks || []);
        startQueuePolling();
        setStatus(t("queueRetryQueued"), "success");
      } else {
        throw new Error((response && response.error) || "Retry all failed");
      }
    } catch (error) {
      console.error("[XMV] retry all failed:", error);
      setStatus(t("queueRetryFailed"), "error");
    } finally {
      btn.disabled = false;
      btn.textContent = t("queueRetryAllFailed");
    }
  });

  document.getElementById("queueList").addEventListener("click", async function(event) {
    const retryBtn = event.target.closest("[data-action='retry-task']");
    if (!retryBtn) return;

    const taskId = retryBtn.dataset.taskId;
    if (!taskId) {
      console.error("[XMV] retry clicked but missing taskId");
      return;
    }

    console.log("[XMV] popup retry clicked:", taskId);
    retryBtn.disabled = true;
    retryBtn.textContent = t("queueRetrying");

    try {
      const response = await sendRuntimeMessage({
        type: "XMV_RETRY_DOWNLOAD_TASK",
        taskId: taskId
      });
      console.log("[XMV] popup retry response:", response);
      if (response && response.ok) {
        renderQueue(response.tasks || []);
        startQueuePolling();
        setStatus(t("queueRetryQueued"), "success");
      } else {
        throw new Error((response && response.error) || "Retry failed");
      }
    } catch (error) {
      console.error("[XMV] popup retry failed:", error);
      setStatus(t("queueRetryFailed"), "error");
      retryBtn.disabled = false;
      retryBtn.textContent = t("queueRetry");
    }
  });

  document.getElementById("batchQueueList").addEventListener("click", async function(event) {
    const removeBtn = event.target.closest("[data-action='remove-batch-item']");
    if (!removeBtn) {
      return;
    }

    const index = Number(removeBtn.dataset.index);
    if (!Number.isFinite(index)) {
      return;
    }

    try {
      const next = currentBatchQueueItems.slice();
      next.splice(index, 1);
      if (chrome && chrome.storage && chrome.storage.local) {
        await chrome.storage.local.set({ [BULK_QUEUE_STORAGE_KEY]: next });
      }
      currentBatchQueueItems = next;
      renderBatchQueue(currentBatchQueueItems);
      setStatus(t("batchQueueItemRemoved", "Removed from batch queue."), "success");
    } catch (error) {
      console.error("[XMV] remove batch item failed:", error);
      setStatus(t("batchQueueRemoveFailed", "Could not remove item."), "error");
    }
  });

  document.getElementById("refreshQueueButton").addEventListener("click", function() {
    loadDownloadTasks();
  });

  document.getElementById("refreshBatchQueueButton").addEventListener("click", function() {
    loadBatchQueue();
  });

  document.getElementById("clearBatchQueueButton").addEventListener("click", async function() {
    try {
      if (chrome && chrome.storage && chrome.storage.local) {
        await chrome.storage.local.set({ [BULK_QUEUE_STORAGE_KEY]: [] });
      }
      currentBatchQueueItems = [];
      renderBatchQueue([]);
      setStatus(t("batchQueueCleared", "Batch queue cleared."), "success");
    } catch (error) {
      console.error("[XMV] clear batch queue failed:", error);
      setStatus(t("batchQueueClearFailed", "Could not clear the batch queue."), "error");
    }
  });

  document.getElementById("downloadBatchQueueButton").addEventListener("click", async function() {
    const btn = document.getElementById("downloadBatchQueueButton");
    if (!currentBatchQueueItems.length) {
      setStatus(t("batchQueueEmpty"), "warning");
      return;
    }

    btn.disabled = true;
    btn.textContent = t("batchQueueDownloading", "Downloading...");

    try {
      const response = await sendRuntimeMessage({
        type: "XMV_DOWNLOAD_MEDIA",
        items: currentBatchQueueItems
      });

      if (response && response.ok) {
        if (chrome && chrome.storage && chrome.storage.local) {
          await chrome.storage.local.set({ [BULK_QUEUE_STORAGE_KEY]: [] });
        }
        currentBatchQueueItems = [];
        renderBatchQueue([]);
        loadDownloadTasks();
        setStatus(t("batchQueueDownloadStarted", "Downloads added to the download queue."), "success");
      } else {
        throw new Error((response && response.error) || "Batch download failed");
      }
    } catch (error) {
      console.error("[XMV] batch download failed:", error);
      setStatus(t("batchQueueDownloadFailed", "Could not start batch download."), "error");
    } finally {
      btn.disabled = false;
      btn.textContent = t("batchQueueDownloadAll");
    }
  });

  elements.saveButton.addEventListener("click", function() {
    saveSettings();
  });

  elements.filenamePresetSelect.addEventListener("change", applyPresetToTemplate);

  elements.filenameTemplateInput.addEventListener("input", function() {
    presetLockedToCustom = true;
    updateFilenamePreview();
  });

  elements.usernameFolderCheckbox.addEventListener("change", updateFilenamePreview);
  elements.skipDuplicateDownloadsCheckbox.addEventListener("change", updateFilenamePreview);
  elements.tweetFolderCheckbox.addEventListener("change", updateFilenamePreview);

  window.addEventListener("unload", stopQueuePolling);
}

// ── Init ──────────────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", async function onReady() {
  applyI18n();
  populateConcurrencySelect();
  bindEvents();
  setStatus("", "");
  await loadSettings();
  showTab("queue");
});
