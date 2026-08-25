// ==========================================================================
// background.js — Service Worker for X Media Downloader
// Handles: auth, GraphQL API, media extraction, downloads, ZIP packaging
// ==========================================================================

// Import the minimal ZIP writer
importScripts("lib/zip-writer.js");

// --- Auth cache ---
let bearerToken = null;
let csrfToken = null;
let cookieStr = null;
let envTimestamp = 0;

// --- Known Twitter Bearer token (public app-level, embedded in X's JS) ---
const KNOWN_BEARER = "AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA";

// --- GraphQL endpoint from yt-dlp (current as of 2025) ---
const GRAPHQL_QUERY_ID = "2ICDjqPd81tulZcYrtpTuQ";
const GRAPHQL_ENDPOINT = "TweetResultByRestId";

// --- Rate limit tracking ---
let lastRequestTime = 0;
let rateLimitHits = 0;
const MIN_REQUEST_INTERVAL = 800; // ms between requests to avoid rate limiting

// --- Community discovery cap ---
// This extension is self-hosted against the signed-in X session only. There is
// no third-party tier service, so the scan cap is intentionally high and
// community-owned rather than limited by a paid/free subscription.
const DEFAULT_DISCOVERY_LIMIT = 99999;
const MAX_DISCOVERY_LIMIT = 99999;

function normalizeDiscoveryLimit(value) {
  if (value === null || value === undefined || value === "") return DEFAULT_DISCOVERY_LIMIT;
  const number = Math.floor(Number(value));
  if (!Number.isFinite(number)) return DEFAULT_DISCOVERY_LIMIT;
  return Math.min(MAX_DISCOVERY_LIMIT, Math.max(1, number));
}

// --- Download queue for ZIP batching ---
const zipBuffers = new Map(); // bulkId → [{data, filename}]

// ==========================================================================
// AUTH — Extract Bearer token from X's JS bundle + read CSRF cookie
// ==========================================================================

async function refreshAuth(tabId) {
  // Always refresh CSRF token (short-lived)
  csrfToken = await getCookie("ct0");
  cookieStr = await getAllCookies();

  // Re-use cached bearer if still fresh
  if (bearerToken && Date.now() - envTimestamp < 60 * 60 * 1000) {
    return { ok: true };
  }

  console.log("[X-DL BG] Extracting Bearer token...");

  // Try extracting from page scripts if we have a tabId
  if (tabId) {
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          return Array.from(document.querySelectorAll('script[src]'))
            .map(s => s.src)
            .filter(s => s.includes('.js'));
        }
      });
      const scriptUrls = results?.[0]?.result || [];
      const mainUrl = scriptUrls.find(u => /main\.[a-f0-9]+/.test(u));

      if (mainUrl) {
        const resp = await fetch(mainUrl);
        const text = await resp.text();
        const patterns = [
          /"Bearer (AAAAAAA[a-zA-Z0-9%_-]+)"/,
          /Bearer (AAAAAAA[a-zA-Z0-9%_-]+)/
        ];
        for (const pat of patterns) {
          const m = text.match(pat);
          if (m) {
            bearerToken = m[1];
            console.log("[X-DL BG] Extracted Bearer from page JS");
            envTimestamp = Date.now();
            return { ok: true };
          }
        }
      }
    } catch (e) {
      console.warn("[X-DL BG] Could not extract from page:", e.message);
    }
  }

  // Fallback to known public bearer token
  bearerToken = KNOWN_BEARER;
  console.log("[X-DL BG] Using known Bearer token");
  envTimestamp = Date.now();
  return { ok: true };
}

function getCookie(name) {
  return new Promise((resolve) => {
    chrome.cookies.get({ url: "https://x.com", name }, (c) => {
      if (c) return resolve(c.value);
      chrome.cookies.get({ url: "https://twitter.com", name }, (c2) => {
        resolve(c2?.value || null);
      });
    });
  });
}

function getAllCookies() {
  return new Promise((resolve) => {
    chrome.cookies.getAll({ url: "https://x.com" }, (cookies) => {
      const str = (cookies || []).map(c => `${c.name}=${c.value}`).join("; ");
      resolve(str);
    });
  });
}

function makeHeaders() {
  return {
    "authorization": "Bearer " + bearerToken,
    "x-csrf-token": csrfToken,
    "x-twitter-auth-type": "OAuth2Session",
    "x-twitter-active-user": "yes",
    "x-twitter-client-language": "en",
    "cookie": cookieStr
  };
}

// ==========================================================================
// RATE LIMITING — Exponential backoff with jitter
// ==========================================================================

async function rateLimitWait() {
  const now = Date.now();
  const elapsed = now - lastRequestTime;

  // Base delay increases with consecutive rate limit hits
  const baseDelay = MIN_REQUEST_INTERVAL + (rateLimitHits * 2000);
  const maxDelay = Math.min(baseDelay, 30000);

  if (elapsed < maxDelay) {
    const jitter = Math.random() * 300;
    const waitTime = maxDelay - elapsed + jitter;
    console.log(`[X-DL BG] Rate limit wait: ${Math.round(waitTime)}ms`);
    await new Promise(r => setTimeout(r, waitTime));
  }

  lastRequestTime = Date.now();
}

