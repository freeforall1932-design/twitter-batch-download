const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function loadBackground(options = {}) {
  const stored = { ...(options.stored || {}) };
  // chrome.storage.sync — output settings written by the Side Panel settings
  // card (rawMasterFolder / nameTemplate / outputFormat).
  const syncStored = { ...(options.syncStored || {}) };
  const downloadChangedListeners = [];
  const startupListeners = [];
  const installedListeners = [];
  let nextDownloadId = 1;
  const context = {
    Blob,
    TextEncoder,
    URL,
    URLSearchParams,
    btoa: (value) => Buffer.from(value, "binary").toString("base64"),
    atob: (value) => Buffer.from(value, "base64").toString("binary"),
    clearTimeout,
    console,
    fetch: options.fetch || (async () => { throw new Error("Unexpected network request in unit test"); }),
    // The worker really loads lib/naming.js, lib/zipWriter.js and
    // lib/pdfBuilder.js through importScripts — run the actual files in the
    // VM context so tests exercise the shipped naming/archive engine.
    importScripts: (...files) => {
      for (const file of files) {
        const libSource = fs.readFileSync(path.join(__dirname, "..", "extension", file), "utf8");
        vm.runInContext(libSource, context, { filename: file });
      }
    },
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
      // chrome.offscreen stays absent by default (like the test VM has no
      // DOM): archive jobs then take the worker data:-URL fallback, which is
      // exactly the offline-testable path. Pass options.offscreen to fake it.
      ...(options.offscreen ? { offscreen: options.offscreen } : {}),
      runtime: {
        lastError: null,
        onInstalled: { addListener: (listener) => installedListeners.push(listener) },
        onMessage: { addListener: () => {} },
        onStartup: { addListener: (listener) => startupListeners.push(listener) },
        sendMessage: options.runtimeSendMessage || (async () => {})
      },
      scripting: { executeScript: async () => [] },
      storage: {
        local: {
          get: async (key) => ({ [key]: stored[key] }),
          set: options.localSet || (async (values) => { Object.assign(stored, values); })
        },
        sync: {
          get: (defaults, callback) => {
            const out = defaults && typeof defaults === "object" ? { ...defaults } : {};
            for (const key of Object.keys(out)) {
              if (key in syncStored) out[key] = syncStored[key];
            }
            callback(out);
          },
          set: async (values) => { Object.assign(syncStored, values); }
        }
      },
      tabs: { query: options.tabsQuery || (async () => []) }
    }
  };
  // Mirror a browser/service-worker global so background.js can hang listeners
  // on globalThis and tests can install spies the same way.
  context.globalThis = context;
  context.global = context;
  vm.createContext(context);
  const source = fs.readFileSync(path.join(__dirname, "..", "extension", "background.js"), "utf8");
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
  context.__stored = stored;
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

test("media filenames use the post username and text instead of a ZIP archive", () => {
  const background = loadBackground();
  const tweet = {
    rest_id: "12345",
    core: {
      user_results: {
        result: {
          legacy: { screen_name: "alice" }
        }
      }
    },
    legacy: {
      created_at: "Sat Aug 23 12:00:00 +0000 2026",
      full_text: "hello world https://t.co/abc",
      extended_entities: {
        media: [
          {
            id_str: "67812",
            type: "photo",
            media_url_https: "https://pbs.example.com/media/photo.jpg"
          },
          {
            id_str: "67813",
            type: "animated_gif",
            video_info: {
              variants: [
                { content_type: "video/mp4", bitrate: 900, url: "https://video.example.com/gif.mp4" }
              ]
            }
          }
        ]
      }
    }
  };

  const items = background.mediaFromTweet(tweet, "@fallback", false);
  assert.deepEqual(Array.from(items, (item) => item.filename), [
    "x-media/alice_hello world_12345_1.jpg",
    "x-media/alice_hello world_12345_2.mp4"
  ]);
  assert.deepEqual(Array.from(items, (item) => item.author), ["@alice", "@alice"]);
});

test("discovery limit defaults to the high community cap and clamps invalid values", () => {
  const background = loadBackground();
  assert.equal(background.normalizeDiscoveryLimit(undefined), 99999);
  assert.equal(background.normalizeDiscoveryLimit(0), 1);
  assert.equal(background.normalizeDiscoveryLimit(-5), 1);
  assert.equal(background.normalizeDiscoveryLimit(1234.9), 1234);
  assert.equal(background.normalizeDiscoveryLimit(200000), 99999);
  assert.equal(background.normalizeDiscoveryLimit(40), 40);
});

