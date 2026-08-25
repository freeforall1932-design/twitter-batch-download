const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function loadBackground(options = {}) {
  const stored = { ...(options.stored || {}) };
  const downloadChangedListeners = [];
  const startupListeners = [];
  const installedListeners = [];
  let nextDownloadId = 1;
  const context = {
    Blob,
    TextEncoder,
    URL,
    URLSearchParams,
    clearTimeout,
    console,
    fetch: async () => { throw new Error("Unexpected network request in unit test"); },
    importScripts: () => {},
    setTimeout,
    chrome: {
      cookies: {
        get: (_details, callback) => callback(null),
        getAll: (_details, callback) => callback([])
      },
      downloads: {
        download: options.download || ((_downloadOptions, callback) => callback(nextDownloadId++)),
        search: options.downloadsSearch || (async () => []),
        onChanged: { addListener: (listener) => downloadChangedListeners.push(listener) }
      },
      runtime: {
        lastError: null,
        onInstalled: { addListener: (listener) => installedListeners.push(listener) },
        onMessage: { addListener: () => {} },
        onStartup: { addListener: (listener) => startupListeners.push(listener) },
        sendMessage: async () => {}
      },
      scripting: { executeScript: async () => [] },
      storage: {
        local: {
          get: async (key) => ({ [key]: stored[key] }),
          set: async (values) => { Object.assign(stored, values); }
        }
      },
      tabs: { query: options.tabsQuery || (async () => []) }
    }
  };
  vm.createContext(context);
  const source = fs.readFileSync(path.join(__dirname, "..", "background.js"), "utf8");
  vm.runInContext(source, context, { filename: "background.js" });
  context.emitDownloadChange = async (delta) => {
    await Promise.all(downloadChangedListeners.map((listener) => listener(delta)));
  };
  context.emitStartup = async () => {
    await Promise.all(startupListeners.map((listener) => listener()));
  };
  context.emitInstalled = async () => {
    await Promise.all(installedListeners.map((listener) => listener()));
  };
  return context;
}

test("takeDiscoveryItems enforces the remaining cap and deduplicates across pages", () => {
  const background = loadBackground();
  const seen = new Set(["already-seen"]);
  const firstPage = background.takeDiscoveryItems([
    { id: "already-seen", url: "https://example.test/old" },
    { id: "one", url: "https://example.test/one" },
    { id: "one", url: "https://example.test/duplicate" },
    { id: "invalid" },
    { id: "two", url: "https://example.test/two" },
    { id: "three", url: "https://example.test/three" }
  ], seen, 2);

  assert.deepEqual(Array.from(firstPage, (item) => item.id), ["one", "two"]);
  assert.deepEqual(Array.from(seen), ["already-seen", "one", "two"]);

  const secondPage = background.takeDiscoveryItems([
    { id: "two", url: "https://example.test/two" },
    { id: "three", url: "https://example.test/three" }
  ], seen, 1);

  assert.deepEqual(Array.from(secondPage, (item) => item.id), ["three"]);
  assert.equal(background.takeDiscoveryItems(secondPage, seen, 0).length, 0);
});

test("queueAdd rejects duplicate IDs within one incoming batch", async () => {
  const background = loadBackground();
  const state = await background.handleQueueMessage({
    action: "queueAdd",
    items: [
      { id: "one", url: "https://example.test/one", selected: true },
      { id: "one", url: "https://example.test/duplicate" },
      { id: "two", url: "https://example.test/two" }
    ]
  });

  assert.deepEqual(Array.from(state.items, (item) => item.id), ["one", "two"]);
  assert.equal(state.items[0].selected, false);

  const updated = await background.handleQueueMessage({
    action: "queueAdd",
    items: [
      { id: "two", url: "https://example.test/two-again" },
      { id: "three", url: "https://example.test/three" }
    ]
  });

  assert.deepEqual(Array.from(updated.items, (item) => item.id), ["three", "one", "two"]);
});

