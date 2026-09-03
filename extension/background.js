// ==========================================================================
// background.js — Service Worker for X Media Downloader
// Handles: auth, GraphQL API, media extraction, queue, direct downloads,
// and (v3.13) MP4→GIF conversion relayed to a GIF-only offscreen document.
// ==========================================================================

// Shared output engine here: naming/template/sanitize (lib/naming.js) and
// duplicate verification (lib/dedupe.js). The GIF encoder (lib/gifEncoder.js)
// loads only in the offscreen document — a worker has no <video>/canvas.
// Guarded so a packaging mistake degrades to raw downloads instead of killing
// the whole worker at parse time.
try {
  importScripts("lib/naming.js", "lib/dedupe.js");
} catch (error) {
  console.error("[X-DL BG] Failed to load lib/ scripts:", error);
}

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
  // ALWAYS force the original ("orig") resolution — GraphQL and DOM sources
  // may hand over pre-sized variants (name=small/medium/large), and the DOM
  // path (content.js normalizeDomPhotoUrl) already forces orig; both sources
  // must produce the same bytes and the same mediaKey.
  if (!rawUrl) return "";
  try {
    const url = new URL(rawUrl);
    url.searchParams.set("name", "orig");
    const format = url.searchParams.get("format");
    if (format) url.searchParams.set("format", String(format).toLowerCase());
    return url.toString();
  } catch (_) {
    if (!/[?&]name=/.test(rawUrl)) {
      return rawUrl.includes("?") ? `${rawUrl}&name=orig` : `${rawUrl}?name=orig`;
    }
    return rawUrl.replace(/([?&]name=)[^&]*/, "$1orig");
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
  // The last resort used to be `x-media/media_<random base36>.<ext>` — literal
  // "garbled random text" whenever Chrome rejected a naming path. Uniqueness is
  // already handled by `conflictAction: "uniquify"` in chromeDownloadOnce, so
  // the last candidate can be a deterministic, readable name instead. The
  // `download_` prefix keeps it distinct from the `x-media/<stem>` rung even
  // when the original path's first segment is already `x-media` (otherwise the
  // dedupe below collapses two rungs into one).
  const candidates = [
    cleaned,
    `${folder}/${safeStem}.${ext}`,
    `x-media/${safeStem}.${ext}`,
    `x-media/download_${safeStem}.${ext}`
  ];
  return candidates.filter((value, index, list) => value && list.indexOf(value) === index);
}

// Photo extension derived from a CDN URL, matching content.js `getPhotoExtension`
// exactly. The DOM path (content.js mediaEntryToItem) and the discovery path
// (mediaItemsFromTweetObject via resolveTweetMedia) must produce the SAME
// extension for the SAME photo or a photo listed from the rendered DOM and the
// same photo parsed from GraphQL would get different filenames. The old inline
// `url.split("?")[0].split(".").pop()` fallback returned the WHOLE host path
// (e.g. "commediaabc") for a bare URL with no `format` param and no file
// extension, so this favours the explicit `format` param, then a known pathname
// extension, and only then the safe default "jpg".
function photoExtensionFromUrl(url) {
  try {
    const parsed = new URL(url, "https://x.com");
    const format = (parsed.searchParams.get("format") || "").toLowerCase();
    if (["png", "webp", "jpg", "jpeg"].includes(format)) return format === "jpeg" ? "jpg" : format;
    const path = parsed.pathname.toLowerCase();
    if (path.endsWith(".png")) return "png";
    if (path.endsWith(".webp")) return "webp";
  } catch (_) {
    const clean = String(url || "").split("?")[0].toLowerCase();
    if (clean.endsWith(".png")) return "png";
    if (clean.endsWith(".webp")) return "webp";
  }
  return "jpg";
}

// ONE media resolver for both media-extraction paths. The single-post GraphQL
// path (getTweetMedia) and the timeline/discovery path (mediaItemsFromTweetObject)
// used to each re-implement the same rules for picking a downloadable CDN URL —
// photo URLs forced to orig resolution, MP4 clips to the highest-bitrate
// variant, and GIF detection. Keeping it in one place means the two paths can
// never drift apart again. Returns null for media with no usable URL.
function resolveTweetMedia(item) {
  if (!item) return null;
  if (item.type === "photo") {
    const url = normalizePhotoUrl(item.media_url_https || item.media_url || "");
    if (!url) return null;
    return { url, kind: "photo", extension: photoExtensionFromUrl(url), isGif: false, bitrate: null };
  }
  if (item.type === "video" || item.type === "animated_gif") {
    // X delivers animated_gif media as a silent MP4 clip; keep kind "video"
    // (capture filters and existing queues treat GIFs as motion media) and
    // flag it so download time can convert it back into a real .gif.
    const variants = (item.video_info?.variants || []).filter((variant) => variant.content_type === "video/mp4");
    variants.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
    const best = variants[0];
    if (!best?.url) return null;
    return { url: best.url, kind: "video", extension: "mp4", isGif: item.type === "animated_gif", bitrate: best.bitrate || 0 };
  }
  return null;
}

// ==========================================================================
// OUTPUT SETTINGS — master folder, name template, output format (v3.5)
// ==========================================================================
// Stored in chrome.storage.sync and written ONLY by the Side Panel settings
// card. Every downloading context receives them through this plain settings
// bag; the offscreen document gets them relayed inside the job message and
// never touches chrome.storage itself (offscreen documents expose only
// chrome.runtime — a storage call there crashes the whole download).

const OUTPUT_SETTINGS_DEFAULTS = {
  rawMasterFolder: "XMedia", // "" (empty) = master folder OFF → old flat layout
  nameTemplate: "{user} - {text} - {id}",
  outputFormat: "raw", // kept for legacy stored values; worker always forces raw (v3.12+)
  // v3.11 — per-user folders:
  //   ON  → XMedia/<user>/<post name>/001.jpg (the user = the owning post's
  //         author, so media from the home timeline, a profile and the
  //         /media page of the SAME user collapse into one folder).
  //   OFF → XMedia/<post name>/001.jpg (pre-v3.11 layout).
  userFolders: true,
  // v3.6/v3.14 — GIF handling:
  //   "gif"     → real .gif, balanced (small files)
  //   "gif-max" → real .gif, maximum quality (local palettes + dithering, larger)
  //   "apng"    → true-color APNG (closest to MP4 quality, larger)
  //   "mp4"     → keep the original MP4 clip
  gifOutput: "gif",
  // v3.10 — duplicate verification:
  verifyDuplicates: true // byte-identical + source-URL checks before a file is saved again
};

function normalizeGifOutput(value) {
  const v = String(value || "").toLowerCase();
  return v === "mp4" ? "mp4" : v === "gif-max" ? "gif-max" : v === "apng" ? "apng" : "gif";
}

// A corrupt/legacy stored value must degrade to the shipped defaults, never
// to a surprise behavior.
function normalizeOutputSettings(stored) {
  const merged = { ...OUTPUT_SETTINGS_DEFAULTS, ...(stored || {}) };
  merged.gifOutput = normalizeGifOutput(merged.gifOutput);
  merged.verifyDuplicates = merged.verifyDuplicates !== false;
  merged.userFolders = merged.userFolders !== false;
  return merged;
}