test("makeMediaFilename sanitizes username and post text deterministically", () => {
  const background = loadBackground();
  const filename = background.makeMediaFilename({
    username: "  alice:bad/name  ",
    text: "look at this https://t.co/x \"quoted\" path\\file",
    tweetId: "abc123",
    mediaId: "987",
    index: 0,
    extension: "mp4"
  });
  assert.equal(filename, "x-media/alicebadname_look at this quoted pathfile_abc123_1.mp4");
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

function loadFixture(name) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", name), "utf8"));
}

test("classifyDiscoveryError maps auth, protected, nsfw, not-found, and rate-limit cases", () => {
  const background = loadBackground();
  assert.equal(background.classifyDiscoveryError("rate limited", { status: 429 }).code, "rate_limited");
  assert.equal(background.classifyDiscoveryError("X rate limit retries were exhausted.").code, "rate_limited");
  assert.equal(background.classifyDiscoveryError("expired", { status: 401 }).code, "auth_expired");
  assert.equal(background.classifyDiscoveryError("No signed-in X session was found.").code, "auth_required");
  assert.equal(background.classifyDiscoveryError("blocked", { status: 403 }).code, "protected");
  assert.equal(background.classifyDiscoveryError("Protected", { reason: "Protected" }).code, "protected");
  assert.equal(background.classifyDiscoveryError("NsfwLoggedOut", { reason: "NsfwLoggedOut" }).code, "nsfw");
  assert.equal(background.classifyDiscoveryError("could not find user").code, "not_found");
  assert.equal(background.classifyDiscoveryError("Could not find current X operation metadata: UserMedia").code, "operation_metadata");
  assert.equal(background.classifyDiscoveryError("Enter an X profile URL or @username.").code, "invalid_target");
  assert.match(background.classifyDiscoveryError("blocked", { status: 403 }).message, /protected/i);
});

test("resolveUserResult classifies protected and missing profiles", () => {
  const background = loadBackground();
  const ok = background.resolveUserResult(loadFixture("user-by-screen-name-ok.json"));
  assert.equal(ok.userId, "111");
  assert.equal(ok.user.legacy.screen_name, "demo");

  const protectedUser = background.resolveUserResult(loadFixture("user-by-screen-name-protected.json"));
  assert.equal(protectedUser.error.code, "protected");
  assert.match(protectedUser.error.message, /protected/i);

  const missing = background.resolveUserResult({ data: { user: { result: null } } });
  assert.equal(missing.error.code, "not_found");
});

test("sanitized UserMedia fixtures parse media, cursors, multi-photo, and repost rules", () => {
  const background = loadBackground();
  const page1 = loadFixture("user-media-page1.json");
  const instructions = background.extractTimelineInstructions(page1);
  assert.ok(Array.isArray(instructions));

  const tweets = [];
  background.collectTweets(instructions, tweets);
  assert.equal(tweets.length, 3, "tombstone entries are skipped");

  const withoutReposts = tweets.flatMap((tweet) => background.mediaFromTweet(tweet, "demo", false));
  assert.deepEqual(Array.from(withoutReposts, (item) => item.id), ["1001-m1", "1001-m2", "1002-v1"]);
  assert.equal(withoutReposts.find((item) => item.id === "1002-v1").url, "https://video.example.com/high.mp4");
  assert.ok(withoutReposts.every((item) => item.type === "photo" ? item.url.includes("name=orig") : true));

  const withReposts = tweets.flatMap((tweet) => background.mediaFromTweet(tweet, "demo", true));
  assert.deepEqual(Array.from(withReposts, (item) => item.id), ["1001-m1", "1001-m2", "1002-v1", "9001-rm1"]);
  const repost = withReposts.find((item) => item.id === "9001-rm1");
  assert.equal(repost.isRepost, true);
  assert.equal(repost.author, "@other");

  assert.equal(background.findBottomCursor(instructions), "bottom-cursor-page-1");

  const page2 = loadFixture("user-media-page2.json");
  const page2Instructions = background.extractTimelineInstructions(page2);
  assert.equal(background.findBottomCursor(page2Instructions), "bottom-cursor-page-2");
  const page2Tweets = [];
  background.collectTweets(page2Instructions, page2Tweets);
  const page2Items = page2Tweets.flatMap((tweet) => background.mediaFromTweet(tweet, "demo", false));
  assert.deepEqual(Array.from(page2Items, (item) => item.id), ["1004-m3"]);
});

test("discoveryFeatures includes current timeline navigation flags", () => {
  const background = loadBackground();
  const features = background.discoveryFeatures();
  assert.equal(features.responsive_web_graphql_timeline_navigation_enabled, true);
  assert.equal(features.view_counts_everywhere_api_enabled, true);
  assert.equal(features.longform_notetweets_inline_media_enabled, true);
  assert.equal(features.responsive_web_enhance_cards_enabled, false);
  assert.equal(background.discoveryFieldToggles().withArticlePlainText, false);
});

test("rate-limit countdown sleep notifies remaining wait windows", async () => {
  const background = loadBackground();
  const events = [];
  background.rateLimitStatusListener = async (info) => { events.push({ ...info }); };

  const started = Date.now();
  await background.sleepWithRateLimitCountdown(1200, { attempt: 1, maxAttempts: 4, status: 429 });
  const elapsed = Date.now() - started;

  assert.ok(elapsed >= 1100);
  assert.ok(events.length >= 2);
  assert.equal(events[0].attempt, 1);
  assert.equal(events[0].status, 429);
  assert.ok(events[0].waitMs >= 1000);
  assert.equal(events[events.length - 1].waitMs, 0);
  background.rateLimitStatusListener = null;
});

test("fetchWithRetry surfaces countdown callbacks on 429 before succeeding", async () => {
  const background = loadBackground();
  const events = [];
  background.rateLimitStatusListener = async (info) => { events.push(info.waitMs); };

  let calls = 0;
  background.fetch = async () => {
    calls++;
    if (calls === 1) {
      return {
        status: 429,
        ok: false,
        headers: { get: (name) => (name.toLowerCase() === "retry-after" ? "0" : null) }
      };
    }
    return {
      status: 200,
      ok: true,
      headers: { get: () => null }
    };
  };
  // Function declarations resolve on the VM global. Replace spacing/auth with
  // no-ops so this test only exercises the 429 retry + countdown path.
  background.rateLimitWait = async () => {};
  background.refreshAuth = async () => ({ ok: true });

  const response = await background.fetchWithRetry("https://x.com/i/api/graphql/test", {}, 2);
  assert.equal(response.status, 200);
  assert.equal(calls, 2);
  assert.ok(events.includes(0));
  background.rateLimitStatusListener = null;
});

test("fetchWithRetry aborts the 429 retry loop once shouldAbort fires (Stop scan)", async () => {
  const background = loadBackground();
  background.rateLimitWait = async () => {};
  background.refreshAuth = async () => ({ ok: true });
  let calls = 0;
  let stopNow = false;
  background.fetch = async () => {
    calls++;
    // User presses Stop scan while the first attempt is in flight.
    stopNow = true;
    return { status: 429, ok: false, headers: { get: () => "0" } };
  };
  // Stop scan during a rate-limit retry must not keep spinning the countdown:
  // the caller gets an explicit abort marker instead of a response.
  const result = await background.fetchWithRetry("https://x.com/i/api/graphql/test", {}, 2, {
    shouldAbort: () => stopNow
  });
  assert.equal(result.aborted, true);
  assert.equal(calls, 1, "no further attempts after the abort");
});

test("callDiscoveryGraphQL reports a user stop as code stopped, not a rate-limit error", async () => {
  const background = loadBackground();
  background.rateLimitWait = async () => {};
  background.refreshAuth = async () => ({ ok: true });
  background.fetch = async () => ({ status: 429, ok: false, headers: { get: () => "0" } });
  await assert.rejects(
    () => background.callDiscoveryGraphQL("queryId99", "UserMedia", {}, null, {
      shouldAbort: () => true
    }),
    (error) => error.code === "stopped" && /stopped/i.test(error.message)
  );
});

test("queueStart gives previously failed items a fresh attempt budget", async () => {
  const background = loadBackground({
    stored: {
      batchDownloadQueueV1: {
        items: [{
          id: "f1",
          url: "https://pbs.example.com/f1.jpg",
          type: "photo",
          filename: "f1.jpg",
          source: "scroll",
          selected: true,
          status: "failed",
          attempts: 3,
          error: "old failure"
        }],
        concurrency: 2,
        running: false,
        stopped: false
      }
    },
    download: (options, callback) => callback(1)
  });

  const started = await background.handleQueueMessage({ action: "queueStart", mode: "selected", source: "scroll" });
  const item = started.items[0];
  assert.equal(item.status, "queued");
  assert.equal(item.attempts, 0, "a user-triggered start resets the attempt budget");
  assert.equal(item.error, null);

  // Without the reset the item would go straight to failed again (attempts 4/3).
  await background.processQueue();
  const state = await background.handleQueueMessage({ action: "queueGet" });
  assert.equal(state.items[0].status, "downloading");
  assert.equal(state.items[0].attempts, 1);
});

test("a rejected storage write cannot poison later queue saves", async () => {
  let failNext = true;
  const background = loadBackground({
    localSet: async (values) => {
      if (failNext) { failNext = false; throw new Error("quota exceeded"); }
      Object.assign(background.__stored, values);
    }
  });

  await background.handleQueueMessage({
    action: "queueAdd",
    items: [{ id: "a", url: "https://pbs.example.com/a.jpg", filename: "a.jpg" }]
  });
  await background.handleQueueMessage({
    action: "queueAdd",
    items: [{ id: "b", url: "https://pbs.example.com/b.jpg", filename: "b.jpg" }]
  });

  // The second save must actually reach storage, not inherit the first failure.
  assert.deepEqual(
    Array.from(background.__stored.batchDownloadQueueV1.items, (item) => item.id),
    ["b", "a"]
  );
});

test("network captures prefer live operation ids and headers without storing cookies", () => {
  const background = loadBackground();
  background.rememberNetworkCapture({
    operationName: "UserMedia",
    queryId: "LiveUserMediaQueryId99",
    features: JSON.stringify({ responsive_web_graphql_timeline_navigation_enabled: true, custom_flag: true }),
    fieldToggles: JSON.stringify({ withArticlePlainText: true }),
    variables: JSON.stringify({ userId: "old", count: 30, withV2Timeline: true }),
    headers: {
      authorization: "Bearer CAPTURED_BEARER_TOKEN",
      "x-csrf-token": "captured-csrf",
      "x-client-transaction-id": "tx-123",
      cookie: "auth_token=SHOULD_NOT_PERSIST; ct0=nope"
    }
  });

  const captured = background.getCapturedOperation("UserMedia");
  assert.equal(captured.queryId, "LiveUserMediaQueryId99");
  const capturedHeaders = background.getCapturedHeaders();
  assert.equal(capturedHeaders.cookie, undefined);
  assert.equal(capturedHeaders.authorization, "Bearer CAPTURED_BEARER_TOKEN");
  assert.equal(capturedHeaders["x-client-transaction-id"], "tx-123");
  assert.equal(capturedHeaders["x-csrf-token"], "captured-csrf");
  assert.equal(background.getLastTransactionId(), "tx-123");

  const headers = background.makeHeaders();
  assert.match(headers.authorization, /CAPTURED_BEARER_TOKEN/);
  assert.equal(headers["x-client-transaction-id"], "tx-123");
  assert.equal(headers["x-csrf-token"], "captured-csrf");

  const variables = background.buildUserMediaVariables("user-42", "cursor-abc", captured);
  assert.equal(variables.userId, "user-42");
  assert.equal(variables.cursor, "cursor-abc");
  assert.equal(variables.count, 30);
  assert.equal(variables.withV2Timeline, true);
  assert.equal(variables.screen_name, undefined);

  const features = background.mergeDiscoveryFeatures(captured);
  assert.equal(features.custom_flag, true);
  assert.equal(features.responsive_web_graphql_timeline_navigation_enabled, true);
});

test("downloadFile falls back to safer paths after Invalid filename", async () => {
  const attempts = [];
  const background = loadBackground({
    download: (options, callback) => {
      attempts.push(options.filename);
      if (attempts.length === 1) {
        background.chrome.runtime.lastError = { message: "Invalid filename" };
        callback(undefined);
        background.chrome.runtime.lastError = null;
        return;
      }
      background.chrome.runtime.lastError = null;
      callback(99);
    }
  });

  const result = await background.downloadFile(
    "https://video.example.com/a.mp4",
    'x-media/alice_hello:world?/<>_123_1.mp4'
  );
  assert.equal(result.success, true);
  assert.equal(result.downloadId, 99);
  assert.ok(attempts.length >= 2);
  assert.notEqual(attempts[0], attempts[1]);
  assert.ok(attempts.every((name) => !name.includes("?")));
});

test("normalizePhotoUrl forces orig and preserves format", () => {
  const background = loadBackground();
  assert.equal(
    background.normalizePhotoUrl("https://pbs.example.com/media/abc?format=png"),
    "https://pbs.example.com/media/abc?format=png&name=orig"
  );
  assert.match(
    background.normalizePhotoUrl("https://pbs.example.com/media/abc.jpg"),
    /name=orig/
  );
});

test("buildFallbackFilenames produces a short safe ladder", () => {
  const background = loadBackground();
  const ladder = background.buildFallbackFilenames('x-media/alice:bad?/name_hello world_1.mp4');
  assert.ok(ladder.length >= 3);
  assert.ok(ladder.every((name) => !/[<>:"|?*]/.test(name)));
  assert.ok(ladder.some((name) => name.startsWith("x-media/")));
});

test("queueAdd collapses the same CDN media discovered from DOM and GraphQL", async () => {
  const background = loadBackground();
  // The DOM scanner keys a photo by CDN leaf; the GraphQL parser keys the same
  // photo by X's media id. Both must land as one row.
  const first = await background.handleQueueMessage({
    action: "queueAdd",
    source: "scroll",
    items: [{ id: "555-AbCdEf", mediaKey: "AbCdEf", url: "https://pbs.example.com/media/AbCdEf.jpg?name=orig", type: "photo" }]
  });
  assert.equal(first.addedCount, 1);

  const second = await background.handleQueueMessage({
    action: "queueAdd",
    source: "scroll",
    items: [{ id: "555-1730000000", mediaKey: "AbCdEf", url: "https://pbs.example.com/media/AbCdEf.jpg?name=orig", type: "photo" }]
  });
  assert.equal(second.addedCount, 0);
  assert.equal(second.items.length, 1);
});

test("queueAdd skips media that already downloaded successfully", async () => {
  const background = loadBackground({ stored: { downloadedMediaIdsV1: ["777-old"] } });
  const state = await background.handleQueueMessage({
    action: "queueAdd",
    source: "scroll",
    skipDownloaded: true,
    items: [
      { id: "777-old", mediaKey: "old", url: "https://pbs.example.com/media/old.jpg", type: "photo" },
      { id: "777-new", mediaKey: "new", url: "https://pbs.example.com/media/new.jpg", type: "photo" }
    ]
  });
  assert.equal(state.addedCount, 1);
  assert.deepEqual(Array.from(state.items, (item) => item.id), ["777-new"]);

  const notSkipped = await background.handleQueueMessage({
    action: "queueAdd",
    source: "scroll",
    skipDownloaded: false,
    items: [{ id: "777-old", mediaKey: "old", url: "https://pbs.example.com/media/old.jpg", type: "photo" }]
  });
  assert.equal(notSkipped.addedCount, 1);
});

test("a completed download is remembered so it is not re-listed later", async () => {
  const background = loadBackground();
  await background.handleQueueMessage({
    action: "queueAdd",
    source: "scroll",
    items: [{ id: "888-a", mediaKey: "a", url: "https://pbs.example.com/media/a.jpg", type: "photo" }]
  });
  await background.handleQueueMessage({ action: "queueStart", mode: "all", source: "scroll" });
  await background.processQueue();
  await background.emitDownloadChange({ id: 1, state: { current: "complete" } });

  await background.handleQueueMessage({ action: "queueClearAll", source: "scroll" });
  const readded = await background.handleQueueMessage({
    action: "queueAdd",
    source: "scroll",
    skipDownloaded: true,
    items: [{ id: "888-a", mediaKey: "a", url: "https://pbs.example.com/media/a.jpg", type: "photo" }]
  });
  assert.equal(readded.addedCount, 0, "an already-downloaded file must not come back after clearing the list");

  await background.handleQueueMessage({ action: "queueClearDownloadedHistory" });
  const afterReset = await background.handleQueueMessage({
    action: "queueAdd",
    source: "scroll",
    skipDownloaded: true,
    items: [{ id: "888-a", mediaKey: "a", url: "https://pbs.example.com/media/a.jpg", type: "photo" }]
  });
  assert.equal(afterReset.addedCount, 1);
});

test("queueRemove drops a single row without touching the rest", async () => {
  const background = loadBackground();
  await background.handleQueueMessage({
    action: "queueAdd",
    source: "scroll",
    items: [
      { id: "a", url: "https://example.test/a", type: "photo" },
      { id: "b", url: "https://example.test/b", type: "photo" }
    ]
  });
  const state = await background.handleQueueMessage({ action: "queueRemove", id: "a" });
  assert.deepEqual(Array.from(state.items, (item) => item.id), ["b"]);
});

test("local timeline capture accepts any GraphQL payload containing media", async () => {
  const background = loadBackground();
  const tweet = {
    __typename: "Tweet",
    rest_id: "4242",
    core: { user_results: { result: { legacy: { screen_name: "loonarae" } } } },
    legacy: {
      created_at: "Sat Aug 23 12:00:00 +0000 2026",
      full_text: "home timeline post",
      extended_entities: {
        media: [{ id_str: "m1", type: "photo", media_url_https: "https://pbs.example.com/media/home1.jpg" }]
      }
    }
  };
  // Deliberately an operation name that is NOT on any allowlist: a home
  // timeline op is exactly the case the old allowlist silently dropped.
  const result = await background.handleLocalTimelineCapture({
    capture: { operationName: "HomeLatestTimeline", queryId: "abc123", json: { data: { home: { home_timeline_urt: { instructions: [{ entries: [{ content: { itemContent: { tweet_results: { result: tweet } } } }] }] } } } } },
    pageUrl: "https://x.com/home"
  });
  assert.equal(result.addedCount, 1);
  assert.deepEqual(Array.from(result.tweetIds), ["4242"]);

  const state = await background.handleQueueMessage({ action: "queueGet" });
  assert.equal(state.items[0].source, "scroll");
  assert.equal(state.items[0].author, "@loonarae");
});

test("local timeline capture honours the photo/video capture filter", async () => {
  const background = loadBackground();
  const tweet = {
    __typename: "Tweet",
    rest_id: "5151",
    core: { user_results: { result: { legacy: { screen_name: "loonarae" } } } },
    legacy: {
      full_text: "mixed post",
      extended_entities: {
        media: [
          { id_str: "p1", type: "photo", media_url_https: "https://pbs.example.com/media/p1.jpg" },
          { id_str: "v1", type: "video", video_info: { variants: [{ content_type: "video/mp4", bitrate: 832000, url: "https://video.example.com/v1.mp4" }] } }
        ]
      }
    }
  };
  const result = await background.handleLocalTimelineCapture({
    capture: { operationName: "UserMedia", json: { data: { user: { result: { timeline_v2: { timeline: { instructions: [{ entries: [{ content: { itemContent: { tweet_results: { result: tweet } } } }] }] } } } } } } },
    pageUrl: "https://x.com/real_loonarae/media",
    mediaFilter: "video"
  });
  assert.equal(result.addedCount, 1);
  const state = await background.handleQueueMessage({ action: "queueGet" });
  assert.deepEqual(Array.from(state.items, (item) => item.type), ["video"]);
});

test("mediaFromTweet stamps a CDN media key for cross-source dedupe", () => {
  const background = loadBackground();
  const tweet = {
    rest_id: "9090",
    core: { user_results: { result: { legacy: { screen_name: "alice" } } } },
    legacy: {
      full_text: "hi",
      extended_entities: {
        media: [{ id_str: "m9", type: "photo", media_url_https: "https://pbs.example.com/media/KeYaBc123.jpg" }]
      }
    }
  };
  const [item] = background.mediaFromTweet(tweet, "alice", false);
  assert.equal(item.mediaKey, "KeYaBc123");
  assert.equal(background.mediaKeyFromUrl("https://pbs.example.com/media/KeYaBc123.jpg?format=jpg&name=orig"), "KeYaBc123");
});

// The live round-3 report: "a GIF/video reaction to a mentioned post — the
// small quote card with thumbnail and text — its media never listed." The
// quoted post's full payload sits inside the same GraphQL response under
// quoted_status_result (the Rank S Plucker resolution path), so it must list
// without any extra request.
function makeQuoteReactionTweet() {
  return {
    __typename: "Tweet",
    rest_id: "7001",
    core: { user_results: { result: { legacy: { screen_name: "reactor" } } } },
    legacy: {
      created_at: "Sat Aug 22 10:00:00 +0000 2026",
      full_text: "my reaction to this https://t.co/x",
      is_quote_status: true,
      extended_entities: {
        media: [{
          id_str: "rm1",
          type: "animated_gif",
          media_url_https: "https://pbs.example.com/media/ReactionThumb.jpg",
          video_info: { variants: [{ content_type: "video/mp4", bitrate: 832000, url: "https://video.example.com/reaction.mp4" }] }
        }]
      },
      quoted_status_result: {
        result: {
          __typename: "Tweet",
          rest_id: "7000",
          core: { user_results: { result: { legacy: { screen_name: "original" } } } },
          legacy: {
            created_at: "Sat Aug 22 09:00:00 +0000 2026",
            full_text: "the mentioned post itself",
            extended_entities: {
              media: [{
                id_str: "qm1",
                type: "video",
                media_url_https: "https://pbs.example.com/media/QuotedThumb.jpg",
                video_info: { variants: [{ content_type: "video/mp4", bitrate: 2176000, url: "https://video.example.com/quoted.mp4" }] }
              }]
            }
          }
        }
      }
    }
  };
}

test("scroll capture lists quoted media from a GIF/video reaction", async () => {
  const background = loadBackground();
  const result = await background.handleLocalTimelineCapture({
    capture: { operationName: "HomeTimeline", json: { data: { home: { home_timeline_urt: { instructions: [{ entries: [{ content: { itemContent: { tweet_results: { result: makeQuoteReactionTweet() } } } }] }] } } } } },
    pageUrl: "https://x.com/home"
  });
  assert.equal(result.addedCount, 2);

  const state = await background.handleQueueMessage({ action: "queueGet" });
  const quoted = state.items.find((item) => item.isQuote);
  const reaction = state.items.find((item) => !item.isQuote);
  assert.ok(quoted, "the quoted card's media must be listed");
  assert.equal(reaction.author, "@reactor");
  assert.equal(reaction.tweetId, "7001");
  assert.equal(quoted.author, "@original");
  assert.equal(quoted.tweetId, "7000");
  assert.equal(quoted.id, "7000-qm1");
  assert.match(quoted.filename, /original_the mentioned post itself_7000_1\.mp4$/);
  assert.equal(quoted.thumbnail, "https://pbs.example.com/media/QuotedThumb.jpg");
});

test("quoted media can be switched off per capture", async () => {
  const background = loadBackground();
  const result = await background.handleLocalTimelineCapture({
    capture: { operationName: "HomeTimeline", json: { data: { home: { home_timeline_urt: { instructions: [{ entries: [{ content: { itemContent: { tweet_results: { result: makeQuoteReactionTweet() } } } }] }] } } } } },
    pageUrl: "https://x.com/home",
    includeQuoted: false
  });
  assert.equal(result.addedCount, 1);
  const state = await background.handleQueueMessage({ action: "queueGet" });
  assert.ok(!state.items.some((item) => item.isQuote), "includeQuoted=false must exclude the quote card");
});

test("a text reaction quoting a media post lists the quoted media", async () => {
  const background = loadBackground();
  const tweet = makeQuoteReactionTweet();
  // The outer post is a bare text reaction: all its media lives in the quote.
  delete tweet.legacy.extended_entities;
  const result = await background.handleLocalTimelineCapture({
    capture: { operationName: "HomeTimeline", json: { data: { home: { home_timeline_urt: { instructions: [{ entries: [{ content: { itemContent: { tweet_results: { result: tweet } } } }] }] } } } } },
    pageUrl: "https://x.com/home"
  });
  assert.equal(result.addedCount, 1);
  assert.deepEqual(Array.from(result.tweetIds), ["7001"], "the outer post's pending video resolve is cleared too");
  const state = await background.handleQueueMessage({ action: "queueGet" });
  assert.equal(state.items[0].tweetId, "7000");
  assert.ok(state.items[0].isQuote);
});

test("a repost of a quote lists repost and quoted media with correct attribution", async () => {
  const background = loadBackground();
  const original = makeQuoteReactionTweet();
  const repost = {
    __typename: "Tweet",
    rest_id: "7002",
    core: { user_results: { result: { legacy: { screen_name: "booster" } } } },
    legacy: {
      created_at: "Sat Aug 22 11:00:00 +0000 2026",
      retweeted_status_result: { result: original }
    }
  };
  const items = background.mediaFromTweet(repost, "booster", { includeRetweets: true, includeQuoted: true });
  assert.equal(items.length, 2);
  assert.equal(items[0].isRepost, true);
  assert.equal(items[0].author, "@reactor");
  assert.equal(items[0].tweetId, "7001");
  assert.equal(items[1].isQuote, true);
  assert.equal(items[1].author, "@original");
  assert.equal(items[1].tweetId, "7000");
});

test("a quoted photo collapses with a DOM-listed copy into one row", async () => {
  const background = loadBackground();
  // The DOM scan attributes a quote-card photo to the outer article; GraphQL
  // then delivers the same file under the quoted post's id. The CDN media key
  // must collapse them — no double entry.
  await background.handleQueueMessage({
    action: "queueAdd",
    source: "scroll",
    items: [{ id: "7100-DUPkey", mediaKey: "DUPkey", url: "https://pbs.example.com/media/DUPkey?format=jpg&name=orig", type: "photo", author: "@reactor", tweetId: "7100" }]
  });
  const tweet = {
    __typename: "Tweet",
    rest_id: "7100",
    core: { user_results: { result: { legacy: { screen_name: "reactor" } } } },
    legacy: {
      full_text: "look at this one",
      quoted_status_result: {
        result: {
          __typename: "Tweet",
          rest_id: "7099",
          core: { user_results: { result: { legacy: { screen_name: "original" } } } },
          legacy: {
            full_text: "quoted photo post",
            extended_entities: { media: [{ id_str: "q1", type: "photo", media_url_https: "https://pbs.example.com/media/DUPkey.jpg" }] }
          }
        }
      }
    }
  };
  const result = await background.handleLocalTimelineCapture({
    capture: { operationName: "HomeTimeline", json: { data: { home: { home_timeline_urt: { instructions: [{ entries: [{ content: { itemContent: { tweet_results: { result: tweet } } } }] }] } } } } },
    pageUrl: "https://x.com/home"
  });
  assert.equal(result.addedCount, 0, "the quoted photo is the same CDN file as the DOM row");
  const state = await background.handleQueueMessage({ action: "queueGet" });
  assert.equal(state.items.length, 1);
});

test("getTweetMedia returns quoted media with owning-post attribution", async () => {
  const payload = {
    data: { tweetResult: { result: makeQuoteReactionTweet() } }
  };
  const background = loadBackground({
    fetch: async () => ({ ok: true, status: 200, text: async () => "", json: async () => payload })
  });
  const media = await background.getTweetMedia("7001");
  assert.equal(media.error, undefined);
  assert.equal(media.videos.length, 2);
  assert.equal(media.videos[0].tweetId, "7001");
  assert.ok(!media.videos[0].isQuote);
  const quotedVideo = media.videos[1];
  assert.equal(quotedVideo.isQuote, true);
  assert.equal(quotedVideo.username, "original");
  assert.equal(quotedVideo.tweetId, "7000");
  assert.equal(quotedVideo.text, "the mentioned post itself");
});

test("queueClearFinished drops only completed and failed rows", async () => {
  const background = loadBackground();
  await background.handleQueueMessage({
    action: "queueAdd",
    source: "scroll",
    items: [
      { id: "901-a", mediaKey: "a", url: "https://pbs.example.com/media/a.jpg", type: "photo" },
      { id: "901-b", mediaKey: "b", url: "https://pbs.example.com/media/b.jpg", type: "photo" }
    ]
  });
  await background.handleQueueMessage({ action: "queueStart", mode: "all", source: "scroll" });
  await background.processQueue();
  await background.emitDownloadChange({ id: 1, state: { current: "complete" } });

  const cleared = await background.handleQueueMessage({ action: "queueClearFinished" });
  const remaining = cleared.items.map((item) => item.id);
  assert.ok(!remaining.includes("901-a"), "the completed row must be removed");
  assert.ok(remaining.includes("901-b"), "an unfinished row must survive Clear finished");
});

// Regression for the round-3 review: two handlers existed in background.js and
// were listed in the SESSION_HANDOFF message contract, but no UI ever sent them
// (queueClearFinished, queueClearDownloadedHistory). A contract the docs
// advertise and no button can reach is dead code either way, so the shipped
// surfaces are cross-checked against the handlers here.
test("every runtime action the UI sends has a handler, and every handler is reachable", () => {
  const JS_TYPE_NAMES = new Set([
    "string", "number", "boolean", "undefined", "object", "function", "bigint", "symbol"
  ]);
  const read = (name) => fs.readFileSync(path.join(__dirname, "..", "extension", name), "utf8");
  const background = read("background.js");
  const content = read("content.js");
  const senders = ["content.js", "sidepanel.js", "popup.js"].map(read).join("\n");

  const actions = (source, pattern) => new Set(
    [...source.matchAll(pattern)]
      .map((match) => match[1])
      // `typeof msg.action === "string"` is a type guard, not a message action.
      .filter((name) => !JS_TYPE_NAMES.has(name))
  );

  const bgHandled = actions(background, /action === "([a-zA-Z]+)"/g);
  const contentHandled = actions(content, /action === "([a-zA-Z]+)"/g);
  const sentLiteral = actions(senders, /action:\s*"([a-zA-Z]+)"/g);
  // content.js also sends through sendMessage(action, ...) with a variable name.
  const sentViaHelper = actions(senders, /sendMessage\("([a-zA-Z]+)"/g);
  const sent = new Set([...sentLiteral, ...sentViaHelper]);

  for (const action of sent) {
    assert.ok(
      bgHandled.has(action) || contentHandled.has(action),
      `"${action}" is sent by the UI but handled nowhere`
    );
  }

  // Handlers with no sender are only allowed for read-only panel hooks and
  // test seams; anything else means a documented feature no button can reach.
  const allowedUnreachable = new Set(["scrollRescan"]);
  for (const action of bgHandled) {
    assert.ok(
      sent.has(action) || allowedUnreachable.has(action),
      `"${action}" is handled in background.js but no UI sends it`
    );
  }
});
