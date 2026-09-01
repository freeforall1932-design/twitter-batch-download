// ==========================================================================
// lib/gifEncoder.js — dependency-free GIF89a encoder (v3.6).
//
// X serves "GIFs" (animated_gif media) as silent MP4 clips; this encoder is
// the second half of the "GIF stays a GIF" pipeline: the offscreen document
// decodes the MP4 frame-by-frame onto a canvas (offscreen.js) and feeds the
// RGBA frames here, producing a real animated .gif file.
//
// Design (memory-conscious — frames are compressed as they arrive, RGBA
// buffers are never accumulated):
//   - Global 256-color palette built once, from the FIRST frame, by median
//     cut over a pixel sample. Later frames map through a nearest-color
//     cache. (Same trade-off gif.js makes with a single global palette:
//     stable colors across frames and one palette write.)
//   - Standard GIF LZW with CLEAR/EOI codes, 8-bit min code size.
//   - NETSCAPE2.0 loop extension (loop forever by default).
//   - No transparency, disposal "do not dispose" — X GIFs are opaque video.
//
// UMD: service worker + offscreen document get `XDLGif`; Node tests
// require() it directly. No DOM/canvas APIs are used in this file.
// ==========================================================================

(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.XDLGif = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const PALETTE_SIZE = 256;
  const PALETTE_SAMPLE_TARGET = 65536; // pixels sampled for the median cut

  // ---- palette (median cut over an RGB sample) -----------------------------

  function samplePixels(rgba) {
    const totalPixels = rgba.length >> 2;
    const stride = Math.max(1, Math.floor(totalPixels / PALETTE_SAMPLE_TARGET));
    const sample = [];
    for (let p = 0; p < totalPixels; p += stride) {
      const i = p << 2;
      sample.push([rgba[i], rgba[i + 1], rgba[i + 2]]);
    }
    return sample;
  }

  function medianCut(sample, maxColors) {
    if (!sample.length) return [[0, 0, 0]];
    let boxes = [sample];
    while (boxes.length < maxColors) {
      // Split the box with the widest channel range.
      let bestBox = -1, bestRange = -1, bestChannel = 0;
      for (let b = 0; b < boxes.length; b++) {
        if (boxes[b].length < 2) continue;
        for (let c = 0; c < 3; c++) {
          let min = 255, max = 0;
          for (const px of boxes[b]) {
            if (px[c] < min) min = px[c];
            if (px[c] > max) max = px[c];
          }
          const range = max - min;
          if (range > bestRange) { bestRange = range; bestBox = b; bestChannel = c; }
        }
      }
      if (bestBox === -1 || bestRange <= 0) break; // nothing left to split
      const box = boxes[bestBox];
      box.sort((a, b) => a[bestChannel] - b[bestChannel]);
      const mid = box.length >> 1;
      boxes.splice(bestBox, 1, box.slice(0, mid), box.slice(mid));
    }
    return boxes.map((box) => {
      let r = 0, g = 0, b = 0;
      for (const px of box) { r += px[0]; g += px[1]; b += px[2]; }
      const n = box.length || 1;
      return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
    });
  }

  function buildPalette(rgba) {
    const colors = medianCut(samplePixels(rgba), PALETTE_SIZE);
    // GIF global color tables must be a power-of-two size; pad with black.
    let size = 2;
    while (size < colors.length) size *= 2;
    const table = new Uint8Array(size * 3);
    for (let i = 0; i < colors.length; i++) {
      table[i * 3] = colors[i][0];
      table[i * 3 + 1] = colors[i][1];
      table[i * 3 + 2] = colors[i][2];
    }
    return { table, colorCount: colors.length, tableSize: size };
  }

  // Nearest palette index with a 24-bit color cache (the gif.js approach:
  // photographic frames repeat colors constantly, so the cache hit rate is
  // high and mapping stays O(pixels)).
  function makeColorMapper(palette) {
    const cache = new Map();
    const { table, colorCount } = palette;
    return function nearestIndex(r, g, b) {
      const key = (r << 16) | (g << 8) | b;
      const hit = cache.get(key);
      if (hit !== undefined) return hit;
      let best = 0, bestDist = Infinity;
      for (let i = 0; i < colorCount; i++) {
        const dr = r - table[i * 3];
        const dg = g - table[i * 3 + 1];
        const db = b - table[i * 3 + 2];
        const dist = dr * dr + dg * dg + db * db;
        if (dist < bestDist) { bestDist = dist; best = i; }
      }
      cache.set(key, best);
      return best;
    };
  }

  // ---- LZW (GIF variant) ---------------------------------------------------

  function lzwEncode(indices, minCodeSize, out) {
    const clearCode = 1 << minCodeSize;
    const eoiCode = clearCode + 1;
    let nextCode, codeSize, dict;

    let bitBuffer = 0, bitCount = 0;
    const chunk = new Uint8Array(255);
    let chunkLen = 0;

    const flushByte = (byte) => {
      chunk[chunkLen++] = byte;
      if (chunkLen === 255) { out.push(255); for (let i = 0; i < 255; i++) out.push(chunk[i]); chunkLen = 0; }
    };
    const writeCode = (code) => {
      bitBuffer |= code << bitCount;
      bitCount += codeSize;
      while (bitCount >= 8) { flushByte(bitBuffer & 0xff); bitBuffer >>= 8; bitCount -= 8; }
      // Grow the code width AFTER writing, once the table has outgrown the
      // current width — the same deferred timing canonical GIF encoders use
      // (decoders lag the encoder's table by one entry, so an immediate bump
      // would desynchronize the bitstream).
      if (nextCode >= 1 << codeSize && codeSize < 12) codeSize++;
    };
    const resetDict = () => {
      dict = new Map();
      nextCode = eoiCode + 1;
      codeSize = minCodeSize + 1;
    };

    resetDict();
    writeCode(clearCode);
    let prefix = indices[0];
    for (let i = 1; i < indices.length; i++) {
      const k = indices[i];
      const key = (prefix << 8) | k;
      const found = dict.get(key);
      if (found !== undefined) { prefix = found; continue; }
      writeCode(prefix);
      // Register the new sequence; the width bump itself happens inside
      // writeCode, deferred by one code to stay decoder-aligned.
      dict.set(key, nextCode);
      nextCode++;
      if (nextCode === 4096) { writeCode(clearCode); resetDict(); }
      prefix = k;
    }
    writeCode(prefix);
    writeCode(eoiCode);
    if (bitCount > 0) flushByte(bitBuffer & 0xff);
    if (chunkLen > 0) { out.push(chunkLen); for (let i = 0; i < chunkLen; i++) out.push(chunk[i]); }
    out.push(0); // block terminator
  }

  // ---- encoder -------------------------------------------------------------

  // Streaming encoder: palette from frame 1, every addFrame() compresses and
  // discards its RGBA input immediately.
  //   const enc = createEncoder({ width, height, loop: 0 });
  //   enc.addFrame(rgbaUint8ClampedArray, delayMs); …
  //   const bytes = enc.finish(); // Uint8Array starting "GIF89a"
  function createEncoder(options) {
    const rawWidth = Number(options && options.width);
    const rawHeight = Number(options && options.height);
    if (!Number.isFinite(rawWidth) || !Number.isFinite(rawHeight) || rawWidth < 1 || rawHeight < 1) {
      throw new Error("GIF encoder needs a width and height.");
    }
    const width = Math.floor(rawWidth);
    const height = Math.floor(rawHeight);
    const loop = options && Number.isFinite(options.loop) ? Math.max(0, options.loop) : 0;

    const out = []; // plain byte array; assembled into Uint8Array at finish()
    let palette = null;
    let mapColor = null;
    let frames = 0;
    let finished = false;

    const push16 = (value) => { out.push(value & 0xff, (value >> 8) & 0xff); };

    function writeHeader() {
      // "GIF89a"
      out.push(0x47, 0x49, 0x46, 0x38, 0x39, 0x61);
      push16(width); push16(height);
      // Global color table flag + 8 bits/channel + table size exponent.
      const sizeExp = Math.round(Math.log2(palette.tableSize)) - 1;
      out.push(0x80 | 0x70 | sizeExp, 0x00, 0x00);
      for (const byte of palette.table) out.push(byte);
      // NETSCAPE2.0 application extension: animation loop count.
      out.push(0x21, 0xff, 0x0b);
      for (const ch of "NETSCAPE2.0") out.push(ch.charCodeAt(0));
      out.push(0x03, 0x01); push16(loop); out.push(0x00);
    }

    function addFrame(rgba, delayMs) {
      if (finished) throw new Error("GIF encoder already finished.");
      if (!rgba || rgba.length < width * height * 4) throw new Error("GIF frame buffer is too small.");
      if (!palette) {
        palette = buildPalette(rgba);
        mapColor = makeColorMapper(palette);
        writeHeader();
      }
      // Graphic control extension: delay in centiseconds, no transparency.
      const delayCs = Math.max(2, Math.round((Number(delayMs) || 100) / 10));
      out.push(0x21, 0xf9, 0x04, 0x04 /* disposal=1 (leave) */); push16(delayCs); out.push(0x00, 0x00);
      // Image descriptor: full frame, global palette.
      out.push(0x2c); push16(0); push16(0); push16(width); push16(height); out.push(0x00);
      // Map RGBA → palette indices, then LZW-compress.
      const totalPixels = width * height;
      const indices = new Uint8Array(totalPixels);
      for (let p = 0, i = 0; p < totalPixels; p++, i += 4) {
        indices[p] = mapColor(rgba[i], rgba[i + 1], rgba[i + 2]);
      }
      out.push(0x08); // LZW min code size (256-color palette)
      lzwEncode(indices, 8, out);
      frames++;
    }

    function finish() {
      if (finished) throw new Error("GIF encoder already finished.");
      if (!frames) throw new Error("Cannot build a GIF with no frames.");
      finished = true;
      out.push(0x3b); // trailer
      return Uint8Array.from(out);
    }

    return { addFrame, finish, get frameCount() { return frames; } };
  }

  // One-shot convenience used by tests and small callers.
  function encodeGif(input) {
    const enc = createEncoder(input);
    for (const frame of input.frames || []) enc.addFrame(frame.data, frame.delayMs);
    return enc.finish();
  }

  return { createEncoder, encodeGif };
});
