// Simulates the live-testing failures reported against v3.1 by running the real
// extension/content.js inside a minimal DOM + chrome shim.
//
// Reproduced scenarios:
//   1. Home timeline capture (no allowlisted operation name).
//   2. Same-tab SPA route change (profile → /media, home → post) with no reload.
//   3. A profile's non-media posts, which only ever emit photos in the DOM.
//   4. Auto-scroll starting and stopping.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function makeElement(tag, options = {}) {
  const el = {
    tagName: String(tag).toUpperCase(),
    // content.js's mutation harvest walks record nodes and skips anything that
    // is not an element, so the shim has to say what these are.
    nodeType: 1,
    children: [],
    parentElement: null,
    attributes: { ...(options.attributes || {}) },
    dataset: {},
    style: {},
    classList: {
      _set: new Set(),
      add(...names) { names.forEach((name) => this._set.add(name)); },
      remove(...names) { names.forEach((name) => this._set.delete(name)); },
      contains(name) { return this._set.has(name); },
      toggle(name, force) { if (force === undefined) { this._set.has(name) ? this._set.delete(name) : this._set.add(name); } else if (force) { this._set.add(name); } else { this._set.delete(name); } }
    },
    innerText: options.innerText || "",
    textContent: options.textContent || "",
    set className(value) { this.classList._set = new Set(String(value).split(/\s+/).filter(Boolean)); },
    get className() { return Array.from(this.classList._set).join(" "); },
    set innerHTML(value) { this._innerHTML = value; },
    get innerHTML() { return this._innerHTML || ""; },
    getAttribute(name) { return name in this.attributes ? this.attributes[name] : null; },
    setAttribute(name, value) { this.attributes[name] = String(value); },
    addEventListener(type, listener) { (this._listeners ||= []).push({ type, listener }); },
    removeEventListener(type, listener) {
      if (!this._listeners) return;
      const index = this._listeners.findIndex((entry) => entry.type === type && entry.listener === listener);
      if (index !== -1) this._listeners.splice(index, 1);
    },
    // Fire a recorded listener the way the browser would. The in-page Fetch
    // dock's handlers call preventDefault/stopPropagation, so supply both.
    emit(type, event = {}) {
      const detail = { type, preventDefault() {}, stopPropagation() {}, ...event };
      (this._listeners || []).filter((entry) => entry.type === type).forEach((entry) => entry.listener(detail));
      return detail;
    },
    appendChild(child) { child.parentElement = this; this.children.push(child); return child; },
    insertAdjacentElement(_position, child) { return this.appendChild(child); },
    get src() { return this.attributes.src || ""; },
    get currentSrc() { return this.attributes.src || ""; },
    closest(selector) {
      let node = this;
      while (node) {
        if (matches(node, selector)) return node;
        node = node.parentElement;
      }
      return null;
    },
    matches(selector) { return matches(this, selector); },
    remove() {
      const parent = this.parentElement;
      if (!parent) return;
      const index = parent.children.indexOf(this);
      if (index !== -1) parent.children.splice(index, 1);
      this.parentElement = null;
    },
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; },
    querySelectorAll(selector) { return descendants(this).filter((node) => selectorMatches(node, selector)); }
  };
  if (options.className) el.className = options.className;
  // In a real DOM `dataset` and `data-*` attributes are two views of the same
  // storage. content.js writes `el.dataset.role` and then queries
  // `[data-role="main"]`, so the shim has to bridge them or those lookups
  // silently return null.
  const dataAttr = (prop) => `data-${String(prop).replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`)}`;
  el.dataset = new Proxy({}, {
    get(_target, prop) { return typeof prop === "string" ? el.attributes[dataAttr(prop)] : undefined; },
    set(_target, prop, value) { if (typeof prop === "string") el.attributes[dataAttr(prop)] = String(value); return true; },
    has(_target, prop) { return typeof prop === "string" && dataAttr(prop) in el.attributes; },
    deleteProperty(_target, prop) { if (typeof prop === "string") delete el.attributes[dataAttr(prop)]; return true; }
  });
  return el;
}

function descendants(root) {
  const out = [];
  for (const child of root.children) {
    out.push(child);
    out.push(...descendants(child));
  }
  return out;
}

function selectorMatches(node, selector) {
  return String(selector).split(",").some((part) => matches(node, part.trim()));
}

function matches(node, selector) {
  if (!node || !selector) return false;
  let rest = selector.trim();

  const tagMatch = rest.match(/^([a-zA-Z]+)/);
  if (tagMatch) {
    if (node.tagName !== tagMatch[1].toUpperCase()) return false;
    rest = rest.slice(tagMatch[1].length);
  }

  // Attribute selectors are extracted BEFORE class selectors: values such as
  // "pbs.twimg.com/media" contain dots that a naive class regex would eat.
  const attributeSelectors = rest.match(/\[[^\]]+\]/g) || [];
  rest = rest.replace(/\[[^\]]+\]/g, "");

  for (const attr of attributeSelectors) {
    const body = attr.slice(1, -1);
    const starMatch = body.match(/^([\w-]+)\*="([^"]*)"$/);
    if (starMatch) {
      if (!String(node.getAttribute(starMatch[1]) || "").includes(starMatch[2])) return false;
      continue;
    }
    const eqMatch = body.match(/^([\w-]+)="([^"]*)"$/);
    if (eqMatch) {
      if (String(node.getAttribute(eqMatch[1]) || "") !== eqMatch[2]) return false;
      continue;
    }
    if (node.getAttribute(body) === null) return false;
  }

  for (const cls of rest.match(/\.[\w-]+/g) || []) {
    if (!node.classList.contains(cls.slice(1))) return false;
  }
  return true;
}

// Builds an <article data-testid="tweet"> the way X renders one.
function makeTweetArticle({ tweetId, handle, displayName, text, photos = [], video = false }) {
  const article = makeElement("article", { attributes: { "data-testid": "tweet" } });

  // The author header lives in [data-testid="User-Name"]: a display-name span
  // plus a handle anchor (real X shape, see content.js getDisplayName). When
  // `displayName` is omitted, no User-Name block is built (the safe fallback).
  if (displayName !== undefined) {
    const nameBlock = makeElement("div", { attributes: { "data-testid": "User-Name" } });
    const nameLink = makeElement("a", { attributes: { role: "link", href: `/${handle}` } });
    const nameDiv = makeElement("div");
    nameDiv.appendChild(makeElement("span", { textContent: displayName }));
    nameLink.appendChild(nameDiv);
    nameBlock.appendChild(nameLink);
    const handleLink = makeElement("a", { attributes: { role: "link", href: `/${handle}` } });
    handleLink.appendChild(makeElement("span", { textContent: `@${handle}` }));
    nameBlock.appendChild(handleLink);
    article.appendChild(nameBlock);
  }

  const profileLink = makeElement("a", { attributes: { role: "link", href: `/${handle}` } });
  article.appendChild(profileLink);

  const textEl = makeElement("div", { attributes: { "data-testid": "tweetText" }, innerText: text });
  article.appendChild(textEl);

  const statusLink = makeElement("a", { attributes: { role: "link", href: `/${handle}/status/${tweetId}` } });
  const time = makeElement("time", { attributes: { datetime: "2026-08-25T00:00:00.000Z" } });
  statusLink.appendChild(time);
  article.appendChild(statusLink);

  for (const photo of photos) {
    const wrap = makeElement("div", { attributes: { "data-testid": "tweetPhoto" } });
    wrap.appendChild(makeElement("img", { attributes: { src: `https://pbs.twimg.com/media/${photo}?format=jpg&name=small` } }));
    article.appendChild(wrap);
  }
  if (video) article.appendChild(makeElement("div", { attributes: { "data-testid": "videoPlayer" } }));

  article.appendChild(makeElement("div", { attributes: { role: "group" } }));
  return article;
}

