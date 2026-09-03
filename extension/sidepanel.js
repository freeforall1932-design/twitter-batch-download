// Persistent batch queue interface for scroll capture, remote discovery, and downloads.
const $ = (id) => document.getElementById(id);
const queueEl = $("queue"), filterEl = $("mediaFilter"), selectAllEl = $("selectAll");
let state = { items: [], concurrency: 2, stopped: false, skipDownloaded: true };
let discovery = { running: false, pages: 0, found: 0, status: "Ready to discover media", error: null, errorCode: null, retryAfterMs: 0, retryUntil: 0 };
let activeTab = "scroll";
let countdownTimer = null;
let localStatusTimer = null;
let rescanRunning = false;
let autoScrollRunning = false;
let deepFetchRunning = false;
let needsTabReload = false;
let reloadTabId = null;
const FETCH_PHASES = {
  shallow: "reading what this tab already loaded",
  scroll: "scrolling the timeline",
  remote: "silently fetching the rest",
  done: "finished"
};

function sourceForActiveTab() { return activeTab === "scroll" ? "scroll" : "remote"; }
function send(message) {
  return new Promise((resolve) => chrome.runtime.sendMessage(message, (response) => resolve(response || { ok: false, error: chrome.runtime.lastError?.message })));
}
function sendToActiveXTab(message) {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
      const url = tab?.url || "";
      if (!tab?.id || (!url.includes("x.com") && !url.includes("twitter.com"))) {
        resolve({ ok: false, error: "Open an X/Twitter tab to capture media.", noTab: true, tabId: tab?.id || null });
        return;
      }
      chrome.tabs.sendMessage(tab.id, message, (response) => {
        // A tab that was open before the extension loaded/reloaded has no live
        // content script — the only fix is a page reload, so the panel now
        // offers that as a button instead of only telling the user to do it.
        if (chrome.runtime.lastError) resolve({ ok: false, error: "This X tab predates the extension — reload it so capture can start.", needsRefresh: true, url, tabId: tab.id });
        else resolve({ ...(response || {}), ok: response?.ok !== false, url, tabId: tab.id });
      });
    });
  });
}

function itemSource(item) { return item.source || "remote"; }
function itemMatchesFilter(item) { return filterEl.value === "all" || item.type === filterEl.value; }
function tabItems() { const source = sourceForActiveTab(); return state.items.filter((item) => itemSource(item) === source); }
function visibleItems() { return tabItems().filter(itemMatchesFilter); }
function selectedItems() { return tabItems().filter((item) => item.selected); }
function escapeHtml(value = "") { const el = document.createElement("div"); el.textContent = value; return el.innerHTML; }

function formatRetryCountdown(discoveryState) {
  const until = Number(discoveryState?.retryUntil) || 0;
  if (!until) return 0;
  return Math.max(0, until - Date.now());
}

function discoveryHintText() {
  const remaining = formatRetryCountdown(discovery);
  if (remaining > 0 || (discovery.retryAfterMs > 0 && discovery.running)) {
    const seconds = Math.max(1, Math.ceil((remaining || discovery.retryAfterMs) / 1000));
    return discovery.status && /rate limited/i.test(discovery.status)
      ? discovery.status.replace(/retrying in \d+s/i, `retrying in ${seconds}s`)
      : `Rate limited — retrying in ${seconds}s…`;
  }
  if (discovery.error) return discovery.error;
  return discovery.status || "Remote fetch can hit X rate limits. Use Scroll capture first when possible.";
}

function renderDiscoveryHint() {
  const hint = $("discoveryHint");
  const remaining = formatRetryCountdown(discovery);
  const isError = Boolean(discovery.error) && remaining <= 0;
  const isRetry = remaining > 0 || (discovery.retryAfterMs > 0 && discovery.running);
  hint.textContent = discoveryHintText();
  hint.classList.toggle("error", isError);
  hint.classList.toggle("retry", isRetry);
  if (discovery.errorCode) hint.dataset.errorCode = discovery.errorCode;
  else delete hint.dataset.errorCode;
}

