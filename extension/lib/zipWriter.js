// ==========================================================================
// lib/zipWriter.js — minimal dependency-free ZIP writer (v3.5).
//
// Builds ZIP/CBZ archives for ONE post's photos (X allows at most 4 per
// post), so entries are stored uncompressed (method 0 — the photos are
// already JPEG/PNG/WebP compressed) with a correct CRC-32, central
// directory, and end-of-central-directory record. Entry names are plain
// ASCII ("001.jpg"…) but the UTF-8 flag is set so any name round-trips.
//
// This deliberately re-implements a tiny subset of ZIP instead of pulling in
// JSZip: the repo has a hard "no npm / no build step" guardrail, and a
// STORE-only writer is byte-auditable in one screen. Consumers:
//   - offscreen.js (primary archive assembly, object URL + anchor save)
//   - background.js (service-worker fallback via data: URL, small files only)
//   - tests/zip-writer.test.js (Node)
// ==========================================================================

(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.XDLZip = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      table[n] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    let crc = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) {
      crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  function asciiBytes(text) {
    const out = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
    return out;
  }

  function u16(value) {
    return new Uint8Array([value & 0xff, (value >>> 8) & 0xff]);
  }

  function u32(value) {
    return new Uint8Array([value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff]);
  }

  function concat(parts) {
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

  // Fixed DOS timestamp (2026-01-01 00:00:00) keeps archives byte-stable for
  // tests and reproducible re-downloads; readers ignore it for images.
  const DOS_TIME = 0;
  const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;
  const UTF8_FLAG = 0x0800;

  // entries: [{ name: "001.jpg", data: Uint8Array }, …] in final order.
  // Returns the complete archive bytes.
  function buildZip(entries) {
    if (!entries || entries.length === 0) {
      throw new Error("Cannot build a ZIP with no entries.");
    }
    const parts = [];
    const central = [];
    let offset = 0;
    for (const entry of entries) {
      const name = asciiBytes(String(entry.name));
      const data = entry.data instanceof Uint8Array ? entry.data : new Uint8Array(entry.data);
      const crc = crc32(data);
      const localHeader = concat([
        u32(0x04034b50), // local file header signature
        u16(20),         // version needed: 2.0
        u16(UTF8_FLAG),
        u16(0),          // method 0 = stored
        u16(DOS_TIME), u16(DOS_DATE),
        u32(crc),
        u32(data.length), // compressed size (== stored)
        u32(data.length), // uncompressed size
        u16(name.length),
        u16(0),          // extra length
        name
      ]);
      parts.push(localHeader, data);
      central.push(concat([
        u32(0x02014b50), // central directory header signature
        u16(20), u16(20),
        u16(UTF8_FLAG),
        u16(0),
        u16(DOS_TIME), u16(DOS_DATE),
        u32(crc),
        u32(data.length),
        u32(data.length),
        u16(name.length),
        u16(0), u16(0),  // extra, comment
        u16(0),          // disk number
        u16(0),          // internal attrs
        u32(0),          // external attrs
        u32(offset),     // local header offset
        name
      ]));
      offset += localHeader.length + data.length;
    }
    const centralBytes = concat(central);
    const eocd = concat([
      u32(0x06054b50), // end of central directory signature
      u16(0), u16(0),
      u16(entries.length), u16(entries.length),
      u32(centralBytes.length),
      u32(offset),
      u16(0)
    ]);
    return concat([...parts, centralBytes, eocd]);
  }

  return { crc32, buildZip };
});