function loadContentScript(documentOptions = {}) {
  const sent = [];
  const posted = [];
  const messageListeners = [];
  const runtimeListeners = [];
  const intervals = [];
  const timeouts = [];
  const observers = [];
  // Stands in for the worker's side of a queueAdd: the real background dedupes
  // against the current queue and holds back already-downloaded items, so a
  // re-send answers addedCount 0 (+ skippedDownloaded) instead of taking
  // everything. Null = the optimistic default below.
  let queueResponder = null;

  const body = documentOptions.body !== undefined ? documentOptions.body : makeElement("body");
  const head = documentOptions.head !== undefined ? documentOptions.head : makeElement("head");
  const documentListeners = [];
  const document = {
    body,
    head,
    documentElement: documentOptions.documentElement !== undefined
      ? documentOptions.documentElement
      : makeElement("html"),
    createElement: (tag) => makeElement(tag),
    addEventListener(type, listener) { documentListeners.push({ type, listener }); },
    removeEventListener(type, listener) {
      const index = documentListeners.findIndex((entry) => entry.type === type && entry.listener === listener);
      if (index !== -1) documentListeners.splice(index, 1);
    },
    querySelector(selector) { return body.querySelector(selector); },
    querySelectorAll(selector) { return body.querySelectorAll(selector); }
  };

  const location = { href: documentOptions.href || "https://x.com/home", origin: "https://x.com" };

  const context = {
    console: { log() {}, warn() {}, error() {} },
    URL,
    URLSearchParams,
    Set,
    Map,
    Promise,
    JSON,
    Date,
    Math,
    Number,
    String,
    Array,
    Object,
    document,
    requestAnimationFrame: (fn) => fn(),
    setTimeout: (fn, ms) => { const id = timeouts.length; timeouts.push({ fn, ms }); return id; },
    clearTimeout: () => {},
    setInterval: (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; },
    clearInterval: () => {},
    MutationObserver: class {
      constructor(callback) { this.callback = callback; observers.push(this); }
      observe() { this.observing = true; }
      disconnect() { this.observing = false; }
    },
    chrome: {
      runtime: {
        id: "test-extension-id",
        lastError: null,
        sendMessage: (message, callback) => {
          sent.push(message);
          if (typeof callback === "function") {
            callback(message.action === "queueAdd"
              ? (queueResponder
                ? queueResponder(message)
                : { addedCount: (message.items || []).length })
              : { ok: true });
          }
        },
        onMessage: { addListener: (listener) => runtimeListeners.push(listener) }
      },
      storage: { local: { get: (_keys, callback) => callback({}) } }
    }
  };

  const window = {
    location,
    innerHeight: 900,
    scrollY: 0,
    document,
    addEventListener: (type, listener) => { if (type === "message") messageListeners.push(listener); },
    postMessage: (data) => { posted.push(data); },
    scrollBy() {},
    requestAnimationFrame: context.requestAnimationFrame,
    setTimeout: context.setTimeout,
    clearTimeout: context.clearTimeout,
    setInterval: context.setInterval,
    getComputedStyle: () => ({})
  };
  context.window = window;
  context.globalThis = context;
  context.self = context;
  vm.createContext(context);

  const source = fs.readFileSync(path.join(__dirname, "..", "extension", "content.js"), "utf8");
  vm.runInContext(source, context, { filename: "content.js" });

  return {
    context,
    window,
    document,
    body,
    head,
    documentElement: () => document.documentElement,
    observers,
    documentListeners,
    emitDocumentEvent: (type) => documentListeners
      .filter((entry) => entry.type === type)
      .forEach((entry) => entry.listener()),
    location,
    sent,
    posted,
    intervals,
    emitWindowMessage: (data) => messageListeners.forEach((listener) => listener({ source: window, data })),
    emitRuntimeMessage: (message) => {
      let captured = null;
      runtimeListeners.forEach((listener) => listener(message, {}, (response) => { captured = response; }));
      return captured;
    },
    runIntervals: () => intervals.forEach((entry) => entry.fn()),
    // Timers never fire on their own in this shim; run `rounds` generations of
    // them (a pass may schedule the next one, e.g. shallowFetchPass's settle).
    runTimeouts: (rounds = 1) => {
      for (let round = 0; round < rounds; round++) {
        const pending = timeouts.splice(0, timeouts.length);
        pending.forEach((entry) => entry.fn());
      }
    },
    timeouts,
    setQueueResponder: (fn) => { queueResponder = fn; },
    // Deliver mutation records to every observing MutationObserver the way the
    // browser does. Each record is { addedNodes: [...], removedNodes: [...] }.
    emitMutations: (records) => observers
      .filter((observer) => observer.observing)
      .forEach((observer) => observer.callback(records, observer)),
    queueAdds: () => sent.filter((message) => message.action === "queueAdd"),
    timelineCaptures: () => sent.filter((message) => message.action === "localTimelineCapture")
  };
}

