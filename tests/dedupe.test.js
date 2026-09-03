// lib/dedupe.js unit tests: SHA-256 vectors, canonical source-URL identity,
// and record merging — the two duplicate verifications (byte + URL).
"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const crypto = require("node:crypto");

const dedupe = require("../extension/lib/dedupe.js");

function bytesOf(hex) {
  return new Uint8Array(hex.match(/.{2}/g).map((pair) => parseInt(pair, 16)));
}

test("sha256 matches Node crypto for known vectors", () => {
  const vectors = [
    ["", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
    ["abc", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"],
    ["hello world", "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9"]
  ];
  for (const [text, expected] of vectors) {
    assert.equal(dedupe.sha256Hex(text), expected, `sha256("${text}")`);
    const utf8 = new TextEncoder().encode(text);
    assert.equal(dedupe.hashBytes(utf8), expected);
    assert.equal(dedupe.hashBytes(utf8.buffer), expected);
  }
});

test("incremental Sha256 matches one-shot and Node for chunked input", () => {
  const data = new TextEncoder().encode("The quick brown fox jumps over the lazy dog — 0123456789");
  const expected = crypto.createHash("sha256").update(data).digest("hex");
  assert.equal(dedupe.hashBytes(data), expected);

  const hasher = new dedupe.Sha256();
  for (let i = 0; i < data.length; i += 7) {
    hasher.update(data.subarray(i, Math.min(i + 7, data.length)));
  }
  assert.equal(hasher.digestHex(), expected);

  // Chunk sizes that hit every inner-block boundary.
  const chunked = new dedupe.Sha256();
  chunked.update(data.subarray(0, 64));
  chunked.update(data.subarray(64));
  assert.equal(chunked.digestHex(), expected);
});

test("canonicalSourceUrl strips delivery query params but keeps the file identity", () => {
  assert.equal(
    dedupe.canonicalSourceUrl("https://pbs.twimg.com/media/AbCdEf.jpg?format=jpg&name=orig"),
    "https://pbs.twimg.com/media/AbCdEf.jpg"
  );
  assert.equal(
    dedupe.canonicalSourceUrl("https://pbs.twimg.com/media/AbCdEf.jpg?name=small&v=12345"),
    dedupe.canonicalSourceUrl("https://pbs.twimg.com/media/AbCdEf.jpg?name=orig")
  );
  // Different media stay different.
  assert.notEqual(
    dedupe.canonicalSourceUrl("https://pbs.twimg.com/media/AbCdEf.jpg"),
    dedupe.canonicalSourceUrl("https://pbs.twimg.com/media/XyZ789.jpg")
  );
  // Host case and default ports normalize; trailing fragment never leaks.
  assert.equal(
    dedupe.canonicalSourceUrl("HTTPS://PBS.TWIMG.COM:443/media/AbCdEf.jpg#frag"),
    dedupe.canonicalSourceUrl("https://pbs.twimg.com/media/AbCdEf.jpg")
  );
  // Non-media URLs keep protocol+host+path identity too.
  assert.equal(
    dedupe.canonicalSourceUrl("https://video.twimg.com/ext_tw_video/123/pu/vid/720x720/video.mp4?tag=12"),
    "https://video.twimg.com/ext_tw_video/123/pu/vid/720x720/video.mp4"
  );
  assert.equal(dedupe.canonicalSourceUrl(""), "");
});

test("mergeRecords unions ids/urls and keeps one source identity", () => {
  const first = {
    id: "555-ABC", mediaKey: "ABC",
    url: "https://pbs.twimg.com/media/ABC.jpg?name=orig",
    urlKey: "https://pbs.twimg.com/media/ABC.jpg",
    hash: "aa11", size: 100, filename: "XMedia/u - p - 555/001.jpg"
  };
  const second = {
    id: "555-1730000000", mediaKey: "ABC",
    url: "https://cdn.example.com/media/ABC.jpg?name=large",
    urlKey: "https://cdn.example.com/media/ABC.jpg",
    hash: "aa11", size: 100
  };
  const merged = dedupe.mergeRecords(first, second);
  assert.deepEqual(merged.ids.sort(), ["555-1730000000", "555-ABC"]);
  assert.ok(merged.urls.length >= 2);
  assert.equal(merged.mediaKey, "ABC");
  assert.equal(merged.hash, "aa11");
  assert.equal(merged.filename, first.filename);
});

test("duplicateNote names byte vs URL reasons", () => {
  assert.match(dedupe.duplicateNote("duplicate_bytes", { filename: "a.jpg" }), /byte-identical/);
  assert.match(dedupe.duplicateNote("duplicate_url", { filename: "a.jpg" }), /same source URL/);
  assert.match(dedupe.duplicateNote("duplicate_bytes", {}), /byte-identical/);
});
