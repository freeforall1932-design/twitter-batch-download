// ==========================================================================
// zip-writer.js — Minimal ZIP file creator (no compression, STORE only)
// Sufficient for bundling downloaded media into a single archive
// ==========================================================================

// eslint-disable-next-line no-unused-vars
class ZipWriter {
  constructor() {
    this.files = []; // { name: Uint8Array, data: Uint8Array, date: Date }
  }

  addFile(name, data) {
    // name: string (filename within zip)
    // data: Uint8Array or ArrayBuffer
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    this.files.push({
      name: new TextEncoder().encode(name),
      data: bytes,
      date: new Date()
    });
  }

  generate() {
    // Calculate total size
    let offset = 0;
    const localHeaders = [];
    const centralHeaders = [];

    for (const file of this.files) {
      // CRC32 of data
      const crc = this._crc32(file.data);

      // DOS date/time
      const dosTime = this._dosDateTime(file.date);

      // Local file header
      const localHeader = new ArrayBuffer(30 + file.name.length);
      const lv = new DataView(localHeader);
      lv.setUint32(0, 0x04034b50, true); // signature
      lv.setUint16(4, 20, true);          // version needed
      lv.setUint16(6, 0, true);           // flags
      lv.setUint16(8, 0, true);           // compression: STORE
      lv.setUint16(10, dosTime.time, true);
      lv.setUint16(12, dosTime.date, true);
      lv.setUint32(14, crc, true);        // CRC-32
      lv.setUint32(18, file.data.length, true); // compressed size
      lv.setUint32(22, file.data.length, true); // uncompressed size
      lv.setUint16(26, file.name.length, true); // filename length
      lv.setUint16(28, 0, true);          // extra field length
      new Uint8Array(localHeader, 30).set(file.name);

      localHeaders.push({ header: new Uint8Array(localHeader), offset, crc, size: file.data.length });
      offset += 30 + file.name.length + file.data.length;
    }

    // Central directory
    const cdStart = offset;
    for (let i = 0; i < this.files.length; i++) {
      const file = this.files[i];
      const local = localHeaders[i];
      const crc = local.crc;
      const dosTime = this._dosDateTime(file.date);

      const cdHeader = new ArrayBuffer(46 + file.name.length);
      const cv = new DataView(cdHeader);
      cv.setUint32(0, 0x02014b50, true);  // signature
      cv.setUint16(4, 20, true);           // version made by
      cv.setUint16(6, 20, true);           // version needed
      cv.setUint16(8, 0, true);            // flags
      cv.setUint16(10, 0, true);           // compression: STORE
      cv.setUint16(12, dosTime.time, true);
      cv.setUint16(14, dosTime.date, true);
      cv.setUint32(16, crc, true);         // CRC-32
      cv.setUint32(20, file.data.length, true); // compressed size
      cv.setUint32(24, file.data.length, true); // uncompressed size
      cv.setUint16(28, file.name.length, true); // filename length
      cv.setUint16(30, 0, true);           // extra field length
      cv.setUint16(32, 0, true);           // comment length
      cv.setUint16(34, 0, true);           // disk number start
      cv.setUint16(36, 0, true);           // internal attrs
      cv.setUint32(38, 0, true);           // external attrs
      cv.setUint32(42, local.offset, true); // local header offset
      new Uint8Array(cdHeader, 46).set(file.name);

      centralHeaders.push(new Uint8Array(cdHeader));
      offset += 46 + file.name.length;
    }

    const cdSize = offset - cdStart;

    // End of central directory
    const eocd = new ArrayBuffer(22);
    const ev = new DataView(eocd);
    ev.setUint32(0, 0x06054b50, true);    // signature
    ev.setUint16(4, 0, true);             // disk number
    ev.setUint16(6, 0, true);             // disk with CD
    ev.setUint16(8, this.files.length, true); // entries on this disk
    ev.setUint16(10, this.files.length, true); // total entries
    ev.setUint32(12, cdSize, true);        // CD size
    ev.setUint32(16, cdStart, true);       // CD offset
    ev.setUint16(20, 0, true);             // comment length

    // Assemble final ZIP
    const result = new Uint8Array(offset + 22);
    let pos = 0;

    for (let i = 0; i < this.files.length; i++) {
      result.set(localHeaders[i].header, pos);
      pos += localHeaders[i].header.length;
      result.set(this.files[i].data, pos);
      pos += this.files[i].data.length;
    }

    for (const cd of centralHeaders) {
      result.set(cd, pos);
      pos += cd.length;
    }

    result.set(new Uint8Array(eocd), pos);

    return result;
  }

  _dosDateTime(date) {
    const time = ((date.getHours() & 0x1F) << 11) |
                 ((date.getMinutes() & 0x3F) << 5) |
                 (Math.floor(date.getSeconds() / 2) & 0x1F);
    const datePart = (((date.getFullYear() - 1980) & 0x7F) << 9) |
                     (((date.getMonth() + 1) & 0x0F) << 5) |
                     (date.getDate() & 0x1F);
    return { time, date: datePart };
  }

  _crc32(data) {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < data.length; i++) {
      crc ^= data[i];
      for (let j = 0; j < 8; j++) {
        crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0);
      }
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }
}