test("capture is active without any watch command from the Side Panel", () => {
  const env = loadContentScript();
  // v3.1 required "localCaptureWatch" before anything was listed, so a tab the
  // panel had not explicitly targeted captured nothing at all.
  env.body.appendChild(makeTweetArticle({ tweetId: "100", handle: "real_loonarae", text: "post one", photos: ["AAA111"] }));
  env.runIntervals();

  const adds = env.queueAdds();
  assert.equal(adds.length, 1);
  assert.equal(adds[0].items.length, 1);
  assert.equal(adds[0].source, "scroll");
  assert.match(adds[0].items[0].url, /name=orig/);
});

test("a same-tab SPA route change re-lists media without a reload", () => {
  const env = loadContentScript();
  env.body.appendChild(makeTweetArticle({ tweetId: "200", handle: "real_loonarae", text: "profile post", photos: ["BBB222"] }));
  env.runIntervals();
  assert.equal(env.queueAdds().length, 1);

  // The exact reported failure: /user → /user/media in the same tab, URL
  // changes, no document load. Media must still list.
  env.location.href = "https://x.com/real_loonarae/media";
  env.emitWindowMessage({
    source: "XDL_INJECTED",
    type: "xdlUrlChanged",
    data: { previousUrl: "https://x.com/real_loonarae", newUrl: "https://x.com/real_loonarae/media" }
  });
  env.body.appendChild(makeTweetArticle({ tweetId: "201", handle: "real_loonarae", text: "media tab post", photos: ["CCC333"] }));
  env.runIntervals();

  const ids = env.queueAdds().flatMap((add) => add.items.map((item) => item.id));
  assert.ok(ids.includes("201-CCC333"), "media listed after an in-tab route change");
});

test("a route change asks the MAIN world to replay cached GraphQL payloads", () => {
  const env = loadContentScript();
  env.posted.length = 0;
  env.location.href = "https://x.com/real_loonarae";
  env.emitWindowMessage({
    source: "XDL_INJECTED",
    type: "xdlUrlChanged",
    data: { newUrl: "https://x.com/real_loonarae" }
  });
  // X serves SPA views from cache without re-issuing GraphQL, so the only way
  // to see that view's media is to replay what the page already fetched.
  assert.ok(env.posted.some((message) => message.type === "xdlRequestReplay"));
});

test("GraphQL responses are forwarded with the current capture filter", () => {
  const env = loadContentScript();
  env.emitRuntimeMessage({ action: "scrollSettings", mediaFilter: "video", scrollSpeed: "fast" });
  env.emitWindowMessage({
    source: "XDL_INJECTED",
    type: "xdlGraphqlResponse",
    data: { operationName: "HomeTimeline", json: { data: {} } },
    capturedUrl: "https://x.com/home"
  });

  const captures = env.timelineCaptures();
  assert.equal(captures.length, 1);
  assert.equal(captures[0].mediaFilter, "video");
  assert.equal(captures[0].pageUrl, "https://x.com/home");
});

