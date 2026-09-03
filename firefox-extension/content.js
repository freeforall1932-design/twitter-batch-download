// ==========================================================================
// content.js — DOM observer, action-bar buttons, scroll capture engine
// Runs in ISOLATED world on x.com / twitter.com
//
// Capture is ALWAYS ON. Earlier builds only listed media after the Side Panel
// sent an explicit "watch" command to the tab that happened to be active, so
// SPA route changes (profile → /media → post) and background tabs silently
// captured nothing until a full reload. Listing now starts at document_start
// and re-arms on every SPA route change.
// Firefox port: MAIN world script injected via <script> tag (Firefox MV2 has
// no world: MAIN manifest support). Chrome version uses manifest world: MAIN.
// ==========================================================================

// Firefox MAIN-world injection shim — runs before IIFE
(function injectMainWorldForFirefox() {
  try {
    const isFirefox = typeof browser !== 'undefined' || navigator.userAgent.includes('Firefox');
    if (!isFirefox) return;
    // Avoid double injection
    if (document.documentElement?.dataset?.xdlInjected) return;
    const script = document.createElement('script');
    script.src = (typeof browser !== 'undefined' ? browser : chrome).runtime.getURL('injected.js');
    script.onload = function() { this.remove(); };
    (document.head || document.documentElement).appendChild(script);
    if (document.documentElement) document.documentElement.dataset.xdlInjected = '1';
  } catch (_) {}
})();

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
  let listedCount = 0;
  let statusText = "Watching this tab — scroll to list media.";
  let envReady = false;
  let lastRoute = routeKey(window.location.href);

  const listedMediaIds = new Set();       // queue item ids already sent
  const listedMediaKeys = new Set();      // CDN media keys already sent
  const pendingVideoTweets = new Set();   // tweet ids seen in DOM with video, unresolved
  const resolvedVideoTweets = new Set();  // tweet ids already resolved or resolving
  let postsOnScreen = 0;

  // Auto-scroll tuning. "Fast" is genuinely fast: it does not sleep on a fixed
  // timer, it waits for X to render the next batch and moves on immediately.
  const SCROLL_CONFIG = {
    slow: { step: 0.75, settle: 1200, maxWait: 5000 },
    medium: { step: 1.1, settle: 550, maxWait: 4000 },
    fast: { step: 1.6, settle: 180, maxWait: 3000 }
  };
  let scrollSpeed = "fast";

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
      safeSend({
        action: "localTimelineCapture",
        capture: payload.data,
        pageUrl: payload.capturedUrl || window.location.href,
        mediaFilter,
        skipDownloaded,
        includeQuoted
      }, (response) => {
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
    // this listener existed.
    try {
      window.postMessage({ source: "XDL_CONTENT", type: "xdlRequestReplay" }, "*");
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
    requestReplay();
    scheduleScan(0);
    scheduleScan(700);
    scheduleScan(1800);
  }

  function safeSend(message, callback) {
    try {
      if (!chrome.runtime?.id) return;
      chrome.runtime.sendMessage(message, (response) => {
        // Reading lastError suppresses "Unchecked runtime.lastError" noise when
        // the service worker is asleep or the extension was just reloaded.
        void chrome.runtime.lastError;
        if (callback) callback(response);
      });
    } catch (_) { /* extension context invalidated */ }
  }

  function sendMessage(action, data = {}) {
    return new Promise((resolve) => {
      safeSend({ action, ...data }, (response) => resolve(response || null));
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
      bottom: 20px;
      z-index: 2147483647;
      padding: 10px 15px;
      border-radius: 9999px;
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
    .xdl-autoscroll-badge {
      position: fixed;
      right: 20px;
      bottom: 20px;
      z-index: 2147483646;
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 10px 14px;
      border-radius: 9999px;
      background: rgba(15,23,31,.95);
      border: 1px solid #2f4250;
      color: #e8f1f7;
      font: 700 12px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      box-shadow: 0 8px 24px rgba(0,0,0,.35);
    }
    .xdl-autoscroll-badge button {
      border: 0;
      border-radius: 9999px;
      padding: 5px 11px;
      background: #f4212e;
      color: #fff;
      font: inherit;
      cursor: pointer;
    }
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
  function scheduleScan(delay = 120) {
    if (delay === 0) { scanVisibleMedia(); return; }
    if (scanQueued) return;
    scanQueued = true;
    setTimeout(() => { scanQueued = false; scanVisibleMedia(); }, delay);
  }

  function scanVisibleMedia() {
    if (!document.body) return;
    const articles = Array.from(document.querySelectorAll('article[data-testid="tweet"]'));
    postsOnScreen = articles.length;
    const items = [];
    for (const article of articles) items.push(...makeDomQueueItems(article));

    if (items.length) {
      safeSend({ action: "queueAdd", items, source: "scroll", skipDownloaded }, (response) => {
        const added = response?.addedCount ?? items.length;
        listedCount += added;
        statusText = `Listed ${listedCount} media item${listedCount === 1 ? "" : "s"} from this tab.`;
      });
    }

    drainPendingVideoTweets();
  }

  // Per-post video resolve, rate-bounded. X often serves an SPA view from cache
  // without re-issuing the timeline GraphQL call, so without this a profile's
  // videos would only ever appear after a hard reload.
  let resolvingVideos = false;
  async function drainPendingVideoTweets() {
    if (resolvingVideos || mediaFilter === "photo") return;
    if (!pendingVideoTweets.size) return;
    resolvingVideos = true;
    try {
      while (pendingVideoTweets.size) {
        const tweetId = pendingVideoTweets.values().next().value;
        pendingVideoTweets.delete(tweetId);
        if (resolvedVideoTweets.has(tweetId)) continue;
        resolvedVideoTweets.add(tweetId);

        if (!envReady) await initEnv();
        const media = await getTweetMedia(tweetId);
        if (!media || media.error) continue;

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
            listedCount += response?.addedCount ?? items.length;
            statusText = `Listed ${listedCount} media item${listedCount === 1 ? "" : "s"} from this tab.`;
          });
        }
        // Keep well below X's per-post GraphQL rate limits.
        await sleep(700);
      }
    } finally {
      resolvingVideos = false;
    }
  }

  // ==========================================================================
  // AUTO-SCROLL — one engine, no item limit, content-driven pacing
  // ==========================================================================

  let autoScrollBadge = null;

  function showAutoScrollBadge() {
    if (!document.body) return;
    if (!autoScrollBadge) {
      autoScrollBadge = document.createElement("div");
      autoScrollBadge.className = "xdl-autoscroll-badge";
      const label = document.createElement("span");
      label.dataset.role = "label";
      const stop = document.createElement("button");
      stop.type = "button";
      stop.textContent = "Stop";
      stop.addEventListener("click", () => { autoScrollStopRequested = true; });
      autoScrollBadge.appendChild(label);
      autoScrollBadge.appendChild(stop);
      document.body.appendChild(autoScrollBadge);
    }
    autoScrollBadge.style.display = "flex";
  }

  function updateAutoScrollBadge(text) {
    const label = autoScrollBadge?.querySelector('[data-role="label"]');
    if (label) label.textContent = text;
  }

  function hideAutoScrollBadge() {
    if (autoScrollBadge) autoScrollBadge.style.display = "none";
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
    autoScrollRunning = true;
    autoScrollStopRequested = false;
    showAutoScrollBadge();
    statusText = "Auto-scrolling…";

    let stallCount = 0;
    while (autoScrollRunning && !autoScrollStopRequested) {
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

      updateAutoScrollBadge(`Auto-scroll · ${listedCount} listed`);
      statusText = `Auto-scrolling — ${listedCount} listed.`;

      if (stallCount >= 6) {
        statusText = `Reached the end of this timeline — ${listedCount} listed.`;
        break;
      }
    }

    autoScrollRunning = false;
    hideAutoScrollBadge();
    if (autoScrollStopRequested) statusText = `Auto-scroll stopped — ${listedCount} listed.`;
    scanVisibleMedia();
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
    const observer = new MutationObserver(() => {
      injectActionButtons();
      scheduleScan(150);
    });
    observer.observe(document.body, { childList: true, subtree: true });
    injectActionButtons();
    scanVisibleMedia();
    setInterval(() => {
      // Belt-and-braces: catches SPA views that reuse existing DOM nodes and
      // routes changed by mechanisms the history patch cannot see.
      handleRouteChange(window.location.href);
      injectActionButtons();
      scheduleScan(0);
    }, 2500);
  }

  chrome.storage?.local?.get(["scrollMediaFilter", "scrollSpeed", "skipDownloaded", "scrollIncludeQuoted"], (saved) => {
    if (saved?.scrollMediaFilter) mediaFilter = saved.scrollMediaFilter;
    if (saved?.scrollSpeed) scrollSpeed = saved.scrollSpeed;
    if (typeof saved?.skipDownloaded === "boolean") skipDownloaded = saved.skipDownloaded;
    if (typeof saved?.scrollIncludeQuoted === "boolean") includeQuoted = saved.scrollIncludeQuoted;
  });

  startDomWatchers();
  requestReplay();

  // ==========================================================================
  // MESSAGE LISTENER — Side Panel commands
  // ==========================================================================

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.action === "scrollSettings") {
      if (msg.mediaFilter) mediaFilter = msg.mediaFilter;
      if (msg.scrollSpeed) scrollSpeed = msg.scrollSpeed;
      if (typeof msg.skipDownloaded === "boolean") skipDownloaded = msg.skipDownloaded;
      if (typeof msg.includeQuoted === "boolean") includeQuoted = msg.includeQuoted;
      scheduleScan(0);
      sendResponse(statusPayload());
      return;
    }

    if (msg.action === "scrollStart") {
      if (autoScrollRunning) {
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

    if (msg.action === "scrollStop") {
      autoScrollStopRequested = true;
      autoScrollRunning = false;
      hideAutoScrollBadge();
      statusText = `Auto-scroll stopped — ${listedCount} listed.`;
      sendResponse({ ...statusPayload(), ok: true, running: false });
      return;
    }

    if (msg.action === "scrollStatus") {
      sendResponse(statusPayload());
      return;
    }

    if (msg.action === "scrollRescan") {
      requestReplay();
      scanVisibleMedia();
      sendResponse(statusPayload());
      return;
    }
  });

  function statusPayload() {
    return {
      ok: true,
      text: statusText,
      running: autoScrollRunning,
      found: listedCount,
      url: window.location.href,
      route: lastRoute,
      postsOnScreen,
      pendingVideos: pendingVideoTweets.size,
      mediaFilter,
      scrollSpeed,
      includeQuoted
    };
  }

  console.log("[X-DL] Scroll capture active — listing media on every X view");
})();