async function getOutputSettings() {
  const sync = chrome.storage?.sync;
  if (!sync?.get) return normalizeOutputSettings(null);
  try {
    const stored = await new Promise((resolve) => {
      const done = (values) => resolve(values || {});
      // Chrome supports both promise and callback styles across versions.
      const maybe = sync.get(OUTPUT_SETTINGS_DEFAULTS, done);
      if (maybe && typeof maybe.then === "function") maybe.then(done, () => done({}));
    });
    return normalizeOutputSettings(stored);
  } catch (_) {
    return normalizeOutputSettings(null);
  }
}

// Template fields for one queue item's owning post.
function namingFieldsForItem(item) {
  return {
    // An absent author is genuinely unknown: do not turn it into a
    // literal "unknown" user folder. The raw-path builder deliberately omits
    // that segment when no owning author is available.
    user: String(item?.author || "").replace(/^@/, "").trim(),
    name: item?.displayName || "",
    text: item?.text || "",
    id: item?.tweetId || "",
    date: item?.date || ""
  };
}

function extensionForItem(item) {
  const fromFilename = String(item?.filename || "").match(/\.([a-z0-9]{1,5})$/i)?.[1];
  if (fromFilename) return fromFilename.toLowerCase();
  const url = String(item?.url || "");
  const fromFormat = url.match(/[?&]format=([a-z0-9]+)/i)?.[1];
  if (fromFormat) return fromFormat.toLowerCase();
  const fromPath = url.split("?")[0].match(/\.([a-z0-9]{1,5})$/i)?.[1];
  if (fromPath) return fromPath.toLowerCase();
  return item?.type === "video" ? "mp4" : "jpg";
}

// Media kind of a queue item: "photo" | "gif" | "video". GIF items keep
// type "video" (X delivers them as MP4 clips, and the photo/video capture
// filter must keep treating them as motion media) plus an isGif flag.
function mediaKindOfItem(item) {
  if (item?.isGif || item?.type === "animated_gif") return "gif";
  return item?.type === "video" ? "video" : "photo";
}

// Raw (loose file) download path for a queue item:
//   master folder ON  → <Master>/<templated post name>/001.jpg…
//   master folder OFF → the item's legacy flat x-media/… filename, unchanged,
//                       so emptying the box restores the old layout exactly.
// Items persisted by older versions carry no text/mediaIndex metadata; they
// keep their stored filename under the master folder rather than guessing.
// `extOverride` swaps the extension (e.g. "gif" after MP4→GIF conversion)
// in BOTH layouts without touching the stored legacy filename.
function rawPathForItem(item, settings, extOverride) {
  const naming = globalThis.XDLNaming;
  if (!naming) return item.filename;
  const swapExt = (path) => (extOverride ? String(path || "").replace(/\.[a-z0-9]{1,5}$/i, `.${extOverride}`) : path);
  const master = naming.normalizeRawMasterFolder(settings?.rawMasterFolder);
  if (master === "") return swapExt(item.filename);
  if (item.mediaIndex === undefined || item.mediaIndex === null) {
    // Legacy rows carry no naming metadata but DO carry the owning post's
    // author, so the per-user folder (when enabled) can still be honored.
    // The author is read directly (not through namingFieldsForItem, which
    // would inject an "unknown" bucket for rows that never had one).
    const legacyLeaf = String(swapExt(item.filename) || "media.bin").split("/").pop();
    const rawUser = settings?.userFolders === false ? "" : String(item.author || "").replace(/^@/, "").trim();
    const root = rawUser ? `${master}/${naming.userFolderName({ user: rawUser })}` : master;
    return naming.sanitizeArtifactFilename(`${root}/${legacyLeaf}`, `XMedia/${legacyLeaf}`);
  }
  return naming.buildRawMediaPath(
    { rawMasterFolder: master, nameTemplate: settings?.nameTemplate, userFolders: settings?.userFolders },
    namingFieldsForItem(item),
    item.mediaIndex,
    extOverride || extensionForItem(item),
    swapExt(item.filename)
  ) || swapExt(item.filename);
}

// Raw download source + path for one item. GIF items are converted from X's
// MP4 clip into a real .gif (balanced or maximum quality) or a true-color
// APNG by the offscreen document (canvas + GIF89a/APNG encoder); the
// resulting data: URL goes through chrome.downloads, which — unlike blob:
// URLs — honors the filename argument including subfolders, so converted
// files still land inside the master folder. Every failure mode (no
// offscreen API, conversion error, oversized result) degrades to the
// original MP4 rather than failing the item.
async function prepareRawDownload(item, settings) {
  const output = normalizeGifOutput(settings?.gifOutput);
  if (mediaKindOfItem(item) === "gif" && output !== "mp4") {
    const converted = await convertGifViaOffscreen(item.url, output);
    if (converted?.ok && converted.base64) {
      const ext = output === "apng" ? "apng" : "gif";
      const mime = output === "apng" ? "image/apng" : "image/gif";
      return { url: `data:${mime};base64,${converted.base64}`, filename: rawPathForItem(item, settings, ext) };
    }
    console.warn("[X-DL BG] GIF/APNG conversion unavailable, keeping the MP4 source:", converted?.error || "offscreen document unavailable");
  }
  return { url: item.url, filename: rawPathForItem(item, settings) };
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
    if (meta.shouldAbort?.()) return;
    const remaining = endedAt - Date.now();
    await new Promise((resolve) => setTimeout(resolve, Math.min(1000, remaining)));
    if (Date.now() < endedAt) await notifyRateLimitWait(endedAt - Date.now(), meta);
  }
  await notifyRateLimitWait(0, meta);
}

async function rateLimitWait(options = {}) {
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
    if (options.shouldAbort?.()) return;
  }

  lastRequestTime = Date.now();
}