test("quoted-media inclusion defaults on and follows the Include quoted switch", () => {
  const env = loadContentScript();
  env.emitWindowMessage({
    source: "XDL_INJECTED",
    type: "xdlGraphqlResponse",
    data: { operationName: "HomeTimeline", json: { data: {} } },
    capturedUrl: "https://x.com/home"
  });
  // Default: quote-card media is listed without the user touching anything.
  assert.equal(env.timelineCaptures()[0].includeQuoted, true);

  env.emitRuntimeMessage({ action: "scrollSettings", mediaFilter: "all", includeQuoted: false });
  env.emitWindowMessage({
    source: "XDL_INJECTED",
    type: "xdlGraphqlResponse",
    data: { operationName: "HomeTimeline", json: { data: {} } },
    capturedUrl: "https://x.com/home"
  });
  assert.equal(env.timelineCaptures()[1].includeQuoted, false);
});

test("the same photo is never listed twice across rescans", () => {
  const env = loadContentScript();
  env.body.appendChild(makeTweetArticle({ tweetId: "300", handle: "real_loonarae", text: "dup", photos: ["DDD444"] }));
  env.runIntervals();
  env.runIntervals();
  env.runIntervals();

  const ids = env.queueAdds().flatMap((add) => add.items.map((item) => item.id));
  assert.deepEqual(ids, ["300-DDD444"]);
});

test("DOM-scanned photos carry the author's display name for the {name} token", () => {
  const env = loadContentScript();
  env.body.appendChild(makeTweetArticle({
    tweetId: "405",
    handle: "real_loonarae",
    displayName: "Real Loonarae",
    text: "display name post",
    photos: ["NAM999"]
  }));
  env.runIntervals();

  const adds = env.queueAdds();
  assert.equal(adds.length, 1);
  assert.equal(adds[0].items[0].displayName, "Real Loonarae",
    "a DOM-scanned photo must carry the display name so {name} matches the GraphQL path");
});

test("DOM-scanned photos without a readable header fall back to an empty display name", () => {
  const env = loadContentScript();
  // No [data-testid="User-Name"] block at all — extraction must not throw and
  // must leave displayName "" (the {name} token then just renders nothing).
  env.body.appendChild(makeTweetArticle({
    tweetId: "406",
    handle: "real_loonarae",
    text: "no header post",
    photos: ["NON888"]
  }));
  env.runIntervals();

  const adds = env.queueAdds();
  assert.equal(adds.length, 1);
  assert.equal(adds[0].items[0].displayName, "");
});

test("video posts are queued for per-post resolve instead of being dropped", () => {
  const env = loadContentScript();
  env.body.appendChild(makeTweetArticle({ tweetId: "400", handle: "real_loonarae", text: "clip", video: true }));
  env.runIntervals();

  const status = env.emitRuntimeMessage({ action: "scrollStatus" });
  assert.ok(status.pendingVideos >= 0);
  assert.equal(status.postsOnScreen, 1);
});

test("photos-only capture skips video posts and vice versa", () => {
  const env = loadContentScript();
  env.emitRuntimeMessage({ action: "scrollSettings", mediaFilter: "video" });
  env.body.appendChild(makeTweetArticle({ tweetId: "500", handle: "real_loonarae", text: "photo post", photos: ["EEE555"] }));
  env.runIntervals();
  assert.equal(env.queueAdds().length, 0, "photos must not list while capturing videos only");

  env.emitRuntimeMessage({ action: "scrollSettings", mediaFilter: "photo" });
  env.runIntervals();
  const ids = env.queueAdds().flatMap((add) => add.items.map((item) => item.id));
  assert.deepEqual(ids, ["500-EEE555"]);
});

test("auto-scroll reports running state and stops on request", () => {
  const env = loadContentScript();
  const started = env.emitRuntimeMessage({ action: "scrollStart", scrollSpeed: "fast", mediaFilter: "all" });
  assert.equal(started.ok, true);
  assert.equal(started.running, true);

  const busy = env.emitRuntimeMessage({ action: "scrollStart" });
  assert.equal(busy.ok, false, "a second start must not launch a second loop");

  const stopped = env.emitRuntimeMessage({ action: "scrollStop" });
  assert.equal(stopped.running, false);
  assert.equal(env.emitRuntimeMessage({ action: "scrollStatus" }).running, false);
});

test("status reports the live route so the panel can show the active tab", () => {
  const env = loadContentScript();
  const status = env.emitRuntimeMessage({ action: "scrollStatus" });
  assert.equal(status.url, "https://x.com/home");
  assert.equal(status.route, "/home");
  assert.equal(status.mediaFilter, "all");
  assert.equal(status.scrollSpeed, "fast");
});