test("profile discovery preserves newest-first order across pages", async () => {
  const background = loadBackground();
  await background.handleQueueMessage({
    action: "queueAdd",
    items: [
      { id: "unrelated-one", url: "https://example.test/unrelated-one" },
      { id: "unrelated-two", url: "https://example.test/unrelated-two" }
    ]
  });

  await background.addQueueItems([
    { id: "newest", url: "https://example.test/newest" },
    { id: "newer", url: "https://example.test/newer" }
  ], { orderedFrontIds: ["newest", "newer"] });

  const result = await background.addQueueItems([
    { id: "older", url: "https://example.test/older" },
    { id: "oldest", url: "https://example.test/oldest" }
  ], { orderedFrontIds: ["newest", "newer", "older", "oldest"] });

  assert.deepEqual(Array.from(result.state.items, (item) => item.id), [
    "newest", "newer", "older", "oldest", "unrelated-one", "unrelated-two"
  ]);
});

test("profile discovery repairs the order of matching records already in the queue", async () => {
  const background = loadBackground();
  await background.handleQueueMessage({
    action: "queueAdd",
    items: [
      { id: "older", url: "https://example.test/older" },
      { id: "newest", url: "https://example.test/newest" },
      { id: "unrelated", url: "https://example.test/unrelated" }
    ]
  });

  const result = await background.addQueueItems([], {
    orderedFrontIds: ["newest", "older"]
  });

  assert.deepEqual(Array.from(result.state.items, (item) => item.id), [
    "newest", "older", "unrelated"
  ]);
});

test("a starting download consumes a concurrency slot", async () => {
  const startedUrls = [];
  const background = loadBackground({
    download: (downloadOptions, callback) => {
      startedUrls.push(downloadOptions.url);
      callback(20);
    }
  });

  await background.handleQueueMessage({
    action: "queueAdd",
    items: [
      { id: "reserved", url: "https://example.test/reserved", filename: "reserved.jpg" },
      { id: "waiting", url: "https://example.test/waiting", filename: "waiting.jpg" }
    ]
  });
  const state = await background.handleQueueMessage({ action: "queueGet" });
  state.concurrency = 1;
  state.running = true;
  state.items[0].status = "starting";
  state.items[1].status = "queued";

  await background.runQueuePass();

  assert.equal(startedUrls.length, 0);
  assert.equal(state.items[1].status, "queued");
});

test("concurrent scheduling requests cannot exceed download concurrency", async () => {
  const startedUrls = [];
  let nextId = 10;
  const background = loadBackground({
    download: (downloadOptions, callback) => {
      startedUrls.push(downloadOptions.url);
      const id = nextId++;
      setTimeout(() => callback(id), 5);
    }
  });

  await background.handleQueueMessage({
    action: "queueAdd",
    items: [1, 2, 3, 4].map((id) => ({
      id: String(id),
      url: `https://example.test/${id}`,
      filename: `${id}.jpg`
    }))
  });
  await background.handleQueueMessage({ action: "queueStart", mode: "all" });

  await Promise.all([
    background.processQueue(),
    background.processQueue(),
    background.processQueue()
  ]);

  let state = await background.handleQueueMessage({ action: "queueGet" });
  assert.equal(startedUrls.length, 2);
  assert.equal(state.items.filter((item) => item.status === "downloading").length, 2);
  assert.equal(state.items.filter((item) => item.status === "queued").length, 2);

  const completed = state.items.find((item) => item.status === "downloading");
  await background.emitDownloadChange({
    id: completed.downloadId,
    state: { current: "complete" }
  });
  await background.processQueue();

  state = await background.handleQueueMessage({ action: "queueGet" });
  assert.equal(startedUrls.length, 3);
  assert.equal(state.items.filter((item) => item.status === "downloading").length, 2);
  assert.equal(state.items.filter((item) => item.status === "completed").length, 1);
  assert.equal(state.items.filter((item) => item.status === "queued").length, 1);
});

test("rapid discovery starts launch only one scan", async () => {
  let releaseTabs;
  let tabQueries = 0;
  let signalTabQuery;
  const tabQueryStarted = new Promise((resolve) => { signalTabQuery = resolve; });
  const tabsGate = new Promise((resolve) => { releaseTabs = resolve; });
  const background = loadBackground({
    tabsQuery: async () => {
      tabQueries++;
      signalTabQuery();
      await tabsGate;
      return [];
    }
  });

  await Promise.all([
    background.handleDiscoveryMessage({ action: "discoveryStart", target: "@first", limit: 10 }),
    background.handleDiscoveryMessage({ action: "discoveryStart", target: "@second", limit: 10 })
  ]);
  await tabQueryStarted;

  let state = await background.handleDiscoveryMessage({ action: "discoveryGet" });
  assert.equal(tabQueries, 1);
  assert.equal(state.running, true);
  assert.equal(state.target, "@first");
  assert.notEqual(state.activeRunId, null);

  releaseTabs();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  state = await background.handleDiscoveryMessage({ action: "discoveryGet" });
  assert.equal(state.running, false);
  assert.equal(state.activeRunId, null);
  assert.match(state.error, /Open x\.com/);
});