async function fetchWithRetry(url, headers, maxRetries = 4) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    await rateLimitWait();

    const resp = await fetch(url, { headers });

    if (resp.status === 429 || resp.status === 503) {
      rateLimitHits++;
      const retryAfter = resp.headers.get("retry-after");
      const waitTime = retryAfter
        ? parseInt(retryAfter) * 1000
        : Math.min(2000 * Math.pow(2, attempt) + Math.random() * 1000, 60000);

      console.log(`[X-DL BG] Rate limited (${resp.status}), attempt ${attempt + 1}/${maxRetries + 1}, waiting ${Math.round(waitTime / 1000)}s`);
      await new Promise(r => setTimeout(r, waitTime));

      // Refresh auth in case CSRF expired
      await refreshAuth(null);
      continue;
    }

    // Reset rate limit counter on success
    if (resp.ok) {
      rateLimitHits = Math.max(0, rateLimitHits - 1);
    }

    return resp;
  }

  // All retries exhausted
  return null;
}

// ==========================================================================
// GRAPHQL API — TweetResultByRestId (primary method)
// ==========================================================================

async function getTweetMedia(tweetId) {
  const variables = {
    tweetId: tweetId,
    withCommunity: false,
    includePromotedContent: false,
    withVoice: false
  };

  const features = {
    creator_subscriptions_tweet_preview_api_enabled: true,
    tweetypie_unmention_optimization_enabled: true,
    responsive_web_edit_tweet_api_enabled: true,
    graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
    view_counts_everywhere_api_enabled: true,
    longform_notetweets_consumption_enabled: true,
    responsive_web_twitter_article_tweet_consumption_enabled: false,
    tweet_awards_web_tipping_enabled: false,
    freedom_of_speech_not_reach_fetch_enabled: true,
    standardized_nudges_misinfo: true,
    tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
    longform_notetweets_rich_text_read_enabled: true,
    longform_notetweets_inline_media_enabled: true,
    responsive_web_graphql_exclude_directive_enabled: true,
    verified_phone_label_enabled: false,
    responsive_web_media_download_video_enabled: false,
    responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
    responsive_web_graphql_timeline_navigation_enabled: true,
    responsive_web_enhance_cards_enabled: false
  };

  const fieldToggles = {
    withArticleRichContentState: false
  };

  const params = new URLSearchParams({
    variables: JSON.stringify(variables),
    features: JSON.stringify(features),
    fieldToggles: JSON.stringify(fieldToggles)
  });

  const url = `https://x.com/i/api/graphql/${GRAPHQL_QUERY_ID}/${GRAPHQL_ENDPOINT}?${params}`;

  console.log("[X-DL BG] GraphQL request for tweet:", tweetId);

  const resp = await fetchWithRetry(url, makeHeaders());
  if (!resp) {
    return { error: "All retries exhausted (rate limited)" };
  }

  if (resp.status === 403) {
    return { error: "protected_or_deleted" };
  }

  if (resp.status === 401 || resp.status === 400) {
    // Auth issue — try refreshing once
    await refreshAuth(null);
    return { error: `Auth error (${resp.status})` };
  }

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    console.error("[X-DL BG] GraphQL error:", resp.status, text.substring(0, 200));
    return { error: `API ${resp.status}: ${text.substring(0, 100)}` };
  }

  let json;
  try {
    json = await resp.json();
  } catch (e) {
    return { error: "Invalid JSON response" };
  }

  // Check for API-level errors
  if (json.errors) {
    const errMsg = json.errors.map(e => e.message).join(", ");
    if (errMsg.toLowerCase().includes("not authorized") || errMsg.toLowerCase().includes("could not find")) {
      return { error: "protected_or_deleted" };
    }
    console.error("[X-DL BG] GraphQL errors:", errMsg);
    return { error: errMsg };
  }

  // Parse the result
  const result = json?.data?.tweetResult?.result;
  if (!result) {
    return { error: "No tweet result in response" };
  }

  // Handle TweetWithVisibilityResults — drill into .tweet
  const tweet = result.__typename === "TweetWithVisibilityResults"
    ? result.tweet
    : result;

  if (!tweet || tweet.__typename === "TweetTombstone") {
    return { error: "protected_or_deleted" };
  }

  if (tweet.__typename === "TweetUnavailable") {
    const reason = tweet.reason || "unavailable";
    if (reason === "Protected") return { error: "protected_or_deleted" };
    if (reason === "NsfwLoggedOut") return { error: "nsfw_login_required" };
    return { error: `unavailable: ${reason}` };
  }

  // Extract media from legacy.extended_entities
  const legacy = tweet.legacy || {};
  const mediaItems = legacy.extended_entities?.media || [];

  // Extract user info
  const user = tweet.core?.user_results?.result?.legacy || {};
  const username = user.screen_name || "unknown";
  const tweetText = legacy.full_text || legacy.text || "";

  // Extract all media (videos + photos)
  const videos = [];
  const photos = [];

  for (const m of mediaItems) {
    if (m.type === "video" || m.type === "animated_gif") {
      const variants = m.video_info?.variants || [];
      let bestUrl = null;
      let bestBitrate = -1;
      for (const v of variants) {
        if (v.content_type === "video/mp4") {
          const br = v.bitrate || 0;
          if (br > bestBitrate) {
            bestBitrate = br;
            bestUrl = v.url;
          }
        }
      }
      if (bestUrl) {
        videos.push({
          url: bestUrl,
          bitrate: bestBitrate,
          mediaId: m.id_str || m.id,
          type: m.type
        });
      }
    } else if (m.type === "photo") {
      // Use original resolution
      let photoUrl = m.media_url_https || m.media_url || "";
      // Append ?name=orig for highest resolution
      if (photoUrl && !photoUrl.includes("name=")) {
        photoUrl += "?name=orig";
      }
      if (photoUrl) {
        photos.push({
          url: photoUrl,
          mediaId: m.id_str || m.id,
          type: "photo"
        });
      }
    }
  }

  console.log(`[X-DL BG] Found ${videos.length} videos, ${photos.length} photos for tweet ${tweetId}`);

  return {
    videos,
    photos,
    username,
    tweetText,
    tweetId
  };
}