function ensureCountdownTimer() {
  const needsTimer = formatRetryCountdown(discovery) > 0 || (discovery.retryAfterMs > 0 && discovery.running);
  if (needsTimer && !countdownTimer) {
    countdownTimer = setInterval(() => {
      renderDiscoveryHint();
      if (formatRetryCountdown(discovery) <= 0 && !(discovery.retryAfterMs > 0 && discovery.running)) {
        clearInterval(countdownTimer);
        countdownTimer = null;
      }
    }, 500);
  } else if (!needsTimer && countdownTimer) {
    clearInterval(countdownTimer);
    countdownTimer = null;
  }
}

function renderTabs() {
  document.querySelectorAll(".tab").forEach((button) => button.classList.toggle("selected", button.dataset.tab === activeTab));
  $("scrollPanel").classList.toggle("hidden", activeTab !== "scroll");
  $("remotePanel").classList.toggle("hidden", activeTab !== "remote");
}

function render() {
  renderTabs();
  const items = visibleItems();
  const allTabItems = tabItems();
  const selected = selectedItems();
  const completed = allTabItems.filter((item) => item.status === "completed").length;
  $("discoveredCount").textContent = allTabItems.length;
  $("selectedCount").textContent = selected.length;
  $("completedCount").textContent = completed;
  // One download action. "Select all" already covers the old "download all".
  $("downloadSelectedBtn").disabled = selected.length === 0;
  $("downloadSelectedBtn").textContent = selected.length
    ? `Download ${selected.length} selected`
    : "Download selected";
  // The other half of "rescan, then pick what to delete": ticking rows can
  // remove them, not only download them.
  $("removeSelectedBtn").disabled = selected.length === 0;
  $("removeSelectedBtn").textContent = selected.length
    ? `Remove ${selected.length} selected`
    : "Remove selected";
  $("stopBtn").disabled = !state.running;
  $("discoverBtn").disabled = discovery.running;
  $("stopDiscoveryBtn").disabled = !discovery.running;
  $("skipDownloaded").checked = state.skipDownloaded !== false;
  renderDiscoveryHint();
  ensureCountdownTimer();
  $("engineStatus").textContent = state.running ? "Downloading" : state.stopped ? "Paused" : activeTab === "scroll" ? "Capturing" : "Ready";
  $("engineStatus").className = "status-pill " + (state.running ? "running" : "idle");

  // v3.6: archive-mode warnings computed by the background at queueStart
  // (video posts being zipped, mixed-media posts, PDF→ZIP fallbacks).
  const noticesBox = $("queueNotices");
  const notices = Array.isArray(state.notices) ? state.notices : [];
  if (notices.length && state.running) {
    noticesBox.style.display = "";
    noticesBox.textContent = "";
    for (const notice of notices) {
      const line = document.createElement("p");
      line.textContent = notice;
      noticesBox.appendChild(line);
    }
  } else {
    noticesBox.style.display = "none";
  }
  selectAllEl.checked = items.length > 0 && items.every((item) => item.selected);
  selectAllEl.indeterminate = items.some((item) => item.selected) && !selectAllEl.checked;
  if (!items.length) {
    const title = activeTab === "scroll" ? "No scroll-captured media yet" : "No remote-fetched media yet";
    const body = activeTab === "scroll"
      ? "Open an X profile, /media page, post, or your home timeline and scroll. Media lists here automatically."
      : "Paste a profile or media URL, then run Remote discover.";
    queueEl.innerHTML = `<div class="empty-state"><div class="empty-icon">↓</div><h2>${title}</h2><p>${body}</p></div>`;
    return;
  }
  queueEl.innerHTML = items.map((item) => {
    const thumbnail = item.thumbnail ? `<img src="${escapeHtml(item.thumbnail)}" alt="" loading="lazy">` : `<div class="thumb-placeholder">${item.type === "video" ? "▶" : "▧"}</div>`;
    const progress = item.status === "downloading" && item.totalBytes > 0 ? ` ${Math.round((item.bytesReceived || 0) * 100 / item.totalBytes)}%` : "";
    const retry = item.status === "failed" ? ` (${item.attempts || 0}/3)` : "";
    const gif = item.isGif ? `<span class="type-badge gif" title="X serves GIFs as MP4 clips; saved per the GIF setting in Output settings.">gif</span>` : "";
    const repost = item.isRepost ? `<span class="type-badge repost">repost</span>` : "";
    const quote = item.isQuote ? `<span class="type-badge quote" title="Media from a post quoted inside another post.">quote</span>` : "";
    const link = item.tweetId ? `<a class="item-link" href="https://x.com/i/status/${escapeHtml(item.tweetId)}" target="_blank" rel="noreferrer" title="Open post">↗</a>` : "";
    return `<article class="queue-item"><input class="item-select" data-id="${escapeHtml(item.id)}" type="checkbox" ${item.selected ? "checked" : ""} aria-label="Select media"><div>${thumbnail}</div><div class="item-info"><div class="item-title">${escapeHtml(item.author || "X post")}${link}</div><div class="item-meta">${escapeHtml(item.date || "Captured while scrolling")}</div><span class="type-badge">${escapeHtml(item.type || "media")}</span>${gif}${repost}${quote}</div><div class="item-right"><span class="item-status ${escapeHtml(item.status || "discovered")}" title="${escapeHtml(item.error || "")}">${escapeHtml(item.status || "discovered")}${progress}${retry}</span><button class="item-remove" data-remove="${escapeHtml(item.id)}" title="Remove from list" aria-label="Remove from list">×</button></div></article>`;
  }).join("");
}