// options.shouldAbort: optional callback — when it returns true (e.g. the user
// pressed Stop scan during a discovery retry), the wait/retry loop stops on
// the next tick and `{ aborted: true }` is returned instead of a response.
async function fetchWithRetry(url, headers, maxRetries = 4, options = {}) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (options.shouldAbort?.()) return { aborted: true };
    await rateLimitWait(options);
    if (options.shouldAbort?.()) return { aborted: true };

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
        status: resp.status,
        shouldAbort: options.shouldAbort
      });
      if (options.shouldAbort?.()) return { aborted: true };

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

  // Extract media from legacy.extended_entities. The quoted ("mentioned") post
  // shown as a small card on this post contributes its own media too — each
  // item carries its owning post's attribution (username/tweetId/text/isQuote)
  // so callers can name and dedupe it against the post that owns the media.
  const legacy = tweet.legacy || {};

  // Extract user info
  const user = tweet.core?.user_results?.result?.legacy || {};
  const username = user.screen_name || "unknown";
  const tweetText = legacy.full_text || legacy.text || "";

  // Extract all media (videos + photos), own post first, then the quoted card.
  const videos = [];
  const photos = [];

  const collectTweetMediaEntries = (owner, isQuote) => {
    const ownerLegacy = owner.legacy || {};
    const ownerUser = owner.core?.user_results?.result?.legacy || {};
    const ownerUsername = ownerUser.screen_name || username;
    const ownerDisplayName = ownerUser.name || "";
    const ownerText = ownerLegacy.full_text || ownerLegacy.text || tweetText;
    const ownerTweetId = owner.rest_id || tweetId;
    const ownerDate = ownerLegacy.created_at || "";
    const mediaItems = ownerLegacy.extended_entities?.media || ownerLegacy.entities?.media || [];
    // Position within the OWNING post's media list — drives the 001…004
    // numbering inside the master folder. URL selection, GIF detection, and
    // extension come from the shared resolveTweetMedia so the single-post
    // path and the timeline path use identical rules.
    let mediaIndex = -1;
    for (const m of mediaItems) {
      mediaIndex += 1;
      const resolved = resolveTweetMedia(m);
      if (!resolved) continue;
      if (resolved.kind === "photo") {
        photos.push({
          url: resolved.url,
          mediaId: m.id_str || m.id,
          type: "photo",
          username: ownerUsername,
          displayName: ownerDisplayName,
          tweetId: ownerTweetId,
          text: ownerText,
          date: ownerDate,
          mediaIndex,
          isQuote
        });
      } else {
        videos.push({
          url: resolved.url,
          bitrate: resolved.bitrate,
          mediaId: m.id_str || m.id,
          // Keep the raw X media type ("video" | "animated_gif") so the content
          // script can still detect GIFs via `entry.type === "animated_gif"`.
          type: m.type,
          username: ownerUsername,
          displayName: ownerDisplayName,
          tweetId: ownerTweetId,
          text: ownerText,
          date: ownerDate,
          mediaIndex,
          isQuote
        });
      }
    }
  };

  collectTweetMediaEntries(tweet, false);
  const quoted = quotedTweetFrom(tweet);
  if (quoted?.rest_id && quoted.rest_id !== String(tweetId)) collectTweetMediaEntries(quoted, true);

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

// Best-effort SHA-256 + size of a media URL, streamed so a large video is
// never held in memory. Failures return a thrown error which callers must
// catch — byte verification must never block a download.
const MAX_DIGEST_BYTES = 512 * 1024 * 1024;

async function computeMediaDigest(url) {
  const dedupe = globalThis.XDLDedupe;
  if (!dedupe || !url) throw new Error("Byte verification is unavailable.");
  const response = await fetch(url, { credentials: "omit" });
  if (!response.ok) {
    throw new Error("Media digest fetch failed (" + response.status + ") for " + url);
  }
  const body = response.body;
  if (body && typeof body.getReader === "function") {
    const reader = body.getReader();
    const hasher = new dedupe.Sha256();
    let size = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        if (chunk.value && chunk.value.byteLength > 0) {
          hasher.update(chunk.value);
          size += chunk.value.byteLength;
          if (size > MAX_DIGEST_BYTES) {
            throw new Error("Media exceeds the byte-verification size bound.");
          }
        }
      }
    } finally {
      try { reader.releaseLock(); } catch (_) { /* stream already closed */ }
    }
    return { hash: hasher.digestHex(), size };
  }
  // No stream (older Chromium / test mocks): one-shot arrayBuffer path.
  const buffer = await response.arrayBuffer();
  if (!buffer || buffer.byteLength < 32) {
    throw new Error("Media digest response was empty for " + url);
  }
  const bytes = new Uint8Array(buffer);
  return { hash: dedupe.hashBytes(bytes), size: bytes.byteLength };
}

async function downloadFile(url, filename, options = {}) {
  // v3.10: verify `url` against the downloaded-history store BEFORE Chrome
  // starts another copy. Two checks, in priority order:
  //   1. source URL  — canonical scheme+host+path (the same media address).
  //   2. byte hash    — SHA-256 of the media; catches byte-identical content
  //                     served from a DIFFERENT URL (size variants, mirrors).
  // A verification failure (network hiccup, huge file) falls back to the
  // historical direct-download behavior — dedupe is best-effort, never a
  // reason to lose a download.
  const item = options.item || null;
  const dedupe = globalThis.XDLDedupe;
  const verify = options.verifyBytes !== false && Boolean(dedupe);
  // Identity belongs to the SOURCE media (item.url), not to a transformed
  // payload URL (e.g. a data: URL carrying GIF-converted bytes). The digest
  // below still covers the exact bytes being saved.
  const sourceUrl = item?.url || url;
  let sourceUrlKey = null;
  let digest = null;
  let duplicate = null;
  let duplicateReason = null;

  if (verify && url) {
    sourceUrlKey = dedupe.canonicalSourceUrl(sourceUrl);
    if (sourceUrlKey) {
      const urlMatch = await findDownloadedBySourceUrl(sourceUrl);
      if (urlMatch) {
        duplicate = urlMatch;
        duplicateReason = "duplicate_url";
        // Only a FINISHED download (non-pending) actually exists on disk; a
        // pending match belongs to a download still in flight, so nothing is
        // persisted yet — the first download's completion writes the record.
        if (!urlMatch.pending) {
          await rememberDownloadedRecord(downloadedRecordFor(item, sourceUrl, sourceUrlKey, null, null, urlMatch));
        }
        return {
          success: true,
          skipped: true,
          reason: duplicateReason,
          duplicate,
          note: dedupe.duplicateNote(duplicateReason, urlMatch),
          sourceUrlKey,
          digest: null,
          filename
        };
      }
      try {
        digest = await computeMediaDigest(url);
        const hashMatch = await findDownloadedByHashValue(digest.hash);
        if (hashMatch) {
          duplicate = hashMatch;
          duplicateReason = "duplicate_bytes";
          if (!hashMatch.pending) {
            await rememberDownloadedRecord(downloadedRecordFor(item, sourceUrl, sourceUrlKey, digest.hash, digest.size, hashMatch));
          }
          return {
            success: true,
            skipped: true,
            reason: duplicateReason,
            duplicate,
            note: dedupe.duplicateNote(duplicateReason, hashMatch),
            sourceUrlKey,
            digest,
            filename
          };
        }
        reservePendingDigest(sourceUrlKey, digest);
      } catch (error) {
        console.warn("[X-DL BG] Byte verification unavailable, downloading anyway:", error?.message || error);
      }
    }
  }

  // Rank S retries Invalid filename with progressively safer paths so a long
  // post-text snippet cannot brick an otherwise valid CDN URL.
  const candidates = buildFallbackFilenames(filename);
  let lastError = "Download failed";
  for (const candidate of candidates) {
    const result = await chromeDownloadOnce(url, candidate);
    if (result.success) {
      // Direct (one-click) downloads: hold the digest until Chrome reports the
      // file completed, then it joins the verification history. Queue items
      // are excluded — their completion is reconciled through the queue item
      // (status + onChanged), so attaching a second record would shadow it.
      if (item && options.trackCompletion !== false && (digest?.hash || sourceUrlKey)) {
        pendingDownloadRecords.set(
          result.downloadId,
          downloadedRecordFor(item, sourceUrl, sourceUrlKey, digest?.hash, digest?.size, null)
        );
        if (pendingDownloadRecords.size > PENDING_RECORDS_MAX) {
          pendingDownloadRecords.delete(pendingDownloadRecords.keys().next().value);
        }
      }
      if (candidate !== candidates[0]) {
        console.log("[X-DL BG] Download started with fallback filename:", candidate, "id:", result.downloadId);
      } else {
        console.log("[X-DL BG] Download started:", candidate, "id:", result.downloadId);
      }
      return { success: true, downloadId: result.downloadId, filename, digest, sourceUrlKey };
    }
    lastError = result.error || lastError;
    const invalid = /invalid filename|invalid file path|path is invalid/i.test(lastError);
    if (!invalid) {
      console.error("[X-DL BG] Download error:", lastError);
      return { success: false, error: lastError, digest, sourceUrlKey };
    }
    console.warn("[X-DL BG] Invalid filename, retrying with safer path:", candidate, "→", lastError);
  }
  console.error("[X-DL BG] Download error after fallbacks:", lastError);
  return { success: false, error: lastError, digest, sourceUrlKey };
}