// ==========================================================================
// DOWNLOAD — Save media file via chrome.downloads
// ==========================================================================

function downloadFile(url, filename) {
  return new Promise((resolve) => {
    chrome.downloads.download(
      { url, filename, conflictAction: "uniquify" },
      (downloadId) => {
        if (chrome.runtime.lastError) {
          console.error("[X-DL BG] Download error:", chrome.runtime.lastError.message);
          resolve({ success: false, error: chrome.runtime.lastError.message });
        } else {
          console.log("[X-DL BG] Download started:", filename, "id:", downloadId);
          resolve({ success: true, downloadId });
        }
      }
    );
  });
}

// ==========================================================================
// PERSISTENT DOWNLOAD QUEUE — schedules only after prior downloads finish
// ==========================================================================
const QUEUE_STORAGE_KEY = "batchDownloadQueueV1";
const QUEUE_DEFAULT = { items: [], concurrency: 2, running: false, stopped: false };
const MAX_DOWNLOAD_ATTEMPTS = 3;
let queueState = null;
let queueSaving = Promise.resolve();
let queueProcessing = Promise.resolve();

function searchDownloads(query) {
  // chrome.downloads.search() supports a promise in current MV3 builds and a
  // callback in older builds. Support both so reconciliation works in either.
  return new Promise((resolve) => {
    let settled = false;
    const done = (results) => {
      if (settled) return;
      settled = true;
      resolve(results || []);
    };
    try {
      const result = chrome.downloads.search(query, done);
      if (result && typeof result.then === "function") {
        result.then(done).catch(() => done([]));
      }
    } catch (error) {
      console.error("[X-DL BG] Unable to inspect downloads", error);
      done([]);
    }
  });
}

async function reconcileQueueAfterRestart(state) {
  let changed = false;
  const items = [];
  for (const item of state.items) {
    const normalized = { attempts: 0, bytesReceived: 0, totalBytes: 0, ...item };

    if (normalized.status === "starting") {
      // A worker stopped while chrome.downloads.download() was in flight. No
      // download id was persisted, so the attempt cannot be verified. Return the
      // item to the queue instead of leaving it stranded forever.
      normalized.status = "queued";
      normalized.downloadId = null;
      changed = true;
      items.push(normalized);
      continue;
    }

    if (normalized.status === "downloading" && normalized.downloadId) {
      const matches = await searchDownloads({ id: normalized.downloadId });
      const download = matches.find((match) => match.id === normalized.downloadId);
      if (!download) {
        // No trackable Chrome download exists anymore. Do not reserve a slot
        // for a ghost download; recover it so the queue can continue.
        normalized.status = "queued";
        normalized.downloadId = null;
        changed = true;
        items.push(normalized);
        continue;
      }

      const nextBytes = typeof download.bytesReceived === "number" ? (download.bytesReceived || 0) : normalized.bytesReceived;
      const nextTotal = typeof download.totalBytes === "number" ? (download.totalBytes || 0) : normalized.totalBytes;
      if (nextBytes !== normalized.bytesReceived || nextTotal !== normalized.totalBytes) changed = true;
      normalized.bytesReceived = nextBytes;
      normalized.totalBytes = nextTotal;

      if (download.state === "complete") {
        normalized.status = "completed";
        normalized.downloadId = null;
        normalized.error = null;
        normalized.bytesReceived = normalized.totalBytes || normalized.bytesReceived;
        changed = true;
      } else if (download.state === "interrupted") {
        normalized.downloadId = null;
        if ((normalized.attempts || 0) < MAX_DOWNLOAD_ATTEMPTS && !state.stopped) {
          normalized.status = "queued";
          normalized.error = `${download.error || "Download interrupted"}; retrying (${(normalized.attempts || 0) + 1}/${MAX_DOWNLOAD_ATTEMPTS})`;
        } else {
          normalized.status = "failed";
          normalized.error = download.error || "Download interrupted";
        }
        changed = true;
      } else {
        // in_progress downloads keep their reserved slot so a restart cannot
        // start a second copy of the same URL.
        normalized.status = "downloading";
      }
      items.push(normalized);
      continue;
    }

    if (normalized.status === "downloading") {
      // Persisted as downloading without a download id: impossible to verify.
      normalized.status = "queued";
      normalized.downloadId = null;
      changed = true;
    }
    items.push(normalized);
  }

  state.items = items;
  if (changed) await saveQueueState();
  return changed;
}

async function getQueueState() {
  if (queueState) return queueState;
  const stored = await chrome.storage.local.get(QUEUE_STORAGE_KEY);
  queueState = { ...QUEUE_DEFAULT, ...(stored[QUEUE_STORAGE_KEY] || {}) };
  queueState.concurrency = queueState.concurrency === 1 ? 1 : 2;
  // Service workers can stop while Chrome downloads continue (or before a
  // download id is persisted). Reconcile stale states before scheduling again.
  await reconcileQueueAfterRestart(queueState);
  return queueState;
}

