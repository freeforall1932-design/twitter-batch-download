// ==========================================================================
// injected.js — MAIN-world network observer (Rank S Plucker insight, local)
// Captures live X GraphQL operation metadata + request headers from the
// signed-in page session and parses every GraphQL response for media.
// Never phones home. Never displays tokens in UI.
// ==========================================================================
(function initXdlInjected(globalScope) {
  if (globalScope.__xdlInjectedNetworkBridge) return;
  globalScope.__xdlInjectedNetworkBridge = true;

  const SOURCE = "XDL_INJECTED";

  // Operations whose *request metadata* (query id / features / variables) is
  // worth remembering for Remote fetch. This list intentionally does NOT gate
  // response parsing: X renames and adds timeline operations often, and an
  // allowlist there silently broke Home timeline and profile capture.
  const TRACKED_OPS = [
    "UserByScreenName",
    "UserMedia",
    "UserTweets",
    "UserTweetsAndReplies",
    "UserPhotoTimeline",
    "UserVideoTimeline",
    "TweetResultByRestId",
    "TweetDetail"
  ];

  const HEADER_KEYS = [
    ["authorization", "authorization"],
    ["x-csrf-token", "x-csrf-token"],
    ["x-client-uuid", "x-client-uuid"],
    ["x-twitter-active-user", "x-twitter-active-user"],
    ["x-twitter-client-language", "x-twitter-client-language"],
    ["x-twitter-auth-type", "x-twitter-auth-type"],
    ["x-client-transaction-id", "x-client-transaction-id"]
  ];

  // Replay buffer (Rank S `replayMediaContext` pattern). The isolated-world
  // content script can be re-created by an extension reload while this MAIN
  // world patch survives, and the very first timeline response of a hard page
  // load can land before the isolated listener is ready. Keep the recent
  // payloads so a late listener can still receive them.
  const REPLAY_MAX = 40;
  const replayBuffer = [];
  const replayedKeys = new Set();
  const capturedOperations = new Map();

  function post(type, data, extra = {}) {
    try {
      globalScope.postMessage({
        source: SOURCE,
        type,
        data,
        capturedUrl: String(globalScope.location?.href || ""),
        ...extra
      }, "*");
    } catch (_) { /* page may be navigating */ }
  }

  function pickHeaders(raw = {}) {
    const out = {};
    for (const [lower, canonical] of HEADER_KEYS) {
      const key = Object.keys(raw).find((name) => String(name).toLowerCase() === lower);
      if (key && raw[key]) out[canonical] = String(raw[key]);
    }
    return out;
  }

  function isGraphqlUrl(urlString) {
    return typeof urlString === "string" && /\/graphql\//.test(urlString);
  }

  function parseGraphqlUrl(urlString) {
    try {
      const url = new URL(urlString, globalScope.location.origin);
      if (!/\/graphql\//.test(url.pathname)) return null;
      const parts = url.pathname.split("/").filter(Boolean);
      // .../graphql/{queryId}/{operationName}
      const gqlIndex = parts.findIndex((part) => part === "graphql");
      if (gqlIndex < 0 || parts.length < gqlIndex + 3) return null;
      const queryId = parts[gqlIndex + 1];
      const operationName = parts[gqlIndex + 2];
      if (!queryId || !operationName) return null;
      return {
        queryId,
        operationName,
        variables: url.searchParams.get("variables") || null,
        features: url.searchParams.get("features") || null,
        fieldToggles: url.searchParams.get("fieldToggles") || null
      };
    } catch (_) {
      return null;
    }
  }

  function emitCapture(urlString, headers) {
    const parsed = parseGraphqlUrl(urlString);
    if (!parsed) return null;
    // Only remember request metadata for the operations Remote fetch replays.
    if (!TRACKED_OPS.includes(parsed.operationName)) return parsed;
    const picked = pickHeaders(headers || {});
    const payload = { ...parsed, headers: picked, at: Date.now() };
    capturedOperations.set(parsed.operationName, payload);
    post("xdlNetworkCapture", payload);
    return parsed;
  }

  function bufferResponse(entry) {
    replayBuffer.push(entry);
    while (replayBuffer.length > REPLAY_MAX) replayBuffer.shift();
  }

  function emitGraphqlResponse(urlString, body) {
    if (!isGraphqlUrl(urlString) || !body || typeof body !== "object") return;
    const parsed = parseGraphqlUrl(urlString) || { operationName: "Unknown", queryId: "" };
    // Cheap pre-filter: only forward payloads that plausibly contain media so
    // large non-media GraphQL responses are not serialized across worlds.
    let serialized = "";
    try {
      serialized = JSON.stringify(body);
    } catch (_) {
      return;
    }
    if (!serialized || !/"(extended_entities|media_url_https|video_info)"/.test(serialized)) return;
    const entry = {
      operationName: parsed.operationName,
      queryId: parsed.queryId,
      json: body,
      at: Date.now(),
      key: `${parsed.operationName}:${parsed.queryId}:${serialized.length}:${serialized.slice(0, 64)}`
    };
    bufferResponse(entry);
    post("xdlGraphqlResponse", entry);
  }

  function replayAll() {
    // Re-send everything buffered. The isolated world deduplicates by item id,
    // and the background queue deduplicates again, so replays are safe.
    for (const entry of replayBuffer) {
      post("xdlGraphqlResponse", entry, { replay: true });
    }
    for (const capture of capturedOperations.values()) {
      post("xdlNetworkCapture", capture, { replay: true });
    }
    post("xdlReplayDone", { count: replayBuffer.length });
  }

  function parseJsonMaybe(text) {
    if (!text || typeof text !== "string") return null;
    try { return JSON.parse(text); } catch (_) { return null; }
  }

  function patchXhr() {
    if (typeof globalScope.XMLHttpRequest !== "function") return;
    const originalOpen = globalScope.XMLHttpRequest.prototype.open;
    const originalSetHeader = globalScope.XMLHttpRequest.prototype.setRequestHeader;
    const originalSend = globalScope.XMLHttpRequest.prototype.send;

    globalScope.XMLHttpRequest.prototype.open = function patchedOpen(method, url) {
      this.__xdlUrl = String(url || "");
      this.__xdlHeaders = {};
      return originalOpen.apply(this, arguments);
    };

    globalScope.XMLHttpRequest.prototype.setRequestHeader = function patchedSetHeader(name, value) {
      try {
        if (!this.__xdlHeaders) this.__xdlHeaders = {};
        this.__xdlHeaders[name] = value;
      } catch (_) { /* ignore */ }
      return originalSetHeader.apply(this, arguments);
    };

    globalScope.XMLHttpRequest.prototype.send = function patchedSend() {
      try {
        if (this.__xdlUrl && isGraphqlUrl(this.__xdlUrl)) {
          emitCapture(this.__xdlUrl, this.__xdlHeaders || {});
          this.addEventListener("loadend", () => {
            try {
              if (this.responseType && this.responseType !== "text") return;
              const json = parseJsonMaybe(this.responseText);
              if (json) emitGraphqlResponse(this.__xdlUrl, json);
            } catch (_) { /* ignore response capture failures */ }
          }, { once: true });
        }
      } catch (_) { /* ignore */ }
      return originalSend.apply(this, arguments);
    };
  }

  function patchFetch() {
    if (typeof globalScope.fetch !== "function") return;
    const originalFetch = globalScope.fetch;
    globalScope.fetch = function patchedFetch(resource, init) {
      let requestUrl = "";
      try {
        requestUrl = typeof resource === "string"
          ? resource
          : (resource && resource.url) || "";
        if (isGraphqlUrl(requestUrl)) {
          const headers = {};
          const rawHeaders = (init && init.headers) || (resource && resource.headers) || null;
          if (rawHeaders) {
            if (typeof rawHeaders.forEach === "function") {
              rawHeaders.forEach((value, key) => { headers[key] = value; });
            } else if (Array.isArray(rawHeaders)) {
              rawHeaders.forEach((entry) => {
                if (entry && entry.length >= 2) headers[entry[0]] = entry[1];
              });
            } else if (typeof rawHeaders === "object") {
              Object.assign(headers, rawHeaders);
            }
          }
          emitCapture(requestUrl, headers);
        }
      } catch (_) { /* ignore */ }
      const result = originalFetch.apply(this, arguments);
      try {
        return Promise.resolve(result).then((response) => {
          try {
            const responseUrl = (response && response.url) || requestUrl;
            if (isGraphqlUrl(responseUrl) && response && typeof response.clone === "function") {
              response.clone().json()
                .then((json) => emitGraphqlResponse(responseUrl, json))
                .catch(() => {});
            }
          } catch (_) { /* ignore */ }
          return response;
        });
      } catch (_) {
        return result;
      }
    };
  }

  // SPA route changes (Rank S URL watcher). X swaps profile → /media and post
  // detail views without a document load, so the isolated world needs an
  // explicit signal to re-scan the DOM instead of waiting for a reload.
  function patchHistory() {
    const originals = {
      push: globalScope.history.pushState.bind(globalScope.history),
      replace: globalScope.history.replaceState.bind(globalScope.history)
    };
    let currentHref = globalScope.location.href;
    const notify = (navigationType) => {
      const next = globalScope.location.href;
      if (next === currentHref) return;
      const previous = currentHref;
      currentHref = next;
      post("xdlUrlChanged", { previousUrl: previous, newUrl: next, navigationType });
    };
    globalScope.history.pushState = function patchedPushState() {
      originals.push.apply(globalScope.history, arguments);
      notify("push");
    };
    globalScope.history.replaceState = function patchedReplaceState() {
      originals.replace.apply(globalScope.history, arguments);
      notify("replace");
    };
    globalScope.addEventListener("popstate", () => notify("pop"));
  }

  // The isolated world asks for a replay whenever it (re)starts, which covers
  // both an extension reload on an open tab and a listener that attached after
  // the first timeline response of a hard page load.
  globalScope.addEventListener("message", (event) => {
    if (event.source !== globalScope) return;
    const payload = event.data;
    if (!payload || payload.source !== "XDL_CONTENT") return;
    if (payload.type === "xdlRequestReplay") replayAll();
  });

  patchXhr();
  patchFetch();
  patchHistory();
  post("xdlInjectedReady", { ok: true });
  // Exposed for the isolated world's dedupe bookkeeping in tests/diagnostics.
  globalScope.__xdlInjectedReplayKeys = replayedKeys;
})(window);