// ==========================================================================
// PERSISTENT DOWNLOAD QUEUE — schedules only after prior downloads finish
// ==========================================================================
const QUEUE_STORAGE_KEY = "batchDownloadQueueV1";
const QUEUE_DEFAULT = { items: [], concurrency: 2, running: false, stopped: false, skipDownloaded: true, outputFormat: "raw", notices: [] };
const MAX_DOWNLOAD_ATTEMPTS = 3;
let queueState = null;
let queueSaving = Promise.resolve();
let queueProcessing = Promise.resolve();

// --- Throttled `queueChanged` broadcast ------------------------------------
// `saveQueueState()` is called on every queue mutation AND on every
// chrome.downloads.onChanged bytesReceived tick, so a long multi-file download
// can fire dozens of `queueChanged` runtime messages a second. The Side Panel
// only needs the latest state, not every intermediate one. Coalesce broadcasts
// to at most one per tick window: the first call emits immediately, and any
// calls arriving inside the window are folded into one trailing emit carrying
// the newest state. A trailing emit is scheduled with setTimeout instead of a
// leading timer so the worker is never held awake purely by the throttle.
const QUEUE_CHANGED_TICK_MS = 250;
let queueChangedTimer = null;
let queueChangedPending = false;

function broadcastQueueChanged() {
  // Leading edge: emit immediately so the Side Panel stays responsive.
  if (!queueChangedTimer) {
    chrome.runtime.sendMessage({ action: "queueChanged" }).catch(() => {});
    queueChangedTimer = setTimeout(() => {
      queueChangedTimer = null;
      // Trailing edge: anything a burst of writes stacked inside the window is
      // folded into ONE final emit carrying the newest state. sendMessage here
      // carries no payload, so the Side Panel just re-reads the freshest state.
      if (queueChangedPending) {
        queueChangedPending = false;
        chrome.runtime.sendMessage({ action: "queueChanged" }).catch(() => {});
      }
    }, QUEUE_CHANGED_TICK_MS);
    return;
  }
  // A timer is already running — a leading emit already went out. Remember that
  // the state changed again so the trailing emit conveys the newest snapshot.
  queueChangedPending = true;
}

// --- Completed-download history (Rank S "Ignore saved") -------------------
// Remembers queue item ids that finished successfully so the same media is not
// re-listed after the user clears the visible history. Ids only — no URLs,
// no tokens, no post content.
// v3.10 extends this to a RICH record store (downloadedMediaRecordsV1) so the
// two duplicate verifications can be answered:
//   - same source URL  → urlKey (canonical scheme+host+path)
//   - byte-identical   → SHA-256 of the actual media bytes
// The legacy id list stays in sync (same id values) so every older code path
// and the "Reset downloaded history" button keep working unchanged.
const DOWNLOADED_STORAGE_KEY = "downloadedMediaIdsV1";
const DOWNLOADED_RECORDS_KEY = "downloadedMediaRecordsV1";
const DOWNLOADED_HISTORY_MAX = 20000;
const PENDING_DIGEST_TTL_MS = 10 * 60 * 1000;
let downloadedIds = null;
let downloadedRecords = null;
let downloadedSaving = Promise.resolve();
let downloadedByUrl = null;   // urlKey → record (source-URL verification)
let downloadedByHash = null;  // hash → record (byte-identical verification)
let downloadedByMediaKey = null;
// Digests computed for downloads that are still in flight. A second item with
// the same bytes/URL arriving in the SAME run skips before the first one's
// record is persisted, so two concurrent queue slots cannot both save it.
let pendingDigests = new Map(); // urlKey → { hash, size, at }
// Direct (non-queue) downloads have no queue item to carry the digest, so the
// record sits here keyed by downloadId until chrome.downloads.onChanged says
// the file completed.
let pendingDownloadRecords = new Map(); // downloadId → record seed
const PENDING_RECORDS_MAX = 500;

function isDownloadedRecord(record) {
  return Boolean(
    record && typeof record === "object" &&
    (record.id || record.mediaKey || record.urlKey || record.hash)
  );
}

function rebuildDownloadedIndexes() {
  downloadedByUrl = new Map();
  downloadedByHash = new Map();
  downloadedByMediaKey = new Map();
  for (const record of downloadedRecords || []) {
    if (record.urlKey && !downloadedByUrl.has(record.urlKey)) downloadedByUrl.set(record.urlKey, record);
    if (record.hash && !downloadedByHash.has(record.hash)) downloadedByHash.set(record.hash, record);
    if (record.mediaKey && !downloadedByMediaKey.has(record.mediaKey)) downloadedByMediaKey.set(record.mediaKey, record);
  }
}

async function getDownloadedRecords() {
  if (downloadedRecords) return downloadedRecords;
  const [recordStore, legacyStore] = await Promise.all([
    chrome.storage.local.get(DOWNLOADED_RECORDS_KEY),
    chrome.storage.local.get(DOWNLOADED_STORAGE_KEY)
  ]);
  const list = Array.isArray(recordStore[DOWNLOADED_RECORDS_KEY]) ? recordStore[DOWNLOADED_RECORDS_KEY] : [];
  downloadedRecords = list.filter(isDownloadedRecord);
  rebuildDownloadedIndexes();
  // Legacy histories (ids saved by older versions) are still honoured without
  // needing a migration: they are folded into the id set on first use.
  const legacyIds = Array.isArray(legacyStore[DOWNLOADED_STORAGE_KEY]) ? legacyStore[DOWNLOADED_STORAGE_KEY] : [];
  if (!downloadedIds) {
    downloadedIds = new Set(legacyIds.filter((id) => typeof id === "string" && id));
    for (const record of downloadedRecords) {
      if (record.id) downloadedIds.add(record.id);
      if (Array.isArray(record.ids)) record.ids.forEach((id) => downloadedIds.add(String(id)));
    }
  }
  return downloadedRecords;
}

async function getDownloadedIds() {
  if (downloadedIds) return downloadedIds;
  await getDownloadedRecords();
  return downloadedIds;
}

async function saveDownloadedIds() {
  if (!downloadedIds) return;
  // Keep the newest ids when the history grows past the cap.
  const list = Array.from(downloadedIds);
  const trimmed = list.length > DOWNLOADED_HISTORY_MAX ? list.slice(list.length - DOWNLOADED_HISTORY_MAX) : list;
  if (trimmed.length !== list.length) downloadedIds = new Set(trimmed);
  // Catch so one rejected storage write cannot poison every later save on the
  // same promise chain (the in-memory state stays authoritative).
  downloadedSaving = downloadedSaving
    .then(() => chrome.storage.local.set({ [DOWNLOADED_STORAGE_KEY]: trimmed }))
    .catch(() => {});
  await downloadedSaving;
}