async function saveQueueState() {
  if (!queueState) return;
  queueSaving = queueSaving.then(() => chrome.storage.local.set({ [QUEUE_STORAGE_KEY]: queueState }));
  await queueSaving;
  chrome.runtime.sendMessage({ action: "queueChanged" }).catch(() => {});
}

function publicQueueState() {
  return queueState || { ...QUEUE_DEFAULT };
}

async function runQueuePass() {
  const state = await getQueueState();
  if (!state.running || state.stopped) return;
  const active = state.items.filter((item) => ["starting", "downloading"].includes(item.status)).length;
  const slots = Math.max(0, state.concurrency - active);
  const nextItems = state.items.filter((item) => item.status === "queued").slice(0, slots);
  for (const item of nextItems) {
    item.status = "starting";
    item.attempts = (item.attempts || 0) + 1;
    await saveQueueState();
    const result = await downloadFile(item.url, item.filename);
    if (result.success) {
      item.status = "downloading";
      item.downloadId = result.downloadId;
    } else if ((item.attempts || 0) < MAX_DOWNLOAD_ATTEMPTS && !state.stopped) {
      item.status = "queued";
      item.error = `${result.error || "Could not start download"}; retrying (${(item.attempts || 0) + 1}/${MAX_DOWNLOAD_ATTEMPTS})`;
      setTimeout(() => processQueue(), 1000 * (item.attempts || 1));
    } else {
      item.status = "failed";
      item.error = result.error || "Could not start download";
    }
    await saveQueueState();
  }
  if (!state.items.some((item) => ["queued", "starting", "downloading"].includes(item.status))) {
    state.running = false;
    await saveQueueState();
  }
}

function processQueue() {
  // Runtime messages, retry timers, and multiple terminal download events can
  // request scheduling at the same time. Chain passes so slot calculations and
  // starting-state reservations cannot overlap.
  queueProcessing = queueProcessing
    .then(() => runQueuePass())
    .catch((error) => console.error("[X-DL BG] Queue processing error", error));
  return queueProcessing;
}

async function resumeQueueAfterRestart() {
  // Reconcile persisted download/starting states first, then resume only if the
  // queue was still running and has work to do. processQueue() itself returns
  // immediately when running is false or stopped is true.
  await getQueueState();
  return processQueue();
}

if (chrome.runtime.onStartup) {
  chrome.runtime.onStartup.addListener(() => {
    resumeQueueAfterRestart().catch((error) => console.error("[X-DL BG] Queue resume error", error));
  });
}
if (chrome.runtime.onInstalled) {
  chrome.runtime.onInstalled.addListener(() => {
    resumeQueueAfterRestart().catch((error) => console.error("[X-DL BG] Queue resume error", error));
  });
}

chrome.downloads.onChanged.addListener(async (delta) => {
  const state = await getQueueState();
  const item = state.items.find((candidate) => candidate.downloadId === delta.id);
  if (!item) return;
  if (delta.bytesReceived) item.bytesReceived = delta.bytesReceived.current || 0;
  if (delta.totalBytes) item.totalBytes = delta.totalBytes.current || 0;
  if (!delta.state || !["complete", "interrupted"].includes(delta.state.current)) {
    await saveQueueState();
    return;
  }
  item.downloadId = null;
  if (delta.state.current === "complete") {
    item.status = "completed";
    item.error = null;
    item.bytesReceived = item.totalBytes || item.bytesReceived;
  } else if ((item.attempts || 0) < MAX_DOWNLOAD_ATTEMPTS && !state.stopped) {
    // Keep the queue at its configured 1–2 active items; retry occupies a new
    // slot only after Chrome has confirmed the old attempt has ended.
    item.status = "queued";
    item.error = `${delta.error?.current || "Download interrupted"}; retrying (${(item.attempts || 0) + 1}/${MAX_DOWNLOAD_ATTEMPTS})`;
  } else {
    item.status = "failed";
    item.error = delta.error?.current || "Download interrupted";
  }
  await saveQueueState();
  // This is deliberately called only after Chrome reports a finished/interrupted download.
  processQueue();
});

function mergeQueueItems(state, candidates, orderedFrontIds = null) {
  const knownIds = new Set(state.items.map((item) => item.id));
  const additions = [];
  for (const candidate of candidates || []) {
    if (!candidate?.id || !candidate.url || knownIds.has(candidate.id)) continue;
    knownIds.add(candidate.id);
    additions.push({ ...candidate, selected: false, status: "discovered", downloadId: null, attempts: 0, bytesReceived: 0, totalBytes: 0 });
  }

  if (!orderedFrontIds) {
    state.items.unshift(...additions);
    return additions.length;
  }

  // A profile scan receives pages newest-first. Rebuild the scanned portion in
  // that same order, including records that were already present in the queue.
  state.items.push(...additions);
  const itemById = new Map();
  for (const item of state.items) {
    if (!itemById.has(item.id)) itemById.set(item.id, item);
  }
  const orderedIds = [];
  const orderedIdSet = new Set();
  for (const id of orderedFrontIds) {
    if (!orderedIdSet.has(id) && itemById.has(id)) {
      orderedIdSet.add(id);
      orderedIds.push(id);
    }
  }
  const orderedItems = orderedIds.map((id) => itemById.get(id));
  const remainingItems = state.items.filter((item) => !orderedIdSet.has(item.id));
  state.items = [...orderedItems, ...remainingItems];
  return additions.length;
}

