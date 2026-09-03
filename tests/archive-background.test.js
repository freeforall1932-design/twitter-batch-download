// Archive-enabled worker pipeline tests for the PRESERVED source variant.
//
// v3.12 retired the per-post ZIP/CBZ/PDF path from the shipped extension: the
// shipped worker forces outputFormat = "raw" and never runs the archive pass.
// The former implementation is kept (not shipped, not a Load-unpacked target)
// under source/archive-enabled/chrome-extension — and these tests pin THAT
// worker, so the historical ZIP/CBZ/PDF behavior stays runnable and cannot
// silently rot. The loadBackground helper is pointed at the source variant;
// everything else is byte-for-byte the suite that covered the pre-v3.12
// extension/ (worker fallback bytes, offscreen job relay, media-kind rules,
// archive toggles and queueStart warnings).

const assert = require("node:assert/strict");
const test = require("node:test");

const { loadBackground } = require("./helpers/load-background.js");

// The worker + lib/ root exercised by every test in this file.
const ARCHIVE_ROOT = "source/archive-enabled/chrome-extension";

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

function anyMediaFetch(fetched) {
  return async (url) => {
    if (fetched) fetched.push(url);
    const isVideo = String(url).includes("video.twimg.com");
    return {
      ok: true,
      status: 200,
      headers: { get: () => (isVideo ? "video/mp4" : "image/jpeg") },
      arrayBuffer: async () => (isVideo ? new Uint8Array(64).fill(7).buffer : makeJpeg(100, 150).buffer)
    };
  };
}

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

function baseItem(overrides = {}) {
  return {
    id: "111-0",
    url: "https://pbs.twimg.com/media/pic0.jpg?format=jpg&name=orig",
    type: "photo",
    author: "@nasa",
    displayName: "NASA",
    text: "Hello world",
    date: "Wed Aug 26 09:15:00 +0000 2026",
    tweetId: "111",
    mediaId: "m0",
    mediaIndex: 0,
    selected: true,
    filename: "x-media/nasa_Hello world_111_1.jpg",
    ...overrides
  };
}

function gifItem(overrides = {}) {
  return baseItem({
    id: "111-g",
    url: "https://video.twimg.com/tweet_video/gif0.mp4",
    type: "video",
    isGif: true,
    mediaId: "g0",
    mediaIndex: 1,
    filename: "x-media/nasa_Hello world_111_2.mp4",
    ...overrides
  });
}

function videoItem(overrides = {}) {
  return baseItem({
    id: "111-v",
    url: "https://video.twimg.com/ext_tw_video/clip.mp4?tag=12",
    type: "video",
    mediaId: "v0",
    mediaIndex: 2,
    filename: "x-media/nasa_Hello world_111_3.mp4",
    ...overrides
  });
}

async function startQueue(background, format) {
  await background.handleQueueMessage({ action: "queueAdd", items: photoItems(2) });
  await background.handleQueueMessage({ action: "queueSelectVisible", filter: "all", selected: true });
  await background.handleQueueMessage({ action: "queueStart", mode: "selected", ...(format !== undefined ? { format } : {}) });
  await background.processQueue();
}

async function runQueue(background, items, format) {
  await background.handleQueueMessage({ action: "queueAdd", items });
  await background.handleQueueMessage({ action: "queueSelectVisible", filter: "all", selected: true });
  const started = await background.handleQueueMessage({ action: "queueStart", mode: "selected", ...(format !== undefined ? { format } : {}) });
  await background.processQueue();
  return started;
}

// ---- worker fallback (data: URL) archives -----------------------------------

test("zip per post: one data-URL archive named <base>.zip with 001/002 entries in post order, items completed", async () => {
  const calls = [];
  const fetched = [];
  const background = loadBackground({
    extensionRoot: ARCHIVE_ROOT,
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
  const background = loadBackground({
    extensionRoot: ARCHIVE_ROOT,
    download: capturingDownload(calls),
    fetch: jpegFetch()
  });
  await startQueue(background, "cbz");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].filename, "nasa - Hello world - 111.cbz");
  assert.ok(calls[0].url.startsWith("data:application/vnd.comicbook+zip;base64,"));
});