async function saveDownloadedRecords() {
  if (!downloadedRecords) return;
  const list = downloadedRecords;
  const trimmed = list.length > DOWNLOADED_HISTORY_MAX ? list.slice(list.length - DOWNLOADED_HISTORY_MAX) : list;
  if (trimmed.length !== list.length) {
    downloadedRecords = trimmed;
    rebuildDownloadedIndexes();
  }
  const ids = [];
  for (const record of downloadedRecords) {
    if (record.id) ids.push(record.id);
    if (Array.isArray(record.ids)) record.ids.forEach((id) => ids.push(String(id)));
  }
  downloadedSaving = downloadedSaving
    .then(() => chrome.storage.local.set({
      [DOWNLOADED_RECORDS_KEY]: downloadedRecords,
      [DOWNLOADED_STORAGE_KEY]: ids.slice(0, DOWNLOADED_HISTORY_MAX)
    }))
    .catch(() => {});
  await downloadedSaving;
}

async function rememberDownloadedId(id) {
  if (!id) return;
  const history = await getDownloadedIds();
  if (history.has(id)) return;
  history.add(id);
  await saveDownloadedIds();
}

// Normalize an incoming record; computes urlKey from url when missing.
function normalizeDownloadedRecord(input) {
  if (!input || typeof input !== "object") return null;
  const dedupe = globalThis.XDLDedupe;
  const url = String(input.url || "");
  const urlKey = String(
    input.urlKey ||
    (url ? (dedupe ? dedupe.canonicalSourceUrl(url) : url) : "")
  );
  const hash = String(input.hash || "");
  if (!input.id && !input.mediaKey && !urlKey && !hash) return null;
  return {
    id: String(input.id || ""),
    mediaKey: String(input.mediaKey || ""),
    url,
    urlKey,
    hash,
    size: Number(input.size) || 0,
    filename: String(input.filename || ""),
    at: Number(input.at) || Date.now()
  };
}

function findDownloadedRecordByUrl(urlKey) {
  return urlKey ? (downloadedByUrl?.get(urlKey) || null) : null;
}
function findDownloadedRecordByHash(hash) {
  return hash ? (downloadedByHash?.get(hash) || null) : null;
}
function findDownloadedRecordByMediaKey(mediaKey) {
  return mediaKey ? (downloadedByMediaKey?.get(mediaKey) || null) : null;
}
function findDownloadedRecordById(id) {
  if (!id || !downloadedRecords) return null;
  const value = String(id);
  return downloadedRecords.find(
    (record) => record.id === value || (Array.isArray(record.ids) && record.ids.includes(value))
  ) || null;
}

async function findDownloadedBySourceUrl(url) {
  if (!url) return null;
  await getDownloadedRecords();
  const dedupe = globalThis.XDLDedupe;
  const urlKey = dedupe ? dedupe.canonicalSourceUrl(url) : String(url);
  const record = findDownloadedRecordByUrl(urlKey);
  if (record) return record;
  const pending = pendingDigests.get(urlKey);
  return pending ? { ...pending, pending: true } : null;
}

async function findDownloadedByHashValue(hash) {
  if (!hash) return null;
  await getDownloadedRecords();
  const record = findDownloadedRecordByHash(hash);
  if (record) return record;
  const now = Date.now();
  for (const [urlKey, entry] of pendingDigests) {
    if (now - entry.at > PENDING_DIGEST_TTL_MS) pendingDigests.delete(urlKey);
    else if (entry.hash === hash) return { ...entry, pending: true, urlKey };
  }
  return null;
}

function reservePendingDigest(urlKey, digest) {
  if (!urlKey || !digest?.hash) return;
  const now = Date.now();
  for (const [key, entry] of pendingDigests) {
    if (now - entry.at > PENDING_DIGEST_TTL_MS) pendingDigests.delete(key);
  }
  pendingDigests.set(urlKey, { hash: digest.hash, size: digest.size || 0, at: now });
}

// Record builder shared by queue items and direct per-post downloads.
function downloadedRecordFor(item, url, urlKey, hash, size, match) {
  return normalizeDownloadedRecord({
    id: String(item?.id || match?.id || ""),
    mediaKey: String(item?.mediaKey || match?.mediaKey || ""),
    url: url || item?.url || match?.url || "",
    urlKey: urlKey || match?.urlKey || "",
    hash: hash || match?.hash || "",
    size: size || match?.size || 0,
    filename: String(item?.filename || match?.filename || ""),
    at: Date.now()
  });
}

// Merge `input` into the downloaded-history store (dedupe by id/url/hash).
async function rememberDownloadedRecord(input) {
  const record = normalizeDownloadedRecord(input);
  if (!record) return null;
  await getDownloadedRecords();
  const existing =
    findDownloadedRecordByUrl(record.urlKey) ||
    findDownloadedRecordByHash(record.hash) ||
    findDownloadedRecordById(record.id) ||
    findDownloadedRecordByMediaKey(record.mediaKey);
  const merged = globalThis.XDLDedupe
    ? globalThis.XDLDedupe.mergeRecords(existing, record)
    : { ...(existing || {}), ...record, at: Date.now() };
  const identity = (candidate) => String(candidate?.id || "");
  downloadedRecords = downloadedRecords.filter(
    (candidate) =>
      candidate !== existing &&
      (!merged.id || identity(candidate) !== identity(merged)) &&
      candidate?.urlKey !== merged.urlKey &&
      candidate?.hash !== merged.hash
  );
  downloadedRecords.push(merged);
  rebuildDownloadedIndexes();
  const history = await getDownloadedIds();
  if (merged.id) history.add(merged.id);
  if (Array.isArray(merged.ids)) merged.ids.forEach((id) => history.add(String(id)));
  await saveDownloadedRecords();
  return merged;
}

// One completed item → remembered record (called from onChanged and restart
// reconciliation).
async function rememberCompletedDownload(item, downloadId) {
  if (!item) return null;
  let filename = "";
  if (downloadId !== undefined && downloadId !== null) {
    const matches = await searchDownloads({ id: downloadId });
    filename = matches.find((match) => match.id === downloadId)?.filename || "";
  }
  const dedupe = globalThis.XDLDedupe;
  const url = String(item.url || "");
  const urlKey = item.sourceUrlKey || (dedupe ? dedupe.canonicalSourceUrl(url) : url);
  const record = await rememberDownloadedRecord({
    id: item.id,
    mediaKey: item.mediaKey,
    url,
    urlKey,
    hash: item.digest?.hash,
    size: item.digest?.size,
    filename: filename || item.filename || "",
    at: Date.now()
  });
  await rememberDownloadedId(item.id);
  return record;
}

async function getDownloadedUrlKeys() {
  const records = await getDownloadedRecords();
  const keys = new Set();
  for (const record of records) if (record.urlKey) keys.add(record.urlKey);
  return keys;
}