async function addQueueItems(items, options = {}) {
  const state = await getQueueState();
  const addedCount = mergeQueueItems(state, items, options.orderedFrontIds || null);
  await saveQueueState();
  return { state: publicQueueState(), addedCount };
}

async function handleQueueMessage(msg) {
  if (msg.action === "queueAdd") {
    return (await addQueueItems(msg.items)).state;
  }
  const state = await getQueueState();
  if (msg.action === "queueGet") return publicQueueState();
  if (msg.action === "queueSetConcurrency") {
    state.concurrency = msg.concurrency === 1 ? 1 : 2;
  } else if (msg.action === "queueSelect") {
    const item = state.items.find((candidate) => candidate.id === msg.id);
    if (item) item.selected = Boolean(msg.selected);
  } else if (msg.action === "queueSelectVisible") {
    state.items.filter((item) => msg.filter === "all" || item.type === msg.filter)
      .forEach((item) => { item.selected = Boolean(msg.selected); });
  } else if (msg.action === "queueClearFinished") {
    state.items = state.items.filter((item) => !["completed", "failed"].includes(item.status));
  } else if (msg.action === "queueRetryFailed") {
    state.items.filter((item) => item.status === "failed").forEach((item) => {
      item.status = "queued"; item.error = null; item.attempts = 0; item.bytesReceived = 0; item.totalBytes = 0;
    });
    state.stopped = false; state.running = true;
  } else if (msg.action === "queueStart") {
    state.items.forEach((item) => {
      const allowed = msg.mode === "all" || item.selected;
      if (allowed && ["discovered", "failed"].includes(item.status)) item.status = "queued";
    });
    state.stopped = false;
    state.running = true;
  } else if (msg.action === "queueStop") {
    state.stopped = true;
    state.running = false;
    state.items.forEach((item) => { if (item.status === "queued") item.status = "discovered"; });
  } else {
    return null;
  }
  await saveQueueState();
  if (["queueStart", "queueSetConcurrency", "queueRetryFailed"].includes(msg.action)) processQueue();
  return publicQueueState();
}


// ==========================================================================
// PROFILE MEDIA DISCOVERY — current X operation IDs are read from its JS
// ==========================================================================
const DISCOVERY_STORAGE_KEY = "profileDiscoveryV1";
const DEFAULT_DISCOVERY = { running: false, stopRequested: false, pages: 0, found: 0, status: "Ready to discover media", error: null, target: "", activeRunId: null };
let discoveryState = null;
let discoveryStateLoading = null;
let discoverySaving = Promise.resolve();
let discoveryRunSerial = 0;

async function getDiscoveryState() {
  if (discoveryState) return discoveryState;
  if (!discoveryStateLoading) {
    discoveryStateLoading = (async () => {
      const stored = await chrome.storage.local.get(DISCOVERY_STORAGE_KEY);
      discoveryState = { ...DEFAULT_DISCOVERY, ...(stored[DISCOVERY_STORAGE_KEY] || {}) };
      // A worker cannot safely resume an unknown in-flight request after suspension.
      if (discoveryState.running) discoveryState = { ...discoveryState, running: false, stopRequested: true, activeRunId: null, status: "Discovery paused when the extension restarted." };
      return discoveryState;
    })();
  }
  try {
    return await discoveryStateLoading;
  } catch (error) {
    discoveryStateLoading = null;
    throw error;
  }
}

async function saveDiscoveryState() {
  const snapshot = { ...discoveryState };
  discoverySaving = discoverySaving.then(() => chrome.storage.local.set({ [DISCOVERY_STORAGE_KEY]: snapshot }));
  await discoverySaving;
  chrome.runtime.sendMessage({ action: "queueChanged" }).catch(() => {});
}