async function refresh() { [state, discovery] = await Promise.all([send({ action: "queueGet" }), send({ action: "discoveryGet" })]); render(); }
async function updateSelection(id, selected) { state = await send({ action: "queueSelect", id, selected }); render(); }

function scrollSettings() {
  return {
    mediaFilter: $("localCaptureFilter").value,
    scrollSpeed: $("localScrollSpeed").value,
    skipDownloaded: $("skipDownloaded").checked,
    includeQuoted: $("scrollIncludeQuoted").checked,
    deepFetchRemote: $("deepFetchRemote").checked,
    showFetchButton: $("showFetchButton").checked
  };
}

function setTabStatus(kind, title, detail) {
  $("tabStatus").className = `tab-status ${kind}`;
  $("tabStatusTitle").textContent = title;
  $("tabStatusDetail").textContent = detail;
}

// Replaces the old manual "Watch current tab" button: capture is always on in
// every X tab, so the panel only needs to report what it currently sees.
function setLocalBusy(busy, options = {}) {
  // A rescan is a short read-only pass, so it blocks starting anything else but
  // has nothing to cancel: Stop stays reserved for the engines that move the
  // page or crawl it.
  const working = busy || Boolean(options.rescanning);
  $("fetchNowBtn").disabled = working;
  $("startLocalScrollBtn").disabled = working;
  $("rescanTabBtn").disabled = working;
  $("stopLocalScrollBtn").disabled = !busy;
}

function setReloadTab(needed, tabId) {
  needsTabReload = Boolean(needed);
  reloadTabId = needsTabReload ? (tabId || reloadTabId) : null;
  $("reloadTabBtn").classList.toggle("hidden", !needsTabReload);
}

async function pollLocalStatus() {
  if (activeTab !== "scroll") return;
  const response = await sendToActiveXTab({ action: "scrollStatus" });
  if (response?.noTab) {
    setTabStatus("warn", "No X tab active", response.error);
    autoScrollRunning = false;
    deepFetchRunning = false;
    setReloadTab(false);
  } else if (response?.needsRefresh) {
    setTabStatus("warn", "Reload needed", response.error);
    autoScrollRunning = false;
    deepFetchRunning = false;
    setReloadTab(true, response.tabId);
  } else if (response?.text) {
    let host = "";
    try { host = new URL(response.url || "").pathname || "/"; } catch (_) { host = "/"; }
    autoScrollRunning = Boolean(response.running);
    deepFetchRunning = Boolean(response.fetching);
    rescanRunning = Boolean(response.rescanning);
    const busy = autoScrollRunning || deepFetchRunning;
    setReloadTab(false);
    setTabStatus(
      busy || rescanRunning ? "active" : "ok",
      deepFetchRunning
        ? `Fetching this tab — ${FETCH_PHASES[response.fetchPhase] || "working"}`
        : busy ? "Auto-scrolling this tab"
          : rescanRunning ? "Re-listing this tab" : "Capturing this tab",
      `${host} · ${response.postsOnScreen || 0} posts on screen${response.pendingVideos ? ` · resolving ${response.pendingVideos} video posts` : ""}`
    );
    $("localHint").textContent = response.text;
    $("localHint").classList.remove("error");
  }
  setLocalBusy(autoScrollRunning || deepFetchRunning, { rescanning: rescanRunning });
}

