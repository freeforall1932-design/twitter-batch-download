// ==========================================================================
// offscreen.js — archive assembly in a DOM context (v3.5).
//
// MV3 service workers cannot create object URLs, and some Chromium builds
// ignore chrome.downloads.download's `filename` for blob: URLs (the file
// saves under the blob's UUID). Both problems are solved here the way the
// sister project nh-dw-2.0 does (offscreen.ts, hard-learned in its v3.2.1):
// build the archive Blob in THIS document and save it by clicking a
// same-context <a download> anchor, so the browser itself applies the name.
//
// HARD RULE (verified on real Chrome in the sister repo): offscreen
// documents expose ONLY chrome.runtime. Never call chrome.storage,
// chrome.downloads, or chrome.scripting here — any such call crashes the
// whole download. All settings arrive pre-read in the job message
// ("settings bag" relay); the archive is fetched and saved entirely locally.
// ==========================================================================

(() => {
  "use strict";

  const REVOKE_DELAY_MS = 60000;

  // Some Chromium builds ignore chrome.downloads' filename for blob: URLs
  // and save the artifact under the blob's UUID. For blobs created in THIS
  // document we sidestep that entirely with the standard HTML5 download
  // mechanism: a same-context anchor whose `download` attribute carries the
  // name. Note the download attribute cannot carry folders — archives land
  // at the download-directory root by design.
  function saveBlobViaAnchor(blob, filename) {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.style.display = "none";
    document.body.appendChild(anchor);
    anchor.click();
    setTimeout(() => {
      try { document.body.removeChild(anchor); } catch (_) { /* detached */ }
    }, 0);
    // Keep the blob alive until the browser has picked up the download.
    setTimeout(() => {
      try { URL.revokeObjectURL(url); } catch (_) { /* already revoked */ }
    }, REVOKE_DELAY_MS);
  }

  // fetchImageBytes / preparePdfImage / bytesToBase64 / buildArchiveBytes
  // live in lib/archive.js — the same code the service-worker fallback runs.

  // ==========================================================================
  // GIF conversion — X's "GIFs" are silent MP4 clips; a real .gif is produced
  // by decoding the clip frame-by-frame through <video> + canvas and feeding
  // the frames to the streaming GIF89a encoder (lib/gifEncoder.js).
  // Bounds keep worst-case CPU/memory sane; every violation falls back to
  // saving the original MP4 instead of failing the item.
  // ==========================================================================

  const GIF_FPS = 12;                 // matches typical X GIF frame pacing
  const GIF_MAX_SECONDS = 30;         // X GIFs are short clips
  const GIF_MAX_FRAMES = 360;         // 30s × 12fps hard cap
  const GIF_MAX_DIMENSION = 720;      // longest side; X GIF sources are ≤720 in practice
  const GIF_MAX_OUTPUT_BYTES = 40 * 1024 * 1024; // relayed as base64 — keep messages bounded

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

  // MP4 clip → animated GIF bytes (Uint8Array).
  async function convertMp4ToGif(url) {
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

      const duration = Math.min(Number(video.duration) || 0, GIF_MAX_SECONDS);
      if (!(duration > 0) || !video.videoWidth || !video.videoHeight) {
        throw new Error("GIF source video is not decodable");
      }
      const scale = Math.min(1, GIF_MAX_DIMENSION / Math.max(video.videoWidth, video.videoHeight));
      const width = Math.max(1, Math.round(video.videoWidth * scale));
      const height = Math.max(1, Math.round(video.videoHeight * scale));
      const frameCount = Math.min(GIF_MAX_FRAMES, Math.max(1, Math.round(duration * GIF_FPS)));
      const frameStep = duration / frameCount;

      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) throw new Error("GIF conversion needs a 2d canvas");

      // Streaming encode: each frame is quantized + LZW-compressed
      // immediately, so only one RGBA buffer is alive at a time.
      const encoder = XDLGif.createEncoder({ width, height, loop: 0 });
      for (let i = 0; i < frameCount; i++) {
        await seekVideo(video, Math.min(i * frameStep, Math.max(0, duration - 0.05)));
        ctx.drawImage(video, 0, 0, width, height);
        encoder.addFrame(ctx.getImageData(0, 0, width, height).data, frameStep * 1000);
      }
      const gifBytes = encoder.finish();
      if (gifBytes.length > GIF_MAX_OUTPUT_BYTES) {
        throw new Error("Converted GIF exceeds the size bound (" + gifBytes.length + " bytes)");
      }
      return gifBytes;
    } finally {
      video.removeAttribute("src");
      video.load();
      URL.revokeObjectURL(objectUrl);
    }
  }

  // One archive entry's bytes + final name, honoring its media kind.
  //   photo → fetched verbatim (already forced to name=orig by the worker).
  //   gif   → converted to a real .gif when the job asks for it; a failed
  //           conversion falls back to the MP4 bytes under an .mp4 name so
  //           the archive is never mislabeled.
  //   video → MP4 bytes verbatim (highest-bitrate variant, chosen upstream).
  async function fetchArchiveEntry(image, gifOutput) {
    if (image.kind === "gif" && gifOutput !== "mp4") {
      try {
        const gifBytes = await convertMp4ToGif(image.url);
        return { name: image.name, url: image.url, bytes: gifBytes, contentType: "image/gif" };
      } catch (error) {
        console.warn("[X-DL OFFSCREEN] GIF conversion failed, embedding MP4:", error);
        const source = await XDLArchive.fetchImageBytes(image.url);
        return { name: image.name.replace(/\.gif$/i, ".mp4"), url: image.url, bytes: source.bytes, contentType: source.contentType };
      }
    }
    const fetched = await XDLArchive.fetchImageBytes(image.url);
    return { name: image.name, url: image.url, bytes: fetched.bytes, contentType: fetched.contentType };
  }


  // job: { format: "zip"|"cbz"|"pdf", filename: "<base>.<ext>",
  //        gifOutput: "gif"|"mp4",
  //        images: [{ url, kind: "photo"|"gif"|"video", name: "001.jpg" }, …]
  //        in post order }
  // PDF jobs only ever carry photos — the worker degrades PDF → ZIP for any
  // post whose archive includes a GIF or video (effectiveGroupFormat).
  async function buildAndSaveArchive(job) {
    const format = XDLNaming.normalizeOutputFormat(job.format);
    if (format === "raw") throw new Error("Raw downloads never reach the offscreen document.");
    const images = Array.isArray(job.images) ? job.images : [];
    if (!images.length) throw new Error("Archive job has no images.");
    const filename = XDLNaming.sanitizeArtifactFilename(String(job.filename || ""), "post." + format);
    const gifOutput = job.gifOutput === "mp4" ? "mp4" : "gif";

    if (format === "pdf") {
      const nonPhoto = images.find((image) => image.kind && image.kind !== "photo");
      if (nonPhoto) throw new Error("PDF archives hold photos only; the worker must degrade this post to ZIP.");
    }

    const fetched = [];
    for (const image of images) {
      fetched.push(await fetchArchiveEntry(image, gifOutput));
    }

    // Byte-level archive work lives in lib/archive.js (shared with the
    // service-worker fallback): fetch, PDF page prep, ZIP/blob building.
    const assembled = await XDLArchive.buildArchiveBytes(fetched, format);
    saveBlobViaAnchor(new Blob([assembled.bytes], { type: assembled.mime }), filename);
    // v3.10 — digests travel back to the worker so the archive and each of
    // its entries are recorded for byte-identical duplicate verification.
    const dedupe = globalThis.XDLDedupe;
    return {
      ok: true,
      filename,
      hash: dedupe ? dedupe.hashBytes(assembled.bytes) : "",
      size: assembled.bytes.byteLength,
      entries: fetched.map((entry) => ({
        url: entry.url,
        hash: dedupe ? dedupe.hashBytes(entry.bytes) : "",
        size: entry.bytes.byteLength
      }))
    };
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.action === "offscreenBuildArchive") {
      buildAndSaveArchive(msg.job || {})
        .then((result) => sendResponse(result))
        .catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
      return true; // async response
    }
    if (msg?.action === "offscreenConvertGif") {
      // Raw-mode GIF conversion: the bytes travel back to the worker as
      // base64 so chrome.downloads can save them as a data: URL WITH the
      // master-folder subpath (the anchor mechanism cannot carry folders).
      convertMp4ToGif(String(msg.job?.url || ""))
        .then((bytes) => sendResponse({ ok: true, base64: XDLArchive.bytesToBase64(bytes) }))
        .catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
      return true; // async response
    }
    return undefined;
  });
})();
