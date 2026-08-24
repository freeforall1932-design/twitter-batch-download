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
let queueState = null;
let queueSaving = Promise.resolve();

async function getQueueState() {
  if (queueState) return queueState;
  const stored = await chrome.storage.local.get(QUEUE_STORAGE_KEY);
  queueState = { ...QUEUE_DEFAULT, ...(stored[QUEUE_STORAGE_KEY] || {}) };
  queueState.concurrency = queueState.concurrency === 1 ? 1 : 2;
  // Service workers can stop while Chrome downloads continue. Reconcile stale states.
  queueState.items = queueState.items.map((item) => item.status === "downloading"
    ? { ...item, status: "queued", downloadId: null } : item);
  await saveQueueState();
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

async function processQueue() {
  const state = await getQueueState();
  if (!state.running || state.stopped) return;
  const active = state.items.filter((item) => item.status === "downloading").length;
  const slots = Math.max(0, state.concurrency - active);
  const nextItems = state.items.filter((item) => item.status === "queued").slice(0, slots);
  for (const item of nextItems) {
    item.status = "starting";
    await saveQueueState();
    const result = await downloadFile(item.url, item.filename);
    if (result.success) {
      item.status = "downloading";
      item.downloadId = result.downloadId;
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

chrome.downloads.onChanged.addListener(async (delta) => {
  if (!delta.state || !["complete", "interrupted"].includes(delta.state.current)) return;
  const state = await getQueueState();
  const item = state.items.find((candidate) => candidate.downloadId === delta.id);
  if (!item) return;
  item.status = delta.state.current === "complete" ? "completed" : "failed";
  item.error = delta.error?.current || null;
  item.downloadId = null;
  await saveQueueState();
  // This is deliberately called only after Chrome reports a finished/interrupted download.
  processQueue();
});

async function handleQueueMessage(msg) {
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
  } else if (msg.action === "queueAdd") {
    // Discovery connectors add normalized media records here; newest discoveries go first.
    const additions = (msg.items || []).filter((candidate) => candidate.id && candidate.url)
      .filter((candidate) => !state.items.some((existing) => existing.id === candidate.id))
      .map((candidate) => ({ ...candidate, selected: false, status: "discovered", downloadId: null }));
    state.items.unshift(...additions);
  } else {
    return null;
  }
  await saveQueueState();
  if (msg.action === "queueStart" || msg.action === "queueSetConcurrency") processQueue();
  return publicQueueState();
}


// ==========================================================================
// MESSAGE HANDLER
// ==========================================================================

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const tabId = sender.tab?.id;

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