queueEl.addEventListener("change", (event) => { if (event.target.matches(".item-select")) updateSelection(event.target.dataset.id, event.target.checked); });
queueEl.addEventListener("click", async (event) => {
  const removeId = event.target.closest("[data-remove]")?.dataset.remove;
  if (!removeId) return;
  state = await send({ action: "queueRemove", id: removeId });
  render();
});
selectAllEl.addEventListener("change", async () => { state = await send({ action: "queueSelectVisible", filter: filterEl.value, source: sourceForActiveTab(), selected: selectAllEl.checked }); render(); });
filterEl.addEventListener("change", render);
$("skipDownloaded").addEventListener("change", async () => {
  const skipDownloaded = $("skipDownloaded").checked;
  await chrome.storage.local.set({ skipDownloaded });
  state = await send({ action: "queueSetSkipDownloaded", skipDownloaded });
  sendToActiveXTab({ action: "scrollSettings", ...scrollSettings() });
  render();
});
$("retryFailedBtn").addEventListener("click", async () => { state = await send({ action: "queueRetryFailed" }); render(); });
$("clearHistoryBtn").addEventListener("click", async () => {
  if (!confirm(`Clear all ${activeTab === "scroll" ? "scroll-captured" : "remote-fetched"} items from this list?`)) return;
  state = await send({ action: "queueClearAll", source: sourceForActiveTab() });
  render();
});
// Both handlers below existed in background.js but nothing in the panel ever
// sent them, so the contract in SESSION_HANDOFF §4 listed two unreachable
// commands. They are wired here rather than deleted.
$("clearFinishedBtn").addEventListener("click", async () => {
  state = await send({ action: "queueClearFinished" });
  render();
});
$("resetDownloadedBtn").addEventListener("click", async () => {
  if (!confirm("Forget which media you already downloaded? Previously skipped items will list again.")) return;
  state = await send({ action: "queueClearDownloadedHistory" });
  render();
});
$("downloadSelectedBtn").addEventListener("click", async () => { state = await send({ action: "queueStart", mode: "selected", source: sourceForActiveTab(), format: $("jobFormat").value }); render(); });
$("stopBtn").addEventListener("click", async () => { state = await send({ action: "queueStop" }); render(); });
$("removeSelectedBtn").addEventListener("click", async () => {
  const ids = selectedItems().map((item) => item.id);
  if (!ids.length) return;
  if (!confirm(`Remove ${ids.length} selected item${ids.length === 1 ? "" : "s"} from this list? Nothing already downloaded is deleted from disk — press Rescan tab to bring them back.`)) return;
  state = await send({ action: "queueRemove", ids });
  render();
});

document.querySelectorAll(".tab").forEach((button) => button.addEventListener("click", async () => {
  activeTab = button.dataset.tab;
  await chrome.storage.local.set({ sidePanelActiveTab: activeTab });
  render();
  if (activeTab === "scroll") pollLocalStatus();
}));

document.querySelectorAll("[data-concurrency]").forEach((button) => button.addEventListener("click", async () => {
  state = await send({ action: "queueSetConcurrency", concurrency: Number(button.dataset.concurrency) });
  document.querySelectorAll("[data-concurrency]").forEach((candidate) => candidate.classList.toggle("selected", candidate === button));
  render();
}));

async function pushScrollSettings() {
  const settings = scrollSettings();
  await chrome.storage.local.set({
    scrollMediaFilter: settings.mediaFilter,
    scrollSpeed: settings.scrollSpeed,
    scrollIncludeQuoted: settings.includeQuoted,
    deepFetchRemote: settings.deepFetchRemote,
    showFetchButton: settings.showFetchButton
  });
  await sendToActiveXTab({ action: "scrollSettings", ...settings });
}
$("localCaptureFilter").addEventListener("change", pushScrollSettings);
$("localScrollSpeed").addEventListener("change", pushScrollSettings);
$("scrollIncludeQuoted").addEventListener("change", pushScrollSettings);

