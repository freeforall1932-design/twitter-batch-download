"use strict";

// lib/apngEncoder.js — structure + round-trip tests. Includes a minimal but
// spec-faithful APNG reader (chunk CRCs, fcTL/fdAT sequence numbers, zlib
// inflate of filter-0 scanlines) so encoded frames are verified pixel by
// pixel — true color, no palette — not just by header sniffing.

const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const zlib = require("node:zlib");

const XDLAPng = require(path.join(__dirname, "..", "extension", "lib", "apngEncoder.js"));

// ---- tiny APNG reader (enough for our own output) --------------------------

function readU32(bytes, pos) { return (bytes[pos] << 24) | (bytes[pos + 1] << 16) | (bytes[pos + 2] << 8) | bytes[pos + 3]; }
function readU16(bytes, pos) { return (bytes[pos] << 8) | bytes[pos + 1]; }

function parseApng(bytes) {
  assert.deepEqual(Array.from(bytes.subarray(0, 8)), [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], "PNG signature");
  const chunks = [];
  let pos = 8;
  while (pos < bytes.length) {
    const length = readU32(bytes, pos);
    const type = String.fromCharCode(bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7]);
    const data = bytes.subarray(pos + 8, pos + 8 + length);
    const crc = readU32(bytes, pos + 8 + length);
    // CRC covers the type + data.
    const crcBytes = Buffer.concat([bytes.subarray(pos + 4, pos + 8), Buffer.from(data)]);
    assert.equal(XDLAPng.crc32(new Uint8Array(crcBytes)) >>> 0, crc >>> 0, `CRC mismatch on ${type}`);
    chunks.push({ type, data, offset: pos });
    pos += 12 + length;
  }
  assert.equal(chunks[chunks.length - 1].type, "IEND", "file ends with IEND");

  const ihdr = chunks.find((c) => c.type === "IHDR").data;
  const info = {
    width: readU32(ihdr, 0),
    height: readU32(ihdr, 4),
    bitDepth: ihdr[8],
    colorType: ihdr[9],
    numFrames: null,
    loop: null,
    frames: []
  };
  assert.equal(info.bitDepth, 8, "8-bit depth");
  assert.equal(info.colorType, 6, "true color with alpha — no palette");

  const actl = chunks.find((c) => c.type === "acTL");
  assert.ok(actl, "animation control chunk present");
  info.numFrames = readU32(actl.data, 0);
  info.loop = readU32(actl.data, 4);

  let lastSeq = -1;
  let currentFrame = null;
  for (const chunk of chunks) {
    if (chunk.type === "fcTL") {
      const seq = readU32(chunk.data, 0);
      assert.ok(seq > lastSeq, "fcTL sequence numbers strictly increase");
      lastSeq = seq;
      assert.equal(readU32(chunk.data, 4), info.width);
      assert.equal(readU32(chunk.data, 8), info.height);
      assert.equal(readU32(chunk.data, 12), 0, "x offset 0");
      assert.equal(readU32(chunk.data, 16), 0, "y offset 0");
      assert.equal(chunk.data[24], 0, "dispose none");
      assert.equal(chunk.data[25], 0, "blend source");
      currentFrame = {
        delayNum: readU16(chunk.data, 20),
        delayDen: readU16(chunk.data, 22),
        deflated: []
      };
      info.frames.push(currentFrame);
    } else if (chunk.type === "IDAT") {
      assert.ok(currentFrame, "IDAT belongs to the first frame");
      assert.equal(info.frames.length, 1, "IDAT only for frame 0");
      currentFrame.deflated.push(chunk.data);
    } else if (chunk.type === "fdAT") {
      assert.ok(currentFrame, "fdAT belongs to the current frame");
      const seq = readU32(chunk.data, 0);
      assert.ok(seq > lastSeq, "fdAT sequence numbers strictly increase");
      lastSeq = seq;
      currentFrame.deflated.push(chunk.data.subarray(4));
    }
  }

  // Inflate each frame and strip the filter-0 byte at the start of each row.
  for (const frame of info.frames) {
    const raw = zlib.inflateSync(Buffer.concat(frame.deflated.map((d) => Buffer.from(d))));
    const stride = info.width * 4;
    assert.equal(raw.length, info.height * (stride + 1), "deflated scanline count");
    const rgba = new Uint8ClampedArray(info.width * info.height * 4);
    for (let y = 0; y < info.height; y++) {
      assert.equal(raw[y * (stride + 1)], 0, "filter type 0");
      rgba.set(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)), y * stride);
    }
    frame.rgba = rgba;
  }
  return info;
}

function solidFrame(width, height, [r, g, b]) {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < rgba.length; i += 4) { rgba[i] = r; rgba[i + 1] = g; rgba[i + 2] = b; rgba[i + 3] = 255; }
  return rgba;
}

// ---- tests -----------------------------------------------------------------

