// ==========================================================================
// offscreen.js — MP4→GIF / MP4→WebP / MP4→APNG conversion in a DOM context
// (v3.15; the balanced global-palette GIF mode was retired in the v3.15
// review — GIF means the maximum-quality encoder).
//
// X serves animated_gif media as a small silent MP4 clip. This document
// decodes the clip frame-by-frame through <video> + canvas and encodes it as
// a real animated .gif (GIF89a, maximum-quality mode), an
// animated .webp (true color via the browser's native frame encoder, wrapped
// into the WebP animation container by lib/webpEncoder.js) or a true-color
// animated PNG (APNG), then returns the bytes to the service worker as
// base64 so chrome.downloads can save them as a data: URL WITH the
// master-folder subpath (the anchor mechanism cannot carry folders).
//
// Transfer: max-quality GIFs and APNGs can exceed the size of a single
// chrome.runtime message, so conversion is two-phase and chunked —
//   offscreenConvertGif { job: { url, output, jobId } } → { ok, jobId, totalChunks }
//   offscreenConvertGifChunk { jobId, index }              → { ok, base64, index, last }
// The bytes stay in a per-jobId buffer in THIS document until the worker has
// pulled every chunk (then the entry is dropped; a stale job is expired).
//
// HARD RULE (verified on real Chrome in the sister repo): offscreen
// documents expose ONLY chrome.runtime. Never call chrome.storage,
// chrome.downloads, or chrome.scripting here — any such call crashes the
// whole download. The job carries just the source URL; the bytes travel
// back through sendResponse.
// ==========================================================================