// Deep fetch — the same command the in-page Fetch button runs.
$("fetchNowBtn").addEventListener("click", async () => {
  const response = await sendToActiveXTab({ action: "scrollFetch", ...scrollSettings() });
  const problem = response.error || (response.ok === false ? response.reason : "");
  $("localHint").textContent = problem
    || "Fetching — reading this tab, scrolling the timeline, then silently filling any gaps.";
  $("localHint").classList.toggle("error", Boolean(problem));
  if (response.needsRefresh) setReloadTab(true, response.tabId);
  deepFetchRunning = Boolean(response.fetching);
  autoScrollRunning = Boolean(response.running);
  setLocalBusy(deepFetchRunning || autoScrollRunning);
  pollLocalStatus();
});
$("startLocalScrollBtn").addEventListener("click", async () => {
  const response = await sendToActiveXTab({ action: "scrollStart", ...scrollSettings() });
  $("localHint").textContent = response.error || response.reason || response.text || "Auto-scroll started.";
  $("localHint").classList.toggle("error", Boolean(response.error));
  autoScrollRunning = Boolean(response.running);
  setLocalBusy(autoScrollRunning || deepFetchRunning);
});
// Shallow pass only: no scrolling, no remote fill. Finally gives the
// long-documented scrollRescan command a real sender.
$("rescanTabBtn").addEventListener("click", async () => {
  const response = await sendToActiveXTab({ action: "scrollRescan" });
  $("localHint").textContent = response.error || "Re-listing this tab…";
  $("localHint").classList.toggle("error", Boolean(response.error));
  if (response.needsRefresh) setReloadTab(true, response.tabId);
  // The pass finishes on its own clock (video posts can take a few seconds to
  // resolve); the 1.5 s status poll replaces the hint with its result note.
  rescanRunning = Boolean(response.rescanning);
  setLocalBusy(autoScrollRunning || deepFetchRunning, { rescanning: rescanRunning });
});
$("stopLocalScrollBtn").addEventListener("click", async () => {
  const response = await sendToActiveXTab({ action: "scrollStop" });
  $("localHint").textContent = response.text || "Stopped.";
  autoScrollRunning = false;
  deepFetchRunning = false;
  setLocalBusy(false);
});
$("reloadTabBtn").addEventListener("click", () => {
  if (!reloadTabId) {
    // No remembered tab id (e.g. the panel opened on a non-X tab): reload the
    // active one, which is what the user is looking at.
    chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => { if (tab?.id) chrome.tabs.reload(tab.id); });
    return;
  }
  chrome.tabs.reload(reloadTabId);
});
$("deepFetchRemote").addEventListener("change", pushScrollSettings);
$("showFetchButton").addEventListener("change", pushScrollSettings);

$("useCurrentBtn").addEventListener("click", () => chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => { $("targetInput").value = tab?.url || ""; }));
$("clearTargetBtn").addEventListener("click", () => { $("targetInput").value = ""; $("targetInput").focus(); });
$("discoverBtn").addEventListener("click", async () => {
  const target = $("targetInput").value.trim();
  if (!target) { $("discoveryHint").textContent = "Enter a profile URL or @username first."; $("discoveryHint").classList.add("error"); return; }
  const options = { target, limit: Math.min(99999, Math.max(1, Number($("discoveryLimit").value) || 99999)), includeRetweets: $("includeRetweets").checked, includeQuoted: $("includeQuoted").checked };
  await chrome.storage.local.set({ batchTarget: options.target, batchLimit: options.limit, includeRetweets: options.includeRetweets, includeQuoted: options.includeQuoted });
  discovery = await send({ action: "discoveryStart", ...options });
  render();
});
$("stopDiscoveryBtn").addEventListener("click", async () => { discovery = await send({ action: "discoveryStop" }); render(); });
chrome.runtime.onMessage.addListener((message) => { if (message.action === "queueChanged") refresh(); });
// A new page in the same tab, or switching tabs, should immediately re-sync the
// capture settings so a route change never leaves the content script stale.
chrome.tabs.onActivated.addListener(() => { pushScrollSettings(); pollLocalStatus(); });
chrome.tabs.onUpdated.addListener((_tabId, changeInfo) => {
  if (changeInfo.status === "complete" || changeInfo.url) { pushScrollSettings(); pollLocalStatus(); }
});
chrome.storage.local.get(["batchTarget", "batchLimit", "includeRetweets", "includeQuoted", "sidePanelActiveTab", "scrollMediaFilter", "scrollSpeed", "skipDownloaded", "scrollIncludeQuoted", "deepFetchRemote", "showFetchButton"], (saved) => {
  activeTab = saved.sidePanelActiveTab || "scroll";
  if (saved.batchTarget) $("targetInput").value = saved.batchTarget;
  if (saved.batchLimit) $("discoveryLimit").value = saved.batchLimit;
  if (saved.includeRetweets) $("includeRetweets").checked = true;
  // Quoted-media inclusion defaults to ON; stored false is the only way off.
  if (typeof saved.includeQuoted === "boolean") $("includeQuoted").checked = saved.includeQuoted;
  if (saved.scrollMediaFilter) $("localCaptureFilter").value = saved.scrollMediaFilter;
  if (saved.scrollSpeed) $("localScrollSpeed").value = saved.scrollSpeed;
  if (typeof saved.skipDownloaded === "boolean") $("skipDownloaded").checked = saved.skipDownloaded;
  if (typeof saved.scrollIncludeQuoted === "boolean") $("scrollIncludeQuoted").checked = saved.scrollIncludeQuoted;
  // Both default ON: the silent fill is what makes a profile complete without
  // endless scrolling, and the in-page button is the point of v3.7.
  if (typeof saved.deepFetchRemote === "boolean") $("deepFetchRemote").checked = saved.deepFetchRemote;
  if (typeof saved.showFetchButton === "boolean") $("showFetchButton").checked = saved.showFetchButton;
  render();
  pushScrollSettings();
  pollLocalStatus();
});
localStatusTimer = setInterval(pollLocalStatus, 1500);
refresh();

