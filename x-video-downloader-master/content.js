// ==========================================================================
// content.js — DOM observer, button injection, bulk scroll loop
// Runs in ISOLATED world on x.com / twitter.com
// ==========================================================================

(() => {
  if (window.__xdl_active !== undefined) {
    console.log("[X-DL] Already injected");
    return;
  }
  window.__xdl_active = false;
  console.log("[X-DL] Content script loaded on:", window.location.href);

  // --- State ---
  let downloaded = 0;
  let maxMedia = 100;
  let scrollSpeed = "medium";
  let mediaFilter = "all"; // "all" | "video" | "photo"
  let useZip = false;
  let running = false;
  let statusText = "Ready";
  let statusState = "";
  const processedTweets = new Set();
  let envReady = false;
  let bulkId = 0; // unique ID for each bulk session

  const SCROLL_CONFIG = {
    slow: { distance: 400, interval: 3500 },
    medium: { distance: 600, interval: 2200 },
    fast: { distance: 900, interval: 1400 }
  };

  // ==========================================================================
  // UI STYLES — Download button styling
  // ==========================================================================

  const style = document.createElement("style");
  style.textContent = `
    .xdl-btn {
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 0 12px;
      height: 32px;
      border: none;
      border-radius: 9999px;
      background: rgba(29,155,240,0.1);
      color: rgb(29,155,240);
      font-size: 13px;
      font-weight: 700;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      cursor: pointer;
      transition: background 0.2s;
      white-space: nowrap;
    }
    .xdl-btn:hover {
      background: rgba(29,155,240,0.2);
    }
    .xdl-btn.xdl-loading {
      opacity: 0.6;
      cursor: wait;
    }
    .xdl-btn.xdl-done {
      background: rgba(0,186,124,0.1);
      color: rgb(0,186,124);
    }
    .xdl-btn.xdl-error {
      background: rgba(244,33,46,0.1);
      color: rgb(244,33,46);
    }
    .xdl-btn svg {
      width: 16px;
      height: 16px;
      fill: currentColor;
    }
  `;
  document.head.appendChild(style);

  const DOWNLOAD_SVG = `<svg viewBox="0 0 24 24"><path d="M12 2a1 1 0 0 1 1 1v10.59l3.3-3.3a1 1 0 1 1 1.4 1.42l-5 5a1 1 0 0 1-1.4 0l-5-5a1 1 0 1 1 1.4-1.42l3.3 3.3V3a1 1 0 0 1 1-1zM5 20a1 1 0 1 0 0 2h14a1 1 0 1 0 0-2H5z"/></svg>`;
  const CHECK_SVG = `<svg viewBox="0 0 24 24"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z"/></svg>`;

  // ==========================================================================
  // UTILITIES
  // ==========================================================================

  function sanitizeFilename(text) {
    return text
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

  // ==========================================================================
  // DOM — Extract tweet info from article node
  // ==========================================================================

  function getTweetInfo(article) {
    // Tweet text
    const tweetTextEl = article.querySelector('[data-testid="tweetText"]');
    const tweetText = tweetTextEl ? tweetTextEl.innerText : "";

    // Author handle — find first link matching /username pattern
    let handle = "";
    const allLinks = article.querySelectorAll('a[role="link"]');
    for (const link of allLinks) {
      const href = link.getAttribute("href");
      if (href && /^\/[A-Za-z0-9_]{1,15}$/.test(href)) {
        handle = href.slice(1);
        break;
      }
    }

    // Tweet ID from the timestamp link
    const timeEl = article.querySelector("time");
    const tweetLink = timeEl ? timeEl.closest("a") : null;
    const tweetHref = tweetLink ? tweetLink.getAttribute("href") : null;

    let tweetId = null;
    if (tweetHref) {
      const match = tweetHref.match(/\/status\/(\d+)/);
      if (match) tweetId = match[1];
    }

    // Detect media types present in this tweet
    const hasVideo =
      article.querySelector("video") !== null ||
      article.querySelector('[data-testid="videoPlayer"]') !== null ||
      article.querySelector('[data-testid="videoComponent"]') !== null;

    // Photo detection — look for tweetPhoto testid or images within media containers
    const photoElements = article.querySelectorAll('[data-testid="tweetPhoto"]');
    const hasPhoto = photoElements.length > 0 && !hasVideo;

    // Also check for images that aren't inside video players
    let hasPhotoFallback = false;
    if (!hasPhoto && !hasVideo) {
      const images = article.querySelectorAll('img[src*="pbs.twimg.com/media"]');
      hasPhotoFallback = images.length > 0;
    }

    return {
      tweetText,
      handle,
      tweetId,
      tweetHref,
      hasVideo,
      hasPhoto: hasPhoto || hasPhotoFallback,
      hasMedia: hasVideo || hasPhoto || hasPhotoFallback
    };
  }

  // ==========================================================================
  // API COMMUNICATION — Talk to background.js
  // ==========================================================================

  function sendMessage(action, data = {}) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ action, ...data }, (resp) => {
        if (chrome.runtime.lastError) {
          console.error(`[X-DL] ${action} error:`, chrome.runtime.lastError.message);
          resolve(null);
          return;
        }
        resolve(resp);
      });
    });
  }

  function initEnv() {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ action: "initEnv" }, (resp) => {
        if (resp?.error) {
          console.error("[X-DL] Init error:", resp.error);
        }
        if (resp?.ok) {
          console.log("[X-DL] Auth initialized successfully");
          envReady = true;
        }
        resolve(!!resp?.ok);
      });
    });
  }

  function getTweetMedia(tweetId) {
    return sendMessage("getTweetMedia", { tweetId });
  }

  function downloadFile(url, filename) {
    return sendMessage("downloadFile", { url, filename });
  }

  // ==========================================================================
  // SINGLE DOWNLOAD — Handle click on a tweet's download button
  // ==========================================================================

  async function handleSingleDownload(btn, article) {
    if (btn.classList.contains("xdl-loading")) return;

    const info = getTweetInfo(article);
    if (!info.tweetId) {
      btn.classList.add("xdl-error");
      btn.innerHTML = `${DOWNLOAD_SVG} No ID`;
      return;
    }

    btn.classList.add("xdl-loading");
    btn.innerHTML = `${DOWNLOAD_SVG} Fetching...`;

    // Init auth if needed
    if (!envReady) {
      const ok = await initEnv();
      if (!ok) {
        btn.classList.remove("xdl-loading");
        btn.classList.add("xdl-error");
        btn.innerHTML = `${DOWNLOAD_SVG} Auth error`;
        setTimeout(() => resetBtn(btn), 3000);
        return;
      }
    }

    const media = await getTweetMedia(info.tweetId);
    if (!media || media.error) {
      btn.classList.remove("xdl-loading");
      if (media?.error === "protected_or_deleted") {
        btn.classList.add("xdl-error");
        btn.innerHTML = `${DOWNLOAD_SVG} Protected/N/A`;
      } else {
        btn.classList.add("xdl-error");
        btn.innerHTML = `${DOWNLOAD_SVG} No media`;
      }
      setTimeout(() => resetBtn(btn), 3000);
      return;
    }

    const safeName = sanitizeFilename(info.tweetText || media.tweetText);
    const handle = info.handle || media.username || "unknown";

    // Download videos
    let successCount = 0;
    if (media.videos && media.videos.length > 0) {
      for (let i = 0; i < media.videos.length; i++) {
        const v = media.videos[i];
        const suffix = media.videos.length > 1 ? `_vid${i + 1}` : "";
        const filename = `x-media/${handle}_${safeName}${suffix}.mp4`;

        btn.innerHTML = `${DOWNLOAD_SVG} Video ${i + 1}/${media.videos.length}...`;
        const result = await downloadFile(v.url, filename);
        if (result?.success) successCount++;
      }
    }

    // Download photos
    if (media.photos && media.photos.length > 0) {
      for (let i = 0; i < media.photos.length; i++) {
        const p = media.photos[i];
        // Determine extension from URL
        const ext = getPhotoExtension(p.url);
        const suffix = media.photos.length > 1 ? `_img${i + 1}` : "";
        const filename = `x-media/${handle}_${safeName}${suffix}.${ext}`;

        btn.innerHTML = `${DOWNLOAD_SVG} Photo ${i + 1}/${media.photos.length}...`;
        const result = await downloadFile(p.url, filename);
        if (result?.success) successCount++;
      }
    }

    btn.classList.remove("xdl-loading");
    if (successCount > 0) {
      btn.classList.add("xdl-done");
      btn.innerHTML = `${CHECK_SVG} Saved (${successCount})`;
    } else {
      btn.classList.add("xdl-error");
      btn.innerHTML = `${DOWNLOAD_SVG} Failed`;
      setTimeout(() => resetBtn(btn), 3000);
    }
  }

  function getPhotoExtension(url) {
    // Twitter photo URLs like: pbs.twimg.com/media/xxx.jpg?name=orig
    // or pbs.twimg.com/media/xxx.png?name=orig
    const cleanUrl = url.split("?")[0];
    if (cleanUrl.endsWith(".png")) return "png";
    if (cleanUrl.endsWith(".webp")) return "webp";
    return "jpg"; // default
  }

  function resetBtn(btn) {
    btn.classList.remove("xdl-error", "xdl-done");
    btn.innerHTML = `${DOWNLOAD_SVG} Download`;
  }

  // ==========================================================================
  // BUTTON INJECTION — Add download buttons to tweet action bars
  // ==========================================================================

  function injectDownloadButtons() {
    const articles = document.querySelectorAll('article[data-testid="tweet"]');

    for (const article of articles) {
      // Skip if button already added
      if (article.querySelector(".xdl-btn")) continue;

      const info = getTweetInfo(article);
      if (!info.hasMedia || !info.tweetId) continue;

      // Find the action bar (like, retweet, reply, share row)
      const actionBar = article.querySelector('[role="group"]');
      if (!actionBar) continue;

      const btn = document.createElement("button");
      btn.className = "xdl-btn";

      // Label based on media type
      let label = "Download";
      if (info.hasVideo && info.hasPhoto) label = "Download all";
      else if (info.hasVideo) label = "Download video";
      else label = "Download photo";

      btn.innerHTML = `${DOWNLOAD_SVG} ${label}`;
      btn.title = "Download media from this tweet";

      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        handleSingleDownload(btn, article);
      });

      actionBar.appendChild(btn);
    }
  }

  // Watch for new tweets appearing in the DOM (virtualized list)
  const observer = new MutationObserver(() => {
    injectDownloadButtons();
  });
  observer.observe(document.body, { childList: true, subtree: true });

  // Initial injection + periodic fallback
  injectDownloadButtons();
  setInterval(injectDownloadButtons, 2000);

  // ==========================================================================
  // BULK SCROLL LOOP — Auto-scroll and download all media
  // ==========================================================================

  function getVisibleMediaTweets() {
    const articles = document.querySelectorAll('article[data-testid="tweet"]');
    const tweets = [];

    for (const article of articles) {
      const info = getTweetInfo(article);
      if (!info.hasMedia || !info.tweetId) continue;
      if (processedTweets.has(info.tweetId)) continue;

      // Apply media type filter
      if (mediaFilter === "video" && !info.hasVideo) continue;
      if (mediaFilter === "photo" && !info.hasPhoto) continue;

      tweets.push({ ...info, article });
    }

    return tweets;
  }

  async function mainLoop() {
    console.log("[X-DL] Initializing auth environment...");
    statusText = "Initializing...";
    bulkId++;

    const envOk = await initEnv();
    if (!envOk) {
      console.error("[X-DL] Failed to initialize auth");
      statusText = "Error: Could not get auth tokens. Refresh the page.";
      statusState = "stopped";
      running = false;
      return;
    }
    console.log("[X-DL] Auth ready. Starting bulk download loop.");

    const config = SCROLL_CONFIG[scrollSpeed] || SCROLL_CONFIG.medium;
    statusState = "running";
    let noNewCount = 0;
    let stuckSinceScroll = 0;

    // Wait for new DOM content after scrolling
    function waitForNewContent(timeout) {
      return new Promise((resolve) => {
        let resolved = false;
        const obs = new MutationObserver(() => {
          if (!resolved) {
            resolved = true;
            obs.disconnect();
            setTimeout(resolve, 300);
          }
        });
        obs.observe(document.body, { childList: true, subtree: true });
        setTimeout(() => {
          if (!resolved) {
            resolved = true;
            obs.disconnect();
            resolve();
          }
        }, timeout);
      });
    }

    while (running && downloaded < maxMedia) {
      const tweets = getVisibleMediaTweets();

      if (tweets.length > 0) {
        noNewCount = 0;
        for (const tweet of tweets) {
          if (!running || downloaded >= maxMedia) break;

          processedTweets.add(tweet.tweetId);
          statusText = `Processing ${downloaded + 1}/${maxMedia}...`;

          console.log("[X-DL] Processing tweet:", tweet.tweetId, "by @" + tweet.handle);

          const media = await getTweetMedia(tweet.tweetId);
          if (!media || media.error) {
            console.warn("[X-DL] No media for tweet:", tweet.tweetId, media?.error);
            continue;
          }

          const safeName = sanitizeFilename(media.tweetText || tweet.tweetText);
          const handle = media.username || tweet.handle || "unknown";

          // Download videos
          if (media.videos) {
            for (let i = 0; i < media.videos.length; i++) {
              if (!running || downloaded >= maxMedia) break;

              const v = media.videos[i];
              const suffix = media.videos.length > 1 ? `_vid${i + 1}` : "";
              const index = String(downloaded + 1).padStart(3, "0");
              const filename = `x-media/${index}_${handle}_${safeName}${suffix}.mp4`;

              statusText = `Downloading video ${downloaded + 1}/${maxMedia}...`;
              const result = await downloadFile(v.url, filename);
              if (result?.success) {
                downloaded++;
                statusText = `Downloaded ${downloaded}/${maxMedia}`;

                const btn = tweet.article.querySelector(".xdl-btn");
                if (btn) {
                  btn.classList.add("xdl-done");
                  btn.innerHTML = `${CHECK_SVG} Saved`;
                }
              }

              // Small delay between downloads
              await sleep(500);
            }
          }

          // Download photos
          if (media.photos) {
            for (let i = 0; i < media.photos.length; i++) {
              if (!running || downloaded >= maxMedia) break;

              const p = media.photos[i];
              const ext = getPhotoExtension(p.url);
              const suffix = media.photos.length > 1 ? `_img${i + 1}` : "";
              const index = String(downloaded + 1).padStart(3, "0");
              const filename = `x-media/${index}_${handle}_${safeName}${suffix}.${ext}`;

              statusText = `Downloading photo ${downloaded + 1}/${maxMedia}...`;
              const result = await downloadFile(p.url, filename);
              if (result?.success) {
                downloaded++;
                statusText = `Downloaded ${downloaded}/${maxMedia}`;

                const btn = tweet.article.querySelector(".xdl-btn");
                if (btn) {
                  btn.classList.add("xdl-done");
                  btn.innerHTML = `${CHECK_SVG} Saved`;
                }
              }

              await sleep(500);
            }
          }
        }
      } else {
        noNewCount++;
      }

      if (!running || downloaded >= maxMedia) break;

      // Scroll forward
      const scrollAmount = noNewCount > 2
        ? Math.min(800 + noNewCount * 400, 5000)
        : config.distance;

      window.scrollBy({ top: scrollAmount, behavior: noNewCount > 2 ? "instant" : "smooth" });
      statusText = `Scrolling... ${downloaded}/${maxMedia} downloaded`;

      if (noNewCount > 2) {
        console.log("[X-DL] Aggressive scroll", scrollAmount + "px (attempt " + noNewCount + ")");
        await waitForNewContent(4000);
      } else {
        await sleep(config.interval);
      }

      // Give up after many attempts with no new media
      if (noNewCount > 50) {
        console.log("[X-DL] No new media tweets after 50 scroll attempts, stopping");
        break;
      }

      // Detect end of page
      const atBottom = window.innerHeight + window.scrollY >= document.body.scrollHeight - 100;
      if (atBottom && noNewCount > 5) {
        window.scrollBy({ top: -200, behavior: "instant" });
        await sleep(500);
        window.scrollBy({ top: 400, behavior: "instant" });
        await waitForNewContent(3000);
        stuckSinceScroll++;
        if (stuckSinceScroll > 5) {
          console.log("[X-DL] Reached end of page");
          break;
        }
      } else {
        stuckSinceScroll = 0;
      }
    }

    running = false;
    window.__xdl_active = false;
    statusState = downloaded >= maxMedia ? "done" : "stopped";
    statusText = downloaded >= maxMedia
      ? `Done! Downloaded ${downloaded} items.`
      : `Stopped at ${downloaded} items.`;
    console.log("[X-DL]", statusText);
  }

  // ==========================================================================
  // MESSAGE LISTENER — Commands from popup.js
  // ==========================================================================

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.action === "start") {
      if (running) {
        sendResponse({ ok: false, reason: "Already running" });
        return;
      }
      maxMedia = msg.maxMedia || msg.maxVideos || 100;
      scrollSpeed = msg.scrollSpeed || "medium";
      mediaFilter = msg.mediaFilter || "all";
      useZip = msg.useZip || false;
      downloaded = 0;
      running = true;
      window.__xdl_active = true;
      processedTweets.clear();
      statusText = "Starting...";
      statusState = "running";
      console.log("[X-DL] STARTED. Max:", maxMedia, "Speed:", scrollSpeed, "Filter:", mediaFilter);
      sendResponse({ ok: true });
      mainLoop();
      return;
    }

    if (msg.action === "stop") {
      running = false;
      window.__xdl_active = false;
      statusText = `Stopped at ${downloaded} items.`;
      statusState = "stopped";
      sendResponse({ ok: true });
      return;
    }

    if (msg.action === "getStatus") {
      sendResponse({ text: statusText, state: statusState, downloaded });
      return;
    }
  });

  console.log("[X-DL] Ready — download buttons active on video and photo tweets");
})();
