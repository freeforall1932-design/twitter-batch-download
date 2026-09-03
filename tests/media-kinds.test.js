// v3.6 media-kind tests for the v3.12 shipped worker: highest-quality photo
// URLs, GIF identity + MP4→GIF conversion plumbing, and the raw-mode queue
// behavior. Runs the REAL background.js + lib/ files in a VM — no browser
// needed. Archive kind rules, toggles and queueStart archive warnings now
// live in tests/archive-background.test.js, which pins the preserved
// archive-enabled source under source/archive-enabled/.

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

test("queueStart warnings stay silent for raw runs", async () => {
  const backgroundRaw = loadBackground({ download: capturingDownload([]) });
  const rawStart = await runQueue(backgroundRaw, [baseItem(), gifItem(), videoItem()], "raw");
  assert.deepEqual(Array.from(rawStart.notices), []);
});

// ---- pipelines ------------------------------------------------------------------

test("raw GIF converts to maximum-quality .gif via the chunked relay (default) and keeps the master-folder path", async () => {
  const calls = [];
  const gifBase64 = Buffer.from("GIF89a-fake-body").toString("base64");
  const half = Math.ceil(gifBase64.length / 2);
  const chunks = [gifBase64.slice(0, half), gifBase64.slice(half)];
  const background = loadBackground({
    download: capturingDownload(calls),
    offscreen: { createDocument: async () => {}, hasDocument: async () => true },
    runtimeSendMessage: (message, callback) => {
      if (message?.action === "offscreenConvertGif") {
        assert.equal(message.job.url, "https://video.twimg.com/tweet_video/gif0.mp4");
        assert.equal(message.job.output, "gif-max", "the retired balanced mode maps to the maximum-quality GIF");
        assert.ok(String(message.job.jobId).startsWith("g-"), "background allocates a job id");
        callback({ ok: true, jobId: message.job.jobId, totalChunks: 2 });
        return undefined;
      }
      if (message?.action === "offscreenConvertGifChunk") {
        const index = Number(message.index);
        assert.ok(index < 2, "chunk index stays in range");
        callback({ ok: true, base64: chunks[index], index, last: index === 1 });
        return undefined;
      }
      return Promise.resolve();
    }
  });
  await runQueue(background, [gifItem()], "raw");

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `data:image/gif;base64,${gifBase64}`);
  assert.equal(calls[0].filename, "XMedia/nasa/nasa - Hello world - 111/002.gif");
});

test("raw GIF with gifOutput=gif-max converts to .gif and keeps the .gif extension", async () => {
  const calls = [];
  const gifBase64 = Buffer.from("GIF89a-max-body").toString("base64");
  const background = loadBackground({
    download: capturingDownload(calls),
    syncStored: { gifOutput: "gif-max" },
    offscreen: { createDocument: async () => {}, hasDocument: async () => true },
    runtimeSendMessage: (message, callback) => {
      if (message?.action === "offscreenConvertGif") {
        assert.equal(message.job.output, "gif-max");
        callback({ ok: true, jobId: message.job.jobId, totalChunks: 1 });
        return undefined;
      }
      if (message?.action === "offscreenConvertGifChunk") {
        callback({ ok: true, base64: gifBase64, index: 0, last: true });
        return undefined;
      }
      return Promise.resolve();
    }
  });
  await runQueue(background, [gifItem()], "raw");

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `data:image/gif;base64,${gifBase64}`);
  assert.equal(calls[0].filename, "XMedia/nasa/nasa - Hello world - 111/002.gif");
});

test("raw GIF with gifOutput=apng converts to a true-color APNG with .apng extension", async () => {
  const calls = [];
  const apngBase64 = Buffer.from("896504470d0a1a0a-apng-body").toString("base64");
  const background = loadBackground({
    download: capturingDownload(calls),
    syncStored: { gifOutput: "apng" },
    offscreen: { createDocument: async () => {}, hasDocument: async () => true },
    runtimeSendMessage: (message, callback) => {
      if (message?.action === "offscreenConvertGif") {
        assert.equal(message.job.output, "apng");
        callback({ ok: true, jobId: message.job.jobId, totalChunks: 1 });
        return undefined;
      }
      if (message?.action === "offscreenConvertGifChunk") {
        callback({ ok: true, base64: apngBase64, index: 0, last: true });
        return undefined;
      }
      return Promise.resolve();
    }
  });
  await runQueue(background, [gifItem()], "raw");

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `data:image/apng;base64,${apngBase64}`);
  assert.equal(calls[0].filename, "XMedia/nasa/nasa - Hello world - 111/002.apng");
});

test("convertGifViaOffscreen degrades when a chunk pull fails", async () => {
  const background = loadBackground({
    offscreen: { createDocument: async () => {}, hasDocument: async () => true },
    runtimeSendMessage: (message, callback) => {
      if (message?.action === "offscreenConvertGif") {
        callback({ ok: true, jobId: message.job.jobId, totalChunks: 2 });
        return undefined;
      }
      callback({ ok: false, error: "GIF job not found" });
      return undefined;
    }
  });
  const result = await background.convertGifViaOffscreen("https://video.twimg.com/tweet_video/gif0.mp4", "gif-max");
  assert.equal(result.ok, false);
  assert.match(String(result.error), /GIF job not found|chunk transfer failed/);
});