test("a stranded starting download is returned to the queue on restart", async () => {
  const background = loadBackground({
    stored: {
      batchDownloadQueueV1: {
        items: [
          { id: "stranded", url: "https://example.test/stranded", filename: "stranded.jpg", status: "starting", attempts: 1, downloadId: null, bytesReceived: 0, totalBytes: 0 }
        ],
        concurrency: 2,
        running: true,
        stopped: false
      }
    }
  });

  const state = await background.handleQueueMessage({ action: "queueGet" });
  const item = state.items.find((candidate) => candidate.id === "stranded");
  assert.equal(item.status, "queued");
  assert.equal(item.downloadId, null);
  assert.equal(item.attempts, 1);
});

test("an active chrome download keeps its slot after a worker restart", async () => {
  const startedUrls = [];
  const background = loadBackground({
    stored: {
      batchDownloadQueueV1: {
        items: [
          { id: "active", url: "https://example.test/active", filename: "active.jpg", status: "downloading", attempts: 1, downloadId: 5, bytesReceived: 10, totalBytes: 100 },
          { id: "waiting", url: "https://example.test/waiting", filename: "waiting.jpg", status: "queued", attempts: 0, downloadId: null, bytesReceived: 0, totalBytes: 0 }
        ],
        concurrency: 2,
        running: true,
        stopped: false
      }
    },
    downloadsSearch: async (query) => {
      assert.equal(query.id, 5);
      return [{ id: 5, state: "in_progress", bytesReceived: 50, totalBytes: 100 }];
    },
    download: (downloadOptions, callback) => {
      startedUrls.push(downloadOptions.url);
      callback(20);
    }
  });

  await background.handleQueueMessage({ action: "queueGet" });
  await background.processQueue();
  const state = await background.handleQueueMessage({ action: "queueGet" });

  assert.deepEqual(Array.from(state.items, (item) => item.id), ["active", "waiting"]);
  assert.deepEqual(startedUrls, ["https://example.test/waiting"]);
  const active = state.items.find((item) => item.id === "active");
  assert.equal(active.status, "downloading");
  assert.equal(active.downloadId, 5);
  assert.equal(active.bytesReceived, 50);
  assert.equal(active.totalBytes, 100);
});

test("a completed chrome download is reconciled as completed on restart", async () => {
  const background = loadBackground({
    stored: {
      batchDownloadQueueV1: {
        items: [
          { id: "done", url: "https://example.test/done", filename: "done.jpg", status: "downloading", attempts: 1, downloadId: 7, bytesReceived: 100, totalBytes: 100 }
        ],
        concurrency: 2,
        running: true,
        stopped: false
      }
    },
    downloadsSearch: async () => [{ id: 7, state: "complete", bytesReceived: 100, totalBytes: 100 }]
  });

  const state = await background.handleQueueMessage({ action: "queueGet" });
  const item = state.items.find((candidate) => candidate.id === "done");
  assert.equal(item.status, "completed");
  assert.equal(item.downloadId, null);
  assert.equal(item.error, null);
  assert.equal(item.bytesReceived, 100);
});

