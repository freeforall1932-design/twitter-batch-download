// Download pipeline tests for the v3.5 output upgrade, mirroring the sister
// repo's "Downloader (raw mode)" suite: master folder on/custom/off/weird
// (feature 1), per-post ZIP/CBZ/PDF assembly through the worker fallback
// (feature 2), and template-driven names end to end (feature 3). Runs the
// REAL background.js + lib/ files in a VM — no browser needed.

const assert = require("node:assert/strict");
const test = require("node:test");

const { loadBackground } = require("./helpers/load-background.js");

// Minimal JPEG with a real SOF0 frame (same fixture as pdf-builder.test.js).
function makeJpeg(width, height, payload = 400) {
  const buf = new Uint8Array(payload + 20);
  buf.set([
    0xFF, 0xD8,
    0xFF, 0xC0, 0x00, 0x11, 0x08,
    (height >> 8) & 0xFF, height & 0xFF,
    (width >> 8) & 0xFF, width & 0xFF,
    3, 0x01, 0x11, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01
  ], 0);
  buf[buf.length - 2] = 0xFF;
  buf[buf.length - 1] = 0xD9;
  return buf;
}

function capturingDownload(calls) {
  let nextId = 1;
  return (downloadOptions, callback) => {
    calls.push(downloadOptions);
    callback(nextId++);
  };
}

function jpegFetch(fetched) {
  return async (url) => {
    if (fetched) fetched.push(url);
    return {
      ok: true,
      status: 200,
      headers: { get: () => "image/jpeg" },
      arrayBuffer: async () => makeJpeg(100, 150).buffer
    };
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
    "XMedia/nasa - Hello world - 111/001.jpg",
    "XMedia/nasa - Hello world - 111/002.jpg"
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
    "Stash/raw/nasa - Hello world - 111/001.jpg",
    "Stash/raw/nasa - Hello world - 111/002.jpg"
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
    "MyFolder/nasa - Hello world - 111/001.jpg",
    "MyFolder/nasa - Hello world - 111/002.jpg"
  ]);
});

test("naming scheme: the stored template drives raw folder names; degenerate names fall back to the post id", async () => {
  const calls = [];
  const background = loadBackground({
    download: capturingDownload(calls),
    syncStored: { nameTemplate: "{user} - {id}" }
  });
  await startQueue(background, "raw");
  assert.equal(calls[0].filename, "XMedia/nasa - 111/001.jpg");

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
  assert.equal(fallbackCalls[0].filename, "XMedia/111/001.jpg");
});

test("zip per post: one data-URL archive named <base>.zip with 001/002 entries in post order, items completed", async () => {
  const calls = [];
  const fetched = [];
  const background = loadBackground({
    download: capturingDownload(calls),
    fetch: jpegFetch(fetched)
  });
  await startQueue(background, "zip");

  assert.equal(calls.length, 1, "exactly one archive download per post");
  assert.equal(calls[0].filename, "nasa - Hello world - 111.zip");
  assert.ok(calls[0].url.startsWith("data:application/zip;base64,"), "worker fallback uses a data: URL");
  // Every original full-size image was fetched, in post order.
  assert.deepEqual(fetched, [
    "https://pbs.twimg.com/media/pic0.jpg?format=jpg&name=orig",
    "https://pbs.twimg.com/media/pic1.jpg?format=jpg&name=orig"
  ]);

  const zip = Buffer.from(calls[0].url.split(",")[1], "base64");
  assert.equal(zip.readUInt32LE(0), 0x04034b50, "ZIP local header signature");
  assert.ok(zip.indexOf(Buffer.from("001.jpg")) !== -1, "entry 001.jpg present");
  assert.ok(zip.indexOf(Buffer.from("002.jpg")) !== -1, "entry 002.jpg present");
  assert.ok(zip.indexOf(Buffer.from("001.jpg")) < zip.indexOf(Buffer.from("002.jpg")), "post order kept");
  // The original image bytes are stored verbatim (STORE method).
  assert.ok(zip.indexOf(Buffer.from(makeJpeg(100, 150))) !== -1, "original image embedded unmodified");

  const state = await background.handleQueueMessage({ action: "queueGet" });
  assert.deepEqual(Array.from(state.items, (item) => item.status), ["completed", "completed"]);
  assert.equal(state.running, false, "queue finished");
});

test("cbz per post: same archive, .cbz name and comicbook MIME", async () => {
  const calls = [];
  const background = loadBackground({ download: capturingDownload(calls), fetch: jpegFetch() });
  await startQueue(background, "cbz");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].filename, "nasa - Hello world - 111.cbz");
  assert.ok(calls[0].url.startsWith("data:application/vnd.comicbook+zip;base64,"));
});

