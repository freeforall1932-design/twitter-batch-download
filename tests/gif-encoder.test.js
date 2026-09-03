"use strict";

// lib/gifEncoder.js — structure + round-trip tests. Includes a minimal but
// spec-faithful GIF LZW decoder so the encoded frames are verified pixel by
// pixel, not just by header sniffing.

const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");

const XDLGif = require(path.join(__dirname, "..", "extension", "lib", "gifEncoder.js"));

// ---- tiny GIF reader (enough for our own output) ---------------------------

function parseGif(bytes) {
  assert.strictEqual(String.fromCharCode(...bytes.subarray(0, 6)), "GIF89a");
  const width = bytes[6] | (bytes[7] << 8);
  const height = bytes[8] | (bytes[9] << 8);
  const packed = bytes[10];
  assert.ok(packed & 0x80, "global color table flag must be set");
  const tableSize = 2 << (packed & 0x07);
  let pos = 13;
  const palette = [];
  for (let i = 0; i < tableSize; i++, pos += 3) {
    palette.push([bytes[pos], bytes[pos + 1], bytes[pos + 2]]);
  }
  const frames = [];
  let loop = null;
  while (pos < bytes.length) {
    const block = bytes[pos++];
    if (block === 0x3b) return { width, height, palette, frames, loop, trailerAt: pos - 1 };
    if (block === 0x21) { // extension
      const label = bytes[pos++];
      if (label === 0xff) {
        const size = bytes[pos++];
        const app = String.fromCharCode(...bytes.subarray(pos, pos + size));
        pos += size;
        const chunks = [];
        while (bytes[pos] !== 0) { const n = bytes[pos++]; chunks.push(bytes.subarray(pos, pos + n)); pos += n; }
        pos++;
        if (app === "NETSCAPE2.0") loop = chunks[0][1] | (chunks[0][2] << 8);
      } else {
        let delay = null;
        while (bytes[pos] !== 0) {
          const n = bytes[pos++];
          if (label === 0xf9) delay = bytes[pos + 1] | (bytes[pos + 2] << 8);
          pos += n;
        }
        pos++;
        if (label === 0xf9) frames.push({ delayCs: delay }); // filled below by 0x2c
      }
      continue;
    }
    if (block === 0x2c) { // image descriptor
      const w = bytes[pos + 4] | (bytes[pos + 5] << 8);
      const h = bytes[pos + 6] | (bytes[pos + 7] << 8);
      assert.strictEqual(bytes[pos + 8] & 0x80, 0, "frames must use the global palette");
      pos += 9;
      const minCodeSize = bytes[pos++];
      const data = [];
      while (bytes[pos] !== 0) { const n = bytes[pos++]; for (let i = 0; i < n; i++) data.push(bytes[pos + i]); pos += n; }
      pos++;
      const frame = frames[frames.length - 1] || {};
      frame.width = w; frame.height = h;
      frame.indices = lzwDecode(Uint8Array.from(data), minCodeSize, w * h);
      if (!frames.includes(frame)) frames.push(frame);
      continue;
    }
    assert.fail(`unexpected block 0x${block.toString(16)} at ${pos - 1}`);
  }
  assert.fail("missing GIF trailer");
}

function lzwDecode(data, minCodeSize, pixelCount) {
  const clearCode = 1 << minCodeSize;
  const eoiCode = clearCode + 1;
  let codeSize = minCodeSize + 1;
  let dict = [];
  const resetDict = () => {
    dict = [];
    for (let i = 0; i < clearCode; i++) dict.push([i]);
    dict.push(null, null); // clear + eoi
    codeSize = minCodeSize + 1;
  };
  resetDict();
  const out = [];
  let bitPos = 0;
  const readCode = () => {
    let code = 0;
    for (let i = 0; i < codeSize; i++) {
      const byte = data[bitPos >> 3];
      code |= ((byte >> (bitPos & 7)) & 1) << i;
      bitPos++;
    }
    return code;
  };
  let prev = null;
  while (out.length < pixelCount) {
    const code = readCode();
    if (code === clearCode) { resetDict(); prev = null; continue; }
    if (code === eoiCode) break;
    let entry;
    if (code < dict.length && dict[code]) entry = dict[code];
    else if (code === dict.length && prev) entry = prev.concat(prev[0]);
    else assert.fail(`bad LZW code ${code} (dict ${dict.length})`);
    out.push(...entry);
    if (prev) {
      dict.push(prev.concat(entry[0]));
      if (dict.length === 1 << codeSize && codeSize < 12) codeSize++;
    }
    prev = entry;
  }
  return out;
}