// ==========================================================================
// OUTPUT SETTINGS (v3.5) — master folder, per-post format, name template.
// This card is the extension's "options page": it is the ONLY writer of the
// chrome.storage.sync output settings. Downloading contexts receive the
// values through a settings bag read in background.js.
// ==========================================================================

const TEMPLATE_LABELS = {
  user: "@handle",
  name: "Display name",
  text: "Post text (first ~40 chars)",
  id: "Post ID",
  date: "Post date (YYYY-MM-DD)"
};

const PREVIEW_FIELDS = {
  user: "nasa",
  name: "NASA",
  text: "Sunrise over the Pacific, seen from the ISS",
  id: "1834567890123456789",
  date: "2026-09-01T09:15:00.000Z"
};

const outputSettingsState = { rawMasterFolder: XDLNaming.DEFAULT_RAW_MASTER_FOLDER, nameTemplate: XDLNaming.DEFAULT_NAME_TEMPLATE, outputFormat: "raw" };

function renderNamePreview() {
  const master = XDLNaming.normalizeRawMasterFolder(outputSettingsState.rawMasterFolder);
  const template = outputSettingsState.nameTemplate;
  const format = XDLNaming.normalizeOutputFormat(outputSettingsState.outputFormat);
  const base = XDLNaming.makePostBaseName(template, PREVIEW_FIELDS);
  let example;
  if (format === "raw") {
    example = master !== ""
      ? `Downloads/${master}/${base}/001.jpg`
      : `Downloads/x-media/nasa_Sunrise over the Pacific…_${PREVIEW_FIELDS.id}_1.jpg (old flat layout)`;
  } else {
    example = `Downloads/${XDLNaming.buildArchiveFilename({ nameTemplate: template }, PREVIEW_FIELDS, format)}`;
  }
  $("namePreview").textContent = `Example file name: ${example}`;
}

function saveNameTemplate(template) {
  outputSettingsState.nameTemplate = template;
  chrome.storage.sync.set({ nameTemplate: template });
  renderNamePreview();
}

function initNameTemplate(storedTemplate) {
  const checksBox = $("nameTemplateChecks");
  const advancedBox = $("nameTemplateAdvanced");
  const advancedInput = $("nameTemplateInput");

  if (!XDLNaming.isTokenOnlyTemplate(storedTemplate)) {
    // A hand-written template the checkboxes cannot represent: show the
    // manual input instead so nothing the user typed is lost.
    checksBox.style.display = "none";
    advancedBox.style.display = "";
    advancedInput.value = storedTemplate;
    advancedInput.addEventListener("change", () => {
      const value = advancedInput.value.trim();
      saveNameTemplate(value);
      if (XDLNaming.isTokenOnlyTemplate(value)) {
        // Cleared / reduced to plain tokens: switch back to checkbox mode.
        advancedBox.style.display = "none";
        checksBox.style.display = "";
        checksBox.textContent = "";
        buildTemplateChecks(value);
      }
    });
    renderNamePreview();
    return;
  }

  advancedBox.style.display = "none";
  buildTemplateChecks(storedTemplate);
  renderNamePreview();
}

