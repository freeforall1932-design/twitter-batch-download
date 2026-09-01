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

  async function fetchImageBytes(url) {
    const response = await fetch(url, { credentials: "omit" });
    if (!response.ok) {
      throw new Error("Image fetch failed (" + response.status + ") for " + url);
    }
    const buffer = await response.arrayBuffer();
    if (!buffer || buffer.byteLength < 32) {
      throw new Error("Image response too small for " + url);
    }
    return {
      bytes: new Uint8Array(buffer),
      contentType: response.headers.get("content-type") || null
    };
  }

  // JPEGs embed verbatim (DCTDecode, dimensions from the SOF frame);
  // PNG/WebP — and CMYK/grayscale JPEGs — re-encode via createImageBitmap +
  // OffscreenCanvas, flattened on white (JPEG has no alpha channel:
  // transparency must not turn black).
  async function preparePdfImage(bytes, contentType) {
    const info = XDLPdf.jpegInfo(bytes);
    if (info !== null && info.components === 3 && info.width > 0 && info.height > 0) {
      return { bytes, width: info.width, height: info.height };
    }
    const bitmap = await createImageBitmap(new Blob([bytes], { type: contentType || "image/jpeg" }));
    try {
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("PDF export cannot encode a page (no 2d canvas).");
      ctx.fillStyle = "#FFFFFF";
      ctx.fillRect(0, 0, bitmap.width, bitmap.height);
      ctx.drawImage(bitmap, 0, 0);
      const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.92 });
      return {
        bytes: new Uint8Array(await blob.arrayBuffer()),
        width: bitmap.width,
        height: bitmap.height
      };
    } finally {
      if (typeof bitmap.close === "function") bitmap.close();
    }
  }

  // job: { format: "zip"|"cbz"|"pdf", filename: "<base>.<ext>",
  //        images: [{ url, name: "001.jpg" }, …] in post order }
  async function buildAndSaveArchive(job) {
    const format = XDLNaming.normalizeOutputFormat(job.format);
    if (format === "raw") throw new Error("Raw downloads never reach the offscreen document.");
    const images = Array.isArray(job.images) ? job.images : [];
    if (!images.length) throw new Error("Archive job has no images.");
    const filename = XDLNaming.sanitizeArtifactFilename(String(job.filename || ""), "post." + format);

    const fetched = [];
    for (const image of images) {
      fetched.push({ name: image.name, ...(await fetchImageBytes(image.url)) });
    }

    let blob;
    if (format === "pdf") {
      const pages = [];
      for (const page of fetched) {
        pages.push(await preparePdfImage(page.bytes, page.contentType));
      }
      blob = new Blob([XDLPdf.buildPdfDocument(pages)], { type: "application/pdf" });
    } else {
      const archive = XDLZip.buildZip(fetched.map((entry) => ({ name: entry.name, data: entry.bytes })));
      blob = new Blob([archive], { type: format === "cbz" ? "application/vnd.comicbook+zip" : "application/zip" });
    }
    saveBlobViaAnchor(blob, filename);
    return { ok: true, filename };
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.action !== "offscreenBuildArchive") return undefined;
    buildAndSaveArchive(msg.job || {})
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
    return true; // async response
  });
})();
