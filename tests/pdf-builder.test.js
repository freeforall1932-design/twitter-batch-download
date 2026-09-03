// Fixture tests for the dependency-free PDF writer
// (source/archive-enabled/chrome-extension/lib/pdfBuilder.js — the archive
// path retired from the shipped extension/ build in v3.12, so this
// archive-specific historical suite pins the preserved source variant):
// JPEG frame parsing (jpegInfo) and PDF document structure — header, page
// tree, DCTDecode image embedding, and exact cross-reference offsets.
// Ported from nh-dw-2.0 test/pdf-builder.test.js (mocha → node:test).

const assert = require("node:assert");
const { describe, it } = require("node:test");
const { jpegInfo, buildPdfDocument } = require("../source/archive-enabled/chrome-extension/lib/pdfBuilder.js");

// Minimal JPEG with a real SOF0 frame: SOI, SOF0(length 17, precision, H, W,
// components + component specs), then payload, then EOI.
function makeJpeg(width, height, components = 3, payload = 1900) {
    const buf = new Uint8Array(payload + 20);
    const header = [
        0xFF, 0xD8,
        0xFF, 0xC0, 0x00, 0x11, 0x08,
        (height >> 8) & 0xFF, height & 0xFF,
        (width >> 8) & 0xFF, width & 0xFF,
        components
    ];
    if (components === 3) {
        header.push(0x01, 0x11, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01);
    } else {
        for (let i = 0; i < components * 3; i++) header.push(0x01);
    }
    buf.set(header, 0);
    buf[buf.length - 2] = 0xFF;
    buf[buf.length - 1] = 0xD9;
    return buf;
}

describe('jpegInfo', () => {
    it('reads dimensions and component count from a baseline SOF0 frame', () => {
        assert.deepStrictEqual(jpegInfo(makeJpeg(1280, 1808)), { width: 1280, height: 1808, components: 3 });
    });

    it('reads progressive (SOF2) frames and non-3 component counts', () => {
        const progressive = makeJpeg(640, 480);
        progressive[3] = 0xC2; // SOF2 instead of SOF0
        assert.deepStrictEqual(jpegInfo(progressive), { width: 640, height: 480, components: 3 });
        assert.strictEqual(jpegInfo(makeJpeg(10, 10, 1)).components, 1);
        assert.strictEqual(jpegInfo(makeJpeg(10, 10, 4)).components, 4);
    });

    it('skips APPn segments (with embedded thumbnails) before the frame', () => {
        const buf = makeJpeg(800, 600);
        // Splice an APP0 segment with a payload right after SOI.
        const app0 = new Uint8Array([0xFF, 0xE0, 0x00, 0x10, ...new Array(14).fill(0x41)]);
        const withApp = new Uint8Array(buf.length + app0.length);
        withApp.set(buf.slice(0, 2), 0);
        withApp.set(app0, 2);
        withApp.set(buf.slice(2), 2 + app0.length);
        assert.deepStrictEqual(jpegInfo(withApp), { width: 800, height: 600, components: 3 });
    });

    it('returns null for non-JPEG bytes, truncated frames, and scan-first data', () => {
        assert.strictEqual(jpegInfo(new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0A])), null); // PNG
        assert.strictEqual(jpegInfo(new Uint8Array(4)), null);
        assert.strictEqual(jpegInfo(null), null);
        const sosFirst = new Uint8Array([0xFF, 0xD8, 0xFF, 0xDA, 0x00, 0x02, 0x00, 0x00]);
        assert.strictEqual(jpegInfo(sosFirst), null);
    });
});

describe('buildPdfDocument', () => {
    const images = [
        { bytes: makeJpeg(120, 200), width: 120, height: 200 },
        { bytes: makeJpeg(120, 190), width: 120, height: 190 },
        { bytes: makeJpeg(120, 180), width: 120, height: 180 }
    ];

    it('produces a PDF 1.4 document with one page and one DCTDecode image per input', () => {
        const pdf = Buffer.from(buildPdfDocument(images));
        assert.ok(pdf.toString('latin1').startsWith('%PDF-1.4\n'), 'PDF header');
        assert.ok(pdf.toString('latin1').endsWith('%%EOF\n'), 'EOF marker');
        const text = pdf.toString('latin1');
        assert.ok(text.includes('/Count 3'), 'page count');
        assert.strictEqual(text.split('/Filter /DCTDecode').length - 1, 3, 'one embedded JPEG per page');
        assert.ok(text.includes('/MediaBox [0 0 120 200]'), 'page size matches image 1');
        assert.ok(text.includes('/MediaBox [0 0 120 180]'), 'page size matches image 3');
    });

    it('embeds the original JPEG bytes verbatim (no re-encode)', () => {
        const pdf = Buffer.from(buildPdfDocument([images[0]]));
        const needle = Buffer.from(images[0].bytes);
        assert.notStrictEqual(pdf.indexOf(needle), -1, 'exact JPEG byte sequence present in the PDF');
    });

    it('writes a cross-reference table whose offsets point at each object', () => {
        const pdf = Buffer.from(buildPdfDocument(images));
        const text = pdf.toString('latin1');
        const startxref = /startxref\n(\d+)\n%%EOF/.exec(text);
        assert.ok(startxref, 'startxref present');
        const xrefOffset = parseInt(startxref[1], 10);
        assert.strictEqual(pdf.slice(xrefOffset, xrefOffset + 4).toString('latin1'), 'xref', 'startxref points at the xref table');

        // The xref follows the last object; parse entries and verify each
        // object offset really starts with "<num> 0 obj".
        const xrefText = text.slice(xrefOffset);
        const countMatch = /xref\n0 (\d+)\n/.exec(xrefText);
        assert.ok(countMatch, 'xref subheader');
        const objectCount = parseInt(countMatch[1], 10) - 1; // entry 0 is the free head
        assert.strictEqual(objectCount, 2 + 3 * 3, 'catalog + pages + 3 objects per page');
        const entries = xrefText.slice(countMatch.index + countMatch[0].length).split('\n');
        // entries[0] is the free-list head (0000000000 65535 f); object N is
        // at entries[N].
        assert.ok(/^0000000000 65535 f $/.test(entries[0]), 'free-list head entry');
        for (let num = 1; num <= objectCount; num++) {
            const entry = entries[num];
            assert.ok(/^\d{10} 00000 n $/.test(entry), 'well-formed xref entry: ' + JSON.stringify(entry));
            const offset = parseInt(entry.slice(0, 10), 10);
            const atOffset = pdf.slice(offset, offset + 12).toString('latin1');
            assert.ok(atOffset.startsWith(num + ' 0 obj'), 'object ' + num + ' offset correct, got ' + JSON.stringify(atOffset));
        }
    });

    it('rejects empty input and unusable pages', () => {
        assert.throws(() => buildPdfDocument([]), /no pages/i);
        assert.throws(() => buildPdfDocument([{ bytes: new Uint8Array(4), width: 0, height: 0 }]), /no usable image/i);
    });
});
