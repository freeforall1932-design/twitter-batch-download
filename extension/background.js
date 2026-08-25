// ==========================================================================
// background.js — Service Worker for X Media Downloader
// Handles: auth, GraphQL API, media extraction, queue, direct downloads
// ==========================================================================

// --- Auth cache ---
let bearerToken = null;
let csrfToken = null;
let cookieStr = null;
let envTimestamp = 0;

// --- Live network capture cache (Rank S insight, local-only) ---
// Populated by MAIN-world injected.js via content.js. Holds the latest
// operation IDs, features/variables templates, and non-cookie request headers
// observed from the signed-in X tab. Never exported to the UI.
const CAPTURE_MAX_AGE_MS = 30 * 60 * 1000;
// Kept on globalThis so the service worker and unit-test VM share one bag and
// tests can inspect captures without fighting module-scoped `let` bindings.
globalThis.__xdlNetworkCapture = {
  operations: new Map(), // operationName → { queryId, features, fieldToggles, variables, at }
  headers: {},
  lastTransactionId: null,
  updatedAt: 0
};

function captureBag() {
  return globalThis.__xdlNetworkCapture;
}

// --- Known Twitter Bearer token (public app-level, embedded in X's JS) ---
const KNOWN_BEARER = "AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA";

// --- GraphQL endpoint from yt-dlp (current as of 2025) ---
const GRAPHQL_QUERY_ID = "2ICDjqPd81tulZcYrtpTuQ";
const GRAPHQL_ENDPOINT = "TweetResultByRestId";

// --- Rate limit tracking ---
let lastRequestTime = 0;
let rateLimitHits = 0;
const MIN_REQUEST_INTERVAL = 800; // ms between requests to avoid rate limiting
// Optional listener used by profile discovery to surface retry countdowns.
// Kept on globalThis so unit tests can install a spy without fighting `let` TDZ.
globalThis.rateLimitStatusListener = null;

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

// Classify transport/API failures into stable, user-facing codes. Live X still
// needs verification, but the wording no longer depends on raw status text.
function classifyDiscoveryError(raw, context = {}) {
  const status = Number(context.status) || 0;
  const message = String(raw?.message || raw || "");
  const lower = message.toLowerCase();
  const typename = String(context.typename || "");
  const reason = String(context.reason || "");

  if (context.code) {
    return {
      code: context.code,
      message: context.message || message || "Discovery needs attention."
    };
  }

  if (status === 429 || status === 503 || /rate limit|retries were exhausted|too many requests|service unavailable/.test(lower)) {
    return {
      code: "rate_limited",
      message: "X rate-limited this scan. Wait for the countdown, then discovery will retry automatically."
    };
  }
  if (status === 401 || /session has expired|sign in to x|not authenticated|unauthorized|csrf|auth error \(401\)/.test(lower)) {
    return {
      code: "auth_expired",
      message: "Your X session has expired. Sign in to X in this Chrome profile, open any X tab, then retry."
    };
  }
  if (
    status === 403 ||
    typename === "UserUnavailable" ||
    reason === "Protected" ||
    /protected|not authorized|you are not authorized|account is temporarily unavailable/.test(lower)
  ) {
    return {
      code: "protected",
      message: "This profile is protected or unavailable to your signed-in account."
    };
  }
  if (reason === "NsfwLoggedOut" || /nsfw|sensitive media|age-restricted/.test(lower)) {
    return {
      code: "nsfw",
      message: "This media is marked sensitive. Sign in to an X account that can view it, then retry."
    };
  }
  // Operation-metadata failures also contain "could not find", so classify them
  // before the generic not-found branch.
  if (/operation metadata|could not find current x operation|current x operation metadata/.test(lower)) {
    return {
      code: "operation_metadata",
      message: message || "Could not read current X operation metadata. Open the profile on x.com, refresh, then retry."
    };
  }
  if (
    typename === "TweetTombstone" ||
    /could not find|deleted|no tweet result|not return a profile|user not found|doesn't exist/.test(lower)
  ) {
    return {
      code: "not_found",
      message: "X did not return that profile or post. It may be deleted, suspended, or mistyped."
    };
  }
  if (/open x\.com|no signed-in x session/.test(lower)) {
    return {
      code: "auth_required",
      message: message || "Open x.com in this Chrome profile and sign in before discovering media."
    };
  }
  if (/enter an x profile|use @username|not an x profile|target must be/.test(lower)) {
    return {
      code: "invalid_target",
      message: message || "Enter an X profile URL or @username."
    };
  }
  return {
    code: "unknown",
    message: message || "Discovery needs attention."
  };
}

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

function rememberNetworkCapture(capture) {
  if (!capture || typeof capture !== "object") return false;
  const bag = captureBag();
  const operationName = String(capture.operationName || "").trim();
  const queryId = String(capture.queryId || "").trim();
  let changed = false;

  if (operationName && queryId && /^[A-Za-z0-9_-]{8,}$/.test(queryId)) {
    const prev = bag.operations.get(operationName) || {};
    const next = {
      queryId,
      features: capture.features || prev.features || null,
      fieldToggles: capture.fieldToggles || prev.fieldToggles || null,
      variables: capture.variables || prev.variables || null,
      at: Date.now()
    };
    bag.operations.set(operationName, next);
    changed = true;
  }

  const headers = capture.headers && typeof capture.headers === "object" ? capture.headers : {};
  for (const [key, value] of Object.entries(headers)) {
    if (!value) continue;
    const lower = String(key).toLowerCase();
    // Never persist Cookie header values into the capture bag.
    if (lower === "cookie") continue;
    if (lower === "authorization") {
      const match = String(value).match(/Bearer\s+(.+)$/i);
      if (match?.[1]) {
        bearerToken = match[1].trim();
        envTimestamp = Date.now();
      }
    }
    if (lower === "x-csrf-token") {
      csrfToken = String(value);
    }
    if (lower === "x-client-transaction-id") {
      bag.lastTransactionId = String(value);
    }
    bag.headers[lower] = String(value);
    changed = true;
  }

  if (changed) bag.updatedAt = Date.now();
  return changed;
}

