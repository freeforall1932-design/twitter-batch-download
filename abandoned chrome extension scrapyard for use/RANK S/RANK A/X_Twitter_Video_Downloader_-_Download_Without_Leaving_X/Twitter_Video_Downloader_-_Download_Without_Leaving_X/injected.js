(function initInjectedScript(globalScope) {
  if (globalScope.__X_MEDIA_VAULT_INJECTED__) {
    return;
  }
  globalScope.__X_MEDIA_VAULT_INJECTED__ = true;

  const mediaCache = new Map();


  function shouldInspectUrl(url) {
    return typeof url === "string" && (url.includes("/graphql/") || url.includes("/i/api/graphql/"));
  }

  function getTweetId(tweetObject) {
    if (!tweetObject || typeof tweetObject !== "object") {
      return "";
    }

    return (
      (tweetObject.legacy && tweetObject.legacy.id_str) ||
      tweetObject.rest_id ||
      (tweetObject.tweet && tweetObject.tweet.legacy && tweetObject.tweet.legacy.id_str) ||
      (tweetObject.tweet && tweetObject.tweet.rest_id) ||
      ""
    );
  }

  function getUsername(tweetObject) {
    if (!tweetObject || typeof tweetObject !== "object") {
      return "";
    }

    const userResult = tweetObject.core && tweetObject.core.user_results && tweetObject.core.user_results.result;
    if (!userResult || typeof userResult !== "object") {
      return "";
    }

    return (
      (userResult.legacy && userResult.legacy.screen_name) ||
      userResult.screen_name ||
      ""
    );
  }

  function getMediaArray(tweetObject) {
    if (!tweetObject || typeof tweetObject !== "object") {
      return [];
    }

    const candidates = [
      tweetObject.legacy && tweetObject.legacy.extended_entities && tweetObject.legacy.extended_entities.media,
      tweetObject.legacy && tweetObject.legacy.entities && tweetObject.legacy.entities.media,
      tweetObject.tweet && tweetObject.tweet.legacy && tweetObject.tweet.legacy.extended_entities && tweetObject.tweet.legacy.extended_entities.media,
      tweetObject.tweet && tweetObject.tweet.legacy && tweetObject.tweet.legacy.entities && tweetObject.tweet.legacy.entities.media
    ];

    for (const candidate of candidates) {
      if (Array.isArray(candidate) && candidate.length) {
        return candidate;
      }
    }

    return [];
  }

  function getBestVideoVariant(mediaItem) {
    const variants = Array.isArray(mediaItem && mediaItem.video_info && mediaItem.video_info.variants)
      ? mediaItem.video_info.variants
      : [];

    const mp4Variants = variants.filter(function filterVariant(variant) {
      return variant && variant.content_type === "video/mp4" && variant.url;
    });

    if (!mp4Variants.length) {
      return null;
    }

    mp4Variants.sort(function sortVariants(left, right) {
      const leftBitrate = typeof left.bitrate === "number" ? left.bitrate : -1;
      const rightBitrate = typeof right.bitrate === "number" ? right.bitrate : -1;
      return rightBitrate - leftBitrate;
    });

    return mp4Variants[0];
  }

  function normalizeImageUrl(rawUrl) {
    try {
      const url = new URL(rawUrl, globalScope.location.origin);
      const ext = (url.searchParams.get("format") || "jpg").toLowerCase();
      url.searchParams.set("format", ext);
      url.searchParams.set("name", "large");
      return {
        url: url.toString(),
        ext: ext
      };
    } catch (error) {
      return null;
    }
  }

  function parseTweetMedia(tweetObject) {
    const tweetId = getTweetId(tweetObject);
    const username = getUsername(tweetObject);
    const media = getMediaArray(tweetObject);

    if (!tweetId || !Array.isArray(media) || !media.length) {
      return null;
    }

    const items = [];
    const seen = new Set();

    for (const mediaItem of media) {
      if (!mediaItem || typeof mediaItem !== "object") {
        continue;
      }

      if (mediaItem.type === "photo" && mediaItem.media_url_https) {
        const normalized = normalizeImageUrl(mediaItem.media_url_https);
        if (!normalized || seen.has(normalized.url)) {
          continue;
        }
        seen.add(normalized.url);
        items.push({
          url: normalized.url,
          type: "image",
          ext: normalized.ext,
          tweetId: tweetId,
          username: username
        });
        continue;
      }

      if (mediaItem.type === "video" || mediaItem.type === "animated_gif") {
        const bestVariant = getBestVideoVariant(mediaItem);
        if (!bestVariant || seen.has(bestVariant.url)) {
          continue;
        }

        seen.add(bestVariant.url);
        items.push({
          url: bestVariant.url,
          type: mediaItem.type === "animated_gif" ? "animated_gif" : "video",
          ext: "mp4",
          tweetId: tweetId,
          username: username
        });
      }
    }

    if (!items.length) {
      return null;
    }

    return {
      tweetId: tweetId,
      items: items
    };
  }

  function walkObject(node, visitor, visited) {
    if (!node || typeof node !== "object") {
      return;
    }

    if (visited.has(node)) {
      return;
    }
    visited.add(node);

    visitor(node);

    if (Array.isArray(node)) {
      for (const item of node) {
        walkObject(item, visitor, visited);
      }
      return;
    }

    for (const key of Object.keys(node)) {
      walkObject(node[key], visitor, visited);
    }
  }

  function parseGraphQLPayload(payload) {
    const foundTweets = [];
    walkObject(payload, function visitNode(node) {
      const parsed = parseTweetMedia(node);
      if (parsed) {
        foundTweets.push(parsed);
      }
    }, new WeakSet());

    if (!foundTweets.length) {
      return;
    }


    for (const entry of foundTweets) {
      mediaCache.set(entry.tweetId, entry.items);
    }
  }

  function handleJsonPayload(url, payload) {
    if (!shouldInspectUrl(url)) {
      return;
    }

    try {
      parseGraphQLPayload(payload);
    } catch (error) {
    }
  }

  function patchFetch() {
    if (typeof globalScope.fetch !== "function") {
      return;
    }

    const originalFetch = globalScope.fetch;
    globalScope.fetch = function patchedFetch(resource, init) {
      const requestUrl = typeof resource === "string" ? resource : (resource && resource.url) || "";
      const promise = originalFetch.call(this, resource, init);

      promise.then(function handleResponse(response) {
        const responseUrl = (response && response.url) || requestUrl;
        if (!shouldInspectUrl(responseUrl) || !response || typeof response.clone !== "function") {
          return;
        }

        response.clone().json().then(function onJson(payload) {
          handleJsonPayload(responseUrl, payload);
        }).catch(function() {
          return undefined;
        });
      }).catch(function() {
        return undefined;
      });

      return promise;
    };
  }

  function patchXhr() {
    if (typeof globalScope.XMLHttpRequest !== "function") {
      return;
    }

    const originalOpen = globalScope.XMLHttpRequest.prototype.open;
    globalScope.XMLHttpRequest.prototype.open = function patchedOpen(method, url) {
      this.__xmvUrl = url;
      return originalOpen.apply(this, arguments);
    };

    const originalSend = globalScope.XMLHttpRequest.prototype.send;
    globalScope.XMLHttpRequest.prototype.send = function patchedSend() {
      this.addEventListener("load", function onLoad() {
        if (!shouldInspectUrl(this.__xmvUrl) || !this.responseText) {
          return;
        }

        try {
          handleJsonPayload(this.__xmvUrl, JSON.parse(this.responseText));
        } catch (error) {
          return undefined;
        }
      });

      return originalSend.apply(this, arguments);
    };
  }

  globalScope.addEventListener("message", function onMessage(event) {
    if (event.source !== globalScope || !event.data || event.data.source !== "XMV_CONTENT") {
      return;
    }

    if (event.data.type !== "XMV_GET_MEDIA") {
      return;
    }

    const tweetId = event.data.tweetId;
    const items = mediaCache.get(tweetId) || [];

    globalScope.postMessage({
      source: "XMV_INJECTED",
      type: "XMV_MEDIA_RESPONSE",
      requestId: event.data.requestId,
      tweetId: tweetId,
      items: items
    }, "*");
  });

  patchFetch();
  patchXhr();
})(window);