test("raw GIF with gifOutput=webp converts to an animated WebP with .webp extension", async () => {
  const calls = [];
  const webpBase64 = Buffer.from("RIFFxxxxWEBP-anim-body").toString("base64");
  const background = loadBackground({
    download: capturingDownload(calls),
    syncStored: { gifOutput: "webp" },
    offscreen: { createDocument: async () => {}, hasDocument: async () => true },
    runtimeSendMessage: (message, callback) => {
      if (message?.action === "offscreenConvertGif") {
        assert.equal(message.job.output, "webp");
        callback({ ok: true, jobId: message.job.jobId, totalChunks: 1 });
        return undefined;
      }
      if (message?.action === "offscreenConvertGifChunk") {
        callback({ ok: true, base64: webpBase64, index: 0, last: true });
        return undefined;
      }
      return Promise.resolve();
    }
  });
  await runQueue(background, [gifItem()], "raw");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `data:image/webp;base64,${webpBase64}`);
  assert.equal(calls[0].filename, "XMedia/nasa/nasa - Hello world - 111/002.webp");
});

test("fallback: chosen APNG failing retries WebP and saves an animated WebP", async () => {
  const calls = [];
  const webpBase64 = Buffer.from("RIFF-fallback-webp").toString("base64");
  const attempted = [];
  const background = loadBackground({
    download: capturingDownload(calls),
    syncStored: { gifOutput: "apng" },
    offscreen: { createDocument: async () => {}, hasDocument: async () => true },
    runtimeSendMessage: (message, callback) => {
      if (message?.action === "offscreenConvertGif") {
        attempted.push(message.job.output);
        if (message.job.output === "apng") {
          callback({ ok: false, error: "APNG encode exploded" });
          return undefined;
        }
        callback({ ok: true, jobId: message.job.jobId, totalChunks: 1 });
        return undefined;
      }
      if (message?.action === "offscreenConvertGifChunk") {
        callback({ ok: true, base64: webpBase64, index: 0, last: true });
        return undefined;
      }
      return Promise.resolve();
    }
  });
  await runQueue(background, [gifItem()], "raw");
  assert.deepEqual(attempted, ["apng", "webp"], "APNG tried first, WebP second — chain stops at the first success");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `data:image/webp;base64,${webpBase64}`);
  assert.equal(calls[0].filename, "XMedia/nasa/nasa - Hello world - 111/002.webp");
});

test("fallback: every animated format failing keeps the original MP4 and reports the chain", async () => {
  const calls = [];
  const attempted = [];
  const warnings = [];
  const background = loadBackground({
    download: capturingDownload(calls),
    syncStored: { gifOutput: "apng" },
    offscreen: { createDocument: async () => {}, hasDocument: async () => true },
    runtimeSendMessage: (message, callback) => {
      if (message?.action !== "offscreenConvertGif") return Promise.resolve();
      attempted.push(message.job.output);
      callback({ ok: false, error: "nope" });
      return undefined;
    }
  });
  background.console = console;
  const warn = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  await runQueue(background, [gifItem()], "raw");
  console.warn = warn;
  assert.deepEqual(attempted, ["apng", "webp", "gif-max"], "chain walks every animated format");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://video.twimg.com/tweet_video/gif0.mp4");
  assert.equal(calls[0].filename, "XMedia/nasa/nasa - Hello world - 111/002.mp4");
  assert.ok(warnings.some((w) => w.includes("Every animated-image format failed") && w.includes("apng") && w.includes("gif")));
});

test("convertFallbackChain: preferred format first, other formats in fidelity order, mp4 alone", () => {
  const background = loadBackground({});
  const chain = (value) => Array.from(background.convertFallbackChain(value));
  assert.deepEqual(chain("apng"), ["apng", "webp", "gif-max"]);
  assert.deepEqual(chain("webp"), ["webp", "apng", "gif-max"]);
  assert.deepEqual(chain("gif-max"), ["gif-max", "apng", "webp"]);
  assert.deepEqual(chain("gif"), ["gif-max", "apng", "webp"], "legacy balanced value degrades to gif-max");
  assert.deepEqual(chain("mp4"), ["mp4"]);
  assert.deepEqual(chain("avif"), ["gif-max", "apng", "webp"], "unknown values degrade to gif-max");
});

test("normalizeGifOutput accepts every mode and degrades unknown/legacy values to maximum-quality gif", () => {
  const background = loadBackground({});
  assert.equal(background.normalizeGifOutput("gif"), "gif-max", "legacy balanced value maps to gif-max");
  assert.equal(background.normalizeGifOutput("gif-max"), "gif-max");
  assert.equal(background.normalizeGifOutput("webp"), "webp");
  assert.equal(background.normalizeGifOutput("apng"), "apng");
  assert.equal(background.normalizeGifOutput("mp4"), "mp4");
  assert.equal(background.normalizeGifOutput("WEBP"), "webp");
  assert.equal(background.normalizeGifOutput("GIF-MAX"), "gif-max");
  assert.equal(background.normalizeGifOutput("webp2"), "gif-max");
  assert.equal(background.normalizeGifOutput(undefined), "gif-max");
});

test("raw GIF with gifOutput=mp4 keeps the original clip untouched", async () => {
  const calls = [];
  const background = loadBackground({
    download: capturingDownload(calls),
    syncStored: { gifOutput: "mp4" }
  });
  await runQueue(background, [gifItem()], "raw");
  assert.equal(calls[0].url, "https://video.twimg.com/tweet_video/gif0.mp4");
  assert.equal(calls[0].filename, "XMedia/nasa/nasa - Hello world - 111/002.mp4");
});