// Regression: "Uncaught TypeError: Cannot read properties of null (reading
// 'appendChild')" at the style-injection line. run_at:document_start can run
// before <head> exists, and on some navigations before <html> exists either.
// The old throw aborted the whole IIFE, so capture never started on that tab.
test("style injection survives a document_start with no <head> yet", () => {
  const env = loadContentScript({ head: null });

  assert.ok(env.documentElement(), "the html element should host the stylesheet");
  assert.equal(env.documentElement().children.length, 1, "the style element must be attached");

  // The crash used to kill the script before any watcher was registered.
  env.body.appendChild(makeTweetArticle({ tweetId: "600", handle: "real_loonarae", text: "early post", photos: ["FFF666"] }));
  env.runIntervals();
  const ids = env.queueAdds().flatMap((add) => add.items.map((item) => item.id));
  assert.deepEqual(ids, ["600-FFF666"], "capture must still work when <head> is missing");
});

test("style injection survives a document_start with neither <head> nor <html>", () => {
  const env = loadContentScript({ head: null, documentElement: null });

  assert.equal(env.documentElement(), null, "still no root element at this point");
  assert.ok(env.observers.length > 0, "a retry must be armed instead of throwing");

  // <html> appears as the parser creates it.
  const html = makeElement("html");
  env.document.documentElement = html;
  env.observers.forEach((observer) => observer.callback());

  assert.equal(html.children.length, 1, "the style element must attach once <html> exists");

  env.body.appendChild(makeTweetArticle({ tweetId: "700", handle: "real_loonarae", text: "late post", photos: ["GGG777"] }));
  env.runIntervals();
  const ids = env.queueAdds().flatMap((add) => add.items.map((item) => item.id));
  assert.deepEqual(ids, ["700-GGG777"], "capture must still work when the document starts empty");
});

test("DOMContentLoaded alone is enough to attach a deferred stylesheet", () => {
  const env = loadContentScript({ head: null, documentElement: null });
  env.observers.forEach((observer) => observer.disconnect());
  assert.equal(env.documentListeners.some((entry) => entry.type === "DOMContentLoaded"), true);

  const html = makeElement("html");
  env.document.documentElement = html;
  env.emitDocumentEvent("DOMContentLoaded");

  assert.equal(html.children.length, 1, "the deferred style element must be attached");
});

// ==========================================================================
// v3.7 — Fetch button: shallow auto-fetch on a fresh tab, the in-page dock,
// and the deep fetch (scroll + silent fill) it triggers.
// ==========================================================================

test("a freshly opened profile tab fetches on its own, without scrolling", () => {
  const env = loadContentScript({ href: "https://x.com/nasa" });
  // At document_start / DOMContentLoaded X has rendered nothing yet; the first
  // batch appears moments later. The delayed load passes must pick it up with
  // no user scrolling — this is the reported "new tab lists nothing" case.
  env.body.appendChild(makeTweetArticle({ tweetId: "800", handle: "nasa", text: "launch", photos: ["HHH888"] }));
  env.observers.forEach((observer) => observer.callback());
  env.runTimeouts(3);

  const ids = env.queueAdds().flatMap((add) => add.items.map((item) => item.id));
  assert.ok(ids.includes("800-HHH888"), "the first rendered batch lists without scrolling");
  assert.deepEqual(ids, ["800-HHH888"], "the repeated passes must not list it twice");
  assert.ok(env.posted.some((message) => message.type === "xdlRequestReplay"),
    "it also pulls whatever GraphQL the page already fetched");
});

test("a route change schedules every staged follow-up scan", () => {
  const env = loadContentScript();
  env.runTimeouts(3); // drain the load passes so only the route change remains
  const before = env.emitRuntimeMessage({ action: "scrollStatus" }).scans;

  env.location.href = "https://x.com/nasa/media";
  env.emitWindowMessage({
    source: "XDL_INJECTED",
    type: "xdlUrlChanged",
    data: { previousUrl: "https://x.com/home", newUrl: "https://x.com/nasa/media" }
  });
  env.runTimeouts(2);
  const after = env.emitRuntimeMessage({ action: "scrollStatus" }).scans;

  // Regression: scheduleScan() coalesces, so the old scheduleScan(700) +
  // scheduleScan(1800) pair silently dropped the 1800 ms pass — a view X
  // rendered in stages was only ever scanned twice.
  assert.equal(after - before, 3, "immediate + 700 ms + 1800 ms scans all ran");
});

test("automatic passes keep replay incremental, so a busy tab stays cheap", () => {
  const env = loadContentScript();
  env.posted.length = 0;
  env.emitWindowMessage({
    source: "XDL_INJECTED",
    type: "xdlGraphqlResponse",
    data: { seq: 7, operationName: "UserMedia", json: { data: {} } },
    capturedUrl: "https://x.com/nasa"
  });

  // A route change is automatic: it must only ask for responses newer than the
  // last one handled. (An explicit rescan deliberately asks for all of them.)
  env.emitWindowMessage({
    source: "XDL_INJECTED",
    type: "xdlUrlChanged",
    data: { previousUrl: "https://x.com/nasa", newUrl: "https://x.com/nasa/media" }
  });
  const replays = env.posted.filter((message) => message.type === "xdlRequestReplay");
  assert.ok(replays.length >= 1, "the route-change pass asked for a replay");
  assert.equal(replays[replays.length - 1].since, 7,
    "only responses newer than the last one handled should be re-sent");
});

