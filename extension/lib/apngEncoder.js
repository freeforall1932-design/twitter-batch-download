// ==========================================================================
// lib/apngEncoder.js — dependency-free animated PNG (APNG) writer (v3.14).
//
// GIF can only hold 256 colors per frame, which is GIF's hard quality
// ceiling. APNG is the "as close to the MP4 source as an
// image format gets" path: true 24/32-bit color per frame (no palette, no
// banding), exact frame pixels, and PNG's lossless compression. It trades
// file size for fidelity — that is deliberate.
//
// Streaming: each frame is filtered (scanline 0, "none") and deflated
// immediately through the CompressionStream API (Chrome 80+, Node 18+); the
// compressed chunks are collected and concatenated at finish(), so RGBA
// frames are never accumulated and only compressed output is held.
//
// UMD: `XDLAPng` in the offscreen document, require() in Node tests.
// No chrome APIs in this file.
// ==========================================================================

(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.XDLAPng = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  // ---- PNG chunk primitives -------------------------------------------------

  const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

  const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      table[n] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  function concatBytes(parts) {
    let total = 0;
    for (const part of parts) total += part.length;
    const out = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
      out.set(part, offset);
      offset += part.length;
    }
    return out;
  }

  // ---- compression (raw deflate via CompressionStream) ----------------------

  async function deflate(bytes) {
    const stream = new CompressionStream("deflate");
    const writer = stream.writable.getWriter();
    const writePromise = writer.write(bytes);
    const closePromise = writer.close();
    await Promise.all([writePromise, closePromise]);
    const reader = stream.readable.getReader();
    const parts = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
      total += value.length;
    }
    const out = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
      out.set(part, offset);
      offset += part.length;
    }
    return out;
  }

  // ---- streaming encoder ----------------------------------------------------

  // createApng({ width, height, loop = 0, frames }) → { addFrame, finish }.
  // addFrame(rgbaUint8ClampedArray, delayMs) is async (deflates the frame);
  // finish() returns the complete APNG bytes (async-safe: called after every
  // addFrame has been awaited).
  function createApng(options) {
    const rawWidth = Number(options && options.width);
    const rawHeight = Number(options && options.height);
    if (!Number.isFinite(rawWidth) || !Number.isFinite(rawHeight) || rawWidth < 1 || rawHeight < 1) {
      throw new Error("APNG encoder needs a width and height.");
    }
    const width = Math.floor(rawWidth);
    const height = Math.floor(rawHeight);
    const loop = options && Number.isFinite(options.loop) ? Math.max(0, options.loop) : 0;
    const totalFrames = Number(options && options.frames) > 0 ? Math.floor(options.frames) : 0;

    const parts = [];
    let seq = 0;
    let frames = 0;
    let framePalette = null; // unused — APNG is true color
    let finished = false;

    const pushPart = (bytes) => { parts.push(bytes); };

    function chunk(type, data) {
      const typeBytes = new Uint8Array(4);
      typeBytes[0] = type.charCodeAt(0);
      typeBytes[1] = type.charCodeAt(1);
      typeBytes[2] = type.charCodeAt(2);
      typeBytes[3] = type.charCodeAt(3);
      const withType = new Uint8Array(4 + data.length);
      withType.set(typeBytes, 0);
      withType.set(data, 4);
      const header = new Uint8Array(8);
      const view = new DataView(header.buffer);
      view.setUint32(0, data.length);
      header.set(typeBytes, 4);
      pushPart(header);
      if (data.length) pushPart(data);
      const crcBytes = new Uint8Array(4);
      new DataView(crcBytes.buffer).setUint32(0, crc32(withType));
      pushPart(crcBytes);
    }

    function u32(value) {
      const out = new Uint8Array(4);
      new DataView(out.buffer).setUint32(0, value >>> 0);
      return out;
    }
    function u16(value) {
      const out = new Uint8Array(2);
      new DataView(out.buffer).setUint16(0, value >>> 0);
      return out;
    }

    function writeSignature() { pushPart(new Uint8Array(SIGNATURE)); }

    function writeHeader() {
      writeSignature();
      const ihdr = new Uint8Array(13);
      const view = new DataView(ihdr.buffer);
      view.setUint32(0, width);
      view.setUint32(4, height);
      ihdr[8] = 8;  // bit depth
      ihdr[9] = 6;  // color type: truecolor with alpha
      ihdr[10] = 0; // compression
      ihdr[11] = 0; // filter
      ihdr[12] = 0; // interlace
      chunk("IHDR", ihdr);
      const actl = new Uint8Array(8);
      new DataView(actl.buffer).setUint32(0, totalFrames);
      new DataView(actl.buffer).setUint32(4, loop); // 0 = loop forever
      chunk("acTL", actl);
    }

    function writeFrameControl(delayMs) {
      const fctl = new Uint8Array(26);
      const view = new DataView(fctl.buffer);
      view.setUint32(0, seq++);      // fcTL sequence number
      view.setUint32(4, width);
      view.setUint32(8, height);
      view.setUint32(12, 0);         // x
      view.setUint32(16, 0);         // y
      view.setUint16(20, Math.max(1, Math.round(Number(delayMs) || 100))); // delay numerator (ms)
      view.setUint16(22, 1000);      // delay denominator
      fctl[24] = 0;                  // dispose: none
      fctl[25] = 0;                  // blend: source
      chunk("fcTL", fctl);
    }

    // Filter-0 ("none") scanlines: 0x00 row-prefix + raw RGBA.
    function filterRgba(rgba) {
      const stride = width * 4;
      const out = new Uint8Array(height * (stride + 1));
      for (let y = 0; y < height; y++) {
        out[y * (stride + 1)] = 0;
        out.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
      }
      return out;
    }

    async function addFrame(rgba, delayMs) {
      if (finished) throw new Error("APNG encoder already finished.");
      if (!rgba || rgba.length < width * height * 4) throw new Error("APNG frame buffer is too small.");
      if (frames === 0) writeHeader();
      writeFrameControl(delayMs);
      const compressed = await deflate(filterRgba(rgba));
      if (frames === 0) {
        chunk("IDAT", compressed);
      } else {
        // fdAT = 4-byte sequence number + deflated frame data.
        const seqBytes = u32(seq++);
        const data = new Uint8Array(4 + compressed.length);
        data.set(seqBytes, 0);
        data.set(compressed, 4);
        chunk("fdAT", data);
      }
      frames++;
    }

    function finish() {
      if (finished) throw new Error("APNG encoder already finished.");
      if (!frames) throw new Error("Cannot build an APNG with no frames.");
      finished = true;
      if (frames > 0 && totalFrames !== frames) {
        // acTL was written with the known count; if the caller lied, the
        // animation is still playable (decoders read fcTL), but patch the
        // count so the file is spec-accurate. The acTL chunk is always at a
        // fixed offset after IHDR; scan parts for it anyway to stay exact.
        patchFrameCount(frames);
      }
      chunk("IEND", new Uint8Array(0));
      return concatBytes(parts);
    }

    // acTL follows IHDR immediately: parts are signature, IHDR header,
    // IHDR data, IHDR crc, acTL header, acTL data, acTL crc → data at 5,
    // crc at 6. Patching the count must also recompute the CRC, or strict
    // decoders reject the file.
    function patchFrameCount(count) {
      const acTL = parts[5];
      new DataView(acTL.buffer, acTL.byteOffset).setUint32(0, count);
      // CRC covers type + data only (the length field is NOT included) —
      // parts[4] is the 8-byte length+type header, so take just the type.
      const withType = concatBytes([parts[4].subarray(4), acTL]);
      new DataView(parts[6].buffer, parts[6].byteOffset).setUint32(0, crc32(withType));
    }

    return { addFrame, finish, get frameCount() { return frames; } };
  }

  // One-shot convenience used by tests and small callers.
  async function encodeApng(input) {
    const enc = createApng(input);
    for (const frame of input.frames || []) await enc.addFrame(frame.data, frame.delayMs);
    return enc.finish();
  }

  return { createApng, encodeApng, crc32 };
});