function isCaptureFresh(entry) {
  if (!entry?.at) return false;
  return Date.now() - entry.at < CAPTURE_MAX_AGE_MS;
}

function getCapturedOperation(name) {
  const entry = captureBag().operations.get(name);
  return isCaptureFresh(entry) ? entry : null;
}

function getCapturedHeaders() {
  return { ...captureBag().headers };
}

function getLastTransactionId() {
  return captureBag().lastTransactionId || captureBag().headers["x-client-transaction-id"] || null;
}

function parseCapturedJson(raw, fallback) {
  if (!raw) return fallback;
  if (typeof raw === "object") return raw;
  try {
    return JSON.parse(raw);
  } catch (_) {
    return fallback;
  }
}

function makeHeaders(options = {}) {
  const headers = {
    "authorization": "Bearer " + bearerToken,
    "x-csrf-token": csrfToken,
    "x-twitter-auth-type": "OAuth2Session",
    "x-twitter-active-user": "yes",
    "x-twitter-client-language": "en",
    "content-type": "application/json",
    "cookie": cookieStr
  };

  // Prefer live headers captured from the signed-in X page (Rank S pattern).
  const captured = captureBag().headers || {};
  for (const key of [
    "authorization",
    "x-csrf-token",
    "x-client-uuid",
    "x-twitter-active-user",
    "x-twitter-client-language",
    "x-twitter-auth-type"
  ]) {
    if (captured[key]) headers[key] = captured[key];
  }

  // Fresh CSRF from cookies always wins over a stale capture.
  if (csrfToken) headers["x-csrf-token"] = csrfToken;
  if (bearerToken && !String(headers.authorization || "").includes(bearerToken)) {
    headers.authorization = "Bearer " + bearerToken;
  }

  // x-client-transaction-id is required by some modern X GraphQL endpoints.
  // Reuse the latest observed value when the page has issued one recently.
  const tx = options.transactionId || getLastTransactionId();
  if (tx) headers["x-client-transaction-id"] = tx;

  return headers;
}

function normalizePhotoUrl(rawUrl) {
  // Rank S keeps the CDN photo URL; Rank A normalizes format + size params.
  // Prefer original resolution while preserving format when X provides it.
  if (!rawUrl) return "";
  try {
    const url = new URL(rawUrl);
    if (!url.searchParams.get("name")) url.searchParams.set("name", "orig");
    const format = url.searchParams.get("format");
    if (format) url.searchParams.set("format", String(format).toLowerCase());
    return url.toString();
  } catch (_) {
    if (!/[?&]name=/.test(rawUrl)) {
      return rawUrl.includes("?") ? `${rawUrl}&name=orig` : `${rawUrl}?name=orig`;
    }
    return rawUrl;
  }
}