test("an interrupted chrome download is retried or failed after restart", async () => {
  const retryBackground = loadBackground({
    stored: {
      batchDownloadQueueV1: {
        items: [
          { id: "interrupted", url: "https://example.test/interrupted", filename: "interrupted.jpg", status: "downloading", attempts: 1, downloadId: 9, bytesReceived: 5, totalBytes: 100 }
        ],
        concurrency: 2,
        running: true,
        stopped: false
      }
    },
    downloadsSearch: async () => [{ id: 9, state: "interrupted", error: "NETWORK_FAILED", bytesReceived: 5, totalBytes: 100 }]
  });

  const retryState = await retryBackground.handleQueueMessage({ action: "queueGet" });
  const retryItem = retryState.items.find((candidate) => candidate.id === "interrupted");
  assert.equal(retryItem.status, "queued");
  assert.equal(retryItem.downloadId, null);
  assert.match(retryItem.error, /NETWORK_FAILED/);
  assert.match(retryItem.error, /retrying/);

  const failedBackground = loadBackground({
    stored: {
      batchDownloadQueueV1: {
        items: [
          { id: "interrupted", url: "https://example.test/interrupted", filename: "interrupted.jpg", status: "downloading", attempts: 3, downloadId: 9, bytesReceived: 5, totalBytes: 100 }
        ],
        concurrency: 2,
        running: true,
        stopped: false
      }
    },
    downloadsSearch: async () => [{ id: 9, state: "interrupted", error: "NETWORK_FAILED", bytesReceived: 5, totalBytes: 100 }]
  });

  const failedState = await failedBackground.handleQueueMessage({ action: "queueGet" });
  const failedItem = failedState.items.find((candidate) => candidate.id === "interrupted");
  assert.equal(failedItem.status, "failed");
  assert.equal(failedItem.downloadId, null);
  assert.equal(failedItem.error, "NETWORK_FAILED");
});

test("a chrome download that no longer exists is recovered on restart", async () => {
  const background = loadBackground({
    stored: {
      batchDownloadQueueV1: {
        items: [
          { id: "ghost", url: "https://example.test/ghost", filename: "ghost.jpg", status: "downloading", attempts: 1, downloadId: 42, bytesReceived: 0, totalBytes: 0 }
        ],
        concurrency: 2,
        running: true,
        stopped: false
      }
    },
    downloadsSearch: async () => []
  });

  const state = await background.handleQueueMessage({ action: "queueGet" });
  const item = state.items.find((candidate) => candidate.id === "ghost");
  assert.equal(item.status, "queued");
  assert.equal(item.downloadId, null);
});

test("restart resume starts waiting items without duplicating active downloads", async () => {
  const startedUrls = [];
  const background = loadBackground({
    stored: {
      batchDownloadQueueV1: {
        items: [
          { id: "active", url: "https://example.test/active", filename: "active.jpg", status: "downloading", attempts: 1, downloadId: 5, bytesReceived: 10, totalBytes: 100 },
          { id: "waiting", url: "https://example.test/waiting", filename: "waiting.jpg", status: "queued", attempts: 0, downloadId: null, bytesReceived: 0, totalBytes: 0 }
        ],
        concurrency: 2,
        running: true,
        stopped: false
      }
    },
    downloadsSearch: async () => [{ id: 5, state: "in_progress", bytesReceived: 10, totalBytes: 100 }],
    download: (downloadOptions, callback) => {
      startedUrls.push(downloadOptions.url);
      callback(20);
    }
  });

  await background.resumeQueueAfterRestart();
  const state = await background.handleQueueMessage({ action: "queueGet" });
  assert.deepEqual(startedUrls, ["https://example.test/waiting"]);
  assert.equal(state.items.find((item) => item.id === "active").status, "downloading");
  assert.equal(state.items.find((item) => item.id === "waiting").status, "downloading");
});

test("a stale discovery run cannot overwrite newer state", async () => {
  let releaseTabs;
  let signalTabQuery;
  const tabQueryStarted = new Promise((resolve) => { signalTabQuery = resolve; });
  const tabsGate = new Promise((resolve) => { releaseTabs = resolve; });
  const background = loadBackground({
    tabsQuery: async () => {
      signalTabQuery();
      await tabsGate;
      return [];
    }
  });

  await background.handleDiscoveryMessage({ action: "discoveryStart", target: "@old", limit: 10 });
  await tabQueryStarted;
  const state = await background.handleDiscoveryMessage({ action: "discoveryGet" });
  state.activeRunId = 999;
  state.running = true;
  state.target = "@newer";
  state.status = "Newer run owns this state";
  state.error = null;

  releaseTabs();
  await new Promise((resolve) => setImmediate(resolve));

  const current = await background.handleDiscoveryMessage({ action: "discoveryGet" });
  assert.equal(current.activeRunId, 999);
  assert.equal(current.running, true);
  assert.equal(current.target, "@newer");
  assert.equal(current.status, "Newer run owns this state");
  assert.equal(current.error, null);
});
