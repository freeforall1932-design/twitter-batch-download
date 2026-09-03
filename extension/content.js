// ==========================================================================
// content.js — DOM observer, action-bar buttons, scroll capture engine
// Runs in ISOLATED world on x.com / twitter.com
//
// Capture is ALWAYS ON. Earlier builds only listed media after the Side Panel
// sent an explicit "watch" command to the tab that happened to be active, so
// SPA route changes (profile → /media → post) and background tabs silently
// captured nothing until a full reload. Listing now starts at document_start
// and re-arms on every SPA route change.
// ==========================================================================

(() => {
  if (window.__xdl_active !== undefined) {
    console.log("[X-DL] Already injected");
    return;
  }
  window.__xdl_active = false;
  console.log("[X-DL] Content script loaded on:", window.location.href);

  // ==========================================================================
  // STATE
  // ==========================================================================

  let mediaFilter = "all"; // "all" | "video" | "photo"
  let skipDownloaded = true;
  let includeQuoted = true; // list media from quoted ("mentioned") posts too
  let autoScrollRunning = false;
  let autoScrollStopRequested = false;
  // Per-run tokens. Stop bumps them, which invalidates whichever loop is in
  // flight, so a Stop followed by an immediate restart can never leave two
  // loops scrolling the same tab or two discovery polls fighting over one run.
  let autoScrollRunId = 0;
  let deepFetchRunId = 0;
  let listedCount = 0;
  let statusText = "Watching this tab — scroll to list media.";
  let envReady = false;
  let lastRoute = routeKey(window.location.href);

  // v3.7 — Fetch button / deep fetch.
  // "Shallow" = pull everything this tab can give us WITHOUT moving the page
  // (replay buffered GraphQL + rescan the DOM + resolve video posts). It runs
  // by itself on load and on every route change, which is what a freshly
  // opened profile tab was missing before. "Deep" = shallow + drive the
  // auto-scroll engine so X loads the rest of the timeline + (optionally) a
  // silent GraphQL fill of the same profile through the background discovery
  // engine. Deep fetch only ever starts from a click (in-page dock or panel).
  let deepFetchRunning = false;
  let deepFetchStopRequested = false;
  let deepFetchPhase = "idle"; // idle | shallow | scroll | remote | done
  let deepFetchNote = "";
  let deepFetchTarget = "";   // profile handle of the silent GraphQL fill, if any
  let deepFetchRemote = true;  // hybrid: also page the profile silently afterwards
  let showFetchDock = true;    // in-page Fetch button on/off (Side Panel switch)
  let fetchDockHidden = false; // user dismissed the dock for this tab
  // Highest replay-buffer sequence number already handled, so a replay request
  // only re-sends responses this world has not seen yet (see injected.js).
  let lastReplaySeq = 0;

  const listedMediaIds = new Set();       // queue item ids already sent
  const listedMediaKeys = new Set();      // CDN media keys already sent
  const pendingVideoTweets = new Set();   // tweet ids seen in DOM with video, unresolved
  const resolvedVideoTweets = new Set();  // tweet ids already resolved or resolving
  // A per-post resolve that failed (rate limit, transient worker wake-up) must
  // not be permanently blacklisted: without a retry budget one failed
  // getTweetMedia call meant that post's video never listed in this tab. Two
  // attempts keeps it recoverable without hammering X on every rescan.
  const VIDEO_RESOLVE_ATTEMPTS = 2;
  const videoResolveAttempts = new Map(); // tweet id → attempts made
  let postsOnScreen = 0;
  let scanCount = 0;  // DOM scans performed in this tab (status/diagnostics)

  // Cumulative, never reset. A pass reports the delta across its own start and
  // end, so two overlapping passes cannot corrupt each other — and they do
  // overlap: a load/route-change pass can land in the middle of an explicit
  // rescan on a busy timeline. The obvious design (one shared tally object that
  // each pass zeroes at its start) made a rescan report "nothing new" right
  // after it had re-listed the whole page, because the automatic pass that
  // followed it wiped the numbers before the note was written.
  const passCounters = { sent: 0, added: 0, skippedDownloaded: 0 };
  let lastPassResult = { sent: 0, added: 0, skippedDownloaded: 0 };
  // Rescans keep their own record. `lastPassResult` is whatever pass ran most
  // recently, and an automatic load/route pass lands right after a rescan often
  // enough that reading the rescan's outcome from it was unreliable.
  let lastRescan = null;
  let rescanRunning = false;

  function notePassResult(response, sentCount) {
    passCounters.sent += Number(sentCount) || 0;
    passCounters.added += Number(response?.addedCount) || 0;
    passCounters.skippedDownloaded += Number(response?.skippedDownloaded) || 0;
  }

  // Forget everything this tab has already listed so the next scan re-sends the
  // posts on screen. This is what makes "delete rows from my list, then press
  // Rescan (or Fetch)" work: the queue dedupes on its own side, so re-sending an
  // item that is still listed is a harmless no-op while an item the user removed
  // comes back. Clearing `lastReplaySeq` is the part that matters most — X
  // virtualizes timelines, so posts that scrolled out of the DOM exist only in
  // the MAIN-world replay buffer, and an incremental replay request would never
  // re-deliver them. Automatic passes (load, route change) do NOT call this: a
  // busy timeline would re-clone its whole buffer on every mutation tick.
  function forgetListedMedia() {
    listedMediaIds.clear();
    listedMediaKeys.clear();
    pendingVideoTweets.clear();
    resolvedVideoTweets.clear();
    videoResolveAttempts.clear();
    lastReplaySeq = 0;
  }

  // Auto-scroll tuning. "Fast" is genuinely fast: it does not sleep on a fixed
  // timer, it waits for X to render the next batch and moves on immediately.
  const SCROLL_CONFIG = {
    slow: { step: 0.75, settle: 1200, maxWait: 5000 },
    medium: { step: 1.1, settle: 550, maxWait: 4000 },
    fast: { step: 1.6, settle: 180, maxWait: 3000 }
  };
  let scrollSpeed = "fast";

  // Bound every background round trip. A service worker suspended mid-request
  // (or any message that simply never gets a response) must not hang the
  // caller. 90 s covers the slowest legitimate path — a GIF → .gif conversion
  // in the offscreen document, itself bounded to ~30 s.
  const MESSAGE_TIMEOUT_MS = 90000;

  // ==========================================================================
  // MAIN-WORLD BRIDGE
  // ==========================================================================

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const payload = event.data;
    if (!payload || payload.source !== "XDL_INJECTED") return;

    if (payload.type === "xdlNetworkCapture" && payload.data) {
      safeSend({
        action: "networkCapture",
        capture: payload.data,
        pageUrl: payload.capturedUrl || window.location.href
      });
      return;
    }

    if (payload.type === "xdlGraphqlResponse" && payload.data) {
      // Remember the newest sequence number we have seen so the next replay
      // request asks only for what arrived after it.
      const seq = Number(payload.data.seq) || 0;
      if (seq > lastReplaySeq) lastReplaySeq = seq;
      safeSend({
        action: "localTimelineCapture",
        capture: payload.data,
        pageUrl: payload.capturedUrl || window.location.href,
        mediaFilter,
        skipDownloaded,
        includeQuoted
      }, (response) => {
        notePassResult(response, 0);
        if (response?.addedCount) {
          listedCount += response.addedCount;
          statusText = `Listed ${listedCount} media item${listedCount === 1 ? "" : "s"} from this tab.`;
        }
        // Videos that arrived through GraphQL no longer need a per-post resolve.
        for (const tweetId of response?.tweetIds || []) {
          pendingVideoTweets.delete(tweetId);
          resolvedVideoTweets.add(tweetId);
        }
      });
      return;
    }

    if (payload.type === "xdlInjectedReady") {
      requestReplay();
      return;
    }

    if (payload.type === "xdlUrlChanged" && payload.data) {
      handleRouteChange(payload.data.newUrl || window.location.href);
    }
  });

  function requestReplay() {
    // Ask the MAIN world to re-post buffered GraphQL payloads. Covers an
    // extension reload on an already-open tab and responses that landed before
    // this listener existed. `since` makes the (now frequent) shallow fetch
    // passes cheap: only responses newer than the last one handled come back.
    try {
      window.postMessage({ source: "XDL_CONTENT", type: "xdlRequestReplay", since: lastReplaySeq }, "*");
    } catch (_) { /* ignore */ }
  }

  function routeKey(href) {
    try {
      const url = new URL(href);
      const path = url.pathname.replace(/\/+$/, "").toLowerCase();
      const filter = (url.searchParams.get("filter") || "").toLowerCase();
      return filter ? `${path}?filter=${filter}` : path;
    } catch (_) {
      return String(href || "");
    }
  }

  function handleRouteChange(newUrl) {
    const next = routeKey(newUrl);
    if (next === lastRoute) return;
    lastRoute = next;
    console.log("[X-DL] Route changed →", next);
    // Deliberately keep listedMediaIds/Keys: the same media can appear on both
    // the profile and its /media view, and re-listing it would duplicate rows.
    pendingVideoTweets.clear();
    statusText = "Route changed — listing media on this view.";
    // X frequently serves SPA views from its cache without re-issuing GraphQL,
    // so replay what the page already fetched and rescan the rendered DOM.
    // Three separate passes, not one coalesced scheduleScan(): X renders an SPA
    // view in stages, and the old scheduleScan(700) + scheduleScan(1800) pair
    // silently dropped the second call because scheduleScan ignores a request
    // while another scan is already pending.
    shallowFetchPass("route");
    scheduleScanAt(700);
    scheduleScanAt(1800);
    renderFetchDock();
  }

  function runtimeAlive() {
    try {
      return Boolean(chrome.runtime?.id);
    } catch (_) {
      return false;
    }
  }

  function safeSend(message, callback) {
    if (!runtimeAlive()) {
      // The extension was reloaded/updated while this tab stayed open, so this
      // context is invalidated. Callers that await a response MUST still be
      // released: returning silently here left drainPendingVideoTweets awaiting
      // initEnv()/getTweetMedia() forever with `resolvingVideos` stuck true, so
      // after one extension reload no video post in that tab was ever listed
      // again until the user reloaded the page. That is the "reload the page to
      // trigger my extension" symptom.
      if (callback) callback(null);
      return;
    }
    try {
      chrome.runtime.sendMessage(message, (response) => {
        // Reading lastError suppresses "Unchecked runtime.lastError" noise when
        // the service worker is asleep or the extension was just reloaded.
        void chrome.runtime.lastError;
        if (callback) callback(response || null);
      });
    } catch (_) {
      if (callback) callback(null);
    }
  }

  function sendMessage(action, data = {}) {
    return withTimeout(
      new Promise((resolve) => {
        safeSend({ action, ...data }, (response) => resolve(response || null));
      }),
      MESSAGE_TIMEOUT_MS
    );
  }

  function withTimeout(promise, ms, fallback = null) {
    let timer = null;
    return Promise.race([
      Promise.resolve(promise),
      new Promise((resolve) => { timer = setTimeout(() => resolve(fallback), ms); })
    ]).then((value) => {
      if (timer !== null) clearTimeout(timer);
      return value;
    });
  }

  // ==========================================================================
  // UI STYLES — action-bar buttons + toast (Rank A pattern, reimplemented)
  // ==========================================================================

  const style = document.createElement("style");
  style.textContent = `
    .xdl-actions {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      margin-left: 4px;
    }
    .xdl-btn {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 0 12px;
      height: 30px;
      border: none;
      border-radius: 9999px;
      background: rgba(29,155,240,0.1);
      color: rgb(29,155,240);
      font-size: 13px;
      font-weight: 700;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      cursor: pointer;
      transition: background 0.15s, color 0.15s;
      white-space: nowrap;
    }
    .xdl-btn:hover { background: rgba(29,155,240,0.2); }
    .xdl-btn.xdl-loading { opacity: 0.6; cursor: wait; }
    .xdl-btn.xdl-done { background: rgba(0,186,124,0.12); color: rgb(0,186,124); }
    .xdl-btn.xdl-error { background: rgba(244,33,46,0.12); color: rgb(244,33,46); }
    .xdl-btn.xdl-queue { background: rgba(120,86,255,0.12); color: rgb(150,120,255); }
    .xdl-btn.xdl-queue:hover { background: rgba(120,86,255,0.22); }
    .xdl-btn svg { width: 15px; height: 15px; fill: currentColor; }
    .xdl-toast {
      position: fixed;
      right: 20px;
      /* Sits ABOVE the fetch dock instead of on top of it. */
      bottom: 74px;
      z-index: 2147483647;
      max-width: 340px;
      padding: 10px 15px;
      border-radius: 14px;
      background: #16202a;
      color: #fff;
      font: 600 13px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      box-shadow: 0 8px 24px rgba(0,0,0,.35);
      opacity: 0;
      transform: translateY(8px);
      transition: opacity .16s ease, transform .16s ease;
      pointer-events: none;
    }
    .xdl-toast.visible { opacity: 1; transform: translateY(0); }
    .xdl-toast.success { background: #0f7a5a; }
    .xdl-toast.warning { background: #8a5a10; }
    .xdl-toast.error { background: #99202a; }
    /* v3.7 in-page Fetch dock. Replaces the old auto-scroll-only badge: one
       widget that both starts a fetch and reports/stops the running one, so
       the panel-driven auto-scroll and the in-page button never fight over the
       same corner of the screen. */
    .xdl-fetch-dock {
      position: fixed;
      right: 20px;
      bottom: 20px;
      z-index: 2147483646;
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 8px 10px 8px 14px;
      border-radius: 9999px;
      background: rgba(15,23,31,.95);
      border: 1px solid #2f4250;
      color: #e8f1f7;
      font: 700 12px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      box-shadow: 0 8px 24px rgba(0,0,0,.35);
    }
    .xdl-fetch-dock .xdl-fetch-label { max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .xdl-fetch-dock button {
      border: 0;
      border-radius: 9999px;
      padding: 6px 12px;
      background: #1d9bf0;
      color: #fff;
      font: inherit;
      cursor: pointer;
      white-space: nowrap;
    }
    .xdl-fetch-dock button:hover { filter: brightness(1.1); }
    .xdl-fetch-dock button.xdl-fetch-stop { background: #f4212e; }
    .xdl-fetch-dock button.xdl-fetch-hide {
      background: transparent;
      color: #7b8b98;
      padding: 6px 8px;
      font-size: 14px;
      line-height: 1;
    }
    .xdl-fetch-dock button.xdl-fetch-hide:hover { color: #e8f1f7; }
  `;
  // run_at:document_start can execute before <head> exists — and on some
  // navigations before <html> exists either. Appending to a null parent threw
  // "Cannot read properties of null (reading 'appendChild')", which aborted
  // this whole IIFE and left capture silently dead on that tab. Never throw
  // here: fall back through the parents we have, and retry once the document
  // element appears.
  function injectStyles() {
    const parent = document.head || document.documentElement;
    if (!parent) return false;
    parent.appendChild(style);
    return true;
  }

  if (!injectStyles()) {
    const retryStyle = () => {
      if (injectStyles()) {
        styleObserver.disconnect();
        document.removeEventListener?.("DOMContentLoaded", retryStyle);
      }
    };
    // The Document node always exists even when it has no element children yet,
    // so a non-subtree childList watch fires exactly when <html> is inserted.
    const styleObserver = new MutationObserver(retryStyle);
    try {
      styleObserver.observe(document, { childList: true });
    } catch (_) {
      /* environments that reject a Document target still get DOMContentLoaded */
    }
    document.addEventListener("DOMContentLoaded", retryStyle, { once: true });
  }

  const DOWNLOAD_SVG = `<svg viewBox="0 0 24 24"><path d="M12 2a1 1 0 0 1 1 1v10.59l3.3-3.3a1 1 0 1 1 1.4 1.42l-5 5a1 1 0 0 1-1.4 0l-5-5a1 1 0 1 1 1.4-1.42l3.3 3.3V3a1 1 0 0 1 1-1zM5 20a1 1 0 1 0 0 2h14a1 1 0 1 0 0-2H5z"/></svg>`;
  const CHECK_SVG = `<svg viewBox="0 0 24 24"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z"/></svg>`;
  const QUEUE_SVG = `<svg viewBox="0 0 24 24"><path d="M4 6h16a1 1 0 1 0 0-2H4a1 1 0 0 0 0 2zm0 5h9a1 1 0 1 0 0-2H4a1 1 0 1 0 0 2zm0 5h9a1 1 0 1 0 0-2H4a1 1 0 1 0 0 2zm14-3a1 1 0 0 1 1 1v2h2a1 1 0 1 1 0 2h-2v2a1 1 0 1 1-2 0v-2h-2a1 1 0 1 1 0-2h2v-2a1 1 0 0 1 1-1z"/></svg>`;

  let toastEl = null;
  let toastTimer = null;
  function showToast(text, kind = "") {
    if (!document.body) return;
    if (!toastEl) {
      toastEl = document.createElement("div");
      toastEl.className = "xdl-toast";
      document.body.appendChild(toastEl);
    }
    toastEl.className = `xdl-toast ${kind}`;
    toastEl.textContent = text;
    requestAnimationFrame(() => toastEl.classList.add("visible"));
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove("visible"), 2600);
  }

  // ==========================================================================
  // UTILITIES
  // ==========================================================================

  function sanitizeFilename(text) {
    return String(text || "")
      .replace(/https?:\/\/\S+/g, "")
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, "")
      .replace(/@\w+/g, "")
      .replace(/#(\w+)/g, "$1")
      .replace(/\s+/g, " ")
      .trim()
      .substring(0, 80) || "media";
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function getPhotoExtension(url) {
    try {
      const parsed = new URL(url, window.location.origin);
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

  function normalizeDomPhotoUrl(rawUrl) {
    if (!rawUrl) return "";
    try {
      const url = new URL(rawUrl, window.location.origin);
      if (!url.hostname.includes("pbs.twimg.com")) return "";
      url.searchParams.set("name", "orig");
      return url.toString();
    } catch (_) {
      return rawUrl.includes("name=") ? rawUrl : `${rawUrl}${rawUrl.includes("?") ? "&" : "?"}name=orig`;
    }
  }

  // Stable CDN key so a photo found in the DOM and the same photo parsed from a
  // GraphQL response collapse into one queue row.
  function mediaKeyFromUrl(rawUrl) {
    try {
      const url = new URL(rawUrl, window.location.origin);
      const leaf = url.pathname.split("/").filter(Boolean).pop() || "";
      return leaf.replace(/\.[a-z0-9]{1,5}$/i, "") || "";
    } catch (_) {
      const leaf = String(rawUrl || "").split("?")[0].split("/").pop() || "";
      return leaf.replace(/\.[a-z0-9]{1,5}$/i, "");
    }
  }

  // ==========================================================================
  // DOM — tweet inspection
  // ==========================================================================

  // Author's display name (the {name} template token). Copied from where the
  // handle lives ([data-testid="User-Name"]): the first <span> that is not the
  // "@handle" is the display name. Live shape (2026): the block holds the
  // display name span(s) and the handle link; verified against several 2026
  // scrapers' selectors ([data-testid="User-Name"] span:first-child,
  // div[data-testid="User-Name"] div span). Safe fallback "" so a template
  // using {name} simply renders nothing for a post we could not read.
  function getDisplayName(article) {
    const nameBlock = article.querySelector('[data-testid="User-Name"]');
    if (!nameBlock) return "";
    for (const span of nameBlock.querySelectorAll("span")) {
      const text = (span.textContent || "").trim();
      if (text && !text.startsWith("@")) return text;
    }
    return "";
  }

  function getTweetInfo(article) {
    const tweetTextEl = article.querySelector('[data-testid="tweetText"]');
    const tweetText = tweetTextEl ? tweetTextEl.innerText : "";

    let handle = "";
    for (const link of article.querySelectorAll('a[role="link"]')) {
      const href = link.getAttribute("href");
      if (href && /^\/[A-Za-z0-9_]{1,15}$/.test(href)) {
        handle = href.slice(1);
        break;
      }
    }

    const timeEl = article.querySelector("time");
    const tweetLink = timeEl ? timeEl.closest("a") : null;
    const tweetHref = tweetLink ? tweetLink.getAttribute("href") : null;
    const tweetId = tweetHref ? (tweetHref.match(/\/status\/(\d+)/)?.[1] || null) : null;

    const hasVideo =
      article.querySelector("video") !== null ||
      article.querySelector('[data-testid="videoPlayer"]') !== null ||
      article.querySelector('[data-testid="videoComponent"]') !== null ||
      article.querySelector('img[src*="ext_tw_video_thumb"], img[src*="amplify_video_thumb"], img[src*="tweet_video_thumb"]') !== null;

    const photoImages = Array.from(
      article.querySelectorAll('img[src*="pbs.twimg.com/media"]')
    );
    const hasPhoto = photoImages.length > 0;

    return {
      tweetText,
      handle,
      tweetId,
      tweetHref,
      displayName: getDisplayName(article),
      hasVideo,
      hasPhoto,
      photoImages,
      hasMedia: hasVideo || hasPhoto
    };
  }

  function initEnv() {
    return new Promise((resolve) => {
      safeSend({ action: "initEnv" }, (resp) => {
        if (resp?.ok) envReady = true;
        resolve(!!resp?.ok);
      });
    });
  }

  function getTweetMedia(tweetId) {
    return sendMessage("getTweetMedia", { tweetId });
  }

  function downloadFile(url, filename, item) {
    // The owning item's metadata lets the background honor the master-folder
    // and name-template settings; url/filename stay as the legacy fallback.
    return sendMessage("downloadFile", { url, filename, item });
  }

  // ==========================================================================
  // SHARED — GraphQL media entry → queue item (used by the scroll-capture
  // video resolver AND the per-post action-bar buttons; one builder so the
  // two paths can never drift apart again)
  // ==========================================================================

  // entry: one element of getTweetMedia().videos / .photos (owning-post
  // attribution included). Returns a queue item, or null when `dedupe` sets
  // are provided and the media is already listed.
  function mediaEntryToItem(entry, index, kind, context) {
    const mediaKey = mediaKeyFromUrl(entry.url);
    const ownerHandle = entry.username || context.handle;
    const ownerText = entry.text || context.fallbackText || "media";
    const ownerTweetId = entry.tweetId || context.tweetId;
    const id = `${ownerTweetId}-${entry.mediaId || mediaKey || index}`;
    if (context.dedupe) {
      const { ids, keys } = context.dedupe;
      if (ids.has(id) || (mediaKey && keys.has(mediaKey))) return null;
      ids.add(id);
      if (mediaKey) keys.add(mediaKey);
    }
    const extension = kind === "video" ? "mp4" : getPhotoExtension(entry.url);
    return {
      id,
      mediaKey,
      url: entry.url,
      type: kind,
      // X delivers "GIFs" as MP4 clips; the flag lets the background convert
      // them back into real .gif files at download time.
      isGif: entry.type === "animated_gif",
      thumbnail: kind === "photo" ? entry.url : "",
      author: `@${ownerHandle}`,
      date: entry.date || "",
      tweetId: ownerTweetId,
      mediaId: String(entry.mediaId || mediaKey || index),
      isRepost: false,
      isQuote: Boolean(entry.isQuote),
      source: "scroll",
      text: entry.text || context.fallbackText || "",
      displayName: entry.displayName || "",
      mediaIndex: entry.mediaIndex ?? index,
      filename: `x-media/${ownerHandle}_${sanitizeFilename(ownerText)}_${ownerTweetId}_${index + 1}.${extension}`
    };
  }

  // ==========================================================================
  // SCROLL CAPTURE — list rendered media into the Side Panel queue
  // ==========================================================================

  function makeDomQueueItems(article) {
    const info = getTweetInfo(article);
    if (!info.tweetId) return [];

    // Videos have no usable direct URL in the DOM; they come from GraphQL
    // captures, or from a bounded per-post resolve if the page never re-fetched.
    if (info.hasVideo && mediaFilter !== "photo" && !resolvedVideoTweets.has(info.tweetId)) {
      pendingVideoTweets.add(info.tweetId);
    }

    if (mediaFilter === "video" || !info.hasPhoto) return [];

    const safeName = sanitizeFilename(info.tweetText || "media");
    const handle = info.handle || "unknown";
    const date = article.querySelector("time")?.getAttribute("datetime") || "";
    const seenUrls = new Set();
    const items = [];

    info.photoImages.forEach((img, index) => {
      const url = normalizeDomPhotoUrl(img.currentSrc || img.src || "");
      if (!url || seenUrls.has(url)) return;
      seenUrls.add(url);
      const mediaKey = mediaKeyFromUrl(url);
      if (!mediaKey || listedMediaKeys.has(mediaKey)) return;
      const id = `${info.tweetId}-${mediaKey}`;
      if (listedMediaIds.has(id)) return;
      listedMediaIds.add(id);
      listedMediaKeys.add(mediaKey);
      items.push({
        id,
        mediaKey,
        url,
        type: "photo",
        thumbnail: img.currentSrc || img.src || url,
        author: `@${handle}`,
        date,
        tweetId: info.tweetId,
        mediaId: mediaKey,
        isRepost: false,
        source: "scroll",
        // Naming metadata (v3.5): raw post text + per-post media position for
        // the download-time template/master-folder path builder. DOM-scanned
        // photos carry the article's display name too (v3.6.2), so a template
        // using {name} names this post the same as its GraphQL-captured copy.
        text: info.tweetText || "",
        displayName: info.displayName || "",
        mediaIndex: index,
        filename: `x-media/${handle}_${safeName}_${info.tweetId}_${index + 1}.${getPhotoExtension(url)}`
      });
    });

    return items;
  }

  let scanQueued = false;
  // Coalescing scheduler for the MutationObserver, which fires dozens of times
  // per second while X renders.
  function scheduleScan(delay = 120) {
    if (delay === 0) { scanVisibleMedia(); return; }
    if (scanQueued) return;
    scanQueued = true;
    setTimeout(() => { scanQueued = false; scanVisibleMedia(); }, delay);
  }

  // Guaranteed one-off delayed scan. A staged render (SPA route change, fresh
  // profile tab) needs several passes at fixed offsets, which scheduleScan()
  // cannot express: it drops every request made while another scan is pending.
  function scheduleScanAt(delay) {
    setTimeout(() => scanVisibleMedia(), delay);
  }

  // Single submission path for DOM-derived items, shared by the full-page scan
  // and the mutation harvest so the counting, status text and dock refresh can
  // never drift apart between them.
  function submitDomItems(items) {
    if (!items || !items.length) return;
    safeSend({ action: "queueAdd", items, source: "scroll", skipDownloaded }, (response) => {
      notePassResult(response, items.length);
      const added = response?.addedCount ?? items.length;
      listedCount += added;
      statusText = `Listed ${listedCount} media item${listedCount === 1 ? "" : "s"} from this tab.`;
      renderFetchDock();
    });
  }

  function scanVisibleMedia() {
    if (!document.body) return;
    scanCount += 1;
    const articles = Array.from(document.querySelectorAll('article[data-testid="tweet"]'));
    postsOnScreen = articles.length;
    const items = [];
    for (const article of articles) items.push(...makeDomQueueItems(article));

    submitDomItems(items);
    drainPendingVideoTweets();
  }

  // X virtualizes its timeline: articles scrolled off-screen are REMOVED from the
  // DOM. A coalesced scan (150 ms) plus the 2.5 s interval scan only ever sees
  // what is in the DOM at that instant, so a post inserted and removed between
  // two scans was never listed at all. Measured on a fast-scroll harness with a
  // 6-article window: 39 of 103 photo posts survived, 126 photos and 16 of 17
  // videos were lost — which is the "only the new posts got added, the existing
  // ones were never listed" report.
  //
  // Reading the mutation records themselves closes the hole, because a record
  // still holds the nodes: `addedNodes` catches posts the moment they arrive
  // (their images may not have decoded yet — `img.src` is already the CDN URL),
  // and `removedNodes` is a guaranteed last chance for posts that already left.
  // A detached subtree stays fully queryable and `src` survives detachment, so
  // this works even when X inserts and removes in the same task, before any
  // observer callback could otherwise see the node in the document.
  //
  // It cannot create duplicates: makeDomQueueItems marks listedMediaIds /
  // listedMediaKeys as it builds each item, so an article harvested on the way
  // in and again on the way out lists once, and the queue dedupes on id and
  // media key as a second line of defence.
  function harvestMutationArticles(mutations) {
    const seen = new Set();
    const articles = [];
    const collect = (node) => {
      if (!node || node.nodeType !== 1 || seen.has(node)) return;
      seen.add(node);
      if (node.matches?.('article[data-testid="tweet"]')) { articles.push(node); return; }
      if (!node.querySelectorAll) return;
      for (const found of node.querySelectorAll('article[data-testid="tweet"]')) {
        if (!seen.has(found)) { seen.add(found); articles.push(found); }
      }
    };
    for (const mutation of mutations || []) {
      for (const node of mutation.addedNodes || []) collect(node);
      for (const node of mutation.removedNodes || []) collect(node);
    }
    if (!articles.length) return;

    const items = [];
    for (const article of articles) items.push(...makeDomQueueItems(article));
    submitDomItems(items);
    // A harvested video post has no usable direct URL, so it needs the same
    // bounded per-post resolve as a scanned one — without this, videos that
    // virtualized away were never even queued for resolving.
    drainPendingVideoTweets();
  }

  // Per-post video resolve, rate-bounded. X often serves an SPA view from cache
  // without re-issuing the timeline GraphQL call, so without this a profile's
  // videos would only ever appear after a hard reload.
  let resolvingVideos = false;
  let resolvingVideosPromise = null;
  // Returns the in-flight resolve loop so a caller (deep fetch) can await it.
  function drainPendingVideoTweets() {
    if (resolvingVideos) return resolvingVideosPromise || Promise.resolve();
    if (mediaFilter === "photo" || !pendingVideoTweets.size) return Promise.resolve();
    resolvingVideos = true;
    resolvingVideosPromise = resolvePendingVideoTweets().finally(() => {
      resolvingVideos = false;
      resolvingVideosPromise = null;
    });
    return resolvingVideosPromise;
  }

  async function resolvePendingVideoTweets() {
    while (pendingVideoTweets.size) {
      const tweetId = pendingVideoTweets.values().next().value;
      pendingVideoTweets.delete(tweetId);
      if (resolvedVideoTweets.has(tweetId)) continue;
      resolvedVideoTweets.add(tweetId);

      if (!envReady) await initEnv();
      const media = await getTweetMedia(tweetId);
      if (!media || media.error) {
        // A failed resolve (rate limit, service worker still waking up,
        // transient network) used to leave the tweet in resolvedVideoTweets
        // forever, so its video never listed in this tab. Allow a bounded
        // number of retries — enough to recover, never enough to hammer X.
        const attempts = (videoResolveAttempts.get(tweetId) || 0) + 1;
        videoResolveAttempts.set(tweetId, attempts);
        if (attempts < VIDEO_RESOLVE_ATTEMPTS) resolvedVideoTweets.delete(tweetId);
        continue;
      }

      const handle = media.username || "unknown";
      // Quoted-card media is attributed to the quoted post (its own author,
      // text, and tweet id) so ids, filenames, and skip-history match the
      // post that actually owns the media. Dedupe against everything this
      // tab already listed (DOM scan or an earlier GraphQL capture).
      const context = {
        handle,
        tweetId,
        fallbackText: media.tweetText || "media",
        dedupe: { ids: listedMediaIds, keys: listedMediaKeys }
      };
      const items = [];
      (media.videos || []).forEach((video, index) => {
        const item = mediaEntryToItem(video, index, "video", context);
        if (item) items.push(item);
      });
      if (mediaFilter !== "video") {
        (media.photos || []).forEach((photo, index) => {
          const item = mediaEntryToItem(photo, index, "photo", context);
          if (item) items.push(item);
        });
      }
      if (items.length) {
        safeSend({ action: "queueAdd", items, source: "scroll", skipDownloaded }, (response) => {
          notePassResult(response, items.length);
          listedCount += response?.addedCount ?? items.length;
          statusText = `Listed ${listedCount} media item${listedCount === 1 ? "" : "s"} from this tab.`;
          renderFetchDock();
        });
      }
      // Keep well below X's per-post GraphQL rate limits.
      await sleep(700);
    }
  }

  // ==========================================================================
  // AUTO-SCROLL — one engine, no item limit, content-driven pacing
  // ==========================================================================

  let fetchDock = null;

  // One dock for both jobs: start a fetch, and report/stop the running one. It
  // replaces the auto-scroll-only badge, so the panel-driven auto-scroll and
  // the in-page button can never fight over the same corner of the screen.
  function ensureFetchDock() {
    if (!document.body) return null;
    if (fetchDock) return fetchDock;
    fetchDock = document.createElement("div");
    fetchDock.className = "xdl-fetch-dock";

    const label = document.createElement("span");
    label.className = "xdl-fetch-label";
    label.dataset.role = "label";

    const main = document.createElement("button");
    main.type = "button";
    main.dataset.role = "main";
    main.textContent = "Fetch media";
    main.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (deepFetchRunning || autoScrollRunning) stopCapture();
      else startDeepFetch();
    });

    const hide = document.createElement("button");
    hide.type = "button";
    hide.className = "xdl-fetch-hide";
    hide.dataset.role = "hide";
    hide.title = "Hide this button for this tab";
    hide.setAttribute("aria-label", "Hide this button for this tab");
    hide.textContent = "×";
    hide.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      fetchDockHidden = true;
      renderFetchDock();
      showToast("Fetch button hidden for this tab — turn it back on in the Side Panel.", "");
    });

    fetchDock.appendChild(label);
    fetchDock.appendChild(main);
    fetchDock.appendChild(hide);
    document.body.appendChild(fetchDock);
    return fetchDock;
  }

  function fetchDockLabelText() {
    if (deepFetchRunning) {
      if (deepFetchPhase === "shallow") return `Reading this view · ${listedCount} listed`;
      if (deepFetchPhase === "scroll") return `Scrolling the timeline · ${listedCount} listed`;
      if (deepFetchPhase === "remote") {
        return `Silently fetching ${deepFetchTarget ? `@${deepFetchTarget}` : "the rest"} · ${listedCount} listed`;
      }
    }
    if (autoScrollRunning) return `Auto-scroll · ${listedCount} listed`;
    if (deepFetchNote) return deepFetchNote;
    return `${listedCount} media listed in this tab`;
  }

  function renderFetchDock() {
    const dock = ensureFetchDock();
    if (!dock) return;
    const running = deepFetchRunning || autoScrollRunning;
    // The in-page button is optional, but a RUNNING fetch always shows its
    // progress and its Stop button — the user must never lose control of a tab
    // the extension is scrolling.
    const wanted = running || (showFetchDock && !fetchDockHidden);
    dock.style.display = wanted ? "flex" : "none";
    if (!wanted) return;
    const label = dock.querySelector('[data-role="label"]');
    if (label) {
      const text = fetchDockLabelText();
      label.textContent = text;
      label.title = text; // the label is ellipsized; hover shows all of it
    }
    const main = dock.querySelector('[data-role="main"]');
    if (main) {
      main.textContent = running ? "Stop" : "Fetch media";
      main.className = running ? "xdl-fetch-stop" : "";
      main.title = running
        ? "Stop fetching"
        : "List every media item on this page: scrolls the timeline for you, then silently fetches the rest";
    }
  }

  function documentHeight() {
    return Math.max(
      document.body?.scrollHeight || 0,
      document.documentElement?.scrollHeight || 0
    );
  }

  // Resolve as soon as the timeline grows or new articles render, instead of
  // sleeping on a fixed timer. This is what makes "fast" actually fast while
  // still not outrunning X's virtualized list.
  function waitForGrowth(previousHeight, previousArticles, maxWait) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (reason) => {
        if (settled) return;
        settled = true;
        observer.disconnect();
        clearTimeout(timer);
        clearInterval(poll);
        resolve(reason);
      };
      const check = () => {
        if (documentHeight() > previousHeight + 40) return finish("grew");
        if (document.querySelectorAll('article[data-testid="tweet"]').length !== previousArticles) return finish("rendered");
      };
      const observer = new MutationObserver(check);
      if (document.body) observer.observe(document.body, { childList: true, subtree: true });
      const poll = setInterval(check, 100);
      const timer = setTimeout(() => finish("timeout"), maxWait);
    });
  }

  async function autoScrollLoop() {
    const config = SCROLL_CONFIG[scrollSpeed] || SCROLL_CONFIG.fast;
    const runId = ++autoScrollRunId;
    autoScrollRunning = true;
    autoScrollStopRequested = false;
    // A plain auto-scroll (panel button) must not inherit the note left behind
    // by an earlier deep fetch, or the dock would report a stale result.
    if (!deepFetchRunning) deepFetchNote = "";
    renderFetchDock();
    statusText = "Auto-scrolling…";

    let stallCount = 0;
    while (runId === autoScrollRunId && autoScrollRunning && !autoScrollStopRequested) {
      scanVisibleMedia();

      const beforeHeight = documentHeight();
      const beforeArticles = document.querySelectorAll('article[data-testid="tweet"]').length;
      const step = Math.round(window.innerHeight * config.step);
      window.scrollBy({ top: step, behavior: "instant" });

      const reason = await waitForGrowth(beforeHeight, beforeArticles, config.maxWait);
      if (config.settle) await sleep(config.settle);
      scanVisibleMedia();

      const atBottom = window.innerHeight + window.scrollY >= documentHeight() - 200;
      if (reason === "timeout" && atBottom) {
        stallCount += 1;
        // Nudge X into requesting the next page before giving up.
        window.scrollBy({ top: -400, behavior: "instant" });
        await sleep(250);
        window.scrollBy({ top: 900, behavior: "instant" });
        await waitForGrowth(documentHeight(), beforeArticles, config.maxWait);
      } else if (reason === "timeout") {
        stallCount += 1;
      } else {
        stallCount = 0;
      }

      renderFetchDock();
      statusText = `Auto-scrolling — ${listedCount} listed.`;

      if (stallCount >= 6) {
        statusText = `Reached the end of this timeline — ${listedCount} listed.`;
        break;
      }
    }

    // A newer run (or a Stop) owns the shared state now — do not touch it.
    if (runId !== autoScrollRunId) return;
    autoScrollRunning = false;
    if (autoScrollStopRequested) statusText = `Auto-scroll stopped — ${listedCount} listed.`;
    scanVisibleMedia();
    renderFetchDock();
  }

  // ==========================================================================
  // FETCH — the "as if I scrolled it myself" engine (v3.7)
  //
  // Two levels, because opening a profile in a new tab used to list nothing
  // until the user scrolled far enough for X to render more posts:
  //   shallow  — no page movement: replay the GraphQL this tab already has,
  //              rescan the rendered DOM, resolve every pending video post.
  //              Runs BY ITSELF on load and on every SPA route change.
  //   deep     — shallow, then drive the auto-scroll engine so X loads the rest
  //              of the timeline, then (optionally) page the same profile
  //              silently through the background's Remote fetch engine to fill
  //              whatever the scroll never rendered. Only ever from a click
  //              (in-page dock or Side Panel).
  // ==========================================================================

  // First path segments that are never a profile handle. Mirrors the reserved
  // list background.js normalizeProfileTarget() rejects, so the in-page button
  // and Remote fetch agree on what counts as a profile.
  const RESERVED_HANDLES = new Set([
    "home", "search", "explore", "settings", "messages", "notifications",
    "i", "intent", "composer", "login", "logout", "signup", "tos", "privacy",
    "about", "jobs", "help", "hashtag"
  ]);
  const PROFILE_SUBVIEWS = new Set(["media", "with_replies", "highlights"]);

  function profileHandleFromUrl(href) {
    try {
      // No base argument on purpose: `href` is always absolute here, and a base
      // of window.location.origin is the literal string "null" on file:/about:
      // documents, which makes the URL constructor throw even for an absolute
      // input (the base is parsed first).
      const url = new URL(String(href || ""));
      if (!/(^|\.)((x)|(twitter))\.com$/i.test(url.hostname)) return null;
      const parts = url.pathname.split("/").filter(Boolean);
      const first = parts[0] || "";
      if (!/^[A-Za-z0-9_]{1,15}$/.test(first)) return null;
      if (RESERVED_HANDLES.has(first.toLowerCase())) return null;
      return { handle: first, subview: (parts[1] || "").toLowerCase() };
    } catch (_) {
      return null;
    }
  }

  // The silent fill only makes sense on a profile timeline. On a single post
  // (/handle/status/id) the user is looking at one tweet, so scrolling it is
  // fine but paging the whole profile's media is not what they asked for.
  function remoteFillTarget(href) {
    const profile = profileHandleFromUrl(href);
    if (!profile) return null;
    if (!profile.subview || PROFILE_SUBVIEWS.has(profile.subview)) return profile.handle;
    return null;
  }

  function storageGetLocal(keys) {
    return new Promise((resolve) => {
      try {
        if (!chrome.storage?.local?.get) return resolve({});
        chrome.storage.local.get(keys, (saved) => resolve(saved || {}));
      } catch (_) {
        resolve({});
      }
    });
  }

  const REPLAY_SETTLE_MS = 250;

  // Everything this tab can give us without moving the page. Safe to run often:
  // the replay request is incremental (`since` the last sequence number seen),
  // the DOM scan dedupes by media key, and the video resolver is rate-bounded.
  // `options.fresh` = start from a clean slate (see forgetListedMedia). Only
  // explicit user actions pass it: Rescan tab, Fetch media, and the in-page
  // dock's Fetch button. Load and route-change passes stay incremental.
  async function shallowFetchPass(reason = "manual", options = {}) {
    if (options.fresh) forgetListedMedia();
    const before = listedCount;
    const countersAtStart = { ...passCounters };
    requestReplay();
    scanVisibleMedia();
    // The replay answer arrives through the window-message bridge, not through
    // this call, so give it a tick before reporting what the pass gained.
    await sleep(REPLAY_SETTLE_MS);
    await drainPendingVideoTweets();
    const gained = listedCount - before;
    lastPassResult = {
      sent: passCounters.sent - countersAtStart.sent,
      added: passCounters.added - countersAtStart.added,
      skippedDownloaded: passCounters.skippedDownloaded - countersAtStart.skippedDownloaded
    };
    if (reason === "deep" || gained > 0) renderFetchDock();
    return { gained, listed: listedCount, reason, ...lastPassResult };
  }

  // An explicit rescan re-lists the posts this tab can see into the Side Panel
  // queue, replacing rows the user deleted. It never moves the page and never
  // crawls: it is the shallow pass with the tab's "already listed" memory wiped.
  async function startRescan() {
    if (rescanRunning) return { ok: false, reason: "A rescan is already running on this tab." };
    rescanRunning = true;
    let result = null;
    try {
      result = await shallowFetchPass("rescan", { fresh: true });
      statusText = rescanNote(result);
      lastRescan = {
        added: Number(result?.added) || 0,
        skippedDownloaded: Number(result?.skippedDownloaded) || 0,
        listed: Number(result?.listed) || 0,
        at: Date.now()
      };
    } catch (error) {
      statusText = `Rescan failed — ${error?.message || error}`;
    } finally {
      rescanRunning = false;
    }
    renderFetchDock();
    return { ok: true, ...(result || {}) };
  }

  function rescanNote(result) {
    const added = Number(result?.added) || 0;
    const skipped = Number(result?.skippedDownloaded) || 0;
    if (added > 0) {
      const held = skipped
        ? ` ${skipped} more held back as already downloaded.`
        : "";
      return `Rescan — ${added} media item${added === 1 ? "" : "s"} re-listed into the queue.${held}`;
    }
    if (skipped > 0) {
      return `Rescan — nothing re-listed: ${skipped} item${skipped === 1 ? "" : "s"} are already downloaded. Untick “Skip already downloaded” to list them again.`;
    }
    return "Rescan — nothing new; the items already in the queue are unchanged.";
  }

  // A freshly opened tab renders (and fetches) in stages over its first
  // seconds. These passes are what makes "open profile in a new tab" list
  // media on its own — no scrolling, no reload.
  const LOAD_FETCH_DELAYS = [900, 2200, 4000];
  function armLoadFetch() {
    for (const delay of LOAD_FETCH_DELAYS) {
      setTimeout(() => { shallowFetchPass("load"); }, delay);
    }
  }

  function stopCapture() {
    const wasDeepFetching = deepFetchRunning;
    const wasFillingRemotely = wasDeepFetching && deepFetchPhase === "remote";
    autoScrollRunId += 1;
    deepFetchRunId += 1;
    autoScrollStopRequested = true;
    autoScrollRunning = false;
    deepFetchStopRequested = true;
    deepFetchRunning = false;
    deepFetchPhase = "idle";
    deepFetchTarget = "";
    deepFetchNote = wasDeepFetching
      ? `Fetch stopped — ${listedCount} listed.`
      : `Auto-scroll stopped — ${listedCount} listed.`;
    statusText = deepFetchNote;
    // The abandoned fill loop can no longer report the Stop itself, so cancel
    // the background scan here rather than leaving it paging on.
    if (wasFillingRemotely) sendMessage("discoveryStop");
    renderFetchDock();
  }

  async function startDeepFetch(options = {}) {
    if (deepFetchRunning) return { ok: false, reason: "A fetch is already running on this tab." };
    if (autoScrollRunning) return { ok: false, reason: "Auto-scroll is already running — press Stop first." };
    if (typeof options.deepFetchRemote === "boolean") deepFetchRemote = options.deepFetchRemote;
    if (typeof options.mediaFilter === "string" && options.mediaFilter) mediaFilter = options.mediaFilter;
    if (options.scrollSpeed) scrollSpeed = options.scrollSpeed;
    if (typeof options.skipDownloaded === "boolean") skipDownloaded = options.skipDownloaded;
    if (typeof options.includeQuoted === "boolean") includeQuoted = options.includeQuoted;

    const runId = ++deepFetchRunId;
    deepFetchRunning = true;
    deepFetchStopRequested = false;
    deepFetchPhase = "shallow";
    deepFetchNote = "";
    deepFetchTarget = "";
    renderFetchDock();
    statusText = "Fetching media from this tab…";

    // A fetch is an explicit action, so it starts from a clean slate: rows the
    // user deleted from the queue come back instead of being suppressed by this
    // tab's "already listed" memory.
    await shallowFetchPass("deep", { fresh: true });
    if (runId !== deepFetchRunId) return { ok: false, superseded: true };

    if (!deepFetchStopRequested) {
      deepFetchPhase = "scroll";
      renderFetchDock();
      // The existing, live-tested auto-scroll engine: it scrolls, waits for X
      // to render each next batch, and stops when the timeline stops growing.
      await autoScrollLoop();
      if (runId !== deepFetchRunId) return { ok: false, superseded: true };
    }

    let fillNote = "";
    if (!deepFetchStopRequested && deepFetchRemote) {
      deepFetchPhase = "remote";
      renderFetchDock();
      const fill = await runRemoteFill(runId);
      if (runId !== deepFetchRunId) return { ok: false, superseded: true };
      fillNote = fill?.note || "";
    }

    deepFetchRunning = false;
    deepFetchPhase = "done";
    deepFetchNote = deepFetchStopRequested
      ? `Fetch stopped — ${listedCount} listed.`
      : [`Fetch complete — ${listedCount} listed from this tab.`, fillNote].filter(Boolean).join(" ");
    statusText = deepFetchNote;
    renderFetchDock();
    showToast(deepFetchNote, deepFetchStopRequested ? "" : "success");
    return { ok: true, running: false, found: listedCount, note: deepFetchNote };
  }

  // Silent gap-fill: page the same profile through the background's discovery
  // engine (the Remote fetch tab's crawler). Items are deduped against the
  // queue by media key, so anything the scroll already listed is not repeated;
  // whatever X never rendered still arrives. They land in the Remote fetch
  // list — the two lists stay separate by explicit product decision.
  async function runRemoteFill(runId = deepFetchRunId) {
    const target = remoteFillTarget(window.location.href);
    if (!target) {
      // Not a profile timeline (home, search, a single post): the scroll phase
      // is all there is to do here, and the note must survive into the final
      // summary so the user learns why nothing was fetched silently.
      deepFetchNote = "Silent fill needs a profile view — skipped on this page.";
      return { skipped: true, note: deepFetchNote };
    }
    const stored = await storageGetLocal(["batchLimit", "includeRetweets", "includeQuoted"]);
    const limit = Math.min(99999, Math.max(1, Number(stored.batchLimit) || 99999));
    deepFetchTarget = target;
    renderFetchDock();

    const started = await sendMessage("discoveryStart", {
      target,
      limit,
      includeRetweets: Boolean(stored.includeRetweets),
      includeQuoted: stored.includeQuoted !== false
    });
    if (!started || started.error) {
      deepFetchNote = started?.error || "Silent fill could not start.";
      return { ok: false, note: deepFetchNote };
    }
    if (!started.running) {
      deepFetchNote = "Silent fill did not start — Remote fetch is busy.";
      return { ok: false, note: deepFetchNote };
    }
    showToast(`Scroll done — silently fetching the rest of @${target} into the Remote fetch list.`, "");

    let found = Number(started.found) || 0;
    let failure = started.error || "";
    // Poll so the dock shows live progress and Stop can cancel the run. The
    // Side Panel's Remote fetch tab is watching the same run.
    while (!deepFetchStopRequested && runId === deepFetchRunId) {
      await sleep(1000);
      const state = await sendMessage("discoveryGet");
      if (!state) break;
      found = Number(state.found) || found;
      failure = state.error || (state.running ? "" : failure);
      renderFetchDock();
      if (!state.running) break;
    }
    if (runId !== deepFetchRunId) return { ok: false, superseded: true };
    if (deepFetchStopRequested) {
      await sendMessage("discoveryStop");
      failure = "";
    }
    deepFetchTarget = "";
    // `found` is what the silent scan SAW; the queue dedupes it against
    // everything the scroll already listed, so never claim these are all new.
    deepFetchNote = deepFetchStopRequested
      ? `Silent fill stopped — ${found} media seen on @${target}.`
      : failure
        ? `Silent fill of @${target}: ${failure}`
        : found > 0
          ? `@${target} silent fill: ${found} media found → Remote fetch tab.`
          : `@${target} silent fill found nothing new.`;
    return { ok: !failure, found, note: deepFetchNote };
  }

  // ==========================================================================
  // ACTION BAR — Download + Add to queue (Rank A UX, reimplemented locally)
  // ==========================================================================

  function resetBtn(btn, label) {
    btn.classList.remove("xdl-error", "xdl-done", "xdl-loading");
    btn.innerHTML = `${DOWNLOAD_SVG} ${label}`;
  }

  async function collectTweetMedia(article, info) {
    if (!envReady) await initEnv();
    const media = await getTweetMedia(info.tweetId);
    if (!media || media.error) return { error: media?.error || "no_media" };
    const handle = media.username || info.handle || "unknown";
    // Quoted ("mentioned") post media carries its own attribution so the
    // download is named after the post that owns the media. No dedupe here —
    // the action-bar buttons operate on exactly one post.
    const context = {
      handle,
      tweetId: info.tweetId,
      fallbackText: info.tweetText || media.tweetText || ""
    };
    const items = [];
    (media.videos || []).forEach((video, index) => {
      items.push(mediaEntryToItem(video, index, "video", context));
    });
    (media.photos || []).forEach((photo, index) => {
      items.push(mediaEntryToItem(photo, index, "photo", context));
    });
    return { items };
  }

  async function handleSingleDownload(btn, article, label) {
    if (btn.classList.contains("xdl-loading")) return;
    const info = getTweetInfo(article);
    if (!info.tweetId) {
      btn.classList.add("xdl-error");
      btn.innerHTML = `${DOWNLOAD_SVG} No ID`;
      return;
    }

    btn.classList.add("xdl-loading");
    btn.innerHTML = `${DOWNLOAD_SVG} Fetching…`;

    const collected = await collectTweetMedia(article, info);
    if (collected.error || !collected.items.length) {
      btn.classList.remove("xdl-loading");
      btn.classList.add("xdl-error");
      btn.innerHTML = collected.error === "protected_or_deleted"
        ? `${DOWNLOAD_SVG} Protected`
        : `${DOWNLOAD_SVG} No media`;
      setTimeout(() => resetBtn(btn, label), 3000);
      return;
    }

    let success = 0;
    for (let i = 0; i < collected.items.length; i++) {
      const item = collected.items[i];
      btn.innerHTML = `${DOWNLOAD_SVG} ${i + 1}/${collected.items.length}…`;
      const result = await downloadFile(item.url, item.filename, item);
      if (result?.success) success++;
    }

    btn.classList.remove("xdl-loading");
    if (success > 0) {
      btn.classList.add("xdl-done");
      btn.innerHTML = `${CHECK_SVG} Saved (${success})`;
    } else {
      btn.classList.add("xdl-error");
      btn.innerHTML = `${DOWNLOAD_SVG} Failed`;
      setTimeout(() => resetBtn(btn, label), 3000);
    }
  }

  async function handleAddToQueue(btn, article) {
    if (btn.disabled) return;
    const info = getTweetInfo(article);
    if (!info.tweetId) return;
    btn.disabled = true;
    btn.innerHTML = `${QUEUE_SVG} Adding…`;

    const collected = await collectTweetMedia(article, info);
    if (collected.error || !collected.items.length) {
      btn.disabled = false;
      btn.innerHTML = `${QUEUE_SVG} Add to queue`;
      showToast("No downloadable media found in this post.", "warning");
      return;
    }

    for (const item of collected.items) {
      listedMediaIds.add(item.id);
      if (item.mediaKey) listedMediaKeys.add(item.mediaKey);
    }
    resolvedVideoTweets.add(info.tweetId);

    safeSend({ action: "queueAdd", items: collected.items, source: "scroll", skipDownloaded }, (response) => {
      const added = response?.addedCount ?? 0;
      btn.disabled = false;
      if (added > 0) {
        btn.classList.add("xdl-done");
        btn.innerHTML = `${CHECK_SVG} In queue`;
        listedCount += added;
        showToast(`Added ${added} item${added === 1 ? "" : "s"} to the Side Panel queue.`, "success");
      } else {
        btn.innerHTML = `${QUEUE_SVG} In queue`;
        showToast("Already in the Side Panel queue.", "");
      }
    });
  }

  function injectActionButtons() {
    for (const article of document.querySelectorAll('article[data-testid="tweet"]')) {
      if (article.querySelector(".xdl-actions")) continue;
      const info = getTweetInfo(article);
      if (!info.hasMedia || !info.tweetId) continue;
      const actionBar = article.querySelector('[role="group"]');
      if (!actionBar) continue;

      const label = info.hasVideo && info.hasPhoto
        ? "Download all"
        : info.hasVideo ? "Download video" : "Download photo";

      const wrap = document.createElement("div");
      wrap.className = "xdl-actions";

      const downloadBtn = document.createElement("button");
      downloadBtn.type = "button";
      downloadBtn.className = "xdl-btn";
      downloadBtn.title = "Download this post's media now";
      downloadBtn.innerHTML = `${DOWNLOAD_SVG} ${label}`;
      downloadBtn.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        handleSingleDownload(downloadBtn, article, label);
      });

      const queueBtn = document.createElement("button");
      queueBtn.type = "button";
      queueBtn.className = "xdl-btn xdl-queue";
      queueBtn.title = "Add this post's media to the Side Panel queue";
      queueBtn.innerHTML = `${QUEUE_SVG} Add to queue`;
      queueBtn.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        handleAddToQueue(queueBtn, article);
      });

      wrap.appendChild(downloadBtn);
      wrap.appendChild(queueBtn);
      actionBar.appendChild(wrap);
    }
  }

  // ==========================================================================
  // WATCHERS
  // ==========================================================================

  function startDomWatchers() {
    if (!document.body) {
      document.addEventListener("DOMContentLoaded", startDomWatchers, { once: true });
      return;
    }
    const observer = new MutationObserver((mutations) => {
      injectActionButtons();
      // Harvest first: this is the only moment a virtualized post is guaranteed
      // to be reachable, so it must not wait for the coalesced scan.
      harvestMutationArticles(mutations);
      scheduleScan(150);
    });
    observer.observe(document.body, { childList: true, subtree: true });
    injectActionButtons();
    scanVisibleMedia();
    renderFetchDock();
    setInterval(() => {
      // Belt-and-braces: catches SPA views that reuse existing DOM nodes and
      // routes changed by mechanisms the history patch cannot see.
      handleRouteChange(window.location.href);
      injectActionButtons();
      scheduleScan(0);
      renderFetchDock();
    }, 2500);
  }

  chrome.storage?.local?.get(
    ["scrollMediaFilter", "scrollSpeed", "skipDownloaded", "scrollIncludeQuoted", "showFetchButton", "deepFetchRemote"],
    (saved) => {
      if (saved?.scrollMediaFilter) mediaFilter = saved.scrollMediaFilter;
      if (saved?.scrollSpeed) scrollSpeed = saved.scrollSpeed;
      if (typeof saved?.skipDownloaded === "boolean") skipDownloaded = saved.skipDownloaded;
      if (typeof saved?.scrollIncludeQuoted === "boolean") includeQuoted = saved.scrollIncludeQuoted;
      if (typeof saved?.showFetchButton === "boolean") showFetchDock = saved.showFetchButton;
      if (typeof saved?.deepFetchRemote === "boolean") deepFetchRemote = saved.deepFetchRemote;
      renderFetchDock();
    }
  );

  startDomWatchers();
  // Shallow fetch on load: the replay + DOM scan above run at document_start /
  // DOMContentLoaded, when X has rendered nothing yet. These delayed passes are
  // what actually list a freshly opened profile's media without any scrolling.
  shallowFetchPass("load");
  armLoadFetch();

  // ==========================================================================
  // MESSAGE LISTENER — Side Panel commands
  // ==========================================================================

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.action === "scrollSettings") {
      if (msg.mediaFilter) mediaFilter = msg.mediaFilter;
      if (msg.scrollSpeed) scrollSpeed = msg.scrollSpeed;
      if (typeof msg.skipDownloaded === "boolean") skipDownloaded = msg.skipDownloaded;
      if (typeof msg.includeQuoted === "boolean") includeQuoted = msg.includeQuoted;
      if (typeof msg.showFetchButton === "boolean") {
        showFetchDock = msg.showFetchButton;
        // Re-enabling from the panel is the way back after the in-page ×, so it
        // also clears this tab's dismissal.
        if (msg.showFetchButton) fetchDockHidden = false;
      }
      if (typeof msg.deepFetchRemote === "boolean") deepFetchRemote = msg.deepFetchRemote;
      renderFetchDock();
      scheduleScan(0);
      sendResponse(statusPayload());
      return;
    }

    if (msg.action === "scrollStart") {
      if (autoScrollRunning || deepFetchRunning) {
        sendResponse({ ...statusPayload(), ok: false, reason: "Auto-scroll is already running." });
        return;
      }
      if (msg.mediaFilter) mediaFilter = msg.mediaFilter;
      if (msg.scrollSpeed) scrollSpeed = msg.scrollSpeed;
      if (typeof msg.skipDownloaded === "boolean") skipDownloaded = msg.skipDownloaded;
      if (typeof msg.includeQuoted === "boolean") includeQuoted = msg.includeQuoted;
      autoScrollLoop();
      sendResponse({ ...statusPayload(), ok: true, running: true });
      return;
    }

    // Deep fetch: shallow pass + auto-scroll + optional silent GraphQL fill.
    // This is the command behind both Fetch buttons (in-page dock and panel).
    if (msg.action === "scrollFetch") {
      if (deepFetchRunning || autoScrollRunning) {
        sendResponse({ ...statusPayload(), ok: false, reason: "A fetch is already running on this tab." });
        return;
      }
      // startDeepFetch sets its running state synchronously, so the response
      // below already reports the fetch as live.
      startDeepFetch(msg || {});
      sendResponse({ ...statusPayload(), ok: true, running: true });
      return;
    }

    // ONE stop command for both engines (there is deliberately no separate
    // scrollFetchStop: an unreachable handler is dead contract surface).
    if (msg.action === "scrollStop") {
      stopCapture();
      sendResponse({ ...statusPayload(), ok: true, running: false });
      return;
    }

    if (msg.action === "scrollStatus") {
      sendResponse(statusPayload());
      return;
    }

    // Shallow pass only — no scrolling, no remote fill — but from a clean
    // slate, so it re-lists posts the user deleted from the queue. Responds
    // immediately (the pass can take seconds while video posts resolve); the
    // panel's status poll picks up the completion note.
    if (msg.action === "scrollRescan") {
      if (rescanRunning) {
        // Say so rather than pretending a second pass started: the panel shows
        // this string, and "rescanning" while nothing is happening is a lie.
        sendResponse({ ...statusPayload(), ok: false, reason: "A rescan is already running on this tab." });
        return;
      }
      startRescan();
      sendResponse({ ...statusPayload(), rescanning: true });
      return;
    }
  });

  function statusPayload() {
    return {
      ok: true,
      text: statusText,
      running: autoScrollRunning,
      // Deep-fetch state, so the panel can show the phase and keep its Fetch /
      // Stop buttons honest while the in-page dock is doing the work.
      fetching: deepFetchRunning,
      rescanning: rescanRunning,
      fetchPhase: deepFetchPhase,
      fetchNote: deepFetchNote,
      fetchTarget: deepFetchTarget,
      deepFetchRemote,
      showFetchButton: showFetchDock,
      dockHidden: fetchDockHidden,
      found: listedCount,
      // Diagnostics: what the last shallow pass sent / the queue took / the
      // queue held back as already downloaded, plus the last explicit rescan's
      // own outcome (a later automatic pass must not overwrite it).
      lastPass: { ...lastPassResult },
      lastRescan: lastRescan ? { ...lastRescan } : null,
      url: window.location.href,
      route: lastRoute,
      postsOnScreen,
      scans: scanCount,
      pendingVideos: pendingVideoTweets.size,
      mediaFilter,
      scrollSpeed,
      includeQuoted
    };
  }

  // Meaningful re-entry guard: the value is checked as `!== undefined` above,
  // so leaving it false forever was dead state.
  window.__xdl_active = true;
  console.log("[X-DL] Scroll capture active — listing media on every X view");
})();