async function findXTab() {
  const tabs = await chrome.tabs.query({});
  return tabs.find((tab) => /^https:\/\/(x|twitter)\.com\//.test(tab.url || "")) || null;
}

function normalizeProfileTarget(rawTarget) {
  const raw = String(rawTarget || "").trim();
  if (!raw) throw new Error("Enter an X profile URL or @username.");
  const candidate = raw.startsWith("@") ? raw.slice(1) : raw;
  if (/^[A-Za-z0-9_]{1,15}$/.test(candidate)) return candidate;
  let url;
  try { url = new URL(/^https?:\/\//.test(candidate) ? candidate : `https://${candidate}`); } catch (_) { throw new Error("Use @username or an x.com profile URL."); }
  if (!/(^|\.)((x)|(twitter))\.com$/i.test(url.hostname)) throw new Error("The target must be an x.com or twitter.com profile URL.");
  const name = url.pathname.split("/").filter(Boolean)[0] || "";
  if (!/^[A-Za-z0-9_]{1,15}$/.test(name) || ["i", "home", "search", "explore", "settings", "messages", "notifications"].includes(name.toLowerCase())) {
    throw new Error("That URL is not an X profile.");
  }
  return name;
}

async function getOperationIds(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => Array.from(document.scripts).map((script) => script.src).filter((src) => /\.js(?:\?|$)/.test(src))
  });
  const urls = results?.[0]?.result || [];
  const ids = {};
  const operationNames = ["UserByScreenName", "UserMedia"];
  // Query IDs change often. Read the bundle belonging to the currently open X UI
  // instead of treating a copied ID as a durable API contract.
  for (const url of urls.slice(0, 80)) {
    if (Object.keys(ids).length === operationNames.length) break;
    try {
      const source = await (await fetch(url)).text();
      for (const name of operationNames) {
        if (ids[name] || !source.includes(name)) continue;
        const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const patterns = [
          new RegExp(`queryId[:=]\\s*["']([A-Za-z0-9_-]{8,})["'][\\s\\S]{0,500}?operationName[:=]\\s*["']${escaped}["']`),
          new RegExp(`operationName[:=]\\s*["']${escaped}["'][\\s\\S]{0,500}?queryId[:=]\\s*["']([A-Za-z0-9_-]{8,})["']`),
          new RegExp(`["']([A-Za-z0-9_-]{8,})["'][\\s\\S]{0,120}?["']${escaped}["']`),
          new RegExp(`["']${escaped}["'][\\s\\S]{0,120}?["']([A-Za-z0-9_-]{8,})["']`)
        ];
        for (const pattern of patterns) {
          const match = source.match(pattern);
          if (match?.[1]) { ids[name] = match[1]; break; }
        }
      }
    } catch (_) { /* An optional bundle may be unavailable; inspect the next one. */ }
  }
  const missing = operationNames.filter((name) => !ids[name]);
  if (missing.length) throw new Error(`Could not find current X operation metadata: ${missing.join(", ")}. Open the target's X profile once, refresh it, then retry.`);
  return ids;
}

function discoveryFeatures() {
  return {
    creator_subscriptions_tweet_preview_api_enabled: true,
    tweetypie_unmention_optimization_enabled: true,
    responsive_web_edit_tweet_api_enabled: true,
    graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
    view_counts_everywhere_api_enabled: true,
    longform_notetweets_consumption_enabled: true,
    longform_notetweets_rich_text_read_enabled: true,
    longform_notetweets_inline_media_enabled: true,
    responsive_web_graphql_exclude_directive_enabled: true,
    responsive_web_graphql_timeline_navigation_enabled: true,
    responsive_web_enhance_cards_enabled: false
  };
}

async function callDiscoveryGraphQL(operationId, operationName, variables) {
  const params = new URLSearchParams({ variables: JSON.stringify(variables), features: JSON.stringify(discoveryFeatures()) });
  const response = await fetchWithRetry(`https://x.com/i/api/graphql/${operationId}/${operationName}?${params}`, makeHeaders());
  if (!response) throw new Error("X rate limit retries were exhausted.");
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(response.status === 401 ? "Your X session has expired. Sign in to X and retry." : response.status === 403 ? "This profile is protected or unavailable to your account." : `X returned ${response.status}: ${body.slice(0, 120)}`);
  }
  const json = await response.json();
  if (json.errors?.length) throw new Error(json.errors.map((entry) => entry.message).join(", "));
  return json;
}

function unwrapTweet(result) {
  if (!result || typeof result !== "object") return null;
  if (result.__typename === "TweetWithVisibilityResults") return result.tweet || null;
  return result.__typename === "Tweet" ? result : null;
}

function collectTweets(value, output, seen = new Set(), parentKey = "") {
  if (!value || typeof value !== "object") return;
  // Reposted media is resolved from its parent post below. Quoted results are
  // deliberately excluded until an explicit Include quoted media option exists.
  if (parentKey === "quoted_status_result" || parentKey === "retweeted_status_result") return;
  const tweet = unwrapTweet(value);
  if (tweet?.rest_id && !seen.has(tweet.rest_id)) { seen.add(tweet.rest_id); output.push(tweet); }
  if (Array.isArray(value)) value.forEach((entry) => collectTweets(entry, output, seen, parentKey));
  else Object.entries(value).forEach(([key, entry]) => collectTweets(entry, output, seen, key));
}

function findBottomCursor(value) {
  if (!value || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (const entry of value) { const cursor = findBottomCursor(entry); if (cursor) return cursor; }
    return null;
  }
  const entryId = value.entryId || value.entry_id || "";
  const cursorType = value.content?.cursorType || value.cursorType || "";
  if ((String(entryId).includes("cursor-bottom") || cursorType === "Bottom") && value.content?.value) return value.content.value;
  for (const child of Object.values(value)) { const cursor = findBottomCursor(child); if (cursor) return cursor; }
  return null;
}

function sanitizeFilePart(value, fallback) {
  const cleaned = String(value || "")
    .replace(/https?:\/\/\S+/g, "")
    // Chrome disallows more common Windows path characters in filenames.
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/g, "");
  return cleaned.slice(0, 64) || fallback;
}

function makeMediaFilename({ username, text, tweetId, mediaId, index, extension }) {
  // Name downloads by the username and text from the post instead of bundling
  // them into one large ZIP archive (which can balloon to several GB).
  const user = sanitizeFilePart(username, "unknown");
  const snippet = sanitizeFilePart(text, "media");
  const ids = String(tweetId || mediaId || "").slice(0, 24).replace(/[^a-zA-Z0-9_-]/g, "") || "";
  const number = Number.isFinite(Number(index)) ? Number(index) + 1 : 1;
  const key = [user, snippet, ids, number].filter(Boolean).join("_");
  return `x-media/${key}.${extension}`;
}