function solidFrame(width, height, [r, g, b]) {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < rgba.length; i += 4) { rgba[i] = r; rgba[i + 1] = g; rgba[i + 2] = b; rgba[i + 3] = 255; }
  return rgba;
}

// Parser for LOCAL-palette output (per-frame color tables + dithering).
// The balanced-mode parser above asserts a global table and refuses LCT
// frames, so max-quality frames get their own reader here.
function parseGifLocal(bytes) {
  assert.strictEqual(String.fromCharCode(...bytes.subarray(0, 6)), "GIF89a");
  const width = bytes[6] | (bytes[7] << 8);
  const height = bytes[8] | (bytes[9] << 8);
  const packed = bytes[10];
  assert.strictEqual(packed & 0x80, 0, "local mode must not write a global color table");
  let pos = 13;
  const frames = [];
  let loop = null;
  while (pos < bytes.length) {
    const block = bytes[pos++];
    if (block === 0x3b) return { width, height, frames, loop, trailerAt: pos - 1 };
    if (block === 0x21) {
      const label = bytes[pos++];
      if (label === 0xff) {
        const size = bytes[pos++];
        const app = String.fromCharCode(...bytes.subarray(pos, pos + size));
        pos += size;
        const chunks = [];
        while (bytes[pos] !== 0) { const n = bytes[pos++]; chunks.push(bytes.subarray(pos, pos + n)); pos += n; }
        pos++;
        if (app === "NETSCAPE2.0") loop = chunks[0][1] | (chunks[0][2] << 8);
      } else {
        let delay = null;
        while (bytes[pos] !== 0) {
          const n = bytes[pos++];
          if (label === 0xf9) delay = bytes[pos + 1] | (bytes[pos + 2] << 8);
          pos += n;
        }
        pos++;
        if (label === 0xf9) frames.push({ delayCs: delay });
      }
      continue;
    }
    if (block === 0x2c) {
      const w = bytes[pos + 4] | (bytes[pos + 5] << 8);
      const h = bytes[pos + 6] | (bytes[pos + 7] << 8);
      const descPacked = bytes[pos + 8];
      assert.strictEqual(descPacked & 0x80, 0x80, "local mode frames must set the LCT flag");
      const tableSize = 2 << (descPacked & 0x07);
      pos += 9;
      const palette = [];
      for (let i = 0; i < tableSize; i++, pos += 3) {
        palette.push([bytes[pos], bytes[pos + 1], bytes[pos + 2]]);
      }
      const minCodeSize = bytes[pos++];
      const data = [];
      while (bytes[pos] !== 0) { const n = bytes[pos++]; for (let i = 0; i < n; i++) data.push(bytes[pos + i]); pos += n; }
      pos++;
      const frame = frames[frames.length - 1] || {};
      frame.width = w; frame.height = h;
      frame.palette = palette;
      frame.indices = lzwDecode(Uint8Array.from(data), minCodeSize, w * h);
      if (!frames.includes(frame)) frames.push(frame);
      continue;
    }
    assert.fail(`unexpected block 0x${block.toString(16)} at ${pos - 1}`);
  }
  assert.fail("missing GIF trailer");
}

// ---- tests -----------------------------------------------------------------

