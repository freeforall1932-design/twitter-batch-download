"use strict";

// lib/webpEncoder.js — animated WebP container tests.
//
// The encoder does not write VP8/VP8L bitstreams (the browser's native encoder
// does that per frame via canvas.toBlob); it re-wraps static WebP key frames
// into the WebP Extended + Animation container. These tests therefore pin the
// container structure exactly — RIFF/VP8X/ANIM/ANMF layout, feature flags,
// 24-bit fields, durations, padding, alpha propagation — using BOTH fabricated
// frames (pure structure) and one REAL static WebP produced by a reference
// encoder (Pillow, 72 bytes, embedded as base64) so a genuine VP8 bitstream is
// also exercised. tests/webp-encoder.test.js cross-checks the output against
// a reference animated-WebP decoder when one is available (scripts only).

const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");

const XDLWebp = require(path.join(__dirname, "..", "extension", "lib", "webpEncoder.js"));

// Real 8x8 lossy static WebP from Pillow (quality 90): RIFF+VP8 only.
const REAL_STATIC_WEBP_B64 =
  "UklGRkAAAABXRUJQVlA4IDQAAAAwAgCdASoIAAgAAMASJaACdLoB+AH4AARoAAD++iGX/3easNN39a3/9aOfron+tHP/WVgA";

function realWebp() {
  return Uint8Array.from(Buffer.from(REAL_STATIC_WEBP_B64, "base64"));
}

// Fabricated static WebP around a fake-but-header-valid VP8 keyframe.
function fakeStaticWebp(width, height, { alpha = null, variant = "vp8", payloadSuffix = [0xde, 0xad] } = {}) {
  const chunks = [];
  if (alpha !== null) chunks.push({ type: "ALPH", data: alpha });
  let payload;
  if (variant === "vp8") {
    // 3-byte frame tag, VP8 start code 9d 01 2a, 14-bit width/height, junk.
    payload = Uint8Array.from([
      0x10, 0x00, 0x00,
      0x9d, 0x01, 0x2a,
      width & 0xff, ((width >> 8) & 0x3f) | 0x40, // top bit exercises the 14-bit mask
      height & 0xff, ((height >> 8) & 0x3f) | 0x40,
      ...payloadSuffix
    ]);
  } else {
    // VP8L: 0x2f, then 14-bit width-1/height-1 packed over 4 bytes.
    const w1 = width - 1, h1 = height - 1;
    payload = Uint8Array.from([
      0x2f,
      w1 & 0xff, ((w1 >> 8) & 0x3f) | ((h1 & 0x03) << 6),
      (h1 >> 2) & 0xff, (h1 >> 10) & 0x0f,
      ...payloadSuffix
    ]);
  }
  chunks.push({ type: variant === "vp8" ? "VP8 " : "VP8L", data: payload });
  let body = [];
  for (const chunk of chunks) {
    body.push(...[chunk.type.charCodeAt(0), chunk.type.charCodeAt(1), chunk.type.charCodeAt(2), chunk.type.charCodeAt(3)]);
    const size = chunk.data.length;
    body.push(size & 0xff, (size >> 8) & 0xff, (size >> 16) & 0xff, (size >> 24) & 0xff);
    body.push(...chunk.data);
    if (size & 1) body.push(0);
  }
  const head = [0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50];
  const bytes = Uint8Array.from([...head, ...body]);
  new DataView(bytes.buffer).setUint32(4, bytes.length - 8, true);
  return bytes;
}

// ---- animated-WebP reader (enough for our own output) -----------------------

function ascii(bytes, pos) { return String.fromCharCode(bytes[pos], bytes[pos + 1], bytes[pos + 2], bytes[pos + 3]); }
function u32le(bytes, pos) { return (bytes[pos] | (bytes[pos + 1] << 8) | (bytes[pos + 2] << 16) | (bytes[pos + 3] << 24)) >>> 0; }
function u24le(bytes, pos) { return bytes[pos] | (bytes[pos + 1] << 8) | (bytes[pos + 2] << 16); }