test("pdf per post: every page in order at native size, named <base>.pdf", async () => {
  const calls = [];
  const background = loadBackground({
    extensionRoot: ARCHIVE_ROOT,
    download: capturingDownload(calls),
    fetch: jpegFetch()
  });
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
    extensionRoot: ARCHIVE_ROOT,
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
    "XMedia/nasa/nasa - Hello world - 111/003.mp4",
    "nasa - Hello world - 111.zip"
  ]);
  const state = await background.handleQueueMessage({ action: "queueGet" });
  const archive = state.items.filter((item) => item.type === "photo");
  assert.deepEqual(Array.from(archive, (item) => item.status), ["completed", "completed"]);
});

test("archive formats: an unknown/corrupt format value degrades to raw", async () => {
  const calls = [];
  const background = loadBackground({
    extensionRoot: ARCHIVE_ROOT,
    download: capturingDownload(calls)
  });
  await startQueue(background, "tarball");
  assert.deepEqual(calls.map((call) => call.filename), [
    "XMedia/nasa/nasa - Hello world - 111/001.jpg",
    "XMedia/nasa/nasa - Hello world - 111/002.jpg"
  ]);
});

test("archive failure marks the whole post failed with the reason, without touching other posts", async () => {
  const calls = [];
  const background = loadBackground({
    extensionRoot: ARCHIVE_ROOT,
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
    extensionRoot: ARCHIVE_ROOT,
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

// ---- media-kind rules -------------------------------------------------------

test("kind rules: photos always archive; GIFs by default; videos only when opted in", () => {
  const background = loadBackground({ extensionRoot: ARCHIVE_ROOT });
  assert.deepEqual([...background.archivedKinds({})].sort(), ["gif", "photo"]);
  assert.deepEqual([...background.archivedKinds({ archiveGifs: false })], ["photo"]);
  assert.deepEqual([...background.archivedKinds({ archiveVideos: true })].sort(), ["gif", "photo", "video"]);
});

test("kind rules: a GIF or video in the archive degrades PDF to ZIP for that post only", () => {
  const background = loadBackground({ extensionRoot: ARCHIVE_ROOT });
  const photos = [baseItem()];
  const withGif = [baseItem(), gifItem()];
  const withVideo = [baseItem(), videoItem()];
  assert.equal(background.effectiveGroupFormat(photos, "pdf"), "pdf");
  assert.equal(background.effectiveGroupFormat(withGif, "pdf"), "zip");
  assert.equal(background.effectiveGroupFormat(withVideo, "pdf"), "zip");
  assert.equal(background.effectiveGroupFormat(withGif, "cbz"), "cbz", "ZIP/CBZ both allowed for motion media");
});

test("buildRunNotices only warns about media kinds actually packed into the archive", () => {
  const background = loadBackground({ extensionRoot: ARCHIVE_ROOT });
  // Items that share a tweetId belong to the same post, so media kinds combine.
  const queued = (id, kind) => ({
    id, tweetId: "tw-mix", type: kind === "gif" ? "video" : kind, isGif: kind === "gif", status: "queued"
  });

  // A post with photos + a video while video archiving is OFF: the archive is a
  // clean photo-only ZIP and the video stays a separate raw MP4. This must NOT
  // raise the "mix ... not a single-format post" warning.
  const photoVideoPost = [
    queued("p1", "photo"),
    queued("v1", "video")
  ];
  const off = background.buildRunNotices(
    { items: photoVideoPost },
    { archiveGifs: true, archiveVideos: false },
    "zip"
  );
  assert.ok(!off.some((notice) => /mix/i.test(notice)), `no mix warning expected: ${off}`);

  // Same post with videos opted in: now the archive genuinely mixes photo/video
  // entries, so the warning is correct.
  const on = background.buildRunNotices(
    { items: photoVideoPost },
    { archiveGifs: true, archiveVideos: true },
    "zip"
  );
  assert.ok(on.some((notice) => /mix/i.test(notice)), "mix warning expected when video is archived");
  assert.ok(on.some((notice) => /include video files packed/i.test(notice)), "video archive warning expected");

  // A post mixing photo + GIF (GIFs archive by default) raises the mix warning.
  const photoGifPost = [
    queued("p2", "photo"),
    queued("g1", "gif")
  ];
  const gifOn = background.buildRunNotices(
    { items: photoGifPost },
    { archiveGifs: true, archiveVideos: false },
    "zip"
  );
  assert.ok(gifOn.some((notice) => /mix/i.test(notice)), "photo+GIF is a genuinely mixed archive");

  // A single-format post (photos only) never warns.
  const photosOnly = [
    queued("p3", "photo"),
    queued("p4", "photo")
  ];
  const singleFormat = background.buildRunNotices(
    { items: photosOnly },
    { archiveGifs: true, archiveVideos: false },
    "zip"
  );
  assert.equal(singleFormat.length, 0, "a photos-only post never warns");
});

test("an already-verified archive group is skipped before assembly (no new file)", async () => {
  const calls = [];
  const background = loadBackground({
    extensionRoot: ARCHIVE_ROOT,
    download: capturingDownload(calls),
    // fetch is never used: the group is rejected before the offscreen/worker
    // assembly path can fetch a single byte.
    fetch: async () => { throw new Error("must not fetch"); },
    stored: {
      downloadedMediaRecordsV1: [
        { id: "500-m1", mediaKey: "m1", url: "https://pbs.twimg.com/media/m1.jpg", urlKey: "https://pbs.twimg.com/media/m1.jpg", hash: "h1", filename: "XMedia/nasa - post - 500/001.jpg" },
        { id: "500-m2", mediaKey: "m2", url: "https://pbs.twimg.com/media/m2.jpg", urlKey: "https://pbs.twimg.com/media/m2.jpg", hash: "h2", filename: "XMedia/nasa - post - 500/002.jpg" }
      ]
    }
  });

  await background.handleQueueMessage({
    action: "queueAdd",
    source: "scroll",
    items: [
      { id: "500-m1", mediaKey: "m1", url: "https://pbs.twimg.com/media/m1.jpg", type: "photo", tweetId: "500", author: "@nasa", displayName: "NASA", text: "post", mediaIndex: 0 },
      { id: "500-m2", mediaKey: "m2", url: "https://pbs.twimg.com/media/m2.jpg", type: "photo", tweetId: "500", author: "@nasa", displayName: "NASA", text: "post", mediaIndex: 1 }
    ]
  });
  await background.handleQueueMessage({ action: "queueStart", mode: "all", source: "scroll", format: "zip" });
  await background.processQueue();

  assert.equal(calls.length, 0, "a fully verified group must not reach the save path");
  const state = await background.handleQueueMessage({ action: "queueGet" });
  assert.ok(state.items.every((item) => item.status === "completed"));
  assert.ok(state.items.every((item) => item.duplicateReason === "archive_duplicate"));
});

test("kind rules: archive entries are named per kind — NNN.gif when converting, NNN.mp4 otherwise", () => {
  const background = loadBackground({ extensionRoot: ARCHIVE_ROOT });
  assert.equal(background.archiveEntryExtension(baseItem(), {}), "jpg");
  assert.equal(background.archiveEntryExtension(gifItem(), { gifOutput: "gif" }), "gif");
  assert.equal(background.archiveEntryExtension(gifItem(), { gifOutput: "mp4" }), "mp4");
  assert.equal(background.archiveEntryExtension(videoItem(), { gifOutput: "gif" }), "mp4");
});

// ---- queueStart warnings ----------------------------------------------------

test("queueStart warns up front: video archiving, mixed-media posts, PDF fallback", async () => {
  const background = loadBackground({
    extensionRoot: ARCHIVE_ROOT,
    download: capturingDownload([]),
    fetch: anyMediaFetch(),
    syncStored: { archiveVideos: true }
  });
  const started = await runQueue(background, [baseItem(), gifItem(), videoItem()], "pdf");
  const notices = started.notices;
  assert.equal(notices.length, 3, JSON.stringify(notices));
  assert.match(notices[0], /video files packed into ZIP archives/);
  assert.match(notices[1], /mix photos, GIFs and\/or videos/);
  assert.match(notices[2], /PDF holds photos only/);
});

test("queueStart warnings stay silent for a single-format photo archive post", async () => {
  const background = loadBackground({
    extensionRoot: ARCHIVE_ROOT,
    download: capturingDownload([]),
    fetch: anyMediaFetch()
  });
  const zipStart = await runQueue(background, [baseItem(), baseItem({ id: "111-1", mediaId: "m1", mediaIndex: 1 })], "zip");
  assert.deepEqual(Array.from(zipStart.notices), []);
});

// ---- pipelines --------------------------------------------------------------

test("mixed post + PDF requested: worker fallback ships ONE zip whose gif entry falls back to .mp4", async () => {
  const calls = [];
  const background = loadBackground({
    extensionRoot: ARCHIVE_ROOT,
    download: capturingDownload(calls),
    fetch: anyMediaFetch()
  });
  await runQueue(background, [baseItem(), gifItem()], "pdf");

  assert.equal(calls.length, 1, "one archive download, no raw files");
  assert.equal(calls[0].filename, "nasa - Hello world - 111.zip", "PDF degraded to ZIP for the mixed post");
  assert.ok(calls[0].url.startsWith("data:application/zip;base64,"));
  const zipBytes = Buffer.from(calls[0].url.split(",")[1], "base64");
  const names = zipBytes.toString("latin1").match(/00\d\.(jpg|mp4|gif)/g);
  // The worker fallback has no DOM, so the GIF entry embeds its MP4 source.
  assert.ok(names.includes("001.jpg") && names.includes("002.mp4"), `entries: ${names}`);
  const state = await background.handleQueueMessage({ action: "queueGet" });
  assert.deepEqual(Array.from(state.items, (item) => item.status), ["completed", "completed"]);
});

test("archiveGifs off: the GIF leaves the archive and downloads raw while photos still zip", async () => {
  const calls = [];
  const background = loadBackground({
    extensionRoot: ARCHIVE_ROOT,
    download: capturingDownload(calls),
    fetch: anyMediaFetch(),
    syncStored: { archiveGifs: false }
  });
  await runQueue(background, [baseItem(), gifItem()], "zip");

  assert.equal(calls.length, 2);
  const rawCall = calls.find((call) => !call.url.startsWith("data:application/zip"));
  const zipCall = calls.find((call) => call.url.startsWith("data:application/zip"));
  // No offscreen document in this harness → GIF conversion degrades to MP4.
  assert.equal(rawCall.url, "https://video.twimg.com/tweet_video/gif0.mp4");
  assert.equal(rawCall.filename, "XMedia/nasa/nasa - Hello world - 111/002.mp4");
  assert.equal(zipCall.filename, "nasa - Hello world - 111.zip");
});

test("archiveVideos on: the video joins the ZIP as NNN.mp4 instead of downloading raw", async () => {
  const calls = [];
  const background = loadBackground({
    extensionRoot: ARCHIVE_ROOT,
    download: capturingDownload(calls),
    fetch: anyMediaFetch(),
    syncStored: { archiveVideos: true }
  });
  await runQueue(background, [baseItem(), videoItem()], "zip");

  assert.equal(calls.length, 1, "video was archived, not downloaded raw");
  const zipBytes = Buffer.from(calls[0].url.split(",")[1], "base64");
  const names = zipBytes.toString("latin1").match(/00\d\.(jpg|mp4)/g);
  assert.ok(names.includes("001.jpg") && names.includes("003.mp4"), `entries: ${names}`);
});

test("offscreen archive job carries kinds + gifOutput so the document can convert GIF entries", async () => {
  const jobs = [];
  const background = loadBackground({
    extensionRoot: ARCHIVE_ROOT,
    download: capturingDownload([]),
    offscreen: { createDocument: async () => {}, hasDocument: async () => true },
    runtimeSendMessage: (message, callback) => {
      if (message?.action !== "offscreenBuildArchive") return Promise.resolve();
      jobs.push(message);
      callback({ ok: true, filename: message.job.filename });
      return undefined;
    }
  });
  await runQueue(background, [baseItem(), gifItem()], "zip");

  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].job.gifOutput, "gif");
  assert.deepEqual(Array.from(jobs[0].job.images, (image) => [image.kind, image.name]), [
    ["photo", "001.jpg"],
    ["gif", "002.gif"]
  ]);
});
