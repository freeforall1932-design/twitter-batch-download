// Structure tests for the STORE-only ZIP writer (extension/lib/zipWriter.js):
// CRC-32 reference vector, local headers, verbatim stored data, central
// directory, and the end-of-central-directory record — everything a reader
// needs to open a per-post archive.

const assert = require("node:assert/strict");
const test = require("node:test");

const { crc32, buildZip } = require("../extension/lib/zipWriter.js");

function bytes(text) {
  return new Uint8Array(Buffer.from(text, "latin1"));
}

function readU32(buf, offset) {
  return buf.readUInt32LE(offset);
}

function readU16(buf, offset) {
  return buf.readUInt16LE(offset);
}

test("crc32 matches the reference test vector", () => {
  // The canonical CRC-32 check value: crc32("123456789") = 0xCBF43926.
  assert.equal(crc32(bytes("123456789")), 0xcbf43926);
  assert.equal(crc32(new Uint8Array(0)), 0);
});

test("buildZip stores entries verbatim with correct local headers", () => {
  const one = bytes("first image bytes");
  const two = bytes("second image bytes, longer");
  const zip = Buffer.from(buildZip([
    { name: "001.jpg", data: one },
    { name: "002.png", data: two }
  ]));

  // Local file header 1 at offset 0.
  assert.equal(readU32(zip, 0), 0x04034b50, "local header signature");
  assert.equal(readU16(zip, 8), 0, "method 0 = stored");
  assert.equal(readU32(zip, 14), crc32(one), "crc of entry 1");
  assert.equal(readU32(zip, 18), one.length, "compressed size == stored size");
  assert.equal(readU32(zip, 22), one.length, "uncompressed size");
  assert.equal(readU16(zip, 26), "001.jpg".length, "name length");
  assert.equal(zip.slice(30, 37).toString("latin1"), "001.jpg", "entry name");
  // Stored data follows the name verbatim (no compression).
  assert.equal(zip.slice(37, 37 + one.length).toString("latin1"), "first image bytes");

  // Entry order is preserved: 001.jpg local header sits before 002.png's.
  assert.ok(zip.indexOf(Buffer.from("001.jpg")) < zip.indexOf(Buffer.from("002.png")));
});

test("buildZip writes a central directory + EOCD a reader can walk", () => {
  const entries = [
    { name: "001.jpg", data: bytes("aaa") },
    { name: "002.jpg", data: bytes("bbbb") },
    { name: "003.jpg", data: bytes("ccccc") }
  ];
  const zip = Buffer.from(buildZip(entries));

  // EOCD record is the last 22 bytes (no comment).
  const eocd = zip.length - 22;
  assert.equal(readU32(zip, eocd), 0x06054b50, "EOCD signature");
  assert.equal(readU16(zip, eocd + 10), 3, "total entry count");
  const centralSize = readU32(zip, eocd + 12);
  const centralOffset = readU32(zip, eocd + 16);
  assert.equal(centralOffset + centralSize, eocd, "central directory ends at EOCD");

  // Walk the central directory: three entries, names in post order, and each
  // recorded local-header offset really points at a local header signature.
  let pos = centralOffset;
  const names = [];
  for (let i = 0; i < 3; i++) {
    assert.equal(readU32(zip, pos), 0x02014b50, `central header ${i} signature`);
    const nameLength = readU16(zip, pos + 28);
    const localOffset = readU32(zip, pos + 42);
    names.push(zip.slice(pos + 46, pos + 46 + nameLength).toString("latin1"));
    assert.equal(readU32(zip, localOffset), 0x04034b50, `entry ${i} local offset valid`);
    pos += 46 + nameLength;
  }
  assert.deepEqual(names, ["001.jpg", "002.jpg", "003.jpg"], "entries at archive root, in order");
  assert.equal(pos, centralOffset + centralSize, "central directory size exact");
});

test("buildZip rejects an empty entry list", () => {
  assert.throws(() => buildZip([]), /no entries/i);
});