test("pdf per post: every page in order at native size, named <base>.pdf", async () => {
  const calls = [];
  const background = loadBackground({ download: capturingDownload(calls), fetch: jpegFetch() });
  await startQueue(background, "pdf");

  assert.equal(calls.length, 1);
  assert.equal(calls[0].filename, "nasa - Hello world - 111.pdf");
  assert.ok(calls[0].url.startsWith("data:application/pdf;base64,"));
  const pdf = Buffer.from(calls[0].url.split(",")[1], "base64");
  const text = pdf.toString("latin1");
  assert.ok(text.startsWith("%PDF-1.4\n"), "PDF header");
  assert.ok(text.includes("/Count 2"), "one page per photo");
  // Right orientation: the page box matches the image's native 100x150.
  assert.equal(text.split("/MediaBox [0 0 100 150]").length - 1, 2, "page size = image size");
  assert.ok(pdf.indexOf(Buffer.from(makeJpeg(100, 150))) !== -1, "JPEG embedded verbatim (DCTDecode)");
});

test("archive formats: videos still download raw; the stored default applies when no per-job format is sent", async () => {
  const calls = [];
  const background = loadBackground({
    download: capturingDownload(calls),
    fetch: jpegFetch(),
    syncStored: { outputFormat: "zip" }
  });
  const video = {
    id: "111-v",
    url: "https://video.twimg.com/vid/111.mp4",
    type: "video",
    author: "@nasa",
    text: "Hello world",
    tweetId: "111",
    mediaId: "v1",
    mediaIndex: 2,
    selected: true,
    filename: "x-media/nasa_Hello world_111_3.mp4"
  };
  await background.handleQueueMessage({ action: "queueAdd", items: [...photoItems(2), video] });
  await background.handleQueueMessage({ action: "queueSelectVisible", filter: "all", selected: true });
  // No format in the message → the stored default ("zip") is used.
  await background.handleQueueMessage({ action: "queueStart", mode: "selected" });
  await background.processQueue();

  const filenames = calls.map((call) => call.filename).sort();
  assert.deepEqual(filenames, [
    "XMedia/nasa - Hello world - 111/003.mp4",
    "nasa - Hello world - 111.zip"
  ]);
  const state = await background.handleQueueMessage({ action: "queueGet" });
  const archive = state.items.filter((item) => item.type === "photo");
  assert.deepEqual(Array.from(archive, (item) => item.status), ["completed", "completed"]);
});

test("archive formats: an unknown/corrupt format value degrades to raw", async () => {
  const calls = [];
  const background = loadBackground({ download: capturingDownload(calls) });
  await startQueue(background, "tarball");
  assert.deepEqual(calls.map((call) => call.filename), [
    "XMedia/nasa - Hello world - 111/001.jpg",
    "XMedia/nasa - Hello world - 111/002.jpg"
  ]);
});

test("archive failure marks the whole post failed with the reason, without touching other posts", async () => {
  const calls = [];
  const background = loadBackground({
    download: capturingDownload(calls),
    fetch: async () => ({ ok: false, status: 404, headers: { get: () => null }, arrayBuffer: async () => new ArrayBuffer(0) })
  });
  await startQueue(background, "zip");
  assert.equal(calls.length, 0, "no download starts for a failed archive");
  const state = await background.handleQueueMessage({ action: "queueGet" });
  assert.deepEqual(Array.from(state.items, (item) => item.status), ["failed", "failed"]);
  assert.match(state.items[0].error, /404/);
});

test("offscreen path: the job is relayed with the templated filename and numbered entries; success completes the post", async () => {
  const jobs = [];
  const background = loadBackground({
    download: capturingDownload([]),
    offscreen: {
      createDocument: async () => {},
      hasDocument: async () => false
    },
    runtimeSendMessage: (message, callback) => {
      // saveQueueState also broadcasts queueChanged with no callback.
      if (message?.action !== "offscreenBuildArchive") return Promise.resolve();
      jobs.push(message);
      callback({ ok: true, filename: message.job.filename });
      return undefined;
    }
  });
  await startQueue(background, "zip");

  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].action, "offscreenBuildArchive");
  assert.equal(jobs[0].job.format, "zip");
  assert.equal(jobs[0].job.filename, "nasa - Hello world - 111.zip");
  assert.deepEqual(Array.from(jobs[0].job.images, (image) => image.name), ["001.jpg", "002.jpg"]);
  const state = await background.handleQueueMessage({ action: "queueGet" });
  assert.deepEqual(Array.from(state.items, (item) => item.status), ["completed", "completed"]);
});

test("single-post downloadFile message honors master folder + template when item metadata is present", async () => {
  const background = loadBackground({ download: capturingDownload([]) });
  const [item] = photoItems(1);
  const withMeta = background.rawPathForItem(item, { rawMasterFolder: "XMedia", nameTemplate: "{user} - {text} - {id}" });
  assert.equal(withMeta, "XMedia/nasa - Hello world - 111/001.jpg");
  // Without metadata (legacy persisted item), the stored filename survives
  // under the master folder instead of guessing.
  const legacy = background.rawPathForItem(
    { filename: "x-media/old_name_1.jpg" },
    { rawMasterFolder: "XMedia" }
  );
  assert.equal(legacy, "XMedia/old_name_1.jpg");
});