async function findDownloadedForItem(item) {
  if (!item) return null;
  await getDownloadedRecords();
  const dedupe = globalThis.XDLDedupe;
  const urlKey = item.sourceUrlKey || (dedupe && item.url ? dedupe.canonicalSourceUrl(item.url) : "");
  return (
    findDownloadedRecordByUrl(urlKey) ||
    findDownloadedRecordByMediaKey(item.mediaKey) ||
    findDownloadedRecordById(item.id) ||
    null
  );
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
        await rememberCompletedDownload(normalized, download.id);
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
  // Catch so one rejected storage write cannot poison every later save on the
  // same promise chain (the in-memory state stays authoritative).
  queueSaving = queueSaving
    .then(() => chrome.storage.local.set({ [QUEUE_STORAGE_KEY]: queueState }))
    .catch(() => {});
  await queueSaving;
  // Coalesced so a long batch of downloads does not flood the Side Panel with a
  // runtime message on every queue mutation and every bytesReceived tick.
  broadcastQueueChanged();
}

function publicQueueState() {
  return queueState || { ...QUEUE_DEFAULT };
}

async function runQueuePass() {
  const state = await getQueueState();
  if (!state.running || state.stopped) return;
  const settings = await getOutputSettings();
  const active = state.items.filter((item) => ["starting", "downloading"].includes(item.status)).length;
  const slots = Math.max(0, state.concurrency - active);
  // Archive output was retired (v3.12): every queued item downloads as its own
  // original-resolution file. No archive pass exists anymore.
  const rawEligible = (item) => item.status === "queued";
  const nextItems = state.items.filter(rawEligible).slice(0, slots);
  for (const item of nextItems) {
    item.status = "starting";
    item.attempts = (item.attempts || 0) + 1;
    await saveQueueState();
    const prepared = await prepareRawDownload(item, settings);
    const result = await downloadFile(prepared.url, prepared.filename, {
      verifyBytes: settings.verifyDuplicates,
      item,
      trackCompletion: false // queue items are reconciled by the onChanged handler below
    });
    if (result.skipped) {
      // Byte-identical or same-source-URL duplicate: no new file is created,
      // but the row counts as done and joins the downloaded-history (with the
      // URL/hash attached) so it never comes back while "Skip already
      // downloaded" is on.
      item.status = "completed";
      item.error = null;
      item.note = result.note || "Already saved — duplicate skipped.";
      item.duplicateReason = result.reason || "";
      item.duplicateOf = result.duplicate?.filename || result.duplicate?.url || result.duplicate?.mediaKey || "";
      item.digest = result.digest || item.digest || null;
      item.sourceUrlKey = result.sourceUrlKey || item.sourceUrlKey || null;
      await rememberDownloadedId(item.id);
    } else if (result.success) {
      item.status = "downloading";
      item.downloadId = result.downloadId;
      item.digest = result.digest || item.digest || null;
      item.sourceUrlKey = result.sourceUrlKey || item.sourceUrlKey || null;
      item.error = null;
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

// ==========================================================================
// GIF/APNG CONVERSION — X's animated_gif media is a silent MP4 clip; a real
// .gif (balanced or maximum quality) or a true-color APNG is produced in a
// small offscreen document (<video> + canvas + the streaming GIF89a/APNG
// encoders). A worker has no DOM, so without the offscreen document the item
// degrades to its original MP4 — never a failed item.
// ==========================================================================
// The offscreen document exposes ONLY chrome.runtime (a storage/downloads
// call there crashes the document), so the job carries just the URL and the
// encoded bytes travel back as base64 (chunked when large). chrome.downloads
// honors the filename argument for data: URLs, so converted files still land
// inside the master folder.

const OFFSCREEN_DOCUMENT_PATH = "offscreen.html";

async function ensureOffscreenDocument() {
  const offscreen = chrome.offscreen;
  if (!offscreen?.createDocument) return false;
  try {
    if (offscreen.hasDocument && await offscreen.hasDocument()) return true;
    await offscreen.createDocument({
      url: OFFSCREEN_DOCUMENT_PATH,
      reasons: ["BLOBS"],
      justification: "Convert X's silent MP4 GIF clips into real animated .gif files."
    });
    return true;
  } catch (error) {
    // "Only a single offscreen document may be created" = it already exists.
    if (String(error?.message || error).toLowerCase().includes("single offscreen")) return true;
    console.warn("[X-DL BG] Offscreen document unavailable:", error);
    return false;
  }
}

// One request/response exchange with the offscreen document. A wedged
// document must fail the job, not hang the queue — hence the hard timeout.
function sendOffscreenRequest(action, payload, timeoutMs, timeoutError) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => { if (!settled) { settled = true; resolve(value); } };
    const timer = setTimeout(() => finish({ ok: false, error: timeoutError || "Offscreen request timed out" }), timeoutMs);
    try {
      chrome.runtime.sendMessage({ action, ...payload }, (response) => {
        clearTimeout(timer);
        if (chrome.runtime.lastError) finish({ ok: false, error: chrome.runtime.lastError.message });
        else finish(response || { ok: false, error: "No response from offscreen document" });
      });
    } catch (error) {
      clearTimeout(timer);
      finish({ ok: false, error: String(error?.message || error) });
    }
  });
}

