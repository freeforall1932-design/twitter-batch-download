// Persistent batch queue interface for profile media discovery and downloads.
const $ = (id) => document.getElementById(id);
const queueEl = $("queue"), filterEl = $("mediaFilter"), selectAllEl = $("selectAll");
let state = { items: [], concurrency: 2, stopped: false };
let discovery = { running: false, pages: 0, found: 0, status: "Ready to discover media", error: null, errorCode: null, retryAfterMs: 0, retryUntil: 0 };
let countdownTimer = null;

function send(message) {
  return new Promise((resolve) => chrome.runtime.sendMessage(message, (response) => resolve(response || { ok: false, error: chrome.runtime.lastError?.message })));
}

function itemMatchesFilter(item) { return filterEl.value === "all" || item.type === filterEl.value; }
function visibleItems() { return state.items.filter(itemMatchesFilter); }
function selectedItems() { return state.items.filter((item) => item.selected); }
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
  return discovery.status || "Choose a profile, then discover its media into this queue.";
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

function render() {
  const items = visibleItems();
  const selected = selectedItems();
  const completed = state.items.filter((item) => item.status === "completed").length;
  $("discoveredCount").textContent = state.items.length;
  $("selectedCount").textContent = selected.length;
  $("completedCount").textContent = completed;
  $("downloadSelectedBtn").disabled = selected.length === 0;
  $("downloadAllBtn").disabled = state.items.length === 0;
  $("stopBtn").disabled = !state.running;
  $("discoverBtn").disabled = discovery.running;
  $("stopDiscoveryBtn").disabled = !discovery.running;
  renderDiscoveryHint();
  ensureCountdownTimer();
  $("engineStatus").textContent = state.running ? "Downloading" : state.stopped ? "Paused" : "Ready";
  $("engineStatus").className = "status-pill " + (state.running ? "running" : "idle");
  selectAllEl.checked = items.length > 0 && items.every((item) => item.selected);
  selectAllEl.indeterminate = items.some((item) => item.selected) && !selectAllEl.checked;
  if (!items.length) {
    queueEl.innerHTML = `<div class="empty-state"><div class="empty-icon">↓</div><h2>Your queue is empty</h2><p>Discovered media will appear here newest first. Tick exactly what you want, or use Download all.</p></div>`;
    return;
  }
  queueEl.innerHTML = items.map((item) => {
    const thumbnail = item.thumbnail ? `<img src="${escapeHtml(item.thumbnail)}" alt="">` : `<div class="thumb-placeholder">${item.type === "video" ? "▶" : "▧"}</div>`;
    const progress = item.status === "downloading" && item.totalBytes > 0 ? ` ${Math.round((item.bytesReceived || 0) * 100 / item.totalBytes)}%` : "";
    const retry = item.status === "failed" ? ` (${item.attempts || 0}/3)` : "";
    const repost = item.isRepost ? `<span class="type-badge repost">repost</span>` : "";
    return `<article class="queue-item"><input class="item-select" data-id="${item.id}" type="checkbox" ${item.selected ? "checked" : ""} aria-label="Select media"><div>${thumbnail}</div><div class="item-info"><div class="item-title">${escapeHtml(item.author || "X post")}</div><div class="item-meta">${escapeHtml(item.date || "Recently discovered")}</div><span class="type-badge">${escapeHtml(item.type || "media")}</span>${repost}</div><span class="item-status ${escapeHtml(item.status || "discovered")}" title="${escapeHtml(item.error || "")}">${escapeHtml(item.status || "discovered")}${progress}${retry}</span></article>`;
  }).join("");
}

async function refresh() { [state, discovery] = await Promise.all([send({ action: "queueGet" }), send({ action: "discoveryGet" })]); render(); }
async function updateSelection(id, selected) { state = await send({ action: "queueSelect", id, selected }); render(); }

queueEl.addEventListener("change", (event) => { if (event.target.matches(".item-select")) updateSelection(event.target.dataset.id, event.target.checked); });
selectAllEl.addEventListener("change", async () => { state = await send({ action: "queueSelectVisible", filter: filterEl.value, selected: selectAllEl.checked }); render(); });
filterEl.addEventListener("change", render);
$("retryFailedBtn").addEventListener("click", async () => { state = await send({ action: "queueRetryFailed" }); render(); });
$("clearFinishedBtn").addEventListener("click", async () => { state = await send({ action: "queueClearFinished" }); render(); });
$("downloadSelectedBtn").addEventListener("click", async () => { state = await send({ action: "queueStart", mode: "selected" }); render(); });
$("downloadAllBtn").addEventListener("click", async () => { state = await send({ action: "queueStart", mode: "all" }); render(); });
$("stopBtn").addEventListener("click", async () => { state = await send({ action: "queueStop" }); render(); });

document.querySelectorAll("[data-concurrency]").forEach((button) => button.addEventListener("click", async () => {
  state = await send({ action: "queueSetConcurrency", concurrency: Number(button.dataset.concurrency) });
  document.querySelectorAll("[data-concurrency]").forEach((candidate) => candidate.classList.toggle("selected", candidate === button));
  render();
}));
$("useCurrentBtn").addEventListener("click", () => chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => { $("targetInput").value = tab?.url || ""; }));
$("discoverBtn").addEventListener("click", async () => {
  const target = $("targetInput").value.trim();
  if (!target) { $("discoveryHint").textContent = "Enter a profile URL or @username first."; $("discoveryHint").classList.add("error"); return; }
  const options = { target, limit: Math.min(99999, Math.max(1, Number($("discoveryLimit").value) || 99999)), includeRetweets: $("includeRetweets").checked };
  await chrome.storage.local.set({ batchTarget: options.target, batchLimit: options.limit, includeRetweets: options.includeRetweets });
  discovery = await send({ action: "discoveryStart", ...options });
  render();
});
$("stopDiscoveryBtn").addEventListener("click", async () => { discovery = await send({ action: "discoveryStop" }); render(); });
chrome.runtime.onMessage.addListener((message) => { if (message.action === "queueChanged") refresh(); });
chrome.storage.local.get(["batchTarget", "batchLimit", "includeRetweets"], (saved) => {
  if (saved.batchTarget) $("targetInput").value = saved.batchTarget;
  if (saved.batchLimit) $("discoveryLimit").value = saved.batchLimit;
  if (saved.includeRetweets) $("includeRetweets").checked = true;
});
refresh();
