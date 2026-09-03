// Download pipeline tests for the v3.5+ output upgrade, mirroring the sister
// repo's "Downloader (raw mode)" suite: master folder on/custom/off/weird
// (feature 1), template-driven names end to end (feature 3), and the v3.11
// per-user folders. Runs the REAL v3.12 shipped background.js + lib/ files in
// a VM — no browser needed. The per-post ZIP/CBZ/PDF assembly tests (the old
// feature 2) now live in tests/archive-background.test.js and exercise the
// preserved source variant under source/archive-enabled/.

const assert = require("node:assert/strict");
const test = require("node:test");

const { loadBackground } = require("./helpers/load-background.js");

function capturingDownload(calls) {
  let nextId = 1;
  return (downloadOptions, callback) => {
    calls.push(downloadOptions);
    callback(nextId++);
  };
}

// A four-photo post plus one video, with the naming metadata every producer
// (background GraphQL parser, content DOM scan) now attaches.
function photoItems(count = 2, overrides = {}) {
  const items = [];
  for (let i = 0; i < count; i++) {
    items.push({
      id: `111-${i}`,
      url: `https://pbs.twimg.com/media/pic${i}.jpg?format=jpg&name=orig`,
      type: "photo",
      author: "@nasa",
      displayName: "NASA",
      text: "Hello world",
      date: "Wed Aug 26 09:15:00 +0000 2026",
      tweetId: "111",
      mediaId: `m${i}`,
      mediaIndex: i,
      selected: true,
      filename: `x-media/nasa_Hello world_111_${i + 1}.jpg`,
      ...overrides
    });
  }
  return items;
}

async function startQueue(background, format) {
  await background.handleQueueMessage({ action: "queueAdd", items: photoItems(2) });
  await background.handleQueueMessage({ action: "queueSelectVisible", filter: "all", selected: true });
  await background.handleQueueMessage({ action: "queueStart", mode: "selected", ...(format !== undefined ? { format } : {}) });
  await background.processQueue();
}

test("raw mode: default master folder groups a post as XMedia/<name>/001…", async () => {
  const calls = [];
  const background = loadBackground({ download: capturingDownload(calls) });
  await startQueue(background, "raw");

  assert.deepEqual(calls.map((call) => call.filename), [
    "XMedia/nasa/nasa - Hello world - 111/001.jpg",
    "XMedia/nasa/nasa - Hello world - 111/002.jpg"
  ]);
  // Raw mode downloads the CDN URL directly — nothing is fetched in-worker.
  assert.deepEqual(calls.map((call) => call.url), [
    "https://pbs.twimg.com/media/pic0.jpg?format=jpg&name=orig",
    "https://pbs.twimg.com/media/pic1.jpg?format=jpg&name=orig"
  ]);
});

test("raw mode: a custom master folder is honored and slashes nest deeper", async () => {
  const calls = [];
  const background = loadBackground({
    download: capturingDownload(calls),
    syncStored: { rawMasterFolder: "Stash/raw" }
  });
  await startQueue(background, "raw");
  assert.deepEqual(calls.map((call) => call.filename), [
    "Stash/raw/nasa/nasa - Hello world - 111/001.jpg",
    "Stash/raw/nasa/nasa - Hello world - 111/002.jpg"
  ]);
});

test("raw mode: EMPTY master folder = off, old flat x-media layout exactly", async () => {
  const calls = [];
  const background = loadBackground({
    download: capturingDownload(calls),
    syncStored: { rawMasterFolder: "" }
  });
  await startQueue(background, "raw");
  assert.deepEqual(calls.map((call) => call.filename), [
    "x-media/nasa_Hello world_111_1.jpg",
    "x-media/nasa_Hello world_111_2.jpg"
  ]);
});

test("raw mode: a weird user-typed master folder is sanitized per segment", async () => {
  const calls = [];
  const background = loadBackground({
    download: capturingDownload(calls),
    syncStored: { rawMasterFolder: 'My:Folder* ' }
  });
  await startQueue(background, "raw");
  assert.deepEqual(calls.map((call) => call.filename), [
    "MyFolder/nasa/nasa - Hello world - 111/001.jpg",
    "MyFolder/nasa/nasa - Hello world - 111/002.jpg"
  ]);
});