// ---------------------------------------------------------------------------
// Rescan / Fetch re-list posts the user deleted from the queue
// ---------------------------------------------------------------------------

const flush = () => new Promise((resolve) => setImmediate(resolve));

test("Rescan re-lists posts the user deleted from the queue", () => {
  const env = loadContentScript({ href: "https://x.com/nasa" });
  env.body.appendChild(makeTweetArticle({ tweetId: "700", handle: "nasa", text: "kept", photos: ["GGG700"] }));
  env.runIntervals();
  assert.equal(env.queueAdds().length, 1, "the first scan listed the post");

  // The user deletes the row in the Side Panel: the worker no longer has it, so
  // it would happily take it again — but this tab remembers having sent it, and
  // that memory is exactly what used to make Rescan look broken.
  env.setQueueResponder((message) => ({ addedCount: (message.items || []).length }));
  env.emitRuntimeMessage({ action: "scrollRescan" });

  const adds = env.queueAdds();
  assert.equal(adds.length, 2, "the rescan re-sent the post");
  assert.deepEqual(
    adds[1].items.map((item) => item.id),
    adds[0].items.map((item) => item.id),
    "the same items come back, so the user can pick which to keep"
  );
});

test("Rescan re-asks for the whole replay buffer, not just what is new", () => {
  const env = loadContentScript({ href: "https://x.com/nasa" });
  env.posted.length = 0;
  env.emitWindowMessage({
    source: "XDL_INJECTED",
    type: "xdlGraphqlResponse",
    data: { seq: 7, operationName: "UserMedia", json: { data: {} } },
    capturedUrl: "https://x.com/nasa"
  });

  env.emitRuntimeMessage({ action: "scrollRescan" });
  const replays = env.posted.filter((message) => message.type === "xdlRequestReplay");
  assert.equal(replays[replays.length - 1].since, 0,
    "X virtualizes timelines, so scrolled-away posts only exist in the buffer");
});

test("Fetch media also starts from a clean slate", () => {
  const env = loadContentScript({ href: "https://x.com/nasa" });
  env.body.appendChild(makeTweetArticle({ tweetId: "701", handle: "nasa", text: "again", photos: ["HHH701"] }));
  env.runIntervals();
  const first = env.queueAdds();
  assert.equal(first.length, 1);

  const dock = env.body.querySelector(".xdl-fetch-dock");
  dock.querySelector('button[data-role="main"]').emit("click");

  const adds = env.queueAdds();
  assert.ok(adds.length >= 2, "delete the list, press Fetch, and the posts come back");
  assert.ok(
    adds.slice(1).some((add) => add.items.some((item) => item.id === first[0].items[0].id)),
    "the previously listed item is re-sent by the fetch"
  );
});

test("a rescan that adds nothing explains why", async () => {
  const env = loadContentScript({ href: "https://x.com/nasa" });
  env.body.appendChild(makeTweetArticle({ tweetId: "702", handle: "nasa", text: "done", photos: ["III702"] }));
  env.runIntervals();

  // The rows are still queued (or already downloaded), so the worker takes
  // nothing. Silence here reads as "the button is broken".
  env.setQueueResponder(() => ({ addedCount: 0, skippedDownloaded: 3 }));
  const immediate = env.emitRuntimeMessage({ action: "scrollRescan" });
  assert.equal(immediate.rescanning, true, "the panel can show a busy state");

  env.runTimeouts(2);
  await flush(); await flush(); await flush();

  const status = env.emitRuntimeMessage({ action: "scrollStatus" });
  assert.equal(status.rescanning, false, "the pass finished");
  assert.match(status.text, /already downloaded/i,
    "the note names the setting that held the items back");
  assert.equal(status.lastRescan.skippedDownloaded, 3,
    "the rescan keeps its own record, so a later automatic pass cannot erase it");
  assert.equal(status.lastRescan.added, 0);
});

// ---------------------------------------------------------------------------
// Virtualized timelines: a post that leaves the DOM must still be listed once
// ---------------------------------------------------------------------------

test("a post that leaves the DOM before any scan is still listed", () => {
  const env = loadContentScript({ href: "https://x.com/nasa" });
  const before = env.queueAdds().length;

  // X inserts an article and removes it again between two coalesced scans; the
  // mutation record is the only place the node still exists.
  const article = makeTweetArticle({ tweetId: "800", handle: "nasa", text: "gone", photos: ["LLL800"] });
  env.emitMutations([{ addedNodes: [article], removedNodes: [] }]);
  env.emitMutations([{ addedNodes: [], removedNodes: [article] }]);
  article.remove();

  const ids = env.queueAdds().slice(before).flatMap((add) => add.items.map((item) => item.id));
  assert.ok(ids.includes("800-LLL800"),
    "the photo was captured from the mutation records, not from a DOM scan");
});

test("a post inserted and removed in the same task is still listed", () => {
  const env = loadContentScript({ href: "https://x.com/nasa" });
  const before = env.queueAdds().length;

  // The hardest case: one record carrying the node on both sides, which is what
  // a synchronous insert+trim produces. No scan could ever see this node in the
  // document, because it was never in the document when a scan ran.
  const article = makeTweetArticle({ tweetId: "801", handle: "nasa", text: "blink", photos: ["MMM801", "MMM802"] });
  env.emitMutations([{ addedNodes: [article], removedNodes: [article] }]);

  const ids = env.queueAdds().slice(before).flatMap((add) => add.items.map((item) => item.id));
  assert.deepEqual(ids.sort(), ["801-MMM801", "801-MMM802"],
    "both photos of the blinked post were listed");
});

