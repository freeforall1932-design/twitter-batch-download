// v3.10 duplicate-verification pipeline tests: the two checks (byte-identical
// SHA-256 + canonical source URL) run through the REAL background.js in a VM,
// with the same lib/ files the extension ships.
"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { loadBackground } = require("./helpers/load-background.js");

// 64+ bytes so the one-shot digest path (no response.body stream in mocks)
// passes the non-empty guard.
function mediaBytes(seed = 7) {
  const bytes = new Uint8Array(160);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31 + seed) & 0xff;
  return bytes;
}

function mediaFetch(bytes) {
  return async () => ({
    ok: true,
    status: 200,
    headers: { get: () => "image/jpeg" },
    arrayBuffer: async () => bytes.buffer
  });
}

function capturingDownload(calls) {
  let nextId = 1;
  return (options, callback) => {
    calls.push(options);
    callback(nextId++);
  };
}

test("queueAdd collapses the same canonical source URL under different query strings", async () => {
  const background = loadBackground();
  const first = await background.handleQueueMessage({
    action: "queueAdd",
    source: "scroll",
    items: [{ id: "111-aaa", url: "https://pbs.twimg.com/media/aaa.jpg?name=orig&format=jpg", type: "photo" }]
  });
  assert.equal(first.addedCount, 1);

  // No mediaKey, no matching id — only the canonical URL can catch this one.
  const second = await background.handleQueueMessage({
    action: "queueAdd",
    source: "scroll",
    items: [{ id: "111-aaa-small", url: "https://pbs.twimg.com/media/aaa.jpg?name=small", type: "photo" }]
  });
  assert.equal(second.addedCount, 0);
  assert.equal(second.items.length, 1);
});

test("byte-identical media from a different URL is skipped before a second file is saved", async () => {
  const calls = [];
  const bytes = mediaBytes(3);
  const background = loadBackground({
    download: capturingDownload(calls),
    fetch: mediaFetch(bytes)
  });

  await background.handleQueueMessage({
    action: "queueAdd",
    source: "scroll",
    skipDownloaded: true,
    items: [
      { id: "1-a", mediaKey: "a", url: "https://pbs.twimg.com/media/a.jpg?name=orig", type: "photo", filename: "XMedia/u - post - 1/001.jpg" },
      // Same BYTES, different host + path: naming and mediaKey cannot catch it.
      { id: "1-b", mediaKey: "b", url: "https://cdn.example.com/mirror/b.jpg?name=large", type: "photo", filename: "XMedia/u - post - 1/002.jpg" }
    ]
  });
  await background.handleQueueMessage({ action: "queueStart", mode: "all", source: "scroll" });
  await background.processQueue();

  assert.equal(calls.length, 1, "only the first URL may reach chrome.downloads");
  await background.emitDownloadChange({ id: 1, state: { current: "complete" } });

  const state = await background.handleQueueMessage({ action: "queueGet" });
  const dupe = state.items.find((item) => item.id === "1-b");
  assert.equal(dupe.status, "completed");
  assert.equal(dupe.duplicateReason, "duplicate_bytes", "byte check must win over URL identity");
  assert.match(dupe.note, /byte-identical/);
});

test("same source URL is skipped BEFORE any byte fetch (URL verification)", async () => {
  let fetchCalls = 0;
  const calls = [];
  const background = loadBackground({
    download: capturingDownload(calls),
    fetch: async () => { fetchCalls += 1; throw new Error("should not be fetched"); },
    stored: {
      downloadedMediaRecordsV1: [{
        id: "777-x",
        mediaKey: "x",
        url: "https://pbs.twimg.com/media/x.jpg?name=orig",
        urlKey: "https://pbs.twimg.com/media/x.jpg",
        hash: "deadbeef",
        filename: "XMedia/u - saved - 777/001.jpg"
      }]
    }
  });

  const result = await background.downloadFile(
    "https://pbs.twimg.com/media/x.jpg?name=small",
    "XMedia/u - saved - 777/001.jpg",
    { verifyBytes: true }
  );
  assert.equal(result.skipped, true);
  assert.equal(result.reason, "duplicate_url");
  assert.equal(fetchCalls, 0, "URL verification must not need a byte fetch");
  assert.equal(calls.length, 0, "no second copy may be started");
  assert.match(result.note, /Already saved/);
});

test("a failed byte fetch still downloads (verification is best-effort)", async () => {
  const calls = [];
  const background = loadBackground({
    download: capturingDownload(calls),
    fetch: async () => { throw new Error("offline"); }
  });
  const result = await background.downloadFile(
    "https://pbs.twimg.com/media/y.jpg?name=orig",
    "XMedia/u - y/001.jpg",
    { verifyBytes: true }
  );
  assert.equal(result.success, true);
  assert.equal(calls.length, 1);
  assert.equal(result.digest, null);
});

