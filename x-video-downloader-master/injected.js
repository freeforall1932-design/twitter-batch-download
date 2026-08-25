// ==========================================================================
// injected.js — MAIN-world network observer (Rank S Plucker insight, local)
// Captures live X GraphQL operation metadata + request headers from the
// signed-in page session. Never phones home. Never displays tokens in UI.
// ==========================================================================
(function initXdlInjected(globalScope) {
  if (globalScope.__xdlInjectedNetworkBridge) return;
  globalScope.__xdlInjectedNetworkBridge = true;

  const SOURCE = "XDL_INJECTED";
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

  function post(type, data) {
    try {
      globalScope.postMessage({ source: SOURCE, type, data, capturedUrl: String(globalScope.location?.href || "") }, "*");
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

  function parseGraphqlUrl(urlString) {
    try {
      const url = new URL(urlString, globalScope.location.origin);
      if (!/\/i\/api\/graphql\//.test(url.pathname) && !/\/graphql\//.test(url.pathname)) return null;
      const parts = url.pathname.split("/").filter(Boolean);
      // .../graphql/{queryId}/{operationName}
      const gqlIndex = parts.findIndex((part) => part === "graphql");
      if (gqlIndex < 0 || parts.length < gqlIndex + 3) return null;
      const queryId = parts[gqlIndex + 1];
      const operationName = parts[gqlIndex + 2];
      if (!queryId || !operationName) return null;
      if (!TRACKED_OPS.includes(operationName)) return null;
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
    if (!parsed) return;
    const picked = pickHeaders(headers || {});
    post("xdlNetworkCapture", {
      ...parsed,
      headers: picked,
      at: Date.now()
    });
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
        if (this.__xdlUrl) emitCapture(this.__xdlUrl, this.__xdlHeaders || {});
      } catch (_) { /* ignore */ }
      return originalSend.apply(this, arguments);
    };
  }

  function patchFetch() {
    if (typeof globalScope.fetch !== "function") return;
    const originalFetch = globalScope.fetch;
    globalScope.fetch = function patchedFetch(resource, init) {
      try {
        const requestUrl = typeof resource === "string"
          ? resource
          : (resource && resource.url) || "";
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
        if (requestUrl) emitCapture(requestUrl, headers);
      } catch (_) { /* ignore */ }
      return originalFetch.apply(this, arguments);
    };
  }

  patchXhr();
  patchFetch();
  post("xdlInjectedReady", { ok: true });
})(window);