test("harvesting the same post twice lists it exactly once", () => {
  const env = loadContentScript({ href: "https://x.com/nasa" });
  const article = makeTweetArticle({ tweetId: "802", handle: "nasa", text: "twice", photos: ["NNN802"] });

  for (let round = 0; round < 4; round++) {
    env.emitMutations([{ addedNodes: [article], removedNodes: [] }]);
    env.emitMutations([{ addedNodes: [], removedNodes: [article] }]);
  }
  env.runIntervals();   // the 2.5 s full-page scan sees it too
  env.runTimeouts(2);   // and so does the coalesced scan

  const ids = env.queueAdds().flatMap((add) => add.items.map((item) => item.id));
  const occurrences = ids.filter((id) => id === "802-NNN802").length;
  assert.equal(occurrences, 1, "one item however many times the node is harvested or scanned");
});

test("a container of articles is harvested, and text nodes are ignored", () => {
  const env = loadContentScript({ href: "https://x.com/nasa" });
  const before = env.queueAdds().length;

  const container = makeElement("div");
  container.appendChild(makeTweetArticle({ tweetId: "803", handle: "nasa", text: "a", photos: ["OOO803"] }));
  container.appendChild(makeTweetArticle({ tweetId: "804", handle: "nasa", text: "b", photos: ["PPP804"] }));
  env.emitMutations([{ addedNodes: [{ nodeType: 3, textContent: "whitespace" }, container], removedNodes: [] }]);

  const ids = env.queueAdds().slice(before).flatMap((add) => add.items.map((item) => item.id));
  assert.deepEqual(ids.sort(), ["803-OOO803", "804-PPP804"],
    "nested articles are found and a text node does not throw");
});

test("a video post that leaves the DOM is still resolved", async () => {
  const env = loadContentScript({ href: "https://x.com/nasa" });
  const article = makeTweetArticle({ tweetId: "805", handle: "nasa", text: "clip", video: true });
  env.emitMutations([{ addedNodes: [article], removedNodes: [article] }]);
  await flush(); await flush(); await flush();

  // A video has no usable direct URL in the DOM, so the proof it was harvested
  // is the per-post resolve being started at all (the harvest drains the pending
  // set immediately, which is why pendingVideos reads 0 here).
  const resolves = env.sent.filter((message) => message.action === "getTweetMedia");
  assert.ok(resolves.some((message) => String(message.tweetId) === "805"),
    "the video post that virtualized away was still queued for resolving");
});

test("the same photo at different sizes lists once", () => {
  const env = loadContentScript({ href: "https://x.com/nasa" });
  const before = env.queueAdds().length;

  // X swaps name=small → name=900x900 → name=orig as a post renders and
  // re-renders; the CDN leaf is the identity, not the query string.
  const small = makeTweetArticle({ tweetId: "806", handle: "nasa", text: "size", photos: ["QQQ806"] });
  env.emitMutations([{ addedNodes: [small], removedNodes: [] }]);
  const large = makeTweetArticle({ tweetId: "806", handle: "nasa", text: "size", photos: ["QQQ806"] });
  env.emitMutations([{ addedNodes: [large], removedNodes: [small] }]);
  env.runIntervals();

  const urls = env.queueAdds().slice(before).flatMap((add) => add.items.map((item) => item.url));
  assert.equal(urls.length, 1, "one row for one photo");
  assert.match(urls[0], /name=orig$/, "and it is the full-resolution variant");
});

test("a rescan after a rescan adds nothing new", async () => {
  const env = loadContentScript({ href: "https://x.com/nasa" });
  env.body.appendChild(makeTweetArticle({ tweetId: "807", handle: "nasa", text: "stable", photos: ["RRR807"] }));
  env.runIntervals();

  // The worker still has the row, so it takes nothing: the content script may
  // re-send, but the list must not grow and the note must say so.
  env.setQueueResponder(() => ({ addedCount: 0, skippedDownloaded: 0 }));
  const first = env.emitRuntimeMessage({ action: "scrollRescan" });
  const second = env.emitRuntimeMessage({ action: "scrollRescan" });
  assert.equal(first.rescanning, true);
  assert.equal(second.reason, "A rescan is already running on this tab.",
    "a second click cannot start a concurrent rescan");

  env.runTimeouts(2);
  await flush(); await flush(); await flush();

  const status = env.emitRuntimeMessage({ action: "scrollStatus" });
  assert.equal(status.lastRescan.added, 0, "no duplicates from repeated rescans");
  assert.match(status.text, /nothing new/, "and the user is told nothing changed");
});