function parseAnimatedWebp(bytes) {
  assert.strictEqual(ascii(bytes, 0), "RIFF");
  assert.strictEqual(u32le(bytes, 4), bytes.length - 8, "RIFF size field");
  assert.strictEqual(ascii(bytes, 8), "WEBP");
  const chunks = [];
  const frames = [];
  let pos = 12;
  while (pos + 8 <= bytes.length) {
    const type = ascii(bytes, pos);
    const size = u32le(bytes, pos + 4);
    const data = bytes.subarray(pos + 8, pos + 8 + size);
    if (size & 1) assert.strictEqual(bytes[pos + 8 + size], 0, "odd chunk padded with 0");
    chunks.push({ type, data });
    pos += 8 + size + (size & 1);
  }
  assert.strictEqual(pos, bytes.length, "no trailing bytes");

  const vp8x = chunks.find((c) => c.type === "VP8X");
  assert.ok(vp8x, "VP8X present");
  const anim = chunks.find((c) => c.type === "ANIM");
  assert.ok(anim, "ANIM present");
  for (const chunk of chunks) {
    if (chunk.type !== "ANMF") continue;
    assert.strictEqual(chunk.data.length >= 16, true, "ANMF header 16 bytes");
    const frame = {
      x: u24le(chunk.data, 0) * 2,
      y: u24le(chunk.data, 3) * 2,
      width: u24le(chunk.data, 6) + 1,
      height: u24le(chunk.data, 9) + 1,
      duration: u24le(chunk.data, 12),
      flags: chunk.data[15],
      subchunks: []
    };
    let sp = 16;
    while (sp + 8 <= chunk.data.length) {
      const st = ascii(chunk.data, sp);
      const ss = u32le(chunk.data, sp + 4);
      frame.subchunks.push({ type: st, data: chunk.data.subarray(sp + 8, sp + 8 + ss) });
      sp += 8 + ss + (ss & 1);
    }
    frames.push(frame);
  }
  return {
    chunks, frames,
    flags: vp8x.data[0],
    canvasWidth: u24le(vp8x.data, 4) + 1,
    canvasHeight: u24le(vp8x.data, 7) + 1,
    bg: Array.from(anim.data.subarray(0, 4)),
    loop: anim.data[4] | (anim.data[5] << 8)
  };
}

// ---- tests -----------------------------------------------------------------

test("webpEncoder: two-frame animation round-trips (RIFF, VP8X, ANIM, ANMF flags, durations)", () => {
  const enc = XDLWebp.createEncoder({ width: 8, height: 8, loop: 0 });
  enc.addFrame(fakeStaticWebp(8, 8), 40);
  enc.addFrame(fakeStaticWebp(8, 8), 80);
  const bytes = enc.finish();

  const webp = parseAnimatedWebp(bytes);
  assert.strictEqual(webp.flags & 0x02, 0x02, "animation flag set");
  assert.strictEqual(webp.flags & 0x10, 0, "no alpha flag for opaque frames");
  assert.strictEqual(webp.canvasWidth, 8);
  assert.strictEqual(webp.canvasHeight, 8);
  assert.deepEqual(webp.bg, [0, 0, 0, 0xff], "BGRA opaque black background");
  assert.strictEqual(webp.loop, 0, "loop forever");
  assert.strictEqual(webp.frames.length, 2);
  assert.deepEqual(
    webp.frames.map((f) => ({ x: f.x, y: f.y, width: f.width, height: f.height, duration: f.duration, flags: f.flags })),
    [
      { x: 0, y: 0, width: 8, height: 8, duration: 40, flags: 0x02 },
      { x: 0, y: 0, width: 8, height: 8, duration: 80, flags: 0x02 }
    ],
    "ANMF headers: full-canvas, no-blend/keep, exact durations"
  );
  for (const frame of webp.frames) {
    assert.deepEqual(frame.subchunks.map((c) => c.type), ["VP8 "], "each ANMF carries its VP8 sub-chunk");
    assert.deepEqual(Array.from(frame.subchunks[0].data.slice(-2)), [0xde, 0xad], "fabricated payload survives verbatim");
  }
});

