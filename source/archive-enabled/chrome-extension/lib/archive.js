// ==========================================================================
// lib/archive.js — shared per-post archive plumbing (v3.5/v3.6).
//
// The two contexts that assemble ZIP/CBZ/PDF files used to carry near-identical
// copies of these helpers — the offscreen document (primary: fetch + assemble +
// anchor save) and the service worker (fallback: data: URL save when
// chrome.offscreen is unavailable). They live here once so the paths cannot
// drift. Pure DOM-free helpers only — no chrome API — so both contexts and the
// Node VM suites run the exact same code.
//
// Consumers:
//   - offscreen.html  (via <script>), before offscreen.js
//   - background.js   (via importScripts), after naming/zip/pdf
//   - tests/          (Node, via require)
// ==========================================================================

(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.XDLArchive = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

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
    const info = globalThis.XDLPdf.jpegInfo(bytes);
    if (info !== null && info.components === 3 && info.width > 0 && info.height > 0) {
      return { bytes, width: info.width, height: info.height };
    }
    const createImageBitmapFn = globalThis.createImageBitmap;
    const OffscreenCanvasCtor = globalThis.OffscreenCanvas;
    if (typeof createImageBitmapFn !== "function" || typeof OffscreenCanvasCtor !== "function") {
      throw new Error("PDF export cannot encode a non-JPEG page in this context.");
    }
    const bitmap = await createImageBitmapFn(new Blob([bytes], { type: contentType || "image/jpeg" }));
    try {
      const canvas = new OffscreenCanvasCtor(bitmap.width, bitmap.height);
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

  function bytesToBase64(bytes) {
    let binary = "";
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + chunkSize, bytes.length)));
    }
    return btoa(binary);
  }

  // entries: [{ name, bytes, contentType }, …] in post order.
  // format: "zip" | "cbz" | "pdf" (callers whitelist before reaching here);
  // anything else is treated as ZIP. Returns { bytes, mime }.
  // ZIP/CBZ embed each entry verbatim (STORE); PDF prepares every page (JPEG
  // passthrough or canvas re-encode) and keeps the original post order.
  async function buildArchiveBytes(entries, format) {
    if (format === "pdf") {
      const pages = [];
      for (const entry of entries) {
        pages.push(await preparePdfImage(entry.bytes, entry.contentType));
      }
      return {
        bytes: globalThis.XDLPdf.buildPdfDocument(pages),
        mime: "application/pdf"
      };
    }
    const bytes = globalThis.XDLZip.buildZip(
      entries.map((entry) => ({ name: entry.name, data: entry.bytes }))
    );
    return {
      bytes,
      mime: format === "cbz" ? "application/vnd.comicbook+zip" : "application/zip"
    };
  }

  return { fetchImageBytes, preparePdfImage, bytesToBase64, buildArchiveBytes };
});
