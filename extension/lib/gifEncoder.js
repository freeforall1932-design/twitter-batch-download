// ==========================================================================
// lib/gifEncoder.js — dependency-free GIF89a encoder (v3.6).
//
// X serves "GIFs" (animated_gif media) as silent MP4 clips; this encoder is
// the second half of the "GIF stays a GIF" pipeline: the offscreen document
// decodes the MP4 frame-by-frame onto a canvas (offscreen.js) and feeds the
// RGBA frames here, producing a real animated .gif file.
//
// Two quality modes (v3.14):
//   balanced (default) — one GLOBAL 256-color palette from the first frame,
//     nearest-color mapping, no dithering. Small files; can band on
//     color-shifting scenes.
//   max quality         — palette:"local", dither:true: each frame gets its
//     OWN 256-color table (from that frame's pixels) + Floyd–Steinberg error
//     diffusion, plus a 5-bit/channel lookup table so the dithering pass
//     stays O(pixels). Much closer to the MP4 source; files are much larger.
//
// Design (memory-conscious — frames are compressed as they arrive, RGBA
// buffers are never accumulated):
//   - Median-cut palette (256 colors, sampled) per frame or global.
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

  // 5-bit/channel lookup table → nearest palette index, built once per frame.
  // This is what makes the per-pixel dithering pass O(1) (32768 entries × ≤256
  // colors ≈ 8M distance checks, ~10 ms) instead of O(pixels × palette).
  function makeLut(palette) {
    const { table, colorCount } = palette;
    const lut = new Uint8Array(32 * 32 * 32);
    for (let r5 = 0; r5 < 32; r5++) {
      for (let g5 = 0; g5 < 32; g5++) {
        for (let b5 = 0; b5 < 32; b5++) {
          const r = Math.min(255, r5 * 8 + 4);
          const g = Math.min(255, g5 * 8 + 4);
          const b = Math.min(255, b5 * 8 + 4);
          let best = 0, bestDist = Infinity;
          for (let i = 0; i < colorCount; i++) {
            const dr = r - table[i * 3];
            const dg = g - table[i * 3 + 1];
            const db = b - table[i * 3 + 2];
            const dist = dr * dr + dg * dg + db * db;
            if (dist < bestDist) { bestDist = dist; best = i; }
          }
          lut[(r5 << 10) | (g5 << 5) | b5] = best;
        }
      }
    }
    return lut;
  }

  // Floyd–Steinberg error diffusion over the lookup table. Only two error
  // rows are alive (current + next) so RAM stays O(width), and errors are
  // distributed 7/16 right, 3/16 down-left, 5/16 down, 1/16 down-right.
  function mapRgbaWithDither(rgba, palette, width, height) {
    const lut = makeLut(palette);
    const { table, colorCount } = palette;
    if (colorCount === 0) throw new Error("Palette is empty.");
    const indices = new Uint8Array(width * height);
    let curErr = new Float32Array(width * 3);
    let nextErr = new Float32Array(width * 3);
    const clamp255 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);

    for (let y = 0; y < height; y++) {
      const rowStart = y * width;
      for (let x = 0; x < width; x++) {
        const src = (rowStart + x) << 2;
        const e = x * 3;
        const r0 = rgba[src];
        const g0 = rgba[src + 1];
        const b0 = rgba[src + 2];
        const r = clamp255(Math.round(r0 + curErr[e]));
        const g = clamp255(Math.round(g0 + curErr[e + 1]));
        const b = clamp255(Math.round(b0 + curErr[e + 2]));
        const idx = lut[((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3)];
        indices[rowStart + x] = idx;
        const er = r0 - table[idx * 3];
        const eg = g0 - table[idx * 3 + 1];
        const eb = b0 - table[idx * 3 + 2];
        if (x + 1 < width) {
          curErr[e + 3] += er * (7 / 16);
          curErr[e + 4] += eg * (7 / 16);
          curErr[e + 5] += eb * (7 / 16);
        }
        if (y + 1 < height) {
          if (x > 0) {
            nextErr[e - 3] += er * (3 / 16);
            nextErr[e - 2] += eg * (3 / 16);
            nextErr[e - 1] += eb * (3 / 16);
          }
          nextErr[e] += er * (5 / 16);
          nextErr[e + 1] += eg * (5 / 16);
          nextErr[e + 2] += eb * (5 / 16);
          if (x + 1 < width) {
            nextErr[e + 3] += er * (1 / 16);
            nextErr[e + 4] += eg * (1 / 16);
            nextErr[e + 5] += eb * (1 / 16);
          }
        }
      }
      const tmp = curErr;
      curErr = nextErr;    // errors accumulated for this new row become current
      nextErr = tmp;       // recycle the old buffer as the next row's accumulator
      nextErr.fill(0);
    }
    return indices;
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

  // Streaming encoder. Every addFrame() compresses and discards its RGBA
  // input immediately.
  //   Balanced   → createEncoder({ width, height, loop: 0 })
  //   Max quality→ createEncoder({ width, height, loop: 0, palette: "local", dither: true })
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
    const localPalette = !!(options && options.palette === "local");
    const dither = !!(options && options.dither);

    const out = []; // plain byte array; assembled into Uint8Array at finish()
    let headerWritten = false;
    let palette = null;
    let mapColor = null;
    let frames = 0;
    let finished = false;

    const push16 = (value) => { out.push(value & 0xff, (value >> 8) & 0xff); };

    function writeHeader() {
      // "GIF89a"
      out.push(0x47, 0x49, 0x46, 0x38, 0x39, 0x61);
      push16(width); push16(height);
      if (localPalette) {
        // No global table — every frame carries its own local color table.
        out.push(0x00, 0x00, 0x00);
      } else {
        // Global color table flag + 8 bits/channel + table size exponent.
        const sizeExp = Math.round(Math.log2(palette.tableSize)) - 1;
        out.push(0x80 | 0x70 | sizeExp, 0x00, 0x00);
        for (const byte of palette.table) out.push(byte);
      }
      // NETSCAPE2.0 application extension: animation loop count.
      out.push(0x21, 0xff, 0x0b);
      for (const ch of "NETSCAPE2.0") out.push(ch.charCodeAt(0));
      out.push(0x03, 0x01); push16(loop); out.push(0x00);
    }

    function addFrame(rgba, delayMs) {
      if (finished) throw new Error("GIF encoder already finished.");
      if (!rgba || rgba.length < width * height * 4) throw new Error("GIF frame buffer is too small.");
      if (!headerWritten) {
        // Balanced mode keeps ONE global palette (built from the first
        // frame); local mode keeps palette null and builds a table per
        // frame. Either way the GIF header is written exactly once — the
        // old `if (!palette)` guard re-wrote the header on every frame in
        // local mode, producing a corrupt multi-header file.
        palette = localPalette ? null : buildPalette(rgba);
        mapColor = localPalette ? null : makeColorMapper(palette);
        writeHeader();
        headerWritten = true;
      }
      // Local-palette mode: build THIS frame's table from this frame's pixels.
      const framePalette = localPalette ? buildPalette(rgba) : palette;
      // Graphic control extension: delay in centiseconds, no transparency.
      const delayCs = Math.max(2, Math.round((Number(delayMs) || 100) / 10));
      out.push(0x21, 0xf9, 0x04, 0x04 /* disposal=1 (leave) */); push16(delayCs); out.push(0x00, 0x00);
      // Image descriptor: full frame. Local mode sets the LCT flag and writes
      // the frame's own table above the LZW data; balanced mode uses the
      // single global table (LCT flag 0).
      let descriptorPacked = 0x00;
      if (localPalette) {
        const sizeExp = Math.round(Math.log2(framePalette.tableSize)) - 1;
        descriptorPacked = 0x80 | sizeExp;
      }
      out.push(0x2c); push16(0); push16(0); push16(width); push16(height); out.push(descriptorPacked);
      if (localPalette) {
        for (const byte of framePalette.table) out.push(byte);
      }
      // Map RGBA → palette indices, then LZW-compress.
      const totalPixels = width * height;
      const indices = dither
        ? mapRgbaWithDither(rgba, framePalette, width, height)
        : (() => {
            const mapper = localPalette ? makeColorMapper(framePalette) : mapColor;
            const ids = new Uint8Array(totalPixels);
            for (let p = 0, i = 0; p < totalPixels; p++, i += 4) {
              ids[p] = mapper(rgba[i], rgba[i + 1], rgba[i + 2]);
            }
            return ids;
          })();
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