test("gifEncoder: two-frame animation round-trips (header, loop, delays, pixels)", () => {
  const enc = XDLGif.createEncoder({ width: 4, height: 3, loop: 0 });
  enc.addFrame(solidFrame(4, 3, [255, 0, 0]), 100);
  enc.addFrame(solidFrame(4, 3, [255, 0, 0]), 250);
  const bytes = enc.finish();

  const gif = parseGif(bytes);
  assert.strictEqual(gif.width, 4);
  assert.strictEqual(gif.height, 3);
  assert.strictEqual(gif.loop, 0, "NETSCAPE loop-forever extension present");
  assert.strictEqual(gif.frames.length, 2);
  assert.strictEqual(gif.frames[0].delayCs, 10);
  assert.strictEqual(gif.frames[1].delayCs, 25);
  for (const frame of gif.frames) {
    assert.strictEqual(frame.indices.length, 12);
    for (const index of frame.indices) {
      const [r, g, b] = gif.palette[index];
      assert.ok(Math.abs(r - 255) <= 8 && g <= 8 && b <= 8, `pixel maps to red, got rgb(${r},${g},${b})`);
    }
  }
});

test("gifEncoder: multi-color frame keeps distinct colors distinct", () => {
  // Left half green, right half blue — the palette must keep both.
  const width = 8, height = 8;
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (x < width / 2) { rgba[i + 1] = 200; } else { rgba[i + 2] = 200; }
      rgba[i + 3] = 255;
    }
  }
  const bytes = XDLGif.encodeGif({ width, height, frames: [{ data: rgba, delayMs: 80 }] });
  const gif = parseGif(bytes);
  const first = gif.palette[gif.frames[0].indices[0]];
  const last = gif.palette[gif.frames[0].indices[width - 1]];
  assert.ok(first[1] > 150 && first[2] < 50, "left pixel decodes green");
  assert.ok(last[2] > 150 && last[1] < 50, "right pixel decodes blue");
});

test("gifEncoder: noisy frame exercises LZW code-width growth without corruption", () => {
  // Deterministic pseudo-random pixels force the dictionary past the 9- and
  // 10-bit boundaries; the decoder must still reproduce every index.
  const width = 64, height = 64;
  const rgba = new Uint8ClampedArray(width * height * 4);
  let seed = 42;
  const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % 256; };
  for (let i = 0; i < rgba.length; i += 4) { rgba[i] = rand(); rgba[i + 1] = rand(); rgba[i + 2] = rand(); rgba[i + 3] = 255; }
  const bytes = XDLGif.encodeGif({ width, height, frames: [{ data: rgba, delayMs: 100 }] });
  const gif = parseGif(bytes);
  assert.strictEqual(gif.frames[0].indices.length, width * height);
  assert.ok(gif.frames[0].indices.every((i) => i >= 0 && i < gif.palette.length));
});

test("gifEncoder: refuses empty animations and undersized buffers", () => {
  const enc = XDLGif.createEncoder({ width: 2, height: 2 });
  assert.throws(() => enc.finish(), /no frames/);
  const enc2 = XDLGif.createEncoder({ width: 2, height: 2 });
  assert.throws(() => enc2.addFrame(new Uint8ClampedArray(4), 100), /too small/);
  assert.throws(() => XDLGif.createEncoder({ width: 0, height: 5 }), /width and height/);
});

test("gifEncoder: streaming encoder frees callers from accumulating RGBA (frameCount tracks)", () => {
  const enc = XDLGif.createEncoder({ width: 2, height: 2 });
  assert.strictEqual(enc.frameCount, 0);
  enc.addFrame(solidFrame(2, 2, [1, 2, 3]), 50);
  enc.addFrame(solidFrame(2, 2, [1, 2, 3]), 50);
  assert.strictEqual(enc.frameCount, 2);
  const bytes = enc.finish();
  assert.strictEqual(bytes[bytes.length - 1], 0x3b, "trailer byte");
  assert.throws(() => enc.addFrame(solidFrame(2, 2, [0, 0, 0]), 50), /finished/);
});

// ---- v3.14 maximum-quality mode (local palettes + Floyd–Steinberg) ---------

function gradientFrame(width, height) {
  // Diagonal RGB gradient with more distinct colors than 256, so palette
  // quantization actually has work to do (the case dithering targets).
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      rgba[i] = Math.round(255 * x / (width - 1));
      rgba[i + 1] = Math.round(255 * y / (height - 1));
      rgba[i + 2] = Math.round(255 * (x + y) / (width + height - 2));
      rgba[i + 3] = 255;
    }
  }
  return rgba;
}