// MP4 "GIF" → real .gif (balanced or maximum quality) or true-color APNG,
// converted in the offscreen document (a service worker has no
// <video>/canvas). Returns { ok, base64 } or { ok:false }.
// Large outputs are transferred chunked (max-quality GIF/APNG can exceed the
// size of a single runtime message): the offscreen document answers with the
// chunk count, then each 3 MB binary chunk is pulled by index and joined here.
async function convertGifViaOffscreen(url, output) {
  if (!(await ensureOffscreenDocument())) return { ok: false, error: "Offscreen document unavailable" };
  const jobId = `g-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const started = await sendOffscreenRequest(
    "offscreenConvertGif",
    { job: { url, output, jobId } },
    600000,
    "GIF conversion timed out"
  );
  if (!started?.ok) return started;
  const chunks = [];
  const total = Number(started.totalChunks) || 1;
  for (let i = 0; i < total; i++) {
    const chunk = await sendOffscreenRequest(
      "offscreenConvertGifChunk",
      { jobId, index: i },
      60000,
      "GIF chunk transfer timed out"
    );
    if (!chunk?.ok || typeof chunk.base64 !== "string") {
      return { ok: false, error: chunk?.error || "GIF chunk transfer failed" };
    }
    chunks.push(chunk.base64);
  }
  return { ok: true, base64: chunks.join("") };
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
  // v3.10: direct (one-click) downloads are not queue items; their digest
  // waits here until the file finishes, then joins the verification history.
  const pendingRecord = pendingDownloadRecords.get(delta.id);
  if (pendingRecord) {
    if (delta.state?.current === "complete") {
      pendingDownloadRecords.delete(delta.id);
      await rememberDownloadedRecord(pendingRecord);
    } else if (delta.state?.current === "interrupted") {
      pendingDownloadRecords.delete(delta.id);
    }
    return;
  }
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
    await rememberCompletedDownload(item, delta.id);
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

function sourceUrlKeyFor(item) {
  const dedupe = globalThis.XDLDedupe;
  return dedupe && item?.url ? dedupe.canonicalSourceUrl(item.url) : "";
}

function mergeQueueItems(state, candidates, orderedFrontIds = null, options = {}) {
  const knownIds = new Set(state.items.map((item) => item.id));
  // A photo can reach the queue twice with different ids: once from the
  // rendered DOM and once from the GraphQL payload for the same post. Collapse
  // on the CDN media key so the user never sees the same file listed twice.
  const knownKeys = new Set(state.items.map((item) => item.mediaKey).filter(Boolean));
  // v3.10 — source-URL identity too: two different id shapes can still carry
  // the SAME media address (e.g. older items with no mediaKey).
  const knownUrls = new Set(state.items.map(sourceUrlKeyFor).filter(Boolean));
  const alreadyDownloaded = options.alreadyDownloaded || null;
  const alreadyDownloadedUrls = options.alreadyDownloadedUrls || null;
  const additions = [];
  // Counted separately from `added` so a rescan can tell the user WHY nothing
  // came back: "already downloaded" is a setting they can change, "already in
  // the list" is not a problem at all. Without this the two look identical.
  let skippedDownloaded = 0;
  for (const candidate of candidates || []) {
    if (!candidate?.id || !candidate.url || knownIds.has(candidate.id)) continue;
    const mediaKey = candidate.mediaKey || null;
    const urlKey = sourceUrlKeyFor(candidate);
    if (mediaKey && knownKeys.has(mediaKey)) continue;
    if (urlKey && knownUrls.has(urlKey)) continue;
    if (alreadyDownloaded && (alreadyDownloaded.has(candidate.id) || (mediaKey && alreadyDownloaded.has(mediaKey)))) {
      skippedDownloaded += 1;
      continue;
    }
    if (alreadyDownloadedUrls && urlKey && alreadyDownloadedUrls.has(urlKey)) {
      skippedDownloaded += 1;
      continue;
    }
    knownIds.add(candidate.id);
    if (mediaKey) knownKeys.add(mediaKey);
    if (urlKey) knownUrls.add(urlKey);
    additions.push({ ...candidate, selected: false, status: "discovered", downloadId: null, attempts: 0, bytesReceived: 0, totalBytes: 0 });
  }

  if (!orderedFrontIds) {
    state.items.unshift(...additions);
    return { added: additions.length, skippedDownloaded };
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
  return { added: additions.length, skippedDownloaded };
}

async function addQueueItems(items, options = {}) {
  const state = await getQueueState();
  const source = options.source || null;
  const normalizedItems = (items || []).map((item) => source && !item.source ? { ...item, source } : item);
  const skipDownloaded = options.skipDownloaded !== undefined
    ? Boolean(options.skipDownloaded)
    : state.skipDownloaded !== false;
  const alreadyDownloaded = skipDownloaded ? await getDownloadedIds() : null;
  const alreadyDownloadedUrls = skipDownloaded ? await getDownloadedUrlKeys() : null;
  const merged = mergeQueueItems(state, normalizedItems, options.orderedFrontIds || null, {
    alreadyDownloaded,
    alreadyDownloadedUrls
  });
  await saveQueueState();
  return { state: publicQueueState(), addedCount: merged.added, skippedDownloaded: merged.skippedDownloaded };
}

async function handleQueueMessage(msg) {
  if (msg.action === "queueAdd") {
    // Content scripts need the accepted count so their local dedupe sets and
    // "listed" counter stay in step with the queue.
    const result = await addQueueItems(msg.items, {
      source: msg.source || null,
      skipDownloaded: msg.skipDownloaded
    });
    return { ...result.state, addedCount: result.addedCount, skippedDownloaded: result.skippedDownloaded };
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
    downloadedRecords = [];
    await saveDownloadedIds();
    await saveDownloadedRecords();
    pendingDigests.clear();
    rebuildDownloadedIndexes();
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
    // Archive output was retired (v3.12): every queue run is now a separate
    // original-resolution file. Ignore stale settings or old UI messages
    // rather than allowing an archived run from pre-v3.12 state.
    state.outputFormat = "raw";
    state.items.forEach((item) => {
      const sourceOk = !msg.source || (item.source || "remote") === msg.source;
      const allowed = sourceOk && (msg.mode === "all" || item.selected);
      if (allowed && ["discovered", "failed"].includes(item.status)) {
        // A user-triggered start is a fresh attempt budget. Without the reset,
        // a previously exhausted item (attempts == MAX) would be re-queued by
        // this button and then fail instantly without a real retry.
        item.status = "queued";
        item.attempts = 0;
        item.error = null;
      }
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
  // Catch so one rejected storage write cannot poison every later save on the
  // same promise chain (the in-memory state stays authoritative).
  discoverySaving = discoverySaving
    .then(() => chrome.storage.local.set({ [DISCOVERY_STORAGE_KEY]: snapshot }))
    .catch(() => {});
  await discoverySaving;
  broadcastQueueChanged();
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

async function callDiscoveryGraphQL(operationId, operationName, variables, capture = null, options = {}) {
  const params = new URLSearchParams({
    variables: JSON.stringify(variables),
    features: JSON.stringify(mergeDiscoveryFeatures(capture)),
    fieldToggles: JSON.stringify(mergeDiscoveryFieldToggles(capture))
  });
  const response = await fetchWithRetry(
    `https://x.com/i/api/graphql/${operationId}/${operationName}?${params}`,
    makeHeaders(),
    4,
    options
  );
  if (response?.aborted) throwClassifiedDiscoveryError("Discovery stopped.", { code: "stopped" });
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
  // Reposted and quoted posts are resolved from their parent post inside
  // mediaFromTweet (with correct attribution and the includeQuoted switch),
  // so their subtrees are pruned here to avoid collecting them twice.
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
    // Invisible bidi/format control characters (same strip lib/naming.js
    // applies) so legacy flat paths cannot render as scrambled text either.
    .replace(/[\u200b\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, "")
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

// The quoted ("mentioned") post renders inside X as a small card with its own
// thumbnail and text. Its full payload — author, text, and media variants — is
// embedded in the same GraphQL response under legacy.quoted_status_result, so
// no extra request is needed to fetch it (Rank S Plucker resolves media through
// this exact field). One level only: a quote-of-quote is not chased.
function quotedTweetFrom(tweet) {
  const raw =
    tweet?.legacy?.quoted_status_result?.result ||
    tweet?.quoted_status_result?.result ||
    null;
  // Soft-unwrap so a deleted/protected/NSFW quoted card is skipped quietly
  // instead of aborting the whole page's media.
  return raw ? unwrapTweet(raw, { soft: true }) : null;
}

// Maps ONE tweet object's own extended_entities media to queue-item candidates.
// Used for a post's own media, the reposted target's media, and the quoted
// post's media — the flags only differ (isRepost / isQuote).
function mediaItemsFromTweetObject(source, { isRepost = false, isQuote = false, fallbackAuthor = "", fallbackDate = "", fallbackTweetId = "" } = {}) {
  const sourceLegacy = source.legacy || {};
  const author =
    source.core?.user_results?.result?.legacy?.screen_name ||
    String(fallbackAuthor || "unknown").replace(/^@/, "");
  const timestamp = sourceLegacy.created_at || fallbackDate || "";
  const text = sourceLegacy.full_text || sourceLegacy.text || "media";
  const media = sourceLegacy.extended_entities?.media || sourceLegacy.entities?.media || [];
  return media.map((item, index) => {
    // URL selection (orig photo, highest-bitrate MP4), GIF detection, and the
    // target extension all come from the shared resolver — identical to the
    // single-post getTweetMedia path, so the two can never drift apart.
    const resolved = resolveTweetMedia(item);
    if (!resolved) return null;
    const type = resolved.kind === "photo" ? "photo" : "video";
    const mediaId = item.id_str || item.id || index;
    // A repost target virtually always carries rest_id; keep the outer post's
    // id as the historical fallback. Quoted media never falls back — a quoted
    // row with a wrong id would break attribution and skip-history.
    const tweetId = source.rest_id || (isQuote ? "" : fallbackTweetId);
    return {
      id: `${tweetId}-${mediaId}`,
      // Same CDN key the content script derives, so a photo listed from the
      // rendered DOM and the same photo parsed from GraphQL collapse into one
      // queue row instead of appearing twice.
      mediaKey: mediaKeyFromUrl(resolved.url),
      url: resolved.url, type, thumbnail: item.media_url_https || item.media_url || "", author: `@${author}`,
      date: timestamp, tweetId, mediaId: String(mediaId), isRepost, isQuote, isGif: resolved.isGif,
      // Naming metadata (v3.5): the download-time path builder renders the
      // user's name template and per-post 001…004 numbering from these.
      // `filename` stays the legacy flat path — it is used verbatim when the
      // master folder is switched off.
      text: String(text || "").slice(0, 280),
      displayName: source.core?.user_results?.result?.legacy?.name || "",
      mediaIndex: index,
      filename: makeMediaFilename({ username: author, text, tweetId, mediaId, index, extension: resolved.extension })
    };
  }).filter(Boolean);
}

function mediaFromTweet(tweet, targetHandle, options = {}) {
  // Back-compat: the third argument used to be a bare includeRetweets boolean.
  const opts = typeof options === "boolean" ? { includeRetweets: options } : (options || {});
  const includeRetweets = opts.includeRetweets !== false;
  const includeQuoted = Boolean(opts.includeQuoted);
  const legacy = tweet.legacy || {};
  const repostResult = legacy.retweeted_status_result?.result || tweet.retweeted_status_result?.result;
  const isRepost = Boolean(repostResult);
  if (isRepost && !includeRetweets) return [];
  // Soft-unwrap so one deleted/NSFW repost target does not abort the whole page.
  const source = unwrapTweet(repostResult, { soft: true }) || tweet;
  // Keep the pre-quote-parse fallbacks: a reposted target without core user
  // data used to fall back to the outer (retweeting) post's author and date.
  const outerAuthor = tweet.core?.user_results?.result?.legacy?.screen_name || targetHandle;
  const outerDate = legacy.created_at || "";
  const items = mediaItemsFromTweetObject(source, { isRepost, fallbackAuthor: outerAuthor, fallbackDate: outerDate, fallbackTweetId: tweet.rest_id });
  if (includeQuoted) {
    // A quote reaction ("GIF/video reacting to a mentioned post") carries the
    // quoted post's media in the card; list it as its own row, attributed to
    // the quoted post's author and id so filenames and skip-history match the
    // post that actually owns the media.
    const quoted = quotedTweetFrom(source);
    if (quoted?.rest_id) items.push(...mediaItemsFromTweetObject(quoted, { isQuote: true, fallbackAuthor: outerAuthor }));
  }
  return items;
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
    // Stop scan must break out of a 429/503 backoff quickly instead of letting
    // the countdown run out — the stop button is otherwise dead for up to a
    // minute. fetchWithRetry checks this callback on every wait boundary.
    const shouldAbort = () => !isCurrentDiscoveryRun(state, runId) || state.stopRequested;
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
      operations.userCapture,
      { shouldAbort }
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
        operations.mediaCapture,
        { shouldAbort }
      );
      if (!isCurrentDiscoveryRun(state, runId)) return;
      const instructions = extractTimelineInstructions(page) || page;
      const tweets = [];
      collectTweets(instructions, tweets);
      const parsedItems = tweets
        .flatMap((tweet) => mediaFromTweet(tweet, username, {
          includeRetweets: Boolean(options.includeRetweets),
          includeQuoted: options.includeQuoted !== false
        }))
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
    if (classified.code === "stopped" || state.stopRequested) {
      // User pressed Stop mid-backoff: a clean stop, not an error.
      state.error = null;
      state.errorCode = null;
      state.status = `Discovery stopped — ${state.found} media found.`;
    } else {
      state.error = classified.message;
      state.errorCode = classified.code;
      state.status = "Discovery needs attention";
    }
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
  if (!json || typeof json !== "object") return { ok: true, addedCount: 0, skippedDownloaded: 0, tweetIds: [] };
  const tweets = [];
  collectTweets(json, tweets);
  if (!tweets.length) return { ok: true, addedCount: 0, skippedDownloaded: 0, tweetIds: [] };

  const targetHandle = inferHandleFromUrl(message.pageUrl || "");
  const mediaFilter = message.mediaFilter === "photo" || message.mediaFilter === "video"
    ? message.mediaFilter
    : "all";
  const tweetIds = [];
  const items = [];
  for (const tweet of tweets) {
    const parsed = mediaFromTweet(tweet, targetHandle, {
      includeRetweets: true,
      // Quoted ("mentioned") post media is on by default for scroll capture —
      // the quote card's GIF/video/photo is exactly what the user sees. The
      // Side Panel can switch it off per its Include quoted checkbox.
      includeQuoted: message.includeQuoted !== false
    })
      .filter((item) => mediaFilter === "all" || item.type === mediaFilter);
    if (!parsed.length) continue;
    if (tweet.rest_id) tweetIds.push(String(tweet.rest_id));
    items.push(...parsed.map((item) => ({ ...item, source: "scroll" })));
  }
  if (!items.length) return { ok: true, addedCount: 0, skippedDownloaded: 0, tweetIds };
  const result = await addQueueItems(items, {
    source: "scroll",
    skipDownloaded: message.skipDownloaded !== false
  });
  return {
    ok: true,
    addedCount: result.addedCount,
    skippedDownloaded: result.skippedDownloaded,
    tweetIds
  };
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

  // Download a single file. When the content script sends the owning item's
  // metadata, the path honors the master-folder + name-template settings and
  // GIF items are converted MP4 → real .gif (same pipeline as the queue);
  // a bare filename (older callers) keeps the legacy flat path.
  if (msg.action === "downloadFile") {
    (async () => {
      const settings = await getOutputSettings();
      if (msg.item) {
        const prepared = await prepareRawDownload(
          { ...msg.item, url: msg.item.url || msg.url, filename: msg.item.filename || msg.filename },
          settings
        );
        // v3.10: byte + source-URL verification also guards one-click saves.
        return downloadFile(prepared.url, prepared.filename, {
          verifyBytes: settings.verifyDuplicates,
          item: msg.item
        });
      }
      return downloadFile(msg.url, msg.filename, { verifyBytes: settings.verifyDuplicates });
    })().then(sendResponse);
    return true;
  }
});
