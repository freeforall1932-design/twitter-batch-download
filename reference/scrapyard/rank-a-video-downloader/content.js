(function initContentScript() {
  if (window.__X_MEDIA_VAULT_CONTENT__) {
    return;
  }
  window.__X_MEDIA_VAULT_CONTENT__ = true;

  const TWEET_SELECTOR = 'article[data-testid="tweet"]';
  const BUTTON_CLASS = "xmv-download-button";
  const ADD_BATCH_BUTTON_CLASS = "xmv-add-batch-button";
  const BULK_BUTTON_CLASS = "xmv-bulk-save-button";
  const BULK_QUEUE_STORAGE_KEY = "xmvBulkQueueItems";
  const BULK_QUEUE_POSITION_KEY = "xmvBulkQueuePosition";
  const pendingGraphQLRequests = new Map();

  let queuePanel = null;
  let queuePollInterval = null;
  let queueMinimized = false;
  let bulkSaveButton = null;
  let bulkSaveInProgress = false;
  let bulkQueuePanel = null;
  let bulkQueueItems = [];
  let bulkQueueMinimized = false;
  let bulkQueuePosition = loadBulkQueuePosition();

  const tweetDownloadState = new Map();


  function t(key, fallback, substitutions) {
    try {
      var msg = chrome.i18n.getMessage(key, substitutions);
      return msg || fallback || key;
    } catch (e) {
      return fallback || key;
    }
  }

  function isExtensionContextValid() {
    try {
      return typeof chrome !== "undefined" &&
        !!chrome.runtime &&
        typeof chrome.runtime.sendMessage === "function" &&
        !!chrome.runtime.id;
    } catch (error) {
      return false;
    }
  }

  function isContextInvalidatedError(error) {
    const message = String(error && error.message ? error.message : error || "");
    return message.toLowerCase().includes("extension context invalidated");
  }

  async function readBulkQueueItems() {
    try {
      const stored = await chrome.storage.local.get({ [BULK_QUEUE_STORAGE_KEY]: [] });
      const items = Array.isArray(stored[BULK_QUEUE_STORAGE_KEY]) ? stored[BULK_QUEUE_STORAGE_KEY] : [];
      bulkQueueItems = dedupeMediaItems(items);
      return bulkQueueItems.slice();
    } catch (error) {
      return bulkQueueItems.slice();
    }
  }

  async function writeBulkQueueItems(items) {
    const next = dedupeMediaItems(Array.isArray(items) ? items : []);
    bulkQueueItems = next;

    try {
      await chrome.storage.local.set({ [BULK_QUEUE_STORAGE_KEY]: next });
    } catch (error) {
    }

    return next.slice();
  }

  function loadBulkQueuePosition() {
    try {
      const raw = window.localStorage.getItem(BULK_QUEUE_POSITION_KEY);
      if (!raw) {
        return { left: 20, top: 120 };
      }

      const parsed = JSON.parse(raw);
      return {
        left: Number(parsed && parsed.left) || 20,
        top: Number(parsed && parsed.top) || 120
      };
    } catch (error) {
      return { left: 20, top: 120 };
    }
  }

  function saveBulkQueuePosition(position) {
    try {
      window.localStorage.setItem(BULK_QUEUE_POSITION_KEY, JSON.stringify(position));
    } catch (error) {
    }
  }

  function clampBulkQueuePosition(left, top, panel) {
    const rect = panel.getBoundingClientRect();
    const maxLeft = Math.max(8, window.innerWidth - rect.width - 8);
    const maxTop = Math.max(8, window.innerHeight - rect.height - 8);

    return {
      left: Math.min(Math.max(8, left), maxLeft),
      top: Math.min(Math.max(8, top), maxTop)
    };
  }

  function applyBulkQueuePosition(panel) {
    if (!panel) {
      return;
    }

    const position = bulkQueuePosition || loadBulkQueuePosition();
    panel.style.left = Math.round(position.left) + "px";
    panel.style.top = Math.round(position.top) + "px";
    panel.style.right = "auto";
    panel.style.bottom = "auto";
  }

  function attachBulkQueueDrag(header, panel) {
    if (!header || !panel) {
      return;
    }

    header.style.touchAction = "none";
    header.style.webkitUserDrag = "none";

    function beginDrag(startEvent) {
      if (startEvent && typeof startEvent.button === "number" && startEvent.button !== 0) {
        return;
      }

      const startRect = panel.getBoundingClientRect();
      const startLeft = startRect.left;
      const startTop = startRect.top;
      const startX = startEvent.clientX;
      const startY = startEvent.clientY;
      let dragging = true;

      function onMove(moveEvent) {
        if (!dragging) {
          return;
        }

        const next = clampBulkQueuePosition(
          startLeft + (moveEvent.clientX - startX),
          startTop + (moveEvent.clientY - startY),
          panel
        );
        bulkQueuePosition = next;
        applyBulkQueuePosition(panel);
      }

      function onUp() {
        if (!dragging) {
          return;
        }

        dragging = false;
        window.removeEventListener("pointermove", onMove, true);
        window.removeEventListener("pointerup", onUp, true);
        window.removeEventListener("pointercancel", onUp, true);
        window.removeEventListener("mousemove", onMove, true);
        window.removeEventListener("mouseup", onUp, true);
        window.removeEventListener("touchmove", onTouchMove, true);
        window.removeEventListener("touchend", onUp, true);
        window.removeEventListener("touchcancel", onUp, true);
        saveBulkQueuePosition(bulkQueuePosition || { left: startLeft, top: startTop });
      }

      function onTouchMove(moveEvent) {
        const touch = moveEvent.touches && moveEvent.touches[0];
        if (!touch) {
          return;
        }
        onMove({
          clientX: touch.clientX,
          clientY: touch.clientY
        });
      }

      window.addEventListener("pointermove", onMove, true);
      window.addEventListener("pointerup", onUp, true);
      window.addEventListener("pointercancel", onUp, true);
      window.addEventListener("mousemove", onMove, true);
      window.addEventListener("mouseup", onUp, true);
      window.addEventListener("touchmove", onTouchMove, { passive: false, capture: true });
      window.addEventListener("touchend", onUp, true);
      window.addEventListener("touchcancel", onUp, true);

      if (typeof startEvent.preventDefault === "function") {
        startEvent.preventDefault();
      }
    }

    header.addEventListener("pointerdown", beginDrag);
    header.addEventListener("mousedown", beginDrag);
    header.addEventListener("touchstart", function(event) {
      const touch = event.touches && event.touches[0];
      if (!touch) {
        return;
      }
      beginDrag({
        clientX: touch.clientX,
        clientY: touch.clientY,
        target: event.target,
        preventDefault: function() {
          event.preventDefault();
        }
      });
    }, { passive: false });
  }

  function normalizeMediaUrlKey(rawUrl) {
    try {
      const url = new URL(String(rawUrl || ""), window.location.origin);
      url.hash = "";
      const host = String(url.hostname || "").toLowerCase();
      const path = url.pathname || "";

      if (host.includes("pbs.twimg.com") && path.includes("/media/")) {
        return url.origin + path;
      }

      if (host.includes("video.twimg.com")) {
        return url.origin + path;
      }

      url.searchParams.delete("name");
      if (url.searchParams.has("format")) {
        url.searchParams.set("format", String(url.searchParams.get("format") || "").toLowerCase());
      }
      return url.origin + path + (url.search ? url.search : "");
    } catch (error) {
      return String(rawUrl || "");
    }
  }

  function getMediaKindLabel(type) {
    const normalized = String(type || "").toLowerCase();
    if (normalized === "image") {
      return "Image";
    }
    if (normalized === "gif") {
      return "GIF";
    }
    if (normalized === "video") {
      return "Video";
    }
    return "Media";
  }

  function showToast(message, type) {
    const existing = document.querySelector(".xmv-toast");
    if (existing) {
      existing.remove();
    }

    const toast = document.createElement("div");
    toast.className = "xmv-toast xmv-toast-" + (type || "info");
    toast.textContent = message;

    document.body.appendChild(toast);

    window.setTimeout(function() {
      toast.classList.add("xmv-toast-visible");
    }, 10);

    window.setTimeout(function() {
      toast.classList.remove("xmv-toast-visible");
      window.setTimeout(function() {
        toast.remove();
      }, 200);
    }, 2200);
  }

  function sendDownloadMessage(items) {
    return new Promise(function(resolve, reject) {
      if (!isExtensionContextValid()) {
        reject(new Error("Extension context invalidated. Refresh the page and try again."));
        return;
      }

      try {
        chrome.runtime.sendMessage(
          {
            type: "XMV_DOWNLOAD_MEDIA",
            items: items
          },
          function onResponse(response) {
            try {
              if (!isExtensionContextValid()) {
                reject(new Error("Extension context invalidated. Refresh the page and try again."));
                return;
              }

              if (chrome.runtime.lastError) {
                reject(new Error(chrome.runtime.lastError.message));
                return;
              }


              if (!response || !response.ok) {
                reject(new Error((response && response.error) || "Background download failed"));
                return;
              }

              resolve(response);
            } catch (error) {
              reject(error);
            }
          }
        );
      } catch (error) {
        reject(error);
      }
    });
  }

  function requestGraphQLMedia(tweetId) {
    return new Promise(function(resolve) {
      const requestId = "xmv_" + Date.now() + "_" + Math.random().toString(16).slice(2);
      const timeoutId = window.setTimeout(function() {
        pendingGraphQLRequests.delete(requestId);
        resolve([]);
      }, 2500);

      pendingGraphQLRequests.set(requestId, function(items) {
        window.clearTimeout(timeoutId);
        resolve(Array.isArray(items) ? items : []);
      });

      window.postMessage({
        source: "XMV_CONTENT",
        type: "XMV_GET_MEDIA",
        requestId: requestId,
        tweetId: tweetId
      }, "*");
    });
  }

  function cleanUsername(value) {
    return String(value || "")
      .replace(/^@/, "")
      .replace(/[^A-Za-z0-9_]/g, "")
      .slice(0, 15);
  }

  function getUsernameFromLocation(tweetId) {
    try {
      const path = window.location.pathname || "";
      const match = path.match(/^\/([^/?#]+)\/status\/(\d+)/);
      if (match && match[1] && (!tweetId || match[2] === tweetId)) {
        return cleanUsername(match[1]);
      }
    } catch (error) {
      return "";
    }
    return "";
  }

  function normalizeHrefPath(href) {
    try {
      if (href.startsWith("http://") || href.startsWith("https://")) {
        return new URL(href).pathname;
      }
      return href.split("?")[0].split("#")[0];
    } catch (error) {
      return href;
    }
  }

  function getUsernameFromStatusLinks(tweetCard, tweetId) {
    const links = tweetCard.querySelectorAll('a[href*="/status/"]');

    for (const link of links) {
      const href = link.getAttribute("href") || "";
      const normalizedHref = normalizeHrefPath(href);
      const match = normalizedHref.match(/^\/([^/?#]+)\/status\/(\d+)/);
      if (!match) {
        continue;
      }

      const username = match[1];
      const id = match[2];
      if (tweetId && id !== tweetId) {
        continue;
      }

      const cleaned = cleanUsername(username);
      if (cleaned) {
        return cleaned;
      }
    }

    return "";
  }

  function getUsernameFromHandleText(tweetCard) {
    const spans = tweetCard.querySelectorAll("span");

    for (const span of spans) {
      const text = (span.textContent || "").trim();
      const match = text.match(/^@([A-Za-z0-9_]{1,15})$/);
      if (match && match[1]) {
        return cleanUsername(match[1]);
      }
    }

    return "";
  }

  function getUsernameFromProfileLinks(tweetCard) {
    const blocked = new Set([
      "home",
      "explore",
      "notifications",
      "messages",
      "search",
      "settings",
      "compose",
      "i"
    ]);

    const links = tweetCard.querySelectorAll('a[href^="/"][role="link"]');

    for (const link of links) {
      const href = link.getAttribute("href") || "";
      const path = href.split("?")[0].split("#")[0];
      const parts = path.split("/").filter(Boolean);

      if (parts.length !== 1) {
        continue;
      }

      const candidate = parts[0];
      if (blocked.has(candidate)) {
        continue;
      }

      if (/^[A-Za-z0-9_]{1,15}$/.test(candidate)) {
        const cleaned = cleanUsername(candidate);
        if (cleaned) {
          return cleaned;
        }
      }
    }

    return "";
  }

  function getUsername(tweetCard, tweetId) {
    const fromLocation = getUsernameFromLocation(tweetId);
    if (fromLocation) {
      return fromLocation;
    }

    const fromStatusLinks = getUsernameFromStatusLinks(tweetCard, tweetId);
    if (fromStatusLinks) {
      return fromStatusLinks;
    }

    const fromHandleText = getUsernameFromHandleText(tweetCard);
    if (fromHandleText) {
      return fromHandleText;
    }

    const fromProfileLinks = getUsernameFromProfileLinks(tweetCard);
    if (fromProfileLinks) {
      return fromProfileLinks;
    }

    return "unknown";
  }

  function getTweetId(tweetCard) {
    const links = tweetCard.querySelectorAll('a[href*="/status/"]');
    for (const link of links) {
      const href = link.getAttribute("href") || "";
      const match = href.match(/\/([^/]+)\/status\/(\d+)/);
      if (match && match[2]) {
        return match[2];
      }
    }
    return "";
  }

  function getTweetContext(tweetCard) {
    const tweetId = getTweetId(tweetCard);
    if (!tweetId) {
      return null;
    }

    return {
      username: getUsername(tweetCard, tweetId),
      tweetId: tweetId
    };
  }

  function normalizeImageUrl(rawUrl) {
    try {
      const url = new URL(rawUrl, window.location.origin);
      const pathname = url.pathname || "";
      if (!pathname.includes("/media/")) {
        return null;
      }

      const currentFormat = (url.searchParams.get("format") || "").toLowerCase();
      const ext = currentFormat || "jpg";
      url.searchParams.set("format", ext);
      url.searchParams.set("name", "large");

      return {
        url: url.toString(),
        ext: ext,
        key: url.origin + pathname
      };
    } catch (error) {
      return null;
    }
  }

  function isVideoThumbnailUrl(rawUrl) {
    return typeof rawUrl === "string" && (
      rawUrl.includes("ext_tw_video_thumb") ||
      rawUrl.includes("tweet_video_thumb") ||
      rawUrl.includes("amplify_video_thumb")
    );
  }

  function isValidTweetMediaUrl(rawUrl) {
    if (!rawUrl || typeof rawUrl !== "string") {
      return false;
    }

    if (rawUrl.startsWith("data:")) {
      return false;
    }

    if (rawUrl.includes("abs.twimg.com")) {
      return false;
    }

    if (rawUrl.includes("/profile_images/")) {
      return false;
    }

    if (rawUrl.includes("/emoji/")) {
      return false;
    }

    if (rawUrl.includes(".svg")) {
      return false;
    }

    if (isVideoThumbnailUrl(rawUrl)) {
      return false;
    }

    return rawUrl.includes("pbs.twimg.com/media/");
  }

  function collectImages(tweetCard, context) {
    const seen = new Set();
    const items = [];
    const images = tweetCard.querySelectorAll("img");

    for (const image of images) {
      const rawUrl = image.currentSrc || image.src || image.getAttribute("src") || "";
      if (!isValidTweetMediaUrl(rawUrl)) {
        continue;
      }

      const normalized = normalizeImageUrl(rawUrl);
      if (!normalized || seen.has(normalized.url)) {
        continue;
      }

      const key = normalized.key || normalized.url;
      if (seen.has(key)) {
        continue;
      }

      seen.add(key);
      items.push({
        url: normalized.url,
        key: key,
        username: context.username,
        tweetId: context.tweetId,
        type: "image",
        ext: normalized.ext
      });
    }

    return items;
  }

  function collectVideoItems(tweetCard, context) {
    const items = [];
    const seen = new Set();
    const videos = tweetCard.querySelectorAll("video");

    for (const video of videos) {
      const candidates = [
        video.currentSrc,
        video.src,
        video.getAttribute("src")
      ];
      const sources = video.querySelectorAll("source");
      for (const source of sources) {
        candidates.push(source.currentSrc || source.src || source.getAttribute("src"));
      }

      for (const rawUrl of candidates) {
        const url = String(rawUrl || "").trim();
        if (!url || seen.has(url) || url.startsWith("blob:")) {
          continue;
        }

        if (!url.includes("video.twimg.com") && !url.includes("pbs.twimg.com") && !url.includes("twimg.com")) {
          continue;
        }

        seen.add(url);
        items.push({
          url: url,
          username: context.username,
          tweetId: context.tweetId,
          type: "video",
          ext: "mp4"
        });
        break;
      }
    }

    return items;
  }

  function mergeMediaItems(imageItems, graphItems) {
    return dedupeMediaItems(imageItems.concat(graphItems));
  }

  function dedupeMediaItems(items) {
    const merged = [];
    const seen = new Set();

    for (const item of items || []) {
      if (!item || !item.url) {
        continue;
      }

      const key = item.key || normalizeMediaUrlKey(item.url);
      if (seen.has(key)) {
        continue;
      }

      seen.add(key);
      merged.push(item);
    }

    return merged;
  }

  async function collectMediaItemsForTweetCard(tweetCard, context) {
    const resolvedContext = context || getTweetContext(tweetCard);
    if (!resolvedContext) {
      return [];
    }

    const imageItems = collectImages(tweetCard, resolvedContext);
    const videoItems = collectVideoItems(tweetCard, resolvedContext);
    const graphItems = await requestGraphQLMedia(resolvedContext.tweetId);
    const graphItemsWithUsername = graphItems.map(function(item) {
      return Object.assign({}, item, {
        username: item && item.username && item.username !== "unknown"
          ? item.username
          : resolvedContext.username
      });
    });

    return mergeMediaItems(imageItems.concat(videoItems), graphItemsWithUsername);
  }

  async function collectBulkMediaItems() {
    const tweetCards = Array.from(document.querySelectorAll(TWEET_SELECTOR));
    const seenTweetIds = new Set();
    const items = [];

    for (const tweetCard of tweetCards) {
      const context = getTweetContext(tweetCard);
      if (!context || seenTweetIds.has(context.tweetId)) {
        continue;
      }

      seenTweetIds.add(context.tweetId);

      try {
        const tweetItems = await collectMediaItemsForTweetCard(tweetCard, context);
        if (tweetItems && tweetItems.length) {
          items.push.apply(items, tweetItems);
        }
      } catch (error) {
        continue;
      }
    }

    return dedupeMediaItems(items);
  }

  async function setBulkQueueItems(items) {
    return writeBulkQueueItems(items);
  }

  async function appendBulkQueueItems(items) {
    const current = await readBulkQueueItems();
    const before = current.length;
    const next = dedupeMediaItems(current.concat(Array.isArray(items) ? items : []));
    await writeBulkQueueItems(next);
    return {
      addedCount: next.length - before,
      totalCount: next.length
    };
  }

  async function removeBulkQueueItem(url) {
    const current = await readBulkQueueItems();
    await writeBulkQueueItems(current.filter(function(item) {
      return item && item.url !== url;
    }));
  }

  async function removeBulkQueueGroup(tweetId) {
    const current = await readBulkQueueItems();
    await writeBulkQueueItems(current.filter(function(item) {
      return item && item.tweetId !== tweetId;
    }));
  }

  async function moveBulkQueueItem(url, delta) {
    const items = await readBulkQueueItems();
    const index = items.findIndex(function(item) {
      return item && item.url === url;
    });
    if (index < 0) {
      return;
    }

    const nextIndex = index + delta;
    if (nextIndex < 0 || nextIndex >= items.length) {
      return;
    }

    const next = items.slice();
    const temp = next[index];
    next[index] = next[nextIndex];
    next[nextIndex] = temp;
    await writeBulkQueueItems(next);
  }

  async function moveBulkQueueGroup(tweetId, delta) {
    const items = await readBulkQueueItems();
    const groups = buildBulkQueueGroups(items);
    const index = groups.findIndex(function(group) {
      return group && group.tweetId === tweetId;
    });
    if (index < 0) {
      return;
    }

    const nextIndex = index + delta;
    if (nextIndex < 0 || nextIndex >= groups.length) {
      return;
    }

    const nextGroups = groups.slice();
    const temp = nextGroups[index];
    nextGroups[index] = nextGroups[nextIndex];
    nextGroups[nextIndex] = temp;
    await writeBulkQueueItems(nextGroups.reduce(function(acc, group) {
      return acc.concat(group.items);
    }, []));
  }

  async function clearBulkQueueItems() {
    await writeBulkQueueItems([]);
  }

  function ensureBulkSaveButton() {
    return null;
  }

  function createAddBatchButton(tweetCard, tweetId) {
    const batchButton = document.createElement("button");
    batchButton.type = "button";
    batchButton.className = ADD_BATCH_BUTTON_CLASS;
    batchButton.dataset.tweetId = tweetId;
    batchButton.textContent = t("addToBatch", "Batch Queue");
    batchButton.title = t("addToBatchHint", "Add this post's media to the batch queue.");
    batchButton.addEventListener("click", async function onBatchClick(event) {
      event.preventDefault();
      event.stopPropagation();
      await onAddToBatchClick(tweetCard, tweetId, batchButton);
    });
    return batchButton;
  }

  function ensureTweetActionButtons(tweetCard, tweetId) {
    const existingWrapper = tweetCard.querySelector(".xmv-download-wrapper");
    if (!existingWrapper) {
      return false;
    }

    let group = existingWrapper.querySelector(".xmv-button-group");
    if (!group) {
      group = document.createElement("div");
      group.className = "xmv-button-group";

      while (existingWrapper.firstChild) {
        group.appendChild(existingWrapper.firstChild);
      }

      existingWrapper.appendChild(group);
    }

    if (!group.querySelector(".xmv-add-batch-button")) {
      group.appendChild(createAddBatchButton(tweetCard, tweetId));
    }

    return true;
  }

  async function onAddToBatchClick(tweetCard, tweetId, button) {
    if (!tweetCard || !tweetId) {
      return;
    }

    if (button) {
      button.disabled = true;
      button.textContent = t("addingToBatch", "Adding...");
    }

    try {
      const username = getUsername(tweetCard, tweetId);
      const items = await collectMediaItemsForTweetCard(tweetCard, { username: username, tweetId: tweetId });

      if (!items.length) {
        showToast(t("toastNoMediaFound"), "warning");
        return;
      }

      const result = await appendBulkQueueItems(items);

      if (result.addedCount > 0) {
        showToast(
          t("toastAddedToBatch", "Added to batch queue."),
          "success"
        );
      } else {
        showToast(
          t("toastAlreadyInBatch", "This post is already in the batch queue."),
          "info"
        );
      }
    } catch (error) {
      if (isContextInvalidatedError(error)) {
        showToast(t("toastExtensionUpdated"), "warning");
      } else {
        showToast(t("toastCouldNotAddToQueue"), "error");
      }
    } finally {
      if (button && button.isConnected) {
        button.disabled = false;
        button.textContent = t("addToBatch", "Batch Queue");
      }
    }
  }

  function updateBulkSaveButtonState(state) {
    return state;
  }

  async function onBulkSaveClick(event) {
    event.preventDefault();
    event.stopPropagation();

    if (bulkSaveInProgress) {
      return;
    }

    bulkSaveInProgress = true;
    ensureBulkSaveButton();
    updateBulkSaveButtonState("checking");

    try {
      const items = await collectBulkMediaItems();
      if (!items.length) {
        updateBulkSaveButtonState("idle");
        showToast(t("toastNoMediaFound"), "warning");
        return;
      }

      updateBulkSaveButtonState("adding");
      await appendBulkQueueItems(items);
      showToast(t("toastQueueReady", "Added to batch queue."), "success");
    } catch (error) {
      if (isContextInvalidatedError(error)) {
        showToast(t("toastExtensionUpdated"), "warning");
      } else {
        showToast(t("toastCouldNotAddToQueue"), "error");
      }
    } finally {
      bulkSaveInProgress = false;
      updateBulkSaveButtonState("idle");
    }
  }

  function showBulkQueuePanel() {
    return;
  }

  function createBulkQueuePanel() {
    const panel = document.createElement("div");
    panel.className = "xmv-bulk-queue-panel";

    const header = document.createElement("div");
    header.className = "xmv-bulk-queue-header";

    const dragHandle = document.createElement("button");
    dragHandle.type = "button";
    dragHandle.className = "xmv-bulk-drag-handle";
    dragHandle.textContent = "⋮⋮";
    dragHandle.title = t("dragQueueHandle", "Drag to move");
    dragHandle.setAttribute("aria-label", t("dragQueueHandle", "Drag to move"));
    header.appendChild(dragHandle);

    const headerText = document.createElement("div");
    headerText.className = "xmv-bulk-queue-header-text";
    const headerKicker = document.createElement("div");
    headerKicker.className = "xmv-bulk-queue-kicker";
    headerKicker.textContent = t("bulkQueueTitleChip", "Batch review");
    const headerStrong = document.createElement("strong");
    headerStrong.textContent = t("bulkQueueTitle", "Review Queue");
    const headerSpan = document.createElement("span");
    headerSpan.textContent = t("bulkQueueSubtitle", "Edit what gets downloaded");
    headerText.appendChild(headerKicker);
    headerText.appendChild(headerStrong);
    headerText.appendChild(headerSpan);
    header.appendChild(headerText);

    const minimizeBtn = document.createElement("button");
    minimizeBtn.type = "button";
    minimizeBtn.className = "xmv-bulk-queue-minimize";
    minimizeBtn.textContent = "\u2014";
    minimizeBtn.title = t("hideQueue", "Hide queue");
    minimizeBtn.setAttribute("aria-label", t("hideQueue", "Hide queue"));
    header.appendChild(minimizeBtn);

    const body = document.createElement("div");
    body.className = "xmv-bulk-queue-body";

    const summaryEl = document.createElement("div");
    summaryEl.className = "xmv-bulk-queue-summary";

    const listEl = document.createElement("div");
    listEl.className = "xmv-bulk-queue-list";

    const note = document.createElement("p");
    note.className = "xmv-bulk-queue-note";
    note.textContent = t(
      "localPrivacyNote",
      "Media is processed locally in your browser. No uploads required."
    );

    const footer = document.createElement("div");
    footer.className = "xmv-bulk-queue-footer";

    const refreshBtn = document.createElement("button");
    refreshBtn.type = "button";
    refreshBtn.className = "xmv-bulk-secondary";
    refreshBtn.textContent = t("bulkQueueRefresh", "Refresh");
    footer.appendChild(refreshBtn);

    const clearBtn = document.createElement("button");
    clearBtn.type = "button";
    clearBtn.className = "xmv-bulk-secondary";
    clearBtn.textContent = t("bulkQueueClear", "Clear");
    footer.appendChild(clearBtn);

    const downloadBtn = document.createElement("button");
    downloadBtn.type = "button";
    downloadBtn.className = "xmv-bulk-primary";
    downloadBtn.textContent = t("bulkQueueDownloadAll", "Download All");
    footer.appendChild(downloadBtn);

    body.appendChild(summaryEl);
    const controlsBar = document.createElement("div");
    controlsBar.className = "xmv-bulk-queue-controls";
    const controlsHint = document.createElement("span");
    controlsHint.textContent = t(
      "bulkQueueControlsHint",
      "Drag the title bar to move. Use arrows to reorder."
    );
    controlsBar.appendChild(controlsHint);
    body.appendChild(controlsBar);
    body.appendChild(listEl);
    body.appendChild(note);
    body.appendChild(footer);
    panel.appendChild(header);
    panel.appendChild(body);

    attachBulkQueueDrag(dragHandle, panel);

    minimizeBtn.addEventListener("click", function(event) {
      event.preventDefault();
      event.stopPropagation();
      bulkQueueMinimized = !bulkQueueMinimized;
      body.hidden = bulkQueueMinimized;
      panel.classList.toggle("xmv-is-collapsed", bulkQueueMinimized);
      minimizeBtn.textContent = bulkQueueMinimized ? "+" : "\u2014";
      minimizeBtn.title = bulkQueueMinimized ? t("showQueue", "Show queue") : t("hideQueue", "Hide queue");
      minimizeBtn.setAttribute("aria-label", bulkQueueMinimized ? t("showQueue", "Show queue") : t("hideQueue", "Hide queue"));
    });

    refreshBtn.addEventListener("click", async function() {
      if (bulkSaveInProgress) {
        return;
      }

      bulkSaveInProgress = true;
      updateBulkSaveButtonState("checking");
      try {
        const items = await collectBulkMediaItems();
        await setBulkQueueItems(items);
        if (!items.length) {
          showToast(t("toastNoMediaFound"), "warning");
        } else {
          showToast(t("toastQueueRefreshed", "Queue refreshed."), "success");
        }
      } finally {
        bulkSaveInProgress = false;
        updateBulkSaveButtonState("idle");
      }
    });

    clearBtn.addEventListener("click", async function() {
      await clearBulkQueueItems();
      showToast(t("toastQueueCleared", "Queue cleared."), "info");
    });

    downloadBtn.addEventListener("click", async function() {
      if (!bulkQueueItems.length) {
        showToast(t("toastNoMediaFound"), "warning");
        return;
      }

      downloadBtn.disabled = true;
      downloadBtn.textContent = t("bulkQueueStarting", "Starting...");
      try {
        const response = await sendDownloadMessage(bulkQueueItems);
        showDownloadQueuePanel();
        renderDownloadQueue(response.tasks || []);
        await clearBulkQueueItems();

        const queuedCount = Array.isArray(response.tasks) ? response.tasks.length : 0;
        if (response && response.skippedCount > 0) {
          showToast(
            t(
              "toastBulkQueuedSummary",
              "Added $1 items, skipped $2 duplicates.",
              [queuedCount, response.skippedCount]
            ),
            "success"
          );
        } else {
          showToast(t("toastAddedToQueue"), "success");
        }
      } catch (error) {
        if (isContextInvalidatedError(error)) {
          showToast(t("toastExtensionUpdated"), "warning");
        } else {
          showToast(t("toastCouldNotAddToQueue"), "error");
        }
      } finally {
        downloadBtn.disabled = false;
        downloadBtn.textContent = t("bulkQueueDownloadAll", "Download All");
      }
    });

    listEl.addEventListener("click", function(event) {
      const toggleGroupMenuBtn = event.target.closest("[data-action='toggle-bulk-group-menu']");
      if (toggleGroupMenuBtn) {
        const shell = toggleGroupMenuBtn.closest(".xmv-bulk-actions-shell");
        if (shell) {
          shell.classList.toggle("xmv-is-open");
        }
        return;
      }

      const toggleItemMenuBtn = event.target.closest("[data-action='toggle-bulk-item-menu']");
      if (toggleItemMenuBtn) {
        const shell = toggleItemMenuBtn.closest(".xmv-bulk-actions-shell");
        if (shell) {
          shell.classList.toggle("xmv-is-open");
        }
        return;
      }

      const moveGroupUpBtn = event.target.closest("[data-action='move-bulk-group-up']");
      if (moveGroupUpBtn) {
        const tweetId = moveGroupUpBtn.dataset.tweetId;
        if (tweetId) {
          moveBulkQueueGroup(tweetId, -1);
        }
        return;
      }

      const moveGroupDownBtn = event.target.closest("[data-action='move-bulk-group-down']");
      if (moveGroupDownBtn) {
        const tweetId = moveGroupDownBtn.dataset.tweetId;
        if (tweetId) {
          moveBulkQueueGroup(tweetId, 1);
        }
        return;
      }

      const removeGroupBtn = event.target.closest("[data-action='remove-bulk-group']");
      if (removeGroupBtn) {
        const tweetId = removeGroupBtn.dataset.tweetId;
        if (tweetId) {
          removeBulkQueueGroup(tweetId);
          showToast(t("toastQueueGroupRemoved", "Post removed from queue."), "info");
        }
        return;
      }

      const removeBtn = event.target.closest("[data-action='remove-bulk-item']");
      if (!removeBtn) {
        const moveItemUpBtn = event.target.closest("[data-action='move-bulk-item-up']");
        if (moveItemUpBtn) {
          const url = moveItemUpBtn.dataset.url;
          if (url) {
            moveBulkQueueItem(url, -1);
          }
          return;
        }

        const moveItemDownBtn = event.target.closest("[data-action='move-bulk-item-down']");
        if (moveItemDownBtn) {
          const url = moveItemDownBtn.dataset.url;
          if (url) {
            moveBulkQueueItem(url, 1);
          }
          return;
        }

        return;
      }

      const url = removeBtn.dataset.url;
      if (!url) {
        return;
      }

      removeBulkQueueItem(url);
      showToast(t("toastQueueItemRemoved", "Removed from queue."), "info");
    });

    return panel;
  }

  function renderBulkQueuePanel() {
    return;
  }

  function buildBulkQueueGroups(items) {
    const groups = new Map();

    (Array.isArray(items) ? items : bulkQueueItems).forEach(function(item, index) {
      if (!item) {
        return;
      }

      const key = item.tweetId || item.url || String(index);
      if (!groups.has(key)) {
        groups.set(key, {
          key: key,
          tweetId: item.tweetId || "",
          title: makeBulkQueueGroupTitle(item),
          subtitle: makeBulkQueueGroupSubtitle(item),
          items: []
        });
      }

      groups.get(key).items.push(item);
    });

    return Array.from(groups.values());
  }

  function makeBulkQueueGroupTitle(item) {
    const username = item && item.username ? "@" + item.username : t("unknownSource", "Unknown source");
    const tweetId = item && item.tweetId ? item.tweetId : t("bulkQueueOnePost", "One post");
    return username + " · " + tweetId;
  }

  function makeBulkQueueGroupSubtitle(item) {
    const count = item && item.tweetId ? t("bulkQueueFromPost", "Post media") : t("bulkQueueLooseMedia", "Unsorted media");
    return count;
  }

  function showDownloadQueuePanel() {
    return;
  }

  function createQueuePanel() {
    const panel = document.createElement("div");
    panel.className = "xmv-queue-panel";

    const header = document.createElement("div");
    header.className = "xmv-queue-header";

    const headerTextDiv = document.createElement("div");
    const headerStrong = document.createElement("strong");
    headerStrong.textContent = t("queueTitle");
    const headerSpan = document.createElement("span");
    headerSpan.textContent = t("queueSubtitle");
    headerTextDiv.appendChild(headerStrong);
    headerTextDiv.appendChild(headerSpan);
    header.appendChild(headerTextDiv);

    const minimizeBtn = document.createElement("button");
    minimizeBtn.type = "button";
    minimizeBtn.className = "xmv-queue-minimize";
    minimizeBtn.textContent = "\u2014";
    header.appendChild(minimizeBtn);

    const body = document.createElement("div");
    body.className = "xmv-queue-body";

    const summaryEl = document.createElement("div");
    summaryEl.className = "xmv-queue-summary";

    const listEl = document.createElement("div");
    listEl.className = "xmv-queue-list";

    const footer = document.createElement("div");
    footer.className = "xmv-queue-footer";

    const clearBtn = document.createElement("button");
    clearBtn.type = "button";
    clearBtn.className = "xmv-clear-completed";
    clearBtn.textContent = t("queueClearCompleted");
    footer.appendChild(clearBtn);

    const retryAllBtn = document.createElement("button");
    retryAllBtn.type = "button";
    retryAllBtn.className = "xmv-retry-failed";
    retryAllBtn.textContent = t("queueRetryAllFailed");
    retryAllBtn.style.display = "none";
    footer.appendChild(retryAllBtn);

    body.appendChild(summaryEl);
    body.appendChild(listEl);
    body.appendChild(footer);
    panel.appendChild(header);
    panel.appendChild(body);

    minimizeBtn.addEventListener("click", function() {
      queueMinimized = !queueMinimized;
      body.style.display = queueMinimized ? "none" : "";
      minimizeBtn.textContent = queueMinimized ? "+" : "\u2014";
    });

    clearBtn.addEventListener("click", function() {
      if (!isExtensionContextValid()) {
        return;
      }
      chrome.runtime.sendMessage({ type: "XMV_CLEAR_COMPLETED_TASKS" }, function(response) {
        if (chrome.runtime.lastError) {
          return;
        }
        if (response && response.ok) {
          renderDownloadQueue(response.tasks || []);
        }
      });
    });

    retryAllBtn.addEventListener("click", function() {
      if (!isExtensionContextValid()) {
        return;
      }
      chrome.runtime.sendMessage({ type: "XMV_RETRY_FAILED_TASKS" }, function(response) {
        if (chrome.runtime.lastError) {
          return;
        }
        if (response && response.ok) {
          renderDownloadQueue(response.tasks || []);
          startDownloadQueuePolling();
          showToast(t("toastRetryQueued"), "success");
        } else {
          showToast(t("toastRetryFailed"), "error");
        }
      });
    });

    listEl.addEventListener("click", function(event) {
      const retryBtn = event.target.closest("[data-action='retry-task']");
      if (!retryBtn) return;

      const taskId = retryBtn.dataset.taskId;
      if (!taskId) {
        return;
      }

      if (!isExtensionContextValid()) return;

      retryBtn.disabled = true;
      retryBtn.textContent = t("queueRetrying");

      chrome.runtime.sendMessage(
        { type: "XMV_RETRY_DOWNLOAD_TASK", taskId: taskId },
        function(response) {
          if (chrome.runtime.lastError) {
            retryBtn.disabled = false;
            retryBtn.textContent = t("queueRetry");
            return;
          }
          if (response && response.ok) {
            renderDownloadQueue(response.tasks || []);
            startDownloadQueuePolling();
            showToast(t("toastRetryQueued"), "success");
          } else {
            retryBtn.disabled = false;
            retryBtn.textContent = t("queueRetry");
            showToast(t("toastRetryFailed"), "error");
          }
        }
      );
    });

    return panel;
  }

  function renderDownloadQueue(tasks) {
    syncTweetButtonStatesFromTasks(tasks);

    if (!queuePanel) {
      return;
    }

    const listEl = queuePanel.querySelector(".xmv-queue-list");
    const summaryEl = queuePanel.querySelector(".xmv-queue-summary");

    if (!tasks || !tasks.length) {
      const emptyDiv = document.createElement("div");
      emptyDiv.className = "xmv-queue-empty";
      emptyDiv.textContent = t("queueNoDownloadsYet");
      listEl.innerHTML = "";
      listEl.appendChild(emptyDiv);
      summaryEl.textContent = "";
      return;
    }

    const counts = { downloading: 0, queued: 0, completed: 0, failed: 0 };
    for (const task of tasks) {
      if (counts[task.status] !== undefined) {
        counts[task.status]++;
      }
    }

    const parts = [];
    if (counts.downloading) parts.push(counts.downloading + " " + t("queueSummaryDownloading"));
    if (counts.queued) parts.push(counts.queued + " " + t("queueSummaryWaiting"));
    if (counts.completed) parts.push(counts.completed + " " + t("queueSummaryDone"));
    if (counts.failed) parts.push(counts.failed + " " + t("queueSummaryFailed"));
    summaryEl.textContent = parts.join(" \u00b7 ");

    listEl.innerHTML = "";
    for (const task of tasks) {
      const item = document.createElement("div");
      item.className = "xmv-queue-item";
      if (task.error) {
        item.title = task.error;
      }

      const filename = (task.filename || "").split("/").pop() || task.filename || "file";
      const statusLabelMap = {
        queued: t("queueStatusWaiting"),
        downloading: t("queueStatusDownloading"),
        completed: t("queueStatusDone"),
        failed: t("queueStatusFailed")
      };
      const statusLabel = statusLabelMap[task.status] || task.status;
      const progress = typeof task.progress === "number" ? task.progress : null;
      const showBar = task.status === "downloading" || task.status === "completed";

      const fileDiv = document.createElement("div");
      fileDiv.className = "xmv-queue-file";
      fileDiv.title = filename;
      fileDiv.textContent = filename;

      const metaDiv = document.createElement("div");
      metaDiv.className = "xmv-queue-meta xmv-queue-item-actions";

      const statusSpan = document.createElement("span");
      statusSpan.className = "xmv-queue-status xmv-status-" + task.status;
      statusSpan.textContent = statusLabel;
      metaDiv.appendChild(statusSpan);

      if (progress !== null && task.status !== "failed") {
        const progressSpan = document.createElement("span");
        progressSpan.className = "xmv-queue-progress";
        progressSpan.textContent = progress + "%";
        metaDiv.appendChild(progressSpan);
      }

      if (task.status === "failed") {
        const retryBtn = document.createElement("button");
        retryBtn.type = "button";
        retryBtn.className = "xmv-retry-task";
        retryBtn.textContent = t("queueRetry");
        retryBtn.dataset.action = "retry-task";
        retryBtn.dataset.taskId = task.taskId;
        metaDiv.appendChild(retryBtn);
      }

      item.appendChild(fileDiv);
      item.appendChild(metaDiv);

      if (showBar) {
        const barDiv = document.createElement("div");
        barDiv.className = "xmv-progress-bar";
        const fillDiv = document.createElement("div");
        fillDiv.style.width = (progress !== null ? progress : 0) + "%";
        barDiv.appendChild(fillDiv);
        item.appendChild(barDiv);
      }

      listEl.appendChild(item);
    }

    const retryAllBtn = queuePanel.querySelector(".xmv-retry-failed");
    if (retryAllBtn) {
      retryAllBtn.style.display = counts.failed > 0 ? "" : "none";
    }

  }

  if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener(function(message, sender, sendResponse) {
      if (!message || typeof message !== "object") {
        return false;
      }

      if (message.type === "XMV_OPEN_BULK_QUEUE") {
        showBulkQueuePanel();
        sendResponse({ ok: true, count: bulkQueueItems.length });
        return false;
      }

      if (message.type !== "XMV_SCAN_AND_OPEN_BULK_QUEUE") {
        return false;
      }

      (async function() {
        try {
          const items = await collectBulkMediaItems();
          if (items.length) {
            setBulkQueueItems(items);
          } else {
            showBulkQueuePanel();
          }
          showBulkQueuePanel();
          sendResponse({ ok: true, count: items.length });
        } catch (error) {
          sendResponse({
            ok: false,
            error: String(error && error.message ? error.message : error)
          });
        }
      })();

      return true;
    });
  }

  function startDownloadQueuePolling() {
    if (queuePollInterval) {
      return;
    }
    queuePollInterval = window.setInterval(function() {
      if (!isExtensionContextValid()) {
        stopDownloadQueuePolling();
        return;
      }
      chrome.runtime.sendMessage({ type: "XMV_GET_DOWNLOAD_TASKS" }, function(response) {
        if (chrome.runtime.lastError) {
          return;
        }
        if (response && response.ok) {
          renderDownloadQueue(response.tasks || []);
        }
      });
    }, 1000);
  }

  function stopDownloadQueuePolling() {
    if (queuePollInterval) {
      window.clearInterval(queuePollInterval);
      queuePollInterval = null;
    }
  }

  function updateButtonState(button, state) {
    button.dataset.xmvState = state;
    button.classList.remove(
      "xmv-state-idle", "xmv-state-checking", "xmv-state-starting",
      "xmv-state-queued", "xmv-state-downloading", "xmv-state-completed",
      "xmv-state-failed", "xmv-state-no-media"
    );
    button.classList.add("xmv-state-" + (state === "noMedia" ? "no-media" : state));
    switch (state) {
      case "checking":
        button.textContent = t("checking");
        button.disabled = true;
        break;
      case "starting":
        button.textContent = t("adding");
        button.disabled = true;
        break;
      case "queued":
        button.textContent = t("inQueue");
        button.disabled = false;
        break;
      case "downloading":
        button.textContent = t("downloading");
        button.disabled = false;
        break;
      case "completed":
        button.textContent = t("done");
        button.disabled = false;
        break;
      case "failed":
        button.textContent = t("retry");
        button.disabled = false;
        break;
      case "noMedia":
        button.textContent = t("noMedia");
        button.disabled = true;
        break;
      case "idle":
      default:
        button.textContent = t("saveMedia");
        button.disabled = false;
        break;
    }
  }

  function deriveTweetStatus(tasks) {
    if (!tasks || !tasks.length) return "idle";
    if (tasks.some(function(tk) { return tk.status === "failed"; })) return "failed";
    if (tasks.some(function(tk) { return tk.status === "downloading"; })) return "downloading";
    if (tasks.some(function(tk) { return tk.status === "queued"; })) return "queued";
    if (tasks.every(function(tk) { return tk.status === "completed"; })) return "completed";
    return "queued";
  }

  function syncTweetButtonStatesFromTasks(tasks) {
    const tasksByTweetId = new Map();
    for (const task of tasks) {
      if (!task.tweetId) continue;
      if (!tasksByTweetId.has(task.tweetId)) {
        tasksByTweetId.set(task.tweetId, []);
      }
      tasksByTweetId.get(task.tweetId).push(task);
    }

    for (const [tweetId, tweetTasks] of tasksByTweetId.entries()) {
      const status = deriveTweetStatus(tweetTasks);
      tweetDownloadState.set(tweetId, {
        status: status,
        taskIds: tweetTasks.map(function(tk) { return tk.taskId; }).filter(Boolean),
        updatedAt: Date.now()
      });

      const buttons = document.querySelectorAll(
        '.xmv-download-button[data-tweet-id="' + tweetId + '"]'
      );
      buttons.forEach(function(btn) {
        updateButtonState(btn, status);
      });
    }
  }

  function insertDownloadButton(tweet, button) {
    if (tweet.querySelector(".xmv-download-wrapper")) {
      return;
    }

    const wrapper = document.createElement("div");
    wrapper.className = "xmv-download-wrapper";
    wrapper.appendChild(button);

    const actionGroup = tweet.querySelector('[role="group"]');
    if (actionGroup && actionGroup.parentElement) {
      actionGroup.insertAdjacentElement("afterend", wrapper);
      return;
    }

    const textContainer = tweet.querySelector('[data-testid="tweetText"]');
    if (textContainer && textContainer.parentElement) {
      textContainer.parentElement.insertAdjacentElement("beforeend", wrapper);
      return;
    }

    tweet.insertAdjacentElement("beforeend", wrapper);
  }

  function injectButton(tweetCard) {
    const context = getTweetContext(tweetCard);
    if (!context) {
      return;
    }

    const tweetId = context.tweetId;
    if (ensureTweetActionButtons(tweetCard, tweetId)) {
      return;
    }

    const buttonGroup = document.createElement("div");
    buttonGroup.className = "xmv-button-group";

    const button = document.createElement("button");
    button.type = "button";
    button.className = BUTTON_CLASS;
    button.dataset.tweetId = tweetId;

    const existingState = tweetDownloadState.get(tweetId);
    updateButtonState(button, existingState ? existingState.status : "idle");
    buttonGroup.appendChild(button);
    buttonGroup.appendChild(createAddBatchButton(tweetCard, tweetId));

    button.addEventListener("click", async function onClick(event) {
      event.preventDefault();
      event.stopPropagation();

      const currentState = tweetDownloadState.get(tweetId);
      if (currentState && ["queued", "downloading", "completed"].includes(currentState.status)) {
        showDownloadQueuePanel();
        if (currentState.status === "completed") {
          showToast(t("alreadyDownloaded"), "info");
        } else {
          showToast(t("toastAlreadyInQueue"), "info");
        }
        return;
      }

      try {
        updateButtonState(button, "checking");
        const username = getUsername(tweetCard, tweetId);
        const items = await collectMediaItemsForTweetCard(tweetCard, { username: username, tweetId: tweetId });

        if (!items.length) {
          updateButtonState(button, "noMedia");
          showToast(t("toastNoMediaFound"), "warning");
          window.setTimeout(function() {
            updateButtonState(button, "idle");
          }, 1500);
          return;
        }

        updateButtonState(button, "starting");
        tweetDownloadState.set(tweetId, {
          status: "starting",
          taskIds: [],
          updatedAt: Date.now()
        });
        showDownloadQueuePanel();

        const response = await sendDownloadMessage(items);

        const taskIds = Array.isArray(response.tasks)
          ? response.tasks.map(function(task) { return task.taskId; }).filter(Boolean)
          : [];

        tweetDownloadState.set(tweetId, {
          status: "queued",
          taskIds: taskIds,
          updatedAt: Date.now()
        });

        updateButtonState(button, "queued");
        renderDownloadQueue(response.tasks || []);
        showToast(t("toastAddedToQueue"), "success");
      } catch (error) {

        tweetDownloadState.set(tweetId, {
          status: "failed",
          taskIds: [],
          updatedAt: Date.now()
        });

        updateButtonState(button, "failed");
        if (isContextInvalidatedError(error)) {
          showToast(t("toastExtensionUpdated"), "warning");
        } else {
          showToast(t("toastCouldNotAddToQueue"), "error");
        }
      }
    });

    insertDownloadButton(tweetCard, buttonGroup);
  }

  function scanTweets() {
    const tweetCards = document.querySelectorAll(TWEET_SELECTOR);
    tweetCards.forEach(injectButton);
  }

  const observer = new MutationObserver(function onMutations() {
    scanTweets();
  });

  window.addEventListener("message", function onMessage(event) {
    if (event.source !== window || !event.data || event.data.source !== "XMV_INJECTED") {
      return;
    }

    if (event.data.type !== "XMV_MEDIA_RESPONSE" || !event.data.requestId) {
      return;
    }

    const handler = pendingGraphQLRequests.get(event.data.requestId);
    if (!handler) {
      return;
    }

    pendingGraphQLRequests.delete(event.data.requestId);
    handler(event.data.items);
  });

  function start() {
    document.querySelectorAll("." + BULK_BUTTON_CLASS + ", .xmv-bulk-queue-panel, .xmv-queue-panel").forEach(function(node) {
      if (node && node.parentNode) {
        node.parentNode.removeChild(node);
      }
    });
    scanTweets();
    observer.observe(document.body || document.documentElement, {
      childList: true,
      subtree: true
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
})();