function buildTemplateChecks(storedTemplate) {
  const checksBox = $("nameTemplateChecks");
  const inUse = XDLNaming.templateTokensInUse(storedTemplate);
  for (const token of XDLNaming.TEMPLATE_TOKENS) {
    const wrapper = document.createElement("label");
    wrapper.className = "check-label";
    const box = document.createElement("input");
    box.type = "checkbox";
    box.id = `template_${token}`;
    box.checked = !!inUse[token];
    wrapper.appendChild(box);
    wrapper.appendChild(document.createTextNode(` ${TEMPLATE_LABELS[token]}`));
    checksBox.appendChild(wrapper);
    box.addEventListener("change", () => {
      const checked = {};
      for (const t of XDLNaming.TEMPLATE_TOKENS) {
        checked[t] = !!document.getElementById(`template_${t}`)?.checked;
      }
      // Nothing checked = empty template; produced names then fall back to
      // the post id (never an empty file name).
      saveNameTemplate(XDLNaming.buildTemplate(checked));
    });
  }
}

chrome.storage.sync.get(
  { rawMasterFolder: XDLNaming.DEFAULT_RAW_MASTER_FOLDER, nameTemplate: XDLNaming.DEFAULT_NAME_TEMPLATE, outputFormat: "raw", gifOutput: "gif", archiveGifs: true, archiveVideos: false },
  (stored) => {
    outputSettingsState.rawMasterFolder = String(stored.rawMasterFolder);
    outputSettingsState.nameTemplate = String(stored.nameTemplate);
    outputSettingsState.outputFormat = XDLNaming.normalizeOutputFormat(stored.outputFormat);

    // Master folder: saved verbatim on change — the EMPTY string is
    // meaningful ("no master folder, old flat layout"), so this field must
    // not ride any generic "skip empty values" widget wiring.
    const masterInput = $("rawMasterFolder");
    masterInput.value = outputSettingsState.rawMasterFolder;
    masterInput.addEventListener("change", () => {
      outputSettingsState.rawMasterFolder = masterInput.value.trim();
      chrome.storage.sync.set({ rawMasterFolder: outputSettingsState.rawMasterFolder });
      renderNamePreview();
    });

    // GIF handling + archive-inclusion toggles (v3.6). Same contract as the
    // other output settings: written ONLY here, read by the background as a
    // plain settings bag.
    const gifOutputSelect = $("gifOutput");
    gifOutputSelect.value = stored.gifOutput === "mp4" ? "mp4" : "gif";
    gifOutputSelect.addEventListener("change", () => {
      chrome.storage.sync.set({ gifOutput: gifOutputSelect.value === "mp4" ? "mp4" : "gif" });
    });
    const archiveGifsBox = $("archiveGifs");
    archiveGifsBox.checked = stored.archiveGifs !== false;
    archiveGifsBox.addEventListener("change", () => {
      chrome.storage.sync.set({ archiveGifs: archiveGifsBox.checked });
    });
    const archiveVideosBox = $("archiveVideos");
    archiveVideosBox.checked = stored.archiveVideos === true;
    archiveVideosBox.addEventListener("change", () => {
      chrome.storage.sync.set({ archiveVideos: archiveVideosBox.checked });
    });

    // Stored default format (settings card) + per-job picker (dock). The
    // dock picker is seeded from the default but never writes it back.
    $("defaultFormat").value = outputSettingsState.outputFormat;
    $("jobFormat").value = outputSettingsState.outputFormat;
    $("defaultFormat").addEventListener("change", () => {
      outputSettingsState.outputFormat = XDLNaming.normalizeOutputFormat($("defaultFormat").value);
      chrome.storage.sync.set({ outputFormat: outputSettingsState.outputFormat });
      $("jobFormat").value = outputSettingsState.outputFormat;
      renderNamePreview();
    });

    initNameTemplate(outputSettingsState.nameTemplate);
  }
);
