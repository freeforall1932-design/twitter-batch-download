// v3.6 media-kind tests: highest-quality photo URLs, GIF identity + MP4→GIF
// conversion plumbing, archive kind rules (GIF/video → ZIP/CBZ only, never
// PDF), the optional archive toggles, and the queueStart warnings. Runs the
// REAL background.js + lib/ files in a VM — no browser needed.

const assert = require("node:assert/strict");
const test = require("node:test");

const { loadBackground } = require("./helpers/load-background.js");

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

async function runQueue(background, items, format) {
  await background.handleQueueMessage({ action: "queueAdd", items });
  await background.handleQueueMessage({ action: "queueSelectVisible", filter: "all", selected: true });
  const started = await background.handleQueueMessage({ action: "queueStart", mode: "selected", ...(format !== undefined ? { format } : {}) });
  await background.processQueue();
  return started;
}

// ---- quality ----------------------------------------------------------------

test("photo quality: normalizePhotoUrl forces name=orig even over a pre-sized variant", () => {
  const background = loadBackground({});
  assert.equal(
    background.normalizePhotoUrl("https://pbs.twimg.com/media/abc.jpg?format=jpg&name=small"),
    "https://pbs.twimg.com/media/abc.jpg?format=jpg&name=orig"
  );
  assert.equal(
    background.normalizePhotoUrl("https://pbs.twimg.com/media/abc.jpg"),
    "https://pbs.twimg.com/media/abc.jpg?name=orig"
  );
});

test("gif identity: animated_gif items keep type video, carry isGif, and pick the best MP4 variant", () => {
  const background = loadBackground({});
  const [item] = background.mediaItemsFromTweetObject({
    rest_id: "42",
    core: { user_results: { result: { legacy: { screen_name: "nasa", name: "NASA" } } } },
    legacy: {
      created_at: "Wed Aug 26 09:15:00 +0000 2026",
      full_text: "gif post",
      extended_entities: {
        media: [{
          type: "animated_gif",
          id_str: "g1",
          media_url_https: "https://pbs.twimg.com/tweet_video_thumb/g1.jpg",
          video_info: {
            variants: [
              { content_type: "video/mp4", bitrate: 0, url: "https://video.twimg.com/tweet_video/low.mp4" },
              { content_type: "video/mp4", bitrate: 950000, url: "https://video.twimg.com/tweet_video/best.mp4" },
              { content_type: "application/x-mpegURL", url: "https://video.twimg.com/hls.m3u8" }
            ]
          }
        }]
      }
    }
  });
  assert.equal(item.type, "video");
  assert.equal(item.isGif, true);
  assert.equal(item.url, "https://video.twimg.com/tweet_video/best.mp4");
});

// ---- kind rules (unit) --------------------------------------------------------

test("kind rules: photos always archive; GIFs by default; videos only when opted in", () => {
  const background = loadBackground({});
  assert.deepEqual([...background.archivedKinds({})].sort(), ["gif", "photo"]);
  assert.deepEqual([...background.archivedKinds({ archiveGifs: false })], ["photo"]);
  assert.deepEqual([...background.archivedKinds({ archiveVideos: true })].sort(), ["gif", "photo", "video"]);
});

test("kind rules: a GIF or video in the archive degrades PDF to ZIP for that post only", () => {
  const background = loadBackground({});
  const photos = [baseItem()];
  const withGif = [baseItem(), gifItem()];
  const withVideo = [baseItem(), videoItem()];
  assert.equal(background.effectiveGroupFormat(photos, "pdf"), "pdf");
  assert.equal(background.effectiveGroupFormat(withGif, "pdf"), "zip");
  assert.equal(background.effectiveGroupFormat(withVideo, "pdf"), "zip");
  assert.equal(background.effectiveGroupFormat(withGif, "cbz"), "cbz", "ZIP/CBZ both allowed for motion media");
});

test("kind rules: archive entries are named per kind — NNN.gif when converting, NNN.mp4 otherwise", () => {
  const background = loadBackground({});
  assert.equal(background.archiveEntryExtension(baseItem(), {}), "jpg");
  assert.equal(background.archiveEntryExtension(gifItem(), { gifOutput: "gif" }), "gif");
  assert.equal(background.archiveEntryExtension(gifItem(), { gifOutput: "mp4" }), "mp4");
  assert.equal(background.archiveEntryExtension(videoItem(), { gifOutput: "gif" }), "mp4");
});

// ---- warnings -----------------------------------------------------------------

test("queueStart warns up front: video archiving, mixed-media posts, PDF fallback", async () => {
  const background = loadBackground({
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

test("queueStart warnings stay silent for raw runs and single-format photo posts", async () => {
  const backgroundRaw = loadBackground({ download: capturingDownload([]) });
  const rawStart = await runQueue(backgroundRaw, [baseItem(), gifItem(), videoItem()], "raw");
  assert.deepEqual(Array.from(rawStart.notices), []);

  const backgroundZip = loadBackground({ download: capturingDownload([]), fetch: anyMediaFetch() });
  const zipStart = await runQueue(backgroundZip, [baseItem(), baseItem({ id: "111-1", mediaId: "m1", mediaIndex: 1 })], "zip");
  assert.deepEqual(Array.from(zipStart.notices), []);
});

// ---- pipelines ------------------------------------------------------------------

test("mixed post + PDF requested: worker fallback ships ONE zip whose gif entry falls back to .mp4", async () => {
  const calls = [];
  const background = loadBackground({ download: capturingDownload(calls), fetch: anyMediaFetch() });
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
  assert.equal(rawCall.filename, "XMedia/nasa - Hello world - 111/002.mp4");
  assert.equal(zipCall.filename, "nasa - Hello world - 111.zip");
});

test("archiveVideos on: the video joins the ZIP as NNN.mp4 instead of downloading raw", async () => {
  const calls = [];
  const background = loadBackground({
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

test("raw GIF with a live offscreen document converts to .gif and keeps the master-folder path", async () => {
  const calls = [];
  const gifBase64 = Buffer.from("GIF89a-fake-body").toString("base64");
  const background = loadBackground({
    download: capturingDownload(calls),
    offscreen: { createDocument: async () => {}, hasDocument: async () => true },
    runtimeSendMessage: (message, callback) => {
      if (message?.action !== "offscreenConvertGif") return Promise.resolve();
      assert.equal(message.job.url, "https://video.twimg.com/tweet_video/gif0.mp4");
      callback({ ok: true, base64: gifBase64 });
      return undefined;
    }
  });
  await runQueue(background, [gifItem()], "raw");

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `data:image/gif;base64,${gifBase64}`);
  assert.equal(calls[0].filename, "XMedia/nasa - Hello world - 111/002.gif");
});

test("raw GIF with gifOutput=mp4 keeps the original clip untouched", async () => {
  const calls = [];
  const background = loadBackground({
    download: capturingDownload(calls),
    syncStored: { gifOutput: "mp4" }
  });
  await runQueue(background, [gifItem()], "raw");
  assert.equal(calls[0].url, "https://video.twimg.com/tweet_video/gif0.mp4");
  assert.equal(calls[0].filename, "XMedia/nasa - Hello world - 111/002.mp4");
});

test("offscreen archive job carries kinds + gifOutput so the document can convert GIF entries", async () => {
  const jobs = [];
  const background = loadBackground({
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