test("naming scheme: the stored template drives raw folder names; degenerate names fall back to the post id", async () => {
  const calls = [];
  const background = loadBackground({
    download: capturingDownload(calls),
    syncStored: { nameTemplate: "{user} - {id}" }
  });
  await startQueue(background, "raw");
  assert.equal(calls[0].filename, "XMedia/nasa/nasa - 111/001.jpg");

  // A post whose fields render to nothing must still produce a folder name.
  const fallbackCalls = [];
  const fallback = loadBackground({
    download: capturingDownload(fallbackCalls),
    syncStored: { nameTemplate: "{text}" }
  });
  await fallback.handleQueueMessage({ action: "queueAdd", items: photoItems(1, { text: "???" }) });
  await fallback.handleQueueMessage({ action: "queueSelectVisible", filter: "all", selected: true });
  await fallback.handleQueueMessage({ action: "queueStart", mode: "selected", format: "raw" });
  await fallback.processQueue();
  assert.equal(fallbackCalls[0].filename, "XMedia/nasa/111/001.jpg");
});

test("raw mode: media from different users lands in separate per-user folders", async () => {
  const calls = [];
  const background = loadBackground({ download: capturingDownload(calls) });
  await background.handleQueueMessage({
    action: "queueAdd",
    items: [
      photoItems(1, { id: "1-a", tweetId: "1", author: "@nasa", mediaIndex: 0 })[0],
      {
        ...photoItems(1, { id: "2-b", tweetId: "2", author: "@spacex", mediaIndex: 0 })[0],
        url: "https://pbs.twimg.com/media/other.jpg?format=jpg&name=orig"
      }
    ]
  });
  await background.handleQueueMessage({ action: "queueSelectVisible", filter: "all", selected: true });
  await background.handleQueueMessage({ action: "queueStart", mode: "selected", format: "raw" });
  await background.processQueue();

  assert.deepEqual(calls.map((call) => call.filename).sort(), [
    "XMedia/nasa/nasa - Hello world - 1/001.jpg",
    "XMedia/spacex/spacex - Hello world - 2/001.jpg"
  ]);
});

test("raw mode: userFolders:false restores the pre-v3.11 master layout", async () => {
  const calls = [];
  const background = loadBackground({
    download: capturingDownload(calls),
    syncStored: { userFolders: false }
  });
  await startQueue(background, "raw");
  assert.deepEqual(calls.map((call) => call.filename), [
    "XMedia/nasa - Hello world - 111/001.jpg",
    "XMedia/nasa - Hello world - 111/002.jpg"
  ]);
});

test("raw mode: a stale format from old UI state still degrades to separate files", async () => {
  const calls = [];
  const background = loadBackground({ download: capturingDownload(calls) });
  // Pre-v3.12 UIs sent "zip"/"cbz"/"pdf" per job; the v3.12+ worker must
  // ignore them and save every item as its own original-resolution file.
  await background.handleQueueMessage({ action: "queueAdd", items: photoItems(2) });
  await background.handleQueueMessage({ action: "queueSelectVisible", filter: "all", selected: true });
  const started = await background.handleQueueMessage({ action: "queueStart", mode: "selected", format: "zip" });
  await background.processQueue();

  assert.equal(started.outputFormat, "raw", "stale archive format ignored");
  assert.deepEqual(calls.map((call) => call.filename), [
    "XMedia/nasa/nasa - Hello world - 111/001.jpg",
    "XMedia/nasa/nasa - Hello world - 111/002.jpg"
  ]);
});

test("single-post downloadFile message honors master folder + template when item metadata is present", async () => {
  const background = loadBackground({ download: capturingDownload([]) });
  const [item] = photoItems(1);
  const withMeta = background.rawPathForItem(item, { rawMasterFolder: "XMedia", nameTemplate: "{user} - {text} - {id}" });
  assert.equal(withMeta, "XMedia/nasa/nasa - Hello world - 111/001.jpg");
  // Without metadata (legacy persisted item), the stored filename survives
  // under the master folder instead of guessing.
  const legacy = background.rawPathForItem(
    { filename: "x-media/old_name_1.jpg" },
    { rawMasterFolder: "XMedia" }
  );
  assert.equal(legacy, "XMedia/old_name_1.jpg");
});