test("webpEncoder: a real reference-encoded WebP frame animates through the container", () => {
  const enc = XDLWebp.createEncoder({ width: 8, height: 8 });
  enc.addFrame(realWebp(), 40);
  enc.addFrame(realWebp(), 40);
  const bytes = enc.finish();
  const webp = parseAnimatedWebp(bytes);
  assert.strictEqual(webp.flags & 0x02, 0x02);
  assert.strictEqual(webp.frames.length, 2);
  for (const frame of webp.frames) {
    assert.strictEqual(frame.subchunks[0].type, "VP8 ");
    assert.ok(frame.subchunks[0].data.length > 40, "real VP8 payload preserved");
  }
  // The two frames' payloads must both be intact (the second parse would have
  // failed on a corrupted RIFF/bitstream header).
  assert.deepEqual(
    Array.from(webp.frames[0].subchunks[0].data.subarray(0, 10)),
    Array.from(webp.frames[1].subchunks[0].data.subarray(0, 10))
  );
});

test("webpEncoder: ALPH chunks propagate to the VP8X alpha flag and into the ANMF payload", () => {
  const alpha = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]);
  const enc = XDLWebp.createEncoder({ width: 4, height: 4 });
  enc.addFrame(fakeStaticWebp(4, 4, { alpha, payloadSuffix: [0xaa] }), 40);
  const bytes = enc.finish();
  const webp = parseAnimatedWebp(bytes);
  assert.strictEqual(webp.flags & 0x10, 0x10, "alpha flag set when a frame has ALPH");
  assert.strictEqual(webp.flags & 0x02, 0x02, "still animated");
  assert.strictEqual(webp.frames.length, 1);
  assert.deepEqual(webp.frames[0].subchunks.map((c) => c.type), ["ALPH", "VP8 "]);
  assert.deepEqual(Array.from(webp.frames[0].subchunks[0].data), Array.from(alpha));
});

test("webpEncoder: VP8L frames are supported and flagged like VP8 frames", () => {
  const enc = XDLWebp.createEncoder({ width: 16, height: 9 });
  enc.addFrame(fakeStaticWebp(16, 9, { variant: "vp8l" }), 40);
  const bytes = enc.finish();
  const webp = parseAnimatedWebp(bytes);
  assert.strictEqual(webp.canvasWidth, 16);
  assert.strictEqual(webp.canvasHeight, 9);
  assert.strictEqual(webp.frames[0].subchunks[0].type, "VP8L");
  assert.deepEqual(Array.from(webp.frames[0].subchunks[0].data.slice(-2)), [0xde, 0xad]);
});

test("webpEncoder: mismatched frame sizes, non-WebP input and empty animations are rejected", () => {
  const enc = XDLWebp.createEncoder({ width: 8, height: 8 });
  assert.throws(() => enc.addFrame(fakeStaticWebp(4, 4), 40), /does not match canvas/);
  assert.throws(() => enc.addFrame(Uint8Array.from([1, 2, 3]), 40), /not a WebP/);
  const enc2 = XDLWebp.createEncoder({ width: 8, height: 8 });
  assert.throws(() => enc2.finish(), /no frames/);
  assert.throws(() => XDLWebp.createEncoder({ width: 0, height: 8 }), /width and height/);
});

test("webpEncoder: streaming encoder tracks frames, enforces duration bounds and is single-use", () => {
  const enc = XDLWebp.createEncoder({ width: 8, height: 8 });
  assert.strictEqual(enc.frameCount, 0);
  enc.addFrame(fakeStaticWebp(8, 8), 50);
  enc.addFrame(fakeStaticWebp(8, 8), 50);
  assert.strictEqual(enc.frameCount, 2);
  assert.throws(() => enc.addFrame(fakeStaticWebp(8, 8), 0x1000000), /duration exceeds/);
  const bytes = enc.finish();
  assert.strictEqual(ascii(bytes, 0), "RIFF");
  assert.throws(() => enc.addFrame(fakeStaticWebp(8, 8), 50), /already finished/);
  assert.throws(() => enc.finish(), /already finished/);
});

test("webpEncoder: encodeWebp one-shot helper agrees with the streaming API", () => {
  const oneShot = XDLWebp.encodeWebp({ width: 8, height: 8, frames: [
    { data: fakeStaticWebp(8, 8), delayMs: 100 },
    { data: fakeStaticWebp(8, 8), delayMs: 100 }
  ] });
  const webp = parseAnimatedWebp(oneShot);
  assert.strictEqual(webp.frames.length, 2);
  assert.strictEqual(webp.frames[0].duration, 100);
});