function mediaFromTweet(tweet, targetHandle, includeRetweets) {
  const legacy = tweet.legacy || {};
  const isRepost = Boolean(legacy.retweeted_status_result?.result || tweet.retweeted_status_result?.result);
  if (isRepost && !includeRetweets) return [];
  const source = unwrapTweet(legacy.retweeted_status_result?.result || tweet.retweeted_status_result?.result) || tweet;
  const sourceLegacy = source.legacy || {};
  const author = source.core?.user_results?.result?.legacy?.screen_name || tweet.core?.user_results?.result?.legacy?.screen_name || targetHandle;
  const timestamp = sourceLegacy.created_at || legacy.created_at || "";
  const text = sourceLegacy.full_text || sourceLegacy.text || "media";
  const media = sourceLegacy.extended_entities?.media || sourceLegacy.entities?.media || [];
  return media.map((item, index) => {
    let url = "", type = item.type === "photo" ? "photo" : "video";
    if (item.type === "photo") {
      url = item.media_url_https || item.media_url || "";
      if (url && !/[?&]name=/.test(url)) url += "?name=orig";
    } else if (item.type === "video" || item.type === "animated_gif") {
      const variants = (item.video_info?.variants || []).filter((variant) => variant.content_type === "video/mp4");
      variants.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
      url = variants[0]?.url || "";
    }
    if (!url) return null;
    const extension = type === "photo" ? ((url.match(/[?&]format=([^&]+)/)?.[1] || url.split("?")[0].split(".").pop() || "jpg").replace(/[^a-z0-9]/gi, "") || "jpg") : "mp4";
    const mediaId = item.id_str || item.id || index;
    const tweetId = source.rest_id || tweet.rest_id || "";
    return {
      id: `${tweetId}-${mediaId}`,
      url, type, thumbnail: item.media_url_https || item.media_url || "", author: `@${author}`,
      date: timestamp, tweetId, mediaId: String(mediaId), isRepost,
      filename: makeMediaFilename({ username: author, text, tweetId, mediaId, index, extension })
    };
  }).filter(Boolean);
}

function takeDiscoveryItems(items, seenIds, remaining) {
  const selected = [];
  const available = Math.max(0, Number(remaining) || 0);
  for (const item of items || []) {
    if (selected.length >= available) break;
    if (!item?.id || !item.url || seenIds.has(item.id)) continue;
    seenIds.add(item.id);
    selected.push(item);
  }
  return selected;
}

function isCurrentDiscoveryRun(state, runId) {
  return state.activeRunId === runId;
}

async function runProfileDiscovery(options, runId) {
  const state = await getDiscoveryState();
  if (!isCurrentDiscoveryRun(state, runId)) return;
  try {
    const username = normalizeProfileTarget(options.target);
    state.target = `@${username}`;
    state.status = "Reading current X session…"; await saveDiscoveryState();
    if (!isCurrentDiscoveryRun(state, runId)) return;
    const tab = await findXTab();
    if (!isCurrentDiscoveryRun(state, runId)) return;
    if (!tab?.id) throw new Error("Open x.com in this Chrome profile and sign in before discovering media.");
    await refreshAuth(tab.id);
    if (!isCurrentDiscoveryRun(state, runId)) return;
    if (!csrfToken || !cookieStr) throw new Error("No signed-in X session was found. Sign in to X in Chrome, then retry.");
    state.status = "Reading current X page metadata…"; await saveDiscoveryState();
    if (!isCurrentDiscoveryRun(state, runId)) return;
    const operations = await getOperationIds(tab.id);
    if (!isCurrentDiscoveryRun(state, runId)) return;
    state.status = `Resolving @${username}…`; await saveDiscoveryState();
    if (!isCurrentDiscoveryRun(state, runId)) return;
    const userJson = await callDiscoveryGraphQL(operations.UserByScreenName, "UserByScreenName", { screen_name: username, withSafetyModeUserFields: true });
    if (!isCurrentDiscoveryRun(state, runId)) return;
    const user = userJson?.data?.user?.result;
    const userId = user?.rest_id || user?.legacy?.id_str;
    if (!userId) throw new Error("X did not return a profile for that username.");
    let cursor = null, previousCursor = null;
    const seenMediaIds = new Set();
    const limit = normalizeDiscoveryLimit(options.limit);
    while (isCurrentDiscoveryRun(state, runId) && !state.stopRequested && state.found < limit) {
      state.status = `Fetching page ${state.pages + 1} — ${state.found} media found…`; await saveDiscoveryState();
      if (!isCurrentDiscoveryRun(state, runId)) return;
      const variables = { userId, count: 40, includePromotedContent: false, withClientEventToken: false, withBirdwatchNotes: false, withVoice: false };
      if (cursor) variables.cursor = cursor;
      const page = await callDiscoveryGraphQL(operations.UserMedia, "UserMedia", variables);
      if (!isCurrentDiscoveryRun(state, runId)) return;
      const tweets = []; collectTweets(page?.data?.user?.result?.timeline?.timeline?.instructions || page, tweets);
      const parsedItems = tweets.flatMap((tweet) => mediaFromTweet(tweet, username, Boolean(options.includeRetweets)));
      const items = takeDiscoveryItems(parsedItems, seenMediaIds, limit - state.found);
      await addQueueItems(items, { orderedFrontIds: Array.from(seenMediaIds) });
      if (!isCurrentDiscoveryRun(state, runId)) return;
      state.found += items.length;
      state.pages++;
      previousCursor = cursor;
      cursor = findBottomCursor(page?.data?.user?.result?.timeline?.timeline?.instructions || page);
      if (!cursor || cursor === previousCursor) break;
    }
    if (!isCurrentDiscoveryRun(state, runId)) return;
    state.running = false;
    state.activeRunId = null;
    state.status = state.stopRequested ? `Discovery stopped — ${state.found} media found.` : state.found >= limit ? `Reached the ${limit.toLocaleString()} media limit.` : `Discovery complete — ${state.found} media found.`;
  } catch (error) {
    if (!isCurrentDiscoveryRun(state, runId)) return;
    state.running = false;
    state.activeRunId = null;
    state.error = error.message || String(error);
    state.status = "Discovery needs attention";
  }
  await saveDiscoveryState();
}

