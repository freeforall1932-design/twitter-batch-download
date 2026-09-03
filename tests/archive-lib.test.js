// Shared archive engine (lib/archive.js): the service-worker fallback and the
// offscreen document run ONE copy of fetch/PDF-page/archive-bytes code.
// This suite pins the byte-level output to the same writers the offscreen
// path uses, so the two contexts cannot drift apart.
//
// v3.12 retired the archive path from the shipped extension/ build. This
// suite is an archive-specific historical test, so it imports the PRESERVED
// source variant (source/archive-enabled/chrome-extension/lib/), which is
// where the archive engine now lives.

const assert = require("node:assert/strict");
const test = require("node:test");

// lib/archive.js discovers its writers the same way in every context it runs
// in (importScripts in the worker, <script> tags in the offscreen document):
// under the globalThis.XDLZip / XDLPdf names. Mirror that here instead of
// wiring module dependencies into the browser-shared file.
globalThis.XDLZip = require("../source/archive-enabled/chrome-extension/lib/zipWriter.js");
globalThis.XDLPdf = require("../source/archive-enabled/chrome-extension/lib/pdfBuilder.js");

const { bytesToBase64, buildArchiveBytes } = require("../source/archive-enabled/chrome-extension/lib/archive.js");
const { buildZip } = require("../source/archive-enabled/chrome-extension/lib/zipWriter.js");
const { jpegInfo, buildPdfDocument } = require("../source/archive-enabled/chrome-extension/lib/pdfBuilder.js");

function makeJpeg(width, height, payload = 400) {
  const buf = new Uint8Array(payload + 20);
  buf.set([
    0xFF, 0xD8,
    0xFF, 0xC0, 0x00, 0x11, 0x08,
    (height >> 8) & 0xFF, height & 0xFF,
    (width >> 8) & 0xFF, width & 0xFF,
    3, 0x01, 0x11, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01
  ], 0);
  buf[buf.length - 2] = 0xFF;
  buf[buf.length - 1] = 0xD9;
  return buf;
}

function entries() {
  const jpeg = makeJpeg(100, 150);
  return [
    { name: "001.jpg", bytes: jpeg, contentType: "image/jpeg" },
    { name: "002.jpg", bytes: jpeg, contentType: "image/jpeg" }
  ];
}

test("bytesToBase64 round-trips through Node's base64 codec", () => {
  const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 255]);
  const encoded = bytesToBase64(bytes);
  assert.deepEqual(Buffer.from(encoded, "base64"), Buffer.from(bytes));
});

test("zip: buildArchiveBytes emits byte-identical output to the STORE writer", async () => {
  const built = await buildArchiveBytes(entries(), "zip");
  const direct = buildZip(entries().map((entry) => ({ name: entry.name, data: entry.bytes })));
  assert.deepEqual(built.bytes, direct);
  assert.equal(built.mime, "application/zip");
});

test("cbz: same bytes as ZIP, comicbook MIME", async () => {
  const cbz = await buildArchiveBytes(entries(), "cbz");
  const zip = await buildArchiveBytes(entries(), "zip");
  assert.deepEqual(cbz.bytes, zip.bytes);
  assert.equal(cbz.mime, "application/vnd.comicbook+zip");
});

test("pdf: pages at native size, verbatim JPEG pages, pdf MIME", async () => {
  const built = await buildArchiveBytes(entries(), "pdf");
  assert.equal(built.mime, "application/pdf");
  const text = Buffer.from(built.bytes).toString("latin1");
  assert.ok(text.startsWith("%PDF-1.4\n"), "PDF header");
  assert.ok(text.includes("/Count 2"), "one page per entry");
  assert.equal(text.split("/MediaBox [0 0 100 150]").length - 1, 2, "page size = image size");
  assert.ok(Buffer.from(built.bytes).includes(Buffer.from(makeJpeg(100, 150))), "JPEG embedded verbatim");
});

test("pdf: an undimensionable page fails loudly instead of producing a broken file", async () => {
  const bogus = [{ name: "001.png", bytes: new Uint8Array(64).fill(1), contentType: "image/png" }];
  await assert.rejects(
    () => buildArchiveBytes(bogus, "pdf"),
    /cannot encode|no usable image|no 2d canvas/i
  );
});

test("unknown formats default to ZIP (same degradation as the worker fallback)", async () => {
  const built = await buildArchiveBytes(entries(), "tarball");
  assert.equal(built.mime, "application/zip");
  assert.deepEqual(built.bytes, buildZip(entries().map((entry) => ({ name: entry.name, data: entry.bytes }))));
  assert.notEqual(jpegInfo(makeJpeg(10, 10)), null, "fixture is a dimensionable JPEG");
  assert.equal(buildPdfDocument([{ bytes: makeJpeg(10, 10), width: 10, height: 10 }]).length > 0, true);
});
