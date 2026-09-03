// ==========================================================================
// offscreen.js — MP4→GIF conversion in a DOM context (v3.13, GIF-only).
//
// X serves animated_gif media as a small silent MP4 clip. This document
// decodes the clip frame-by-frame through <video> + canvas and feeds the
// frames to the streaming GIF89a encoder (lib/gifEncoder.js), then returns
// the bytes to the service worker as base64 so chrome.downloads can save
// them as a data: URL WITH the master-folder subpath.
//
// HARD RULE (verified on real Chrome in the sister repo): offscreen
// documents expose ONLY chrome.runtime. Never call chrome.storage,
// chrome.downloads, or chrome.scripting here — any such call crashes the
// whole download. The job carries just the source URL; the bytes travel
// back through sendResponse.
// ==========================================================================

(() => {
  "use strict";

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

  // Chunked so 40 MB of bytes never blows the call stack through apply/spread.
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

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.action === "offscreenConvertGif") {
      // Raw-mode GIF conversion: the bytes travel back to the worker as
      // base64 so chrome.downloads can save them as a data: URL WITH the
      // master-folder subpath (the anchor mechanism cannot carry folders).
      convertMp4ToGif(String(msg.job?.url || ""))
        .then((bytes) => sendResponse({ ok: true, base64: bytesToBase64(bytes) }))
        .catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
      return true; // async response
    }
    return undefined;
  });
})();