test("a rescan that re-lists everything says how many", async () => {
  const env = loadContentScript({ href: "https://x.com/nasa" });
  env.body.appendChild(makeTweetArticle({ tweetId: "703", handle: "nasa", text: "one", photos: ["JJJ703"] }));
  env.body.appendChild(makeTweetArticle({ tweetId: "704", handle: "nasa", text: "two", photos: ["KKK704"] }));
  env.runIntervals();
  env.setQueueResponder((message) => ({ addedCount: (message.items || []).length }));

  env.emitRuntimeMessage({ action: "scrollRescan" });
  env.runTimeouts(2);
  await flush(); await flush(); await flush();

  const status = env.emitRuntimeMessage({ action: "scrollStatus" });
  assert.match(status.text, /Rescan — 2 media items re-listed/,
    "the count is reported so the user knows the list was rebuilt");
});

test("the in-page Fetch button starts a fetch as if the user scrolled", () => {
  const env = loadContentScript({ href: "https://x.com/nasa" });
  const dock = env.body.querySelector(".xdl-fetch-dock");
  assert.ok(dock, "the dock is injected into the page");
  assert.equal(dock.style.display, "flex");

  const main = dock.querySelector('button[data-role="main"]');
  assert.equal(main.textContent, "Fetch media");
  main.emit("click");

  const status = env.emitRuntimeMessage({ action: "scrollStatus" });
  assert.equal(status.fetching, true, "the click started a deep fetch");
  assert.equal(status.fetchPhase, "shallow", "it reads the tab before scrolling it");
  assert.equal(main.textContent, "Stop", "the same button becomes Stop while fetching");
  assert.ok(env.posted.some((message) => message.type === "xdlRequestReplay"));
});

test("the in-page Fetch button respects the Side Panel switch, except while running", () => {
  const env = loadContentScript();
  const dock = env.body.querySelector(".xdl-fetch-dock");

  env.emitRuntimeMessage({ action: "scrollSettings", showFetchButton: false });
  assert.equal(dock.style.display, "none", "switched off → no in-page button");

  // A running fetch must always keep its progress + Stop on the page, or the
  // user would have no way to stop a tab the extension is scrolling.
  env.emitRuntimeMessage({ action: "scrollFetch" });
  assert.equal(dock.style.display, "flex");
});

test("the in-page × dismisses the dock and the panel switch brings it back", () => {
  const env = loadContentScript();
  const dock = env.body.querySelector(".xdl-fetch-dock");
  dock.querySelector('button[data-role="hide"]').emit("click");
  assert.equal(dock.style.display, "none");

  env.emitRuntimeMessage({ action: "scrollSettings", showFetchButton: true });
  assert.equal(dock.style.display, "flex", "re-enabling clears the per-tab dismissal");
});

test("the Side Panel Fetch command starts a deep fetch and Stop cancels it", () => {
  const env = loadContentScript();
  const started = env.emitRuntimeMessage({ action: "scrollFetch", scrollSpeed: "medium", mediaFilter: "all" });
  assert.equal(started.ok, true);
  assert.equal(started.fetching, true);
  assert.equal(started.running, true);

  const busy = env.emitRuntimeMessage({ action: "scrollFetch" });
  assert.equal(busy.ok, false, "a second fetch must not launch a second engine");

  const stopped = env.emitRuntimeMessage({ action: "scrollStop" });
  assert.equal(stopped.fetching, false);
  assert.equal(stopped.running, false);
  assert.equal(env.emitRuntimeMessage({ action: "scrollStatus" }).fetching, false);
});

test("Rescan re-reads the tab without scrolling it", () => {
  const env = loadContentScript();
  env.posted.length = 0;
  env.body.appendChild(makeTweetArticle({ tweetId: "810", handle: "nasa", text: "post", photos: ["RES111"] }));

  const status = env.emitRuntimeMessage({ action: "scrollRescan" });
  assert.equal(status.ok, true);
  assert.equal(status.fetching, false, "a rescan is not a deep fetch");
  assert.ok(env.posted.some((message) => message.type === "xdlRequestReplay"));
  const ids = env.queueAdds().flatMap((add) => add.items.map((item) => item.id));
  assert.deepEqual(ids, ["810-RES111"]);
});

// Regression: safeSend() used to return without invoking its callback when the
// extension context was invalidated (extension reloaded/updated while the X tab
// stayed open). Every awaiting caller then hung forever, and the video resolver
// wedged with `resolvingVideos` stuck true — no video post in that tab was ever
// listed again until the user reloaded the page.
test("a dead extension context releases awaiting callers instead of wedging capture", async () => {
  const env = loadContentScript();
  env.context.chrome.runtime.id = undefined;
  env.body.appendChild(makeTweetArticle({ tweetId: "900", handle: "nasa", text: "clip", video: true }));
  env.runIntervals();
  await new Promise((resolve) => setImmediate(resolve));

  // Context back (a page reload would do this in real life): the same post must
  // be resolvable again, which is only true if the first attempt released the
  // resolver and left the post eligible for its bounded retry.
  env.context.chrome.runtime.id = "test-extension-id";
  env.body.appendChild(makeTweetArticle({ tweetId: "901", handle: "nasa", text: "clip 2", video: true }));
  env.runIntervals();
  await new Promise((resolve) => setImmediate(resolve));

  assert.ok(env.sent.some((message) => message.action === "getTweetMedia"),
    "video resolution still runs after an invalidated context");
});