async function handleDiscoveryMessage(msg) {
  const state = await getDiscoveryState();
  if (msg.action === "discoveryGet") return state;
  if (msg.action === "discoveryStop") { state.stopRequested = true; state.status = "Stopping after this page…"; await saveDiscoveryState(); return state; }
  if (msg.action === "discoveryStart") {
    if (state.running) return state;
    const runId = ++discoveryRunSerial;
    state.running = true;
    state.stopRequested = false;
    state.pages = 0;
    state.found = 0;
    state.target = String(msg.target || "");
    state.error = null;
    state.status = "Starting discovery…";
    state.activeRunId = runId;
    await saveDiscoveryState();
    runProfileDiscovery(msg, runId).catch((error) => console.error("[X-DL BG] Discovery error", error));
    return state;
  }
  return null;
}

// ==========================================================================
// MESSAGE HANDLER
// ==========================================================================

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const tabId = sender.tab?.id;

  // Side-panel discovery controls
  if (typeof msg.action === "string" && msg.action.startsWith("discovery")) {
    handleDiscoveryMessage(msg).then((result) => sendResponse(result));
    return true;
  }

  // Persistent side-panel queue controls
  if (typeof msg.action === "string" && msg.action.startsWith("queue")) {
    handleQueueMessage(msg).then((result) => sendResponse(result));
    return true;
  }

  // Initialize auth environment
  if (msg.action === "initEnv") {
    refreshAuth(tabId).then((result) => {
      if (!result.ok) {
        console.error("[X-DL BG] Init failed:", result.error);
      } else {
        console.log("[X-DL BG] Auth ready. CSRF:", csrfToken ? "yes" : "NO", "Bearer:", bearerToken ? "yes" : "NO");
      }
      sendResponse(result);
    });
    return true;
  }

  // Get media info for a tweet (videos + photos)
  if (msg.action === "getTweetMedia") {
    (async () => {
      await refreshAuth(tabId);
      const result = await getTweetMedia(msg.tweetId);
      sendResponse(result);
    })();
    return true;
  }

  // Legacy: get video URL only (for backward compat with old content.js)
  if (msg.action === "getVideoUrl") {
    (async () => {
      await refreshAuth(tabId);
      const result = await getTweetMedia(msg.tweetId);
      if (result.videos && result.videos.length > 0) {
        sendResponse({ url: result.videos[0].url });
      } else {
        sendResponse({ url: null, error: result.error || "No video found" });
      }
    })();
    return true;
  }

  // Download a single file
  if (msg.action === "downloadFile") {
    downloadFile(msg.url, msg.filename).then(sendResponse);
    return true;
  }

  // Legacy: downloadVideo alias
  if (msg.action === "downloadVideo") {
    downloadFile(msg.url, msg.filename).then(sendResponse);
    return true;
  }

  // Fetch file as ArrayBuffer (for ZIP assembly)
  if (msg.action === "fetchAsArrayBuffer") {
    (async () => {
      try {
        const resp = await fetch(msg.url);
        if (!resp.ok) {
          sendResponse({ error: `HTTP ${resp.status}` });
          return;
        }
        const buffer = await resp.arrayBuffer();
        // Convert to regular Array for message passing (ArrayBuffers don't serialize well)
        const arr = Array.from(new Uint8Array(buffer));
        sendResponse({ data: arr, ok: true });
      } catch (e) {
        sendResponse({ error: e.message });
      }
    })();
    return true;
  }

  // Create a ZIP from multiple URLs and download it
  if (msg.action === "downloadZip") {
    (async () => {
      try {
        const { files, zipFilename } = msg;
        // files: [{ url, name }]
        const zip = new ZipWriter();
        let fetched = 0;

        for (const file of files) {
          try {
            const resp = await fetch(file.url);
            if (resp.ok) {
              const buffer = await resp.arrayBuffer();
              zip.addFile(file.name, buffer);
            }
          } catch (e) {
            console.warn("[X-DL BG] Failed to fetch for ZIP:", file.name, e.message);
          }
          fetched++;
        }

        const zipData = zip.generate();
        const blob = new Blob([zipData], { type: "application/zip" });
        const zipUrl = URL.createObjectURL(blob);

        chrome.downloads.download(
          { url: zipUrl, filename: zipFilename || "x-media/archive.zip", conflictAction: "uniquify" },
          (downloadId) => {
            URL.revokeObjectURL(zipUrl);
            if (chrome.runtime.lastError) {
              sendResponse({ success: false, error: chrome.runtime.lastError.message });
            } else {
              sendResponse({ success: true, downloadId, files: fetched });
            }
          }
        );
      } catch (e) {
        sendResponse({ success: false, error: e.message });
      }
    })();
    return true;
  }
});