test("a completed download is remembered with hash+URL, so a re-listed copy is held back", async () => {
  const calls = [];
  const bytes = mediaBytes(11);
  const background = loadBackground({
    download: capturingDownload(calls),
    fetch: mediaFetch(bytes)
  });

  await background.handleQueueMessage({
    action: "queueAdd",
    source: "scroll",
    items: [{ id: "900-a", mediaKey: "a", url: "https://pbs.twimg.com/media/a.jpg?name=orig", type: "photo" }]
  });
  await background.handleQueueMessage({ action: "queueStart", mode: "all", source: "scroll" });
  await background.processQueue();
  await background.emitDownloadChange({ id: 1, state: { current: "complete" } });

  const records = background.__stored.downloadedMediaRecordsV1 || [];
  assert.equal(records.length, 1);
  assert.match(records[0].hash, /^[0-9a-f]{64}$/);
  assert.equal(records[0].urlKey, "https://pbs.twimg.com/media/a.jpg");

  // Clear the visible list, then re-list the same media under a DIFFERENT
  // URL: the URL check cannot catch it, so the byte check must — at download
  // time, before a second file is ever created.
  await background.handleQueueMessage({ action: "queueClearAll" });
  const readded = await background.handleQueueMessage({
    action: "queueAdd",
    source: "scroll",
    skipDownloaded: true,
    items: [{ id: "900-b", mediaKey: "b", url: "https://cdn.example.com/mirror/a.jpg?name=large", type: "photo" }]
  });
  assert.equal(readded.addedCount, 1, "URL differs, so the row may be listed again");
  assert.equal(readded.skippedDownloaded, 0);

  await background.handleQueueMessage({ action: "queueStart", mode: "all", source: "scroll" });
  await background.processQueue();
  assert.equal(calls.length, 1, "the re-listed byte-identical copy must not reach chrome.downloads");
  const state = await background.handleQueueMessage({ action: "queueGet" });
  const dupe = state.items.find((item) => item.id === "900-b");
  assert.equal(dupe.status, "completed");
  assert.equal(dupe.duplicateReason, "duplicate_bytes");
});

test("Reset downloaded history clears URL and byte records alike", async () => {
  const background = loadBackground({
    stored: {
      downloadedMediaIdsV1: ["777-x"],
      downloadedMediaRecordsV1: [{
        id: "777-x",
        mediaKey: "x",
        url: "https://pbs.twimg.com/media/x.jpg",
        urlKey: "https://pbs.twimg.com/media/x.jpg",
        hash: "abc123",
        filename: "x.jpg"
      }]
    }
  });
  await background.handleQueueMessage({ action: "queueClearDownloadedHistory" });
  // Length checks: the arrays live inside the VM realm, where strict
  // deep-equality against host-side [] fails on prototype identity.
  assert.equal(background.__stored.downloadedMediaRecordsV1.length, 0);
  assert.equal(background.__stored.downloadedMediaIdsV1.length, 0);

  const readded = await background.handleQueueMessage({
    action: "queueAdd",
    source: "scroll",
    skipDownloaded: true,
    items: [{ id: "777-x", mediaKey: "x", url: "https://pbs.twimg.com/media/x.jpg", type: "photo" }]
  });
  assert.equal(readded.addedCount, 1, "after a reset the same media lists again");
});

test("a direct one-click download records its digest when Chrome finishes", async () => {
  const bytes = mediaBytes(5);
  const background = loadBackground({
    download: capturingDownload([]),
    fetch: mediaFetch(bytes)
  });
  const result = await background.downloadFile(
    "https://pbs.twimg.com/media/direct.jpg?name=orig",
    "XMedia/u - direct/001.jpg",
    {
      verifyBytes: true,
      item: { id: "direct-1", mediaKey: "direct", url: "https://pbs.twimg.com/media/direct.jpg?name=orig", filename: "XMedia/u - direct/001.jpg" }
    }
  );
  assert.equal(result.success, true);
  assert.ok(result.digest?.hash);

  await background.emitDownloadChange({ id: 1, state: { current: "complete" } });
  const records = background.__stored.downloadedMediaRecordsV1 || [];
  assert.equal(records.length, 1);
  assert.equal(records[0].id, "direct-1");
  assert.match(records[0].hash, /^[0-9a-f]{64}$/);

  // The same media via a different URL is now byte-verified as a duplicate.
  const second = await background.downloadFile(
    "https://cdn.example.com/mirror/direct.jpg?name=large",
    "XMedia/u - direct/002.jpg",
    { verifyBytes: true }
  );
  assert.equal(second.skipped, true);
  assert.equal(second.reason, "duplicate_bytes");
});

// The archive-group skip behavior (an already-verified post assembling
// nothing) lives with the other archive tests in tests/archive-background
// .test.js, which pins the preserved archive-enabled source variant.