test("gifEncoder max quality: local mode writes per-frame color tables, not a global one", () => {
  const enc = XDLGif.createEncoder({ width: 8, height: 8, loop: 0, palette: "local", dither: true });
  enc.addFrame(solidFrame(8, 8, [255, 0, 0]), 100);
  enc.addFrame(solidFrame(8, 8, [0, 0, 255]), 100);
  const bytes = enc.finish();

  const gif = parseGifLocal(bytes);
  assert.strictEqual(gif.width, 8);
  assert.strictEqual(gif.height, 8);
  assert.strictEqual(gif.loop, 0, "NETSCAPE loop-forever extension still present");
  assert.strictEqual(gif.frames.length, 2);
  assert.strictEqual(gif.frames[0].delayCs, 10);
  // Each frame carries its OWN table; solid red vs solid blue must differ.
  const red = gif.frames[0].palette[gif.frames[0].indices[0]];
  const blue = gif.frames[1].palette[gif.frames[1].indices[0]];
  assert.ok(red[0] > 200 && red[1] < 40 && red[2] < 40, "frame 0 palette decodes red");
  assert.ok(blue[2] > 200 && blue[0] < 40 && blue[1] < 40, "frame 1 palette decodes blue");
  assert.notDeepEqual(gif.frames[0].palette, gif.frames[1].palette, "per-frame tables are distinct");
});

test("gifEncoder max quality: dithering produces a different pattern but every index stays valid", () => {
  const width = 64, height = 64;
  const data = gradientFrame(width, height);
  const balanced = XDLGif.encodeGif({ width, height, frames: [{ data, delayMs: 40 }] });
  const dithered = XDLGif.encodeGif({ width, height, frames: [{ data, delayMs: 40 }], palette: "local", dither: true });
  assert.notDeepEqual(Array.from(balanced), Array.from(dithered), "dither mode must change the encoded pattern");

  const gif = parseGifLocal(dithered);
  assert.strictEqual(gif.frames.length, 1);
  assert.strictEqual(gif.frames[0].indices.length, width * height);
  assert.ok(gif.frames[0].indices.every((i) => i >= 0 && i < gif.frames[0].palette.length), "all indices map");
  // A gradient must keep multiple palette entries alive — dithering must not
  // collapse the frame into one flat color.
  const used = new Set(gif.frames[0].indices);
  assert.ok(used.size > 16, `gradient uses ${used.size} distinct palette entries`);
  // The dither pattern must actually mix entries: a real gradient frame output
  // is never a single repeated index per row (that would be plain mapping).
  const row = gif.frames[0].indices.slice(0, width);
  assert.ok(new Set(row).size > 1, "dithering mixes palette entries inside a row");
});

test("gifEncoder max quality: noisy frame with dither exercises LZW code-width growth", () => {
  const width = 64, height = 64;
  const rgba = new Uint8ClampedArray(width * height * 4);
  let seed = 7;
  const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % 256; };
  for (let i = 0; i < rgba.length; i += 4) { rgba[i] = rand(); rgba[i + 1] = rand(); rgba[i + 2] = rand(); rgba[i + 3] = 255; }
  const bytes = XDLGif.encodeGif({ width, height, frames: [{ data: rgba, delayMs: 40 }], palette: "local", dither: true });
  const gif = parseGifLocal(bytes);
  assert.strictEqual(gif.frames[0].indices.length, width * height);
  assert.ok(gif.frames[0].indices.every((i) => i >= 0 && i < gif.frames[0].palette.length));
});

test("gifEncoder max quality: a solid frame stays exact under dithering (no error to diffuse)", () => {
  const bytes = XDLGif.encodeGif({ width: 16, height: 16, frames: [{ data: solidFrame(16, 16, [12, 34, 56]), delayMs: 40 }], palette: "local", dither: true });
  const gif = parseGifLocal(bytes);
  const code = gif.frames[0].palette[gif.frames[0].indices[0]];
  for (const index of gif.frames[0].indices) {
    assert.strictEqual(index, gif.frames[0].indices[0], "uniform frame maps to one palette entry");
  }
  assert.ok(Math.abs(code[0] - 12) <= 4 && Math.abs(code[1] - 34) <= 4 && Math.abs(code[2] - 56) <= 4, `solid color preserved, got rgb(${code})`);
});
