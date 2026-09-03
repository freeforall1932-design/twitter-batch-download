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
            callback(message.action === "queueAdd" ? { addedCount: (message.items || []).length } : { ok: true });
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

test("replay requests are incremental, so repeated fetches stay cheap", () => {
  const env = loadContentScript();
  env.posted.length = 0;
  env.emitWindowMessage({
    source: "XDL_INJECTED",
    type: "xdlGraphqlResponse",
    data: { seq: 7, operationName: "UserMedia", json: { data: {} } },
    capturedUrl: "https://x.com/nasa"
  });

  env.emitRuntimeMessage({ action: "scrollRescan" });
  const replays = env.posted.filter((message) => message.type === "xdlRequestReplay");
  assert.equal(replays[replays.length - 1].since, 7,
    "only responses newer than the last one handled should be re-sent");
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
