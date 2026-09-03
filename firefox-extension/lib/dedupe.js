// ==========================================================================
// lib/dedupe.js — byte-identical + source-URL duplicate verification (v3.10).
//
// Two independent checks stop the same media from being saved twice even when
// the generated file name differs (sanitizer/fallback/uniquify can rename a
// file while the content stays the same):
//
//   1. Source-URL verification — a canonical form of the media URL
//      (scheme + host + path; delivery query params like name/format stripped)
//      identifies "the same post url address" regardless of query strings.
//   2. Byte-identical verification — a SHA-256 of the actual media bytes.
//      Two different URLs (size variants, CDN mirrors, renamed copies) that
//      carry byte-identical content collapse into one download.
//
// Pure DOM/worker/Node-compatible, no crypto.subtle dependency (service
// workers, offscreen documents, and the VM test harness all run the exact
// same code). Consumers:
//   - background.js   (service worker, via importScripts)
//   - offscreen.html  (via <script>), before offscreen.js
//   - tests/          (Node, via require)
// ==========================================================================

(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.XDLDedupe = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  // ---- SHA-256 -------------------------------------------------------------
  // Incremental (streaming) implementation: media can be hundreds of MB, so
  // the digest is computed chunk-by-chunk without ever holding the whole file
  // in memory. Matches FIPS 180-4; vector-checked in tests/dedupe.test.js.

  const K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ];

  function rotr(value, bits) {
    return (value >>> bits) | (value << (32 - bits));
  }

  function toBytes(input) {
    if (input instanceof Uint8Array) return input;
    if (input instanceof ArrayBuffer) return new Uint8Array(input);
    if (ArrayBuffer.isView(input)) {
      return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    }
    if (typeof input === "string") {
      // UTF-8 encode without depending on TextEncoder (available everywhere a
      // worker runs, but keep the lib dependency-free for the VM tests).
      const encoded = unescape(encodeURIComponent(input));
      const out = new Uint8Array(encoded.length);
      for (let i = 0; i < encoded.length; i++) out[i] = encoded.charCodeAt(i) & 0xff;
      return out;
    }
    throw new TypeError("sha256Hex expects Uint8Array, ArrayBuffer, typed array, or string.");
  }

  class Sha256 {
    constructor() {
      this._h = [
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
        0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
      ];
      this._block = new Uint8Array(64);
      this._blockLen = 0;
      this._total = 0;
    }

    // Feed the next chunk of bytes (Uint8Array / ArrayBuffer / string).
    update(input) {
      const bytes = toBytes(input);
      this._total += bytes.length;
      let offset = 0;
      if (this._blockLen > 0) {
        const take = Math.min(64 - this._blockLen, bytes.length);
        this._block.set(bytes.subarray(0, take), this._blockLen);
        this._blockLen += take;
        offset += take;
        if (this._blockLen === 64) {
          this._compress(this._block, 0);
          this._blockLen = 0;
        }
      }
      while (offset + 64 <= bytes.length) {
        this._compress(bytes, offset);
        offset += 64;
      }
      if (offset < bytes.length) {
        this._block.set(bytes.subarray(offset), 0);
        this._blockLen = bytes.length - offset;
      }
      return this;
    }

    // Finalize and return the lowercase hex digest (does not mutate state
    // beyond the internal buffer, so a caller may keep streaming if needed).
    digestHex() {
      const bitLenHi = Math.floor(this._total / 0x20000000); // (total*8) >>> 32
      const bitLenLo = (this._total * 8) >>> 0;
      const pad = new Uint8Array((((this._blockLen + 8) >> 6) + 1) * 64);
      pad.set(this._block.subarray(0, this._blockLen), 0);
      pad[this._blockLen] = 0x80;
      const view = new DataView(pad.buffer);
      view.setUint32(pad.length - 8, bitLenHi >>> 0, false);
      view.setUint32(pad.length - 4, bitLenLo, false);
      for (let i = 0; i < pad.length; i += 64) this._compress(pad, i);
      return this._h.map((value) => (value >>> 0).toString(16).padStart(8, "0")).join("");
    }

    _compress(bytes, offset) {
      const w = new Uint32Array(64);
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      for (let i = 0; i < 16; i++) {
        w[i] = view.getUint32(offset + i * 4, false);
      }
      for (let i = 16; i < 64; i++) {
        const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
        const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
      }
      let a = this._h[0], b = this._h[1], c = this._h[2], d = this._h[3];
      let e = this._h[4], f = this._h[5], g = this._h[6], h = this._h[7];
      for (let i = 0; i < 64; i++) {
        const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
        const ch = (e & f) ^ (~e & g);
        const temp1 = (h + S1 + ch + K[i] + w[i]) >>> 0;
        const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
        const maj = (a & b) ^ (a & c) ^ (b & c);
        const temp2 = (S0 + maj) >>> 0;
        h = g; g = f; f = e; e = (d + temp1) >>> 0;
        d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
      }
      this._h[0] = (this._h[0] + a) >>> 0;
      this._h[1] = (this._h[1] + b) >>> 0;
      this._h[2] = (this._h[2] + c) >>> 0;
      this._h[3] = (this._h[3] + d) >>> 0;
      this._h[4] = (this._h[4] + e) >>> 0;
      this._h[5] = (this._h[5] + f) >>> 0;
      this._h[6] = (this._h[6] + g) >>> 0;
      this._h[7] = (this._h[7] + h) >>> 0;
    }
  }

  function sha256Hex(input) {
    return new Sha256().update(input).digestHex();
  }

  function hashBytes(bytes) {
    return sha256Hex(bytes);
  }

  // ---- Canonical source URL ------------------------------------------------
  // The media's source identity is scheme + host + path. X (and most CDNs)
  // vary delivery through query params (name=small/orig, format, tag, v,
  // w/h) — those change HOW the file is served, not WHICH file it is, and
  // the DOM/GraphQL extractors already force name=orig. Hash-free "same url"
  // comparison uses this form; byte verification catches anything the URL
  // form cannot (e.g. two CDN hosts carrying identical bytes).
  function canonicalSourceUrl(rawUrl) {
    const value = String(rawUrl || "").trim();
    if (!value) return "";
    if (/^(data|blob):/i.test(value)) return value.split("#")[0];
    try {
      const url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(value) ? value : "https://" + value);
      if (url.protocol === "http:" || url.protocol === "https:") {
        return `${url.protocol}//${url.host}${url.pathname}`;
      }
      return url.href.split("#")[0];
    } catch (_) {
      // Last resort for a malformed URL: strip fragment/query and collapse
      // duplicate slashes so the same address typed two ways still matches.
      return value.split("#")[0].replace(/[?#].*$/, "").replace(/\/{2,}/g, "/").replace(/\/+$/, "");
    }
  }

  // ---- Downloaded records ---------------------------------------------------
  // Records are plain JSON and may carry several ids/urls over time (the
  // same media discovered as "555-ABC" from the DOM and "555-1730000000"
  // from GraphQL). Merging keeps ONE per source URL / hash / id.

  function mergeRecords(a, b) {
    const left = a || {};
    const right = b || {};
    const ids = new Set();
    const urls = new Set();
    for (const record of [left, right]) {
      if (record.id) ids.add(String(record.id));
      if (Array.isArray(record.ids)) record.ids.forEach((id) => ids.add(String(id)));
      if (record.url) urls.add(String(record.url));
      if (Array.isArray(record.urls)) record.urls.forEach((url) => urls.add(String(url)));
    }
    const firstId = [...ids][0] || "";
    const firstUrl = [...urls][0] || "";
    return {
      id: left.id || right.id || firstId,
      ids: [...ids],
      mediaKey: left.mediaKey || right.mediaKey || "",
      url: left.url || right.url || firstUrl,
      urls: [...urls],
      urlKey: left.urlKey || right.urlKey || "",
      hash: left.hash || right.hash || "",
      size: Number(left.size) || Number(right.size) || 0,
      filename: left.filename || right.filename || "",
      at: Date.now()
    };
  }

  // User-facing reason for a skip, naming the file it was already saved as
  // when we know one.
  function duplicateNote(reason, record) {
    const known = record?.filename ? ` Already saved as "${record.filename}".` : "";
    if (reason === "duplicate_bytes") {
      return "Skipped — byte-identical file content (same bytes)." + known;
    }
    return "Skipped — same source URL." + known;
  }

  return {
    Sha256,
    sha256Hex,
    hashBytes,
    canonicalSourceUrl,
    sourceUrlKey: canonicalSourceUrl,
    mergeRecords,
    duplicateNote
  };
});