function sanitizeDownloadPath(filename) {
  return String(filename || "x-media/media.bin")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/\.\.+/g, ".")
    .replace(/[<>:"|?*\x00-\x1f]/g, "_")
    .replace(/\/{2,}/g, "/");
}

function buildFallbackFilenames(filename) {
  // Rank S / Rank A both retry downloads after "Invalid filename" with simpler
  // paths. Produce a short ladder of increasingly safe names.
  const cleaned = sanitizeDownloadPath(filename);
  const parts = cleaned.split("/");
  const leaf = parts.pop() || "media.bin";
  const extMatch = leaf.match(/\.([a-z0-9]{1,5})$/i);
  const ext = extMatch ? extMatch[1].toLowerCase() : "bin";
  const stem = leaf.replace(/\.[a-z0-9]{1,5}$/i, "").slice(0, 80) || "media";
  const safeStem = stem.replace(/[^\w.-]+/g, "_").replace(/^_+|_+$/g, "") || "media";
  const folder = parts[0] && parts[0] !== ".." ? parts[0].replace(/[^\w.-]+/g, "_") : "x-media";
  return [
    cleaned,
    `${folder}/${safeStem}.${ext}`,
    `x-media/${safeStem}.${ext}`,
    `x-media/media_${Date.now().toString(36)}.${ext}`
  ].filter((value, index, list) => value && list.indexOf(value) === index);
}

// ==========================================================================
// RATE LIMITING — Exponential backoff with jitter
// ==========================================================================

async function notifyRateLimitWait(waitMs, meta = {}) {
  const listener = globalThis.rateLimitStatusListener;
  if (typeof listener !== "function") return;
  try {
    await listener({
      waitMs: Math.max(0, Math.round(waitMs || 0)),
      attempt: meta.attempt || 0,
      maxAttempts: meta.maxAttempts || 0,
      status: meta.status || 0,
      until: Date.now() + Math.max(0, Math.round(waitMs || 0))
    });
  } catch (_) { /* Discovery UI updates must never break the request loop. */ }
}

async function sleepWithRateLimitCountdown(waitMs, meta = {}) {
  const total = Math.max(0, Math.round(waitMs || 0));
  const endedAt = Date.now() + total;
  await notifyRateLimitWait(total, meta);
  while (Date.now() < endedAt) {
    const remaining = endedAt - Date.now();
    await new Promise((resolve) => setTimeout(resolve, Math.min(1000, remaining)));
    if (Date.now() < endedAt) await notifyRateLimitWait(endedAt - Date.now(), meta);
  }
  await notifyRateLimitWait(0, meta);
}

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
    // Spacing delays stay quiet in the UI; only 429/503 retries show a countdown.
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
      const parsedRetryAfter = retryAfter ? parseInt(retryAfter, 10) : NaN;
      const waitTime = Number.isFinite(parsedRetryAfter)
        ? parsedRetryAfter * 1000
        : Math.min(2000 * Math.pow(2, attempt) + Math.random() * 1000, 60000);

      console.log(`[X-DL BG] Rate limited (${resp.status}), attempt ${attempt + 1}/${maxRetries + 1}, waiting ${Math.round(waitTime / 1000)}s`);
      await sleepWithRateLimitCountdown(waitTime, {
        attempt: attempt + 1,
        maxAttempts: maxRetries + 1,
        status: resp.status
      });

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

  // Prefer a live-captured TweetResultByRestId query id when the page has
  // already issued one (Rank S intercept pattern). Do not fall back to
  // TweetDetail here: its variables/response shape differ and would break
  // the single-tweet parser below.
  const tweetCapture = getCapturedOperation("TweetResultByRestId");
  const queryId = tweetCapture?.queryId || GRAPHQL_QUERY_ID;
  const operationName = GRAPHQL_ENDPOINT;
  const mergedFeatures = tweetCapture ? { ...features, ...parseCapturedJson(tweetCapture.features, {}) } : features;
  const mergedToggles = tweetCapture ? { ...fieldToggles, ...parseCapturedJson(tweetCapture.fieldToggles, {}) } : fieldToggles;

  const params = new URLSearchParams({
    variables: JSON.stringify(variables),
    features: JSON.stringify(mergedFeatures),
    fieldToggles: JSON.stringify(mergedToggles)
  });

  const url = `https://x.com/i/api/graphql/${queryId}/${operationName}?${params}`;

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

  // Parse the result (TweetResultByRestId shape; never TweetDetail)
  const result = json?.data?.tweetResult?.result || json?.data?.tweet_result?.result;
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
      const photoUrl = normalizePhotoUrl(m.media_url_https || m.media_url || "");
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

function chromeDownloadOnce(url, filename) {
  return new Promise((resolve) => {
    chrome.downloads.download(
      { url, filename, saveAs: false, conflictAction: "uniquify" },
      (downloadId) => {
        if (chrome.runtime.lastError) {
          resolve({ success: false, error: chrome.runtime.lastError.message || "Download failed" });
        } else {
          resolve({ success: true, downloadId, filename });
        }
      }
    );
  });
}

async function downloadFile(url, filename) {
  // Rank S retries Invalid filename with progressively safer paths so a long
  // post-text snippet cannot brick an otherwise valid CDN URL.
  const candidates = buildFallbackFilenames(filename);
  let lastError = "Download failed";
  for (const candidate of candidates) {
    const result = await chromeDownloadOnce(url, candidate);
    if (result.success) {
      if (candidate !== candidates[0]) {
        console.log("[X-DL BG] Download started with fallback filename:", candidate, "id:", result.downloadId);
      } else {
        console.log("[X-DL BG] Download started:", candidate, "id:", result.downloadId);
      }
      return result;
    }
    lastError = result.error || lastError;
    const invalid = /invalid filename|invalid file path|path is invalid/i.test(lastError);
    if (!invalid) {
      console.error("[X-DL BG] Download error:", lastError);
      return { success: false, error: lastError };
    }
    console.warn("[X-DL BG] Invalid filename, retrying with safer path:", candidate, "→", lastError);
  }
  console.error("[X-DL BG] Download error after fallbacks:", lastError);
  return { success: false, error: lastError };
}

// ==========================================================================
// PERSISTENT DOWNLOAD QUEUE — schedules only after prior downloads finish
// ==========================================================================
const QUEUE_STORAGE_KEY = "batchDownloadQueueV1";
const QUEUE_DEFAULT = { items: [], concurrency: 2, running: false, stopped: false, skipDownloaded: true };
const MAX_DOWNLOAD_ATTEMPTS = 3;
let queueState = null;
let queueSaving = Promise.resolve();
let queueProcessing = Promise.resolve();

// --- Completed-download history (Rank S "Ignore saved") -------------------
// Remembers queue item ids that finished successfully so the same media is not
// re-listed after the user clears the visible history. Ids only — no URLs,
// no tokens, no post content.
const DOWNLOADED_STORAGE_KEY = "downloadedMediaIdsV1";
const DOWNLOADED_HISTORY_MAX = 20000;
let downloadedIds = null;
let downloadedSaving = Promise.resolve();

async function getDownloadedIds() {
  if (downloadedIds) return downloadedIds;
  const stored = await chrome.storage.local.get(DOWNLOADED_STORAGE_KEY);
  const list = Array.isArray(stored?.[DOWNLOADED_STORAGE_KEY]) ? stored[DOWNLOADED_STORAGE_KEY] : [];
  downloadedIds = new Set(list.filter((id) => typeof id === "string" && id));
  return downloadedIds;
}

async function saveDownloadedIds() {
  if (!downloadedIds) return;
  // Keep the newest ids when the history grows past the cap.
  const list = Array.from(downloadedIds);
  const trimmed = list.length > DOWNLOADED_HISTORY_MAX ? list.slice(list.length - DOWNLOADED_HISTORY_MAX) : list;
  if (trimmed.length !== list.length) downloadedIds = new Set(trimmed);
  downloadedSaving = downloadedSaving.then(() => chrome.storage.local.set({ [DOWNLOADED_STORAGE_KEY]: trimmed }));
  await downloadedSaving;
}

async function rememberDownloadedId(id) {
  if (!id) return;
  const history = await getDownloadedIds();
  if (history.has(id)) return;
  history.add(id);
  await saveDownloadedIds();
}

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
    await rememberDownloadedId(item.id);
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

function mergeQueueItems(state, candidates, orderedFrontIds = null, options = {}) {
  const knownIds = new Set(state.items.map((item) => item.id));
  // A photo can reach the queue twice with different ids: once from the
  // rendered DOM and once from the GraphQL payload for the same post. Collapse
  // on the CDN media key so the user never sees the same file listed twice.
  const knownKeys = new Set(state.items.map((item) => item.mediaKey).filter(Boolean));
  const alreadyDownloaded = options.alreadyDownloaded || null;
  const additions = [];
  for (const candidate of candidates || []) {
    if (!candidate?.id || !candidate.url || knownIds.has(candidate.id)) continue;
    const mediaKey = candidate.mediaKey || null;
    if (mediaKey && knownKeys.has(mediaKey)) continue;
    if (alreadyDownloaded && (alreadyDownloaded.has(candidate.id) || (mediaKey && alreadyDownloaded.has(mediaKey)))) continue;
    knownIds.add(candidate.id);
    if (mediaKey) knownKeys.add(mediaKey);
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
  const source = options.source || null;
  const normalizedItems = (items || []).map((item) => source && !item.source ? { ...item, source } : item);
  const skipDownloaded = options.skipDownloaded !== undefined
    ? Boolean(options.skipDownloaded)
    : state.skipDownloaded !== false;
  const alreadyDownloaded = skipDownloaded ? await getDownloadedIds() : null;
  const addedCount = mergeQueueItems(state, normalizedItems, options.orderedFrontIds || null, { alreadyDownloaded });
  await saveQueueState();
  return { state: publicQueueState(), addedCount };
}

async function handleQueueMessage(msg) {
  if (msg.action === "queueAdd") {
    // Content scripts need the accepted count so their local dedupe sets and
    // "listed" counter stay in step with the queue.
    const result = await addQueueItems(msg.items, {
      source: msg.source || null,
      skipDownloaded: msg.skipDownloaded
    });
    return { ...result.state, addedCount: result.addedCount };
  }
  const state = await getQueueState();
  if (msg.action === "queueGet") return publicQueueState();
  if (msg.action === "queueSetConcurrency") {
    state.concurrency = msg.concurrency === 1 ? 1 : 2;
  } else if (msg.action === "queueSelect") {
    const item = state.items.find((candidate) => candidate.id === msg.id);
    if (item) item.selected = Boolean(msg.selected);
  } else if (msg.action === "queueSelectVisible") {
    state.items.filter((item) => {
      const sourceOk = !msg.source || (item.source || "remote") === msg.source;
      return sourceOk && (msg.filter === "all" || item.type === msg.filter);
    }).forEach((item) => { item.selected = Boolean(msg.selected); });
  } else if (msg.action === "queueSetSkipDownloaded") {
    state.skipDownloaded = msg.skipDownloaded !== false;
  } else if (msg.action === "queueRemove") {
    const ids = new Set(Array.isArray(msg.ids) ? msg.ids : [msg.id].filter(Boolean));
    state.items = state.items.filter((item) => !ids.has(item.id));
  } else if (msg.action === "queueClearDownloadedHistory") {
    downloadedIds = new Set();
    await saveDownloadedIds();
  } else if (msg.action === "queueClearAll") {
    state.items = msg.source
      ? state.items.filter((item) => (item.source || "remote") !== msg.source)
      : [];
  } else if (msg.action === "queueClearFinished") {
    state.items = state.items.filter((item) => !["completed", "failed"].includes(item.status));
  } else if (msg.action === "queueRetryFailed") {
    state.items.filter((item) => item.status === "failed").forEach((item) => {
      item.status = "queued"; item.error = null; item.attempts = 0; item.bytesReceived = 0; item.totalBytes = 0;
    });
    state.stopped = false; state.running = true;
  } else if (msg.action === "queueStart") {
    state.items.forEach((item) => {
      const sourceOk = !msg.source || (item.source || "remote") === msg.source;
      const allowed = sourceOk && (msg.mode === "all" || item.selected);
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
const DEFAULT_DISCOVERY = {
  running: false,
  stopRequested: false,
  pages: 0,
  found: 0,
  status: "Ready to discover media",
  error: null,
  errorCode: null,
  retryAfterMs: 0,
  retryUntil: 0,
  target: "",
  activeRunId: null
};
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

function resolveOperationRecord(preferredNames) {
  // Rank S prefers live-intercepted query IDs (UserMedia / photo-video timelines)
  // over brittle bundle scraping. Accept the first fresh capture among aliases.
  for (const name of preferredNames) {
    const captured = getCapturedOperation(name);
    if (captured?.queryId) {
      return { name, queryId: captured.queryId, capture: captured, source: "capture" };
    }
  }
  return null;
}

async function scrapeOperationIdsFromBundles(tabId, operationNames) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => Array.from(document.scripts).map((script) => script.src).filter((src) => /\.js(?:\?|$)/.test(src))
  });
  const urls = results?.[0]?.result || [];
  const ids = {};
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
  return ids;
}

async function getOperationIds(tabId) {
  // Prefer Rank S-style live captures. Fall back to bundle scrape, then to
  // alternate media timeline operation names X has shipped recently.
  const userOp = resolveOperationRecord(["UserByScreenName"]) || null;
  const mediaOp = resolveOperationRecord(["UserMedia", "UserPhotoTimeline", "UserVideoTimeline"]) || null;

  const needed = [];
  if (!userOp) needed.push("UserByScreenName");
  if (!mediaOp) needed.push("UserMedia", "UserPhotoTimeline", "UserVideoTimeline");

  let scraped = {};
  if (needed.length && tabId) {
    scraped = await scrapeOperationIdsFromBundles(tabId, [...new Set(needed)]);
  }

  const resolvedUser = userOp || (scraped.UserByScreenName
    ? { name: "UserByScreenName", queryId: scraped.UserByScreenName, capture: null, source: "bundle" }
    : null);

  let resolvedMedia = mediaOp;
  if (!resolvedMedia) {
    for (const name of ["UserMedia", "UserPhotoTimeline", "UserVideoTimeline"]) {
      if (scraped[name]) {
        resolvedMedia = { name, queryId: scraped[name], capture: null, source: "bundle" };
        break;
      }
    }
  }

  if (!resolvedUser || !resolvedMedia) {
    const missing = [
      !resolvedUser ? "UserByScreenName" : null,
      !resolvedMedia ? "UserMedia" : null
    ].filter(Boolean);
    throw new Error(`Could not find current X operation metadata: ${missing.join(", ")}. Open the target's X profile/media page once, refresh it, then retry.`);
  }

  return {
    UserByScreenName: resolvedUser.queryId,
    UserMedia: resolvedMedia.queryId,
    userOperationName: resolvedUser.name,
    mediaOperationName: resolvedMedia.name,
    userCapture: resolvedUser.capture,
    mediaCapture: resolvedMedia.capture,
    sources: { user: resolvedUser.source, media: resolvedMedia.source }
  };
}

function discoveryFeatures() {
  // Feature flags aligned with current X web timeline requests (and Rank S
  // Plucker captures). Exact live shapes still need signed-in verification.
  return {
    profile_label_improvements_pcf_label_in_post_enabled: true,
    rweb_tipjar_consumption_enabled: true,
    responsive_web_graphql_exclude_directive_enabled: true,
    verified_phone_label_enabled: false,
    creator_subscriptions_tweet_preview_api_enabled: true,
    responsive_web_graphql_timeline_navigation_enabled: true,
    responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
    premium_content_api_read_enabled: false,
    communities_web_enable_tweet_community_results_fetch: true,
    c9s_tweet_anatomy_moderator_badge_enabled: true,
    responsive_web_grok_analyze_button_fetch_trends_enabled: false,
    responsive_web_grok_analyze_post_followups_enabled: true,
    responsive_web_jetfuel_frame: false,
    responsive_web_grok_share_attachment_enabled: true,
    articles_preview_enabled: true,
    responsive_web_edit_tweet_api_enabled: true,
    graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
    view_counts_everywhere_api_enabled: true,
    longform_notetweets_consumption_enabled: true,
    responsive_web_twitter_article_tweet_consumption_enabled: true,
    tweet_awards_web_tipping_enabled: false,
    responsive_web_grok_analysis_button_from_backend: true,
    creator_subscriptions_quote_tweet_preview_enabled: false,
    freedom_of_speech_not_reach_fetch_enabled: true,
    standardized_nudges_misinfo: true,
    tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
    rweb_video_timestamps_enabled: true,
    longform_notetweets_rich_text_read_enabled: true,
    longform_notetweets_inline_media_enabled: true,
    responsive_web_grok_image_annotation_enabled: true,
    responsive_web_enhance_cards_enabled: false,
    tweetypie_unmention_optimization_enabled: true
  };
}

function discoveryFieldToggles() {
  return { withArticlePlainText: false };
}

function throwClassifiedDiscoveryError(raw, context = {}) {
  const classified = classifyDiscoveryError(raw, context);
  const error = new Error(classified.message);
  error.code = classified.code;
  throw error;
}

function mergeDiscoveryFeatures(capture) {
  const defaults = discoveryFeatures();
  const captured = parseCapturedJson(capture?.features, null);
  if (!captured || typeof captured !== "object") return defaults;
  // Live feature flags from the signed-in page override defaults (Rank S).
  return { ...defaults, ...captured };
}

function mergeDiscoveryFieldToggles(capture) {
  const defaults = discoveryFieldToggles();
  const captured = parseCapturedJson(capture?.fieldToggles, null);
  if (!captured || typeof captured !== "object") return defaults;
  return { ...defaults, ...captured };
}

function buildUserMediaVariables(userId, cursor, capture) {
  // Start from a captured variables template when available so newly required
  // X flags travel with the request automatically.
  const capturedVars = parseCapturedJson(capture?.variables, {}) || {};
  const variables = {
    ...capturedVars,
    userId,
    count: Math.min(40, Math.max(10, Number(capturedVars.count) || 20)),
    includePromotedContent: capturedVars.includePromotedContent !== false,
    withQuickPromoteEligibilityTweetFields: capturedVars.withQuickPromoteEligibilityTweetFields !== false,
    withVoice: capturedVars.withVoice !== false,
    withV2Timeline: capturedVars.withV2Timeline !== false
  };
  // Cursor always comes from our pagination state, never a stale capture.
  if (cursor) variables.cursor = cursor;
  else delete variables.cursor;
  // Ensure the resolved user wins over any screen_name leftover in the template.
  variables.userId = userId;
  delete variables.screen_name;
  return variables;
}

async function callDiscoveryGraphQL(operationId, operationName, variables, capture = null) {
  const params = new URLSearchParams({
    variables: JSON.stringify(variables),
    features: JSON.stringify(mergeDiscoveryFeatures(capture)),
    fieldToggles: JSON.stringify(mergeDiscoveryFieldToggles(capture))
  });
  const response = await fetchWithRetry(
    `https://x.com/i/api/graphql/${operationId}/${operationName}?${params}`,
    makeHeaders()
  );
  if (!response) throwClassifiedDiscoveryError("X rate limit retries were exhausted.", { code: "rate_limited" });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throwClassifiedDiscoveryError(body || `X returned ${response.status}`, { status: response.status });
  }
  let json;
  try {
    json = await response.json();
  } catch (_) {
    throwClassifiedDiscoveryError("Invalid JSON response from X.", { code: "unknown" });
  }
  if (json.errors?.length) {
    const errMsg = json.errors.map((entry) => entry.message || entry.code || "X GraphQL error").join(", ");
    throwClassifiedDiscoveryError(errMsg, { status: response.status });
  }
  return json;
}

function unwrapTweet(result, options = {}) {
  if (!result || typeof result !== "object") return null;
  if (result.__typename === "TweetWithVisibilityResults") return result.tweet || null;
  if (result.__typename === "TweetUnavailable") {
    if (options.soft) return null;
    const reason = result.reason || "unavailable";
    if (reason === "Protected") throwClassifiedDiscoveryError(reason, { code: "protected", reason });
    if (reason === "NsfwLoggedOut") throwClassifiedDiscoveryError(reason, { code: "nsfw", reason });
    throwClassifiedDiscoveryError(`unavailable: ${reason}`, { reason, typename: "TweetUnavailable" });
  }
  if (result.__typename === "TweetTombstone") {
    if (options.soft) return null;
    throwClassifiedDiscoveryError("deleted", { code: "not_found", typename: "TweetTombstone" });
  }
  // Prefer an explicit Tweet typename. Fall back only when the object already
  // looks like a tweet payload (rest_id + legacy) and is not a User result.
  if (result.__typename === "Tweet") return result;
  if (!result.__typename && result.rest_id && result.legacy && !result.timeline) return result;
  return null;
}

function resolveUserResult(userJson) {
  const user = userJson?.data?.user?.result || userJson?.data?.user_result?.result || null;
  if (!user) return { error: classifyDiscoveryError("X did not return a profile for that username.", { code: "not_found" }) };
  if (user.__typename === "UserUnavailable") {
    const reason = user.reason || "";
    if (/protect/i.test(reason) || reason === "Protected") {
      return { error: classifyDiscoveryError(reason || "protected", { code: "protected", reason, typename: "UserUnavailable" }) };
    }
    if (/suspend/i.test(reason)) {
      return { error: classifyDiscoveryError(reason || "suspended", { code: "not_found", reason, typename: "UserUnavailable" }) };
    }
    return { error: classifyDiscoveryError(reason || "User unavailable", { code: "not_found", reason, typename: "UserUnavailable" }) };
  }
  const userId = user.rest_id || user.legacy?.id_str;
  if (!userId) return { error: classifyDiscoveryError("X did not return a profile for that username.", { code: "not_found" }) };
  return { user, userId };
}

function collectTweets(value, output, seen = new Set(), parentKey = "") {
  if (!value || typeof value !== "object") return;
  // Reposted media is resolved from its parent post below. Quoted results are
  // deliberately excluded until an explicit Include quoted media option exists.
  if (parentKey === "quoted_status_result" || parentKey === "retweeted_status_result") return;
  // Soft-unwrap skips unavailable/deleted individual timeline entries. Profile
  // unavailability is handled separately in resolveUserResult.
  const tweet = unwrapTweet(value, { soft: true });
  if (tweet?.rest_id && !seen.has(tweet.rest_id)) { seen.add(tweet.rest_id); output.push(tweet); }
  if (Array.isArray(value)) value.forEach((entry) => collectTweets(entry, output, seen, parentKey));
  else Object.entries(value).forEach(([key, entry]) => collectTweets(entry, output, seen, key));
}

function findBottomCursor(value) {
  if (!value || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    // Prefer the last Bottom cursor in instruction entry lists (X media timelines).
    let found = null;
    for (const entry of value) {
      const cursor = findBottomCursor(entry);
      if (cursor) found = cursor;
    }
    return found;
  }
  const entryId = value.entryId || value.entry_id || "";
  const content = value.content || value;
  const entryType = content.entryType || content.__typename || value.entryType || "";
  const cursorType = content.cursorType || value.cursorType || "";
  const cursorValue = content.value || value.value || "";
  if (
    cursorValue &&
    (cursorType === "Bottom" || String(entryId).includes("cursor-bottom")) &&
    (!entryType || entryType === "TimelineTimelineCursor" || String(entryId).includes("cursor"))
  ) {
    return cursorValue;
  }
  let found = null;
  for (const child of Object.values(value)) {
    const cursor = findBottomCursor(child);
    if (cursor) found = cursor;
  }
  return found;
}

function extractTimelineInstructions(page) {
  return (
    page?.data?.user?.result?.timeline_v2?.timeline?.instructions ||
    page?.data?.user?.result?.timeline?.timeline?.instructions ||
    page?.data?.user?.result?.timeline?.instructions ||
    page?.data?.user_result?.result?.timeline_v2?.timeline?.instructions ||
    page?.data?.user_result?.result?.timeline?.timeline?.instructions ||
    null
  );
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

// Stable CDN identity for a media file, independent of query params, size
// suffixes, and which surface (DOM vs GraphQL) discovered it.
function mediaKeyFromUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    const leaf = url.pathname.split("/").filter(Boolean).pop() || "";
    return leaf.replace(/\.[a-z0-9]{1,5}$/i, "") || "";
  } catch (_) {
    const leaf = String(rawUrl || "").split("?")[0].split("/").pop() || "";
    return leaf.replace(/\.[a-z0-9]{1,5}$/i, "");
  }
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
  const repostResult = legacy.retweeted_status_result?.result || tweet.retweeted_status_result?.result;
  const isRepost = Boolean(repostResult);
  if (isRepost && !includeRetweets) return [];
  // Soft-unwrap so one deleted/NSFW repost target does not abort the whole page.
  const source = unwrapTweet(repostResult, { soft: true }) || tweet;
  const sourceLegacy = source.legacy || {};
  const author =
    source.core?.user_results?.result?.legacy?.screen_name ||
    tweet.core?.user_results?.result?.legacy?.screen_name ||
    String(targetHandle || "unknown").replace(/^@/, "");
  const timestamp = sourceLegacy.created_at || legacy.created_at || "";
  const text = sourceLegacy.full_text || sourceLegacy.text || "media";
  const media = sourceLegacy.extended_entities?.media || sourceLegacy.entities?.media || [];
  return media.map((item, index) => {
    let url = "", type = item.type === "photo" ? "photo" : "video";
    if (item.type === "photo") {
      url = normalizePhotoUrl(item.media_url_https || item.media_url || "");
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
      // Same CDN key the content script derives, so a photo listed from the
      // rendered DOM and the same photo parsed from GraphQL collapse into one
      // queue row instead of appearing twice.
      mediaKey: mediaKeyFromUrl(url),
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

async function clearDiscoveryRetry(state) {
  if (!state) return;
  state.retryAfterMs = 0;
  state.retryUntil = 0;
}

async function runProfileDiscovery(options, runId) {
  const state = await getDiscoveryState();
  if (!isCurrentDiscoveryRun(state, runId)) return;

  const previousListener = globalThis.rateLimitStatusListener;
  globalThis.rateLimitStatusListener = async (info) => {
    if (!isCurrentDiscoveryRun(state, runId)) return;
    const waitMs = Math.max(0, Number(info?.waitMs) || 0);
    state.retryAfterMs = waitMs;
    state.retryUntil = waitMs > 0 ? (Number(info?.until) || (Date.now() + waitMs)) : 0;
    if (waitMs > 0) {
      const seconds = Math.max(1, Math.ceil(waitMs / 1000));
      const attempt = info?.attempt && info?.maxAttempts ? ` (retry ${info.attempt}/${info.maxAttempts})` : "";
      state.status = `Rate limited — retrying in ${seconds}s${attempt}…`;
      state.error = null;
      state.errorCode = "rate_limited";
    } else if (state.errorCode === "rate_limited" && !state.error) {
      state.errorCode = null;
      state.status = `Fetching page ${state.pages + 1} — ${state.found} media found…`;
    }
    await saveDiscoveryState();
  };

  try {
    const username = normalizeProfileTarget(options.target);
    state.target = `@${username}`;
    state.status = "Reading current X session…";
    await clearDiscoveryRetry(state);
    await saveDiscoveryState();
    if (!isCurrentDiscoveryRun(state, runId)) return;
    const tab = await findXTab();
    if (!isCurrentDiscoveryRun(state, runId)) return;
    if (!tab?.id) throwClassifiedDiscoveryError("Open x.com in this Chrome profile and sign in before discovering media.", { code: "auth_required" });
    await refreshAuth(tab.id);
    if (!isCurrentDiscoveryRun(state, runId)) return;
    if (!csrfToken || !cookieStr) throwClassifiedDiscoveryError("No signed-in X session was found. Sign in to X in Chrome, then retry.", { code: "auth_required" });
    // Prefer an explicit auth_token cookie when present; ct0 alone can remain
    // after a partial logout and produce confusing 401s later.
    const authToken = await getCookie("auth_token");
    if (!authToken) throwClassifiedDiscoveryError("No signed-in X session was found. Sign in to X in Chrome, then retry.", { code: "auth_required" });
    state.status = "Reading current X page metadata…"; await saveDiscoveryState();
    if (!isCurrentDiscoveryRun(state, runId)) return;
    const operations = await getOperationIds(tab.id);
    if (!isCurrentDiscoveryRun(state, runId)) return;
    state.status = `Resolving @${username}…`; await saveDiscoveryState();
    if (!isCurrentDiscoveryRun(state, runId)) return;
    const userJson = await callDiscoveryGraphQL(
      operations.UserByScreenName,
      operations.userOperationName || "UserByScreenName",
      { screen_name: username, withSafetyModeUserFields: true },
      operations.userCapture
    );
    if (!isCurrentDiscoveryRun(state, runId)) return;
    const resolved = resolveUserResult(userJson);
    if (resolved.error) {
      const error = new Error(resolved.error.message);
      error.code = resolved.error.code;
      throw error;
    }
    const { userId } = resolved;
    let cursor = null, previousCursor = null;
    const seenMediaIds = new Set();
    const limit = normalizeDiscoveryLimit(options.limit);
    let emptyPages = 0;
    while (isCurrentDiscoveryRun(state, runId) && !state.stopRequested && state.found < limit) {
      state.status = `Fetching page ${state.pages + 1} — ${state.found} media found…`;
      state.error = null;
      if (state.errorCode === "rate_limited") state.errorCode = null;
      await clearDiscoveryRetry(state);
      await saveDiscoveryState();
      if (!isCurrentDiscoveryRun(state, runId)) return;
      // Prefer live-captured features/variables (Rank S). Fall back to defaults.
      const variables = buildUserMediaVariables(userId, cursor, operations.mediaCapture);
      const page = await callDiscoveryGraphQL(
        operations.UserMedia,
        operations.mediaOperationName || "UserMedia",
        variables,
        operations.mediaCapture
      );
      if (!isCurrentDiscoveryRun(state, runId)) return;
      const instructions = extractTimelineInstructions(page) || page;
      const tweets = [];
      collectTweets(instructions, tweets);
      const parsedItems = tweets
        .flatMap((tweet) => mediaFromTweet(tweet, username, Boolean(options.includeRetweets)))
        .map((item) => ({ ...item, source: "remote" }));
      const items = takeDiscoveryItems(parsedItems, seenMediaIds, limit - state.found);
      await addQueueItems(items, { orderedFrontIds: Array.from(seenMediaIds), source: "remote" });
      if (!isCurrentDiscoveryRun(state, runId)) return;
      state.found += items.length;
      state.pages++;
      previousCursor = cursor;
      cursor = findBottomCursor(instructions);
      if (!items.length) emptyPages += 1;
      else emptyPages = 0;
      // End when X stops paging, repeats a cursor, or returns multiple empty pages.
      if (!cursor || cursor === previousCursor || emptyPages >= 2) break;
    }
    if (!isCurrentDiscoveryRun(state, runId)) return;
    state.running = false;
    state.activeRunId = null;
    state.error = null;
    state.errorCode = null;
    await clearDiscoveryRetry(state);
    state.status = state.stopRequested
      ? `Discovery stopped — ${state.found} media found.`
      : state.found >= limit
        ? `Reached the ${limit.toLocaleString()} media limit.`
        : `Discovery complete — ${state.found} media found.`;
  } catch (error) {
    if (!isCurrentDiscoveryRun(state, runId)) return;
    const classified = classifyDiscoveryError(error, { code: error.code });
    state.running = false;
    state.activeRunId = null;
    state.error = classified.message;
    state.errorCode = classified.code;
    state.status = "Discovery needs attention";
    await clearDiscoveryRetry(state);
  } finally {
    globalThis.rateLimitStatusListener = previousListener;
  }
  await saveDiscoveryState();
}

async function handleDiscoveryMessage(msg) {
  const state = await getDiscoveryState();
  if (msg.action === "discoveryGet") return state;
  if (msg.action === "discoveryStop") {
    state.stopRequested = true;
    state.status = "Stopping after this page…";
    await saveDiscoveryState();
    return state;
  }
  if (msg.action === "discoveryStart") {
    if (state.running) return state;
    const runId = ++discoveryRunSerial;
    state.running = true;
    state.stopRequested = false;
    state.pages = 0;
    state.found = 0;
    state.target = String(msg.target || "");
    state.error = null;
    state.errorCode = null;
    state.retryAfterMs = 0;
    state.retryUntil = 0;
    state.status = "Starting discovery…";
    state.activeRunId = runId;
    await saveDiscoveryState();
    runProfileDiscovery(msg, runId).catch((error) => console.error("[X-DL BG] Discovery error", error));
    return state;
  }
  return null;
}

function inferHandleFromUrl(rawUrl) {
  try {
    const url = new URL(rawUrl || "");
    const first = url.pathname.split("/").filter(Boolean)[0] || "";
    return /^[A-Za-z0-9_]{1,15}$/.test(first) ? first : "unknown";
  } catch (_) {
    return "unknown";
  }
}

async function handleLocalTimelineCapture(message) {
  // No operation-name allowlist. X renames and adds timeline operations
  // frequently (Home, profile, /media, post detail, bookmarks all differ), and
  // gating on a fixed list is what made Home-timeline and same-tab route
  // changes capture nothing. Any GraphQL payload that parses into media counts.
  const capture = message.capture || {};
  const json = capture.json;
  if (!json || typeof json !== "object") return { ok: true, addedCount: 0, tweetIds: [] };
  const tweets = [];
  collectTweets(json, tweets);
  if (!tweets.length) return { ok: true, addedCount: 0, tweetIds: [] };

  const targetHandle = inferHandleFromUrl(message.pageUrl || "");
  const mediaFilter = message.mediaFilter === "photo" || message.mediaFilter === "video"
    ? message.mediaFilter
    : "all";
  const tweetIds = [];
  const items = [];
  for (const tweet of tweets) {
    const parsed = mediaFromTweet(tweet, targetHandle, true)
      .filter((item) => mediaFilter === "all" || item.type === mediaFilter);
    if (!parsed.length) continue;
    if (tweet.rest_id) tweetIds.push(String(tweet.rest_id));
    items.push(...parsed.map((item) => ({ ...item, source: "scroll" })));
  }
  if (!items.length) return { ok: true, addedCount: 0, tweetIds };
  const result = await addQueueItems(items, {
    source: "scroll",
    skipDownloaded: message.skipDownloaded !== false
  });
  return { ok: true, addedCount: result.addedCount, tweetIds };
}

// ==========================================================================
// MESSAGE HANDLER
// ==========================================================================

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const tabId = sender.tab?.id;

  // Live GraphQL/header captures from MAIN-world injected.js (via content.js).
  if (msg.action === "networkCapture") {
    rememberNetworkCapture(msg.capture || {});
    sendResponse({ ok: true });
    return false;
  }

  if (msg.action === "localTimelineCapture") {
    handleLocalTimelineCapture(msg)
      .then((result) => sendResponse(result))
      .catch((error) => {
        console.warn("[X-DL BG] Local timeline capture parse failed", error);
        sendResponse({ ok: false, error: error.message || "Local capture failed" });
      });
    return true;
  }

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

  // Download a single file
  if (msg.action === "downloadFile") {
    downloadFile(msg.url, msg.filename).then(sendResponse);
    return true;
  }
});