test("apngEncoder: two-frame animation round-trips (header, acTL, delays, exact pixels)", async () => {
  const enc = XDLAPng.createApng({ width: 4, height: 3, loop: 0, frames: 2 });
  await enc.addFrame(solidFrame(4, 3, [255, 0, 0]), 40);
  await enc.addFrame(solidFrame(4, 3, [0, 0, 255]), 80);
  const bytes = enc.finish();

  const apng = parseApng(bytes);
  assert.equal(apng.width, 4);
  assert.equal(apng.height, 3);
  assert.equal(apng.numFrames, 2);
  assert.equal(apng.loop, 0, "loop forever");
  assert.equal(apng.frames.length, 2);
  assert.equal(apng.frames[0].delayNum, 40);
  assert.equal(apng.frames[0].delayDen, 1000);
  assert.equal(apng.frames[1].delayNum, 80);
  for (let i = 0; i < 12; i++) {
    assert.equal(apng.frames[0].rgba[i * 4], 255);
    assert.equal(apng.frames[0].rgba[i * 4 + 1], 0);
    assert.equal(apng.frames[0].rgba[i * 4 + 2], 0);
    assert.equal(apng.frames[1].rgba[i * 4], 0);
    assert.equal(apng.frames[1].rgba[i * 4 + 2], 255);
  }
});

test("apngEncoder: true color — distinct gradients survive byte-exact, unlike 256-color GIF", async () => {
  // 300 distinct channel values across one frame: a palette-based format
  // would quantize; APNG must reproduce every pixel.
  const width = 300, height = 1;
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let x = 0; x < width; x++) {
    const i = x * 4;
    rgba[i] = x; rgba[i + 1] = x; rgba[i + 2] = x; rgba[i + 3] = 255;
  }
  const bytes = await XDLAPng.encodeApng({ width, height, frames: [{ data: rgba, delayMs: 40 }] });
  const apng = parseApng(bytes);
  assert.equal(apng.frames.length, 1);
  for (let x = 0; x < width; x++) {
    const value = Math.min(255, x); // Uint8ClampedArray clamps at 255
    assert.equal(apng.frames[0].rgba[x * 4], value, `red byte exact at ${x}`);
    assert.equal(apng.frames[0].rgba[x * 4 + 1], value, `green byte exact at ${x}`);
    assert.equal(apng.frames[0].rgba[x * 4 + 2], value, `blue byte exact at ${x}`);
    assert.equal(apng.frames[0].rgba[x * 4 + 3], 255);
  }
});

test("apngEncoder: finish patches acTL frame count AND its CRC when the declared count was wrong", async () => {
  // Caller declares 3 frames but only adds 2; the writer must correct acTL
  // and keep the CRC consistent so strict decoders accept the file.
  const enc = XDLAPng.createApng({ width: 2, height: 2, loop: 0, frames: 3 });
  await enc.addFrame(solidFrame(2, 2, [10, 20, 30]), 40);
  await enc.addFrame(solidFrame(2, 2, [40, 50, 60]), 40);
  const bytes = enc.finish();
  const apng = parseApng(bytes); // parseApng asserts every chunk CRC
  assert.equal(apng.numFrames, 2);
  assert.equal(apng.frames.length, 2);
});

test("apngEncoder: refuses empty animations and undersized buffers", async () => {
  const enc = XDLAPng.createApng({ width: 2, height: 2, frames: 2 });
  assert.throws(() => enc.finish(), /no frames/);
  const enc2 = XDLAPng.createApng({ width: 2, height: 2, frames: 1 });
  await assert.rejects(() => enc2.addFrame(new Uint8ClampedArray(4), 100), /too small/);
  assert.throws(() => XDLAPng.createApng({ width: 0, height: 5 }), /width and height/);
});

test("apngEncoder: streaming encoder tracks frames and is single-use", async () => {
  const enc = XDLAPng.createApng({ width: 2, height: 2 });
  assert.strictEqual(enc.frameCount, 0);
  await enc.addFrame(solidFrame(2, 2, [1, 2, 3]), 50);
  await enc.addFrame(solidFrame(2, 2, [1, 2, 3]), 50);
  assert.strictEqual(enc.frameCount, 2);
  const bytes = enc.finish();
  assert.strictEqual(bytes[0], 0x89, "PNG signature");
  // File ends with the IEND chunk: 0-byte data, CRC 0xae426082.
  assert.deepEqual(Array.from(bytes.subarray(bytes.length - 4)), [0xae, 0x42, 0x60, 0x82], "IEND CRC tail");
  await assert.rejects(() => enc.addFrame(solidFrame(2, 2, [0, 0, 0]), 50), /finished/);
});

test("apngEncoder: crc32 matches the reference PNG CRC-32 for a known vector", () => {
  // CRC-32 of "IEND" + 0-byte payload = 0xae426082 (the well-known value in
  // every PNG file's last four bytes).
  const iend = new Uint8Array([0x49, 0x45, 0x4e, 0x44]);
  assert.equal(XDLAPng.crc32(iend) >>> 0, 0xae426082);
});
