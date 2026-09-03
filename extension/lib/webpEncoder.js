// ==========================================================================
// lib/webpEncoder.js — dependency-free ANIMATED WebP container writer (v3.15).
//
// Writing a VP8/VP8L *bitstream* encoder by hand is not realistic, but it is
// also unnecessary: the browser already encodes each canvas frame natively —
// canvas.toBlob("image/webp", quality) produces a static WebP (RIFF wrapped
// VP8/VP8L keyframe, optionally with an ALPH chunk). This file does the second
// half: it strips the RIFF wrapper, validates the frame dimensions, and
// re-serializes the frames into the WebP Extended + Animation container
// (VP8X → ANIM → ANMF...), exactly per the WebP container specification.
//
// Output: true-color frames at Chrome's own lossy/lossless encoder quality,
// up to 750 frames, animation looping forever — a genuine middle ground
// between APNG (lossless, huge) and GIF (256 colors, banding): like APNG it
// keeps full color; like GIF it stays small (the "balanced" option).
//
// Frames arrive as already-compressed static WebP byte strings
// (Uint8Array), so only the (small) compressed payloads are held until
// finish().
//
// UMD: `XDLWebp` in the offscreen document, require() in Node tests.
// No chrome APIs in this file.
// ==========================================================================

(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.XDLWebp = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  // VP8X feature flags (WebP container spec, byte order MSB→LSB):
  //   bit1 (0x02) = animation, bit4 (0x10) = alpha.
  const ANIMATION_FLAG = 0x02;
  const ALPHA_FLAG = 0x10;
  // ANMF flags byte: bit1 (0x02) = no blending (overwrite), bit0 (0x01) =
  // dispose to background. Full-canvas opaque frames → overwrite, keep.
  const ANMF_BLEND_ONLY = 0x02;

  function fourCC(type) {
    return [type.charCodeAt(0), type.charCodeAt(1), type.charCodeAt(2), type.charCodeAt(3)];
  }

  function readAscii(bytes, pos) {
    return String.fromCharCode(bytes[pos], bytes[pos + 1], bytes[pos + 2], bytes[pos + 3]);
  }

  function readU32Le(bytes, pos) {
    return (bytes[pos] | (bytes[pos + 1] << 8) | (bytes[pos + 2] << 16) | (bytes[pos + 3] << 24)) >>> 0;
  }

  // 24-bit little-endian width/height ("minus one") fields used by VP8X/ANMF.
  function writeU24(out, value) {
    const v = Math.max(0, Math.floor(value));
    out.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff);
  }

  // VP8: 3-byte frame tag + start code + 14-bit width/height.
  // VP8L: 0x2f signature + 14-bit width-1/height-1 packed over 4 bytes.
  function dimensionsOf(bitstream) {
    const p = bitstream.payload;
    if (bitstream.type === "VP8 ") {
      if (p.length < 10 || p[3] !== 0x9d || p[4] !== 0x01 || p[5] !== 0x2a) {
        throw new Error("Unsupported VP8 bitstream (missing frame start code)");
      }
      const width = p[6] | ((p[7] & 0x3f) << 8);
      const height = p[8] | ((p[9] & 0x3f) << 8);
      return { width, height };
    }
    if (bitstream.type === "VP8L") {
      if (p.length < 5 || p[0] !== 0x2f) throw new Error("Unsupported VP8L bitstream");
      const width = (p[1] | ((p[2] & 0x3f) << 8)) + 1;
      const height = ((p[2] >> 6) | (p[3] << 2) | ((p[4] & 0x0f) << 10)) + 1;
      return { width, height };
    }
    throw new Error("WebP frame has no VP8/VP8L bitstream");
  }

  // Static WebP (RIFF) → { alpha, bitstream, width, height }. Metadata chunks
  // (ICCP/EXIF/XMP) are intentionally dropped: canvas frames are bare sRGB.
  function parseStaticWebp(bytes) {
    if (!bytes || bytes.length < 12 || readAscii(bytes, 0) !== "RIFF" || readAscii(bytes, 8) !== "WEBP") {
      throw new Error("Frame is not a WebP file");
    }
    let alpha = null;
    let bitstream = null;
    let pos = 12;
    while (pos + 8 <= bytes.length) {
      const type = readAscii(bytes, pos);
      const size = readU32Le(bytes, pos + 4);
      const start = pos + 8;
      if (start + size > bytes.length) throw new Error("WebP frame is truncated");
      if (type === "ALPH") {
        if (alpha !== null) throw new Error("WebP frame has more than one ALPH chunk");
        alpha = bytes.slice(start, start + size);
      } else if (type === "VP8 " || type === "VP8L") {
        if (bitstream !== null) throw new Error("WebP frame has more than one bitstream chunk");
        bitstream = { type, payload: bytes.slice(start, start + size) };
      }
      pos = start + size + (size & 1); // RIFF chunks are padded to even size
    }
    if (!bitstream) throw new Error("WebP frame has no image data");
    const { width, height } = dimensionsOf(bitstream);
    return { alpha, bitstream, width, height };
  }

  // ---- streaming encoder -----------------------------------------------------

  // createEncoder({ width, height, loop = 0 }) → { addFrame, finish }.
  // addFrame(staticWebpBytes, delayMs) parses synchronously (async-friendly
  // for the offscreen loop); finish() returns the complete animated WebP.
  // Each frame must match the canvas size (WebP frames are stored as
  // keyframes with their own dimensions).
  function createEncoder(options) {
    const rawWidth = Number(options && options.width);
    const rawHeight = Number(options && options.height);
    if (!Number.isFinite(rawWidth) || !Number.isFinite(rawHeight) || rawWidth < 1 || rawHeight < 1) {
      throw new Error("WebP encoder needs a width and height.");
    }
    const width = Math.floor(rawWidth);
    const height = Math.floor(rawHeight);
    const loop = options && Number.isFinite(options.loop) ? Math.max(0, options.loop) : 0;

    const frames = [];
    let finished = false;
    let hasAlpha = false;

    function addFrame(webpBytes, delayMs) {
      if (finished) throw new Error("WebP encoder already finished.");
      const parsed = parseStaticWebp(webpBytes);
      if (parsed.width !== width || parsed.height !== height) {
        throw new Error(`WebP frame size ${parsed.width}x${parsed.height} does not match canvas ${width}x${height}`);
      }
      const duration = Math.max(1, Math.round(Number(delayMs) || 40));
      if (duration > 0xffffff) throw new Error("WebP frame duration exceeds 24-bit limit");
      frames.push({ ...parsed, duration });
      hasAlpha = hasAlpha || Boolean(parsed.alpha);
      return this;
    }

    function chunk(out, type, data) {
      out.push(...fourCC(type));
      const size = data.length;
      out.push(size & 0xff, (size >> 8) & 0xff, (size >> 16) & 0xff, (size >> 24) & 0xff);
      for (let i = 0; i < size; i++) out.push(data[i]);
      if (size & 1) out.push(0); // RIFF padding, not counted in the size field
    }

    function finish() {
      if (finished) throw new Error("WebP encoder already finished.");
      if (!frames.length) throw new Error("Cannot build a WebP animation with no frames.");
      finished = true;

      const out = [];
      out.push(0x52, 0x49, 0x46, 0x46); // "RIFF"
      out.push(0, 0, 0, 0);             // size patched below (total - 8)
      out.push(0x57, 0x45, 0x42, 0x50); // "WEBP"

      // VP8X: flags (animation + alpha when any frame carries an ALPH chunk),
      // 3 reserved bytes, canvas width-1 / height-1 (24-bit little-endian).
      const vp8x = [];
      vp8x.push(ANIMATION_FLAG | (hasAlpha ? ALPHA_FLAG : 0), 0, 0, 0);
      writeU24(vp8x, width - 1);
      writeU24(vp8x, height - 1);
      chunk(out, "VP8X", vp8x);

      // ANIM: background color BGRA (opaque black — frames are full-canvas)
      // + 16-bit loop count (0 = forever).
      const anim = [0, 0, 0, 0xff, loop & 0xff, (loop >> 8) & 0xff];
      chunk(out, "ANIM", anim);

      for (const frame of frames) {
        // ANMF: 16-byte header (x/2, y/2, w-1, h-1, duration ms, flags),
        // then the frame sub-chunks (ALPH + VP8/VP8L), each with headers.
        const anmf = [];
        writeU24(anmf, 0); // Frame X * 2 = 0
        writeU24(anmf, 0); // Frame Y * 2 = 0
        writeU24(anmf, width - 1);
        writeU24(anmf, height - 1);
        writeU24(anmf, frame.duration);
        anmf.push(ANMF_BLEND_ONLY); // flags: 6 reserved bits | B=1 (overwrite) | D=0 (keep)
        if (frame.alpha) chunk(anmf, "ALPH", frame.alpha);
        chunk(anmf, frame.bitstream.type, frame.bitstream.payload);
        chunk(out, "ANMF", anmf);
      }

      const bytes = Uint8Array.from(out);
      // RIFF chunk size = file size - 8 ("RIFF" + size field).
      const view = new DataView(bytes.buffer, bytes.byteOffset);
      view.setUint32(4, bytes.length - 8, true);
      return bytes;
    }

    return { addFrame, finish, get frameCount() { return frames.length; } };
  }

  // One-shot convenience used by tests and small callers.
  function encodeWebp(input) {
    const enc = createEncoder(input);
    for (const frame of input.frames || []) enc.addFrame(frame.data, frame.delayMs);
    return enc.finish();
  }

  return { createEncoder, encodeWebp, parseStaticWebp };
});