(() => {
  "use strict";

  // Quality modes: what the "as close to MP4 as possible" trade-off means.
  // (The pre-v3.15 balanced global-palette GIF mode was retired — see
  // background.js; the offscreen still maps an unknown/legacy output to the
  // maximum-quality GIF.)
  //   gif-max  — maximum-quality GIF: 25 fps, ≤1920 px, per-frame local
  //              palettes + Floyd–Steinberg dithering.
  //   webp     — animated WebP: true color, 25 fps, ≤1920 px, encoded per
  //              frame by the browser's native WebP encoder (canvas.toBlob)
  //              and wrapped into the animation container. The middle
  //              ground: APNG's color fidelity at GIF-like sizes.
  //   apng     — true color per frame (no palette), same 25 fps / ≤1920 px
  //              caps. The closest an image format gets to the MP4 quality.
  const MODES = {
    "gif-max": { fps: 25, maxSeconds: 30, maxDimension: 1920, maxOutputBytes: 256 * 1024 * 1024, palette: "local", dither: true },
    "webp":    { fps: 25, maxSeconds: 30, maxDimension: 1920, maxOutputBytes: 256 * 1024 * 1024, output: "webp", webpQuality: 0.9 },
    "apng":    { fps: 25, maxSeconds: 30, maxDimension: 1920, maxOutputBytes: 256 * 1024 * 1024, output: "apng" }
  };

  const CHUNK_BYTES = 3 * 1024 * 1024;          // 3 MB binary → ~4 MB base64 per message
  const JOB_TTL_MS = 15 * 60 * 1000;            // stale buffers are expired
  const jobBuffers = new Map();                 // jobId → { bytes, totalChunks, timer }

  function eventWithin(target, event, errorEvent, timeoutMs, label) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(label + " timed out")), timeoutMs);
      const ok = () => { cleanup(); resolve(); };
      const bad = () => { cleanup(); reject(new Error(label + " failed")); };
      const cleanup = () => {
        clearTimeout(timer);
        target.removeEventListener(event, ok);
        if (errorEvent) target.removeEventListener(errorEvent, bad);
      };
      target.addEventListener(event, ok, { once: true });
      if (errorEvent) target.addEventListener(errorEvent, bad, { once: true });
    });
  }

  async function seekVideo(video, time) {
    const done = eventWithin(video, "seeked", "error", 10000, "Video seek");
    video.currentTime = time;
    await done;
  }

  // MP4 clip → encoded image bytes (Uint8Array).
  async function convertMp4ToImage(url, output) {
    const mode = MODES[output] || MODES["gif-max"];
    const response = await fetch(url, { credentials: "omit" });
    if (!response.ok) throw new Error("GIF source fetch failed (" + response.status + ")");
    const sourceBlob = await response.blob();
    const objectUrl = URL.createObjectURL(sourceBlob);
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    try {
      const metadataReady = eventWithin(video, "loadedmetadata", "error", 15000, "Video metadata");
      video.src = objectUrl;
      await metadataReady;

      const duration = Math.min(Number(video.duration) || 0, mode.maxSeconds);
      if (!(duration > 0) || !video.videoWidth || !video.videoHeight) {
        throw new Error("GIF source video is not decodable");
      }
      const scale = Math.min(1, mode.maxDimension / Math.max(video.videoWidth, video.videoHeight));
      const width = Math.max(1, Math.round(video.videoWidth * scale));
      const height = Math.max(1, Math.round(video.videoHeight * scale));
      const frameCount = Math.min(Math.round(mode.maxSeconds * mode.fps), Math.max(1, Math.round(duration * mode.fps)));
      const frameStep = duration / frameCount;

      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) throw new Error("GIF conversion needs a 2d canvas");

      let bytes;
      if (mode.output === "apng") {
        // True color: raw RGBA frames, no quantization.
        const encoder = XDLAPng.createApng({ width, height, loop: 0, frames: frameCount });
        for (let i = 0; i < frameCount; i++) {
          await seekVideo(video, Math.min(i * frameStep, Math.max(0, duration - 0.05)));
          ctx.drawImage(video, 0, 0, width, height);
          await encoder.addFrame(ctx.getImageData(0, 0, width, height).data, frameStep * 1000);
        }
        bytes = encoder.finish();
      } else if (mode.output === "webp") {
        // Native per-frame WebP encode (true color, browser quality) wrapped
        // into the WebP animation container.
        const encoder = XDLWebp.createEncoder({ width, height, loop: 0 });
        for (let i = 0; i < frameCount; i++) {
          await seekVideo(video, Math.min(i * frameStep, Math.max(0, duration - 0.05)));
          ctx.drawImage(video, 0, 0, width, height);
          const blob = await new Promise((resolve, reject) => {
            canvas.toBlob(
              (result) => (result ? resolve(result) : reject(new Error("WebP frame encode failed"))),
              "image/webp",
              mode.webpQuality
            );
          });
          encoder.addFrame(new Uint8Array(await blob.arrayBuffer()), frameStep * 1000);
        }
        bytes = encoder.finish();
      } else {
        // Streaming encode: each frame is quantized + LZW-compressed
        // immediately, so only one RGBA buffer is alive at a time.
        const encoder = XDLGif.createEncoder({
          width, height, loop: 0,
          ...(mode.palette ? { palette: mode.palette, dither: mode.dither } : {})
        });
        for (let i = 0; i < frameCount; i++) {
          await seekVideo(video, Math.min(i * frameStep, Math.max(0, duration - 0.05)));
          ctx.drawImage(video, 0, 0, width, height);
          encoder.addFrame(ctx.getImageData(0, 0, width, height).data, frameStep * 1000);
        }
        bytes = encoder.finish();
      }
      if (bytes.length > mode.maxOutputBytes) {
        const label = mode.output === "apng" ? "APNG" : mode.output === "webp" ? "WebP" : "GIF";
        throw new Error(`Converted ${label} exceeds the size bound (${bytes.length} bytes; max ${mode.maxOutputBytes})`);
      }
      return bytes;
    } finally {
      video.removeAttribute("src");
      video.load();
      URL.revokeObjectURL(objectUrl);
    }
  }

  // Chunked so large outputs never blow the call stack through apply/spread.
  function bytesToBase64(bytes) {
    const chunks = [];
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      const slice = bytes.subarray(i, i + CHUNK);
      let binary = "";
      for (let j = 0; j < slice.length; j++) binary += String.fromCharCode(slice[j]);
      chunks.push(binary);
    }
    return btoa(chunks.join(""));
  }

  function startJob(jobId, bytes, mode) {
    const totalChunks = Math.max(1, Math.ceil(bytes.length / CHUNK_BYTES));
    const timer = setTimeout(() => jobBuffers.delete(jobId), JOB_TTL_MS);
    jobBuffers.set(jobId, { bytes, totalChunks, timer });
    return totalChunks;
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.action === "offscreenConvertGif") {
      const job = msg.job || {};
      const output = (["gif-max", "webp", "apng"].includes(job.output) && job.output) || "gif-max";
      const jobId = String(job.jobId || "");
      // Convert first, then answer with the chunk map so a failure never
      // leaves a job the worker would keep polling.
      convertMp4ToImage(String(job.url || ""), output)
        .then((bytes) => {
          if (!jobId) {
            // Legacy/single-use path: one message carries the whole file
            // (tests + small conversions).
            sendResponse({ ok: true, base64: bytesToBase64(bytes) });
            return;
          }
          const totalChunks = startJob(jobId, bytes, output);
          sendResponse({ ok: true, jobId, totalChunks });
        })
        .catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
      return true; // async response
    }

    if (msg?.action === "offscreenConvertGifChunk") {
      const job = jobBuffers.get(String(msg.jobId || ""));
      if (!job) {
        sendResponse({ ok: false, error: "GIF job not found (expired or never started)" });
        return true;
      }
      const index = Number(msg.index);
      if (!Number.isInteger(index) || index < 0 || index >= job.totalChunks) {
        sendResponse({ ok: false, error: "GIF chunk index out of range" });
        return true;
      }
      const start = index * CHUNK_BYTES;
      const slice = job.bytes.subarray(start, Math.min(start + CHUNK_BYTES, job.bytes.length));
      const last = index === job.totalChunks - 1;
      if (last) {
        clearTimeout(job.timer);
        jobBuffers.delete(String(msg.jobId || ""));
      }
      sendResponse({ ok: true, base64: bytesToBase64(slice), index, last });
      return true;
    }
    return undefined;
  });
})();
