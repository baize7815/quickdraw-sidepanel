(() => {
  'use strict';

  const encoder = new TextEncoder();
  const crcTable = new Uint32Array(256);
  for (let value = 0; value < 256; value += 1) {
    let crc = value;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1);
    crcTable[value] = crc >>> 0;
  }

  function crc32(bytes) {
    let crc = 0xffffffff;
    for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  }

  function dosDateTime(date = new Date()) {
    const year = Math.max(1980, date.getFullYear());
    return {
      time: ((date.getHours() & 31) << 11) | ((date.getMinutes() & 63) << 5) | ((date.getSeconds() / 2) & 31),
      date: (((year - 1980) & 127) << 9) | (((date.getMonth() + 1) & 15) << 5) | (date.getDate() & 31)
    };
  }

  function localHeader(name, size, checksum, stamp) {
    const header = new Uint8Array(30 + name.length);
    const view = new DataView(header.buffer);
    view.setUint32(0, 0x04034b50, true);
    view.setUint16(4, 20, true);
    view.setUint16(6, 0x0800, true);
    view.setUint16(8, 0, true);
    view.setUint16(10, stamp.time, true);
    view.setUint16(12, stamp.date, true);
    view.setUint32(14, checksum, true);
    view.setUint32(18, size, true);
    view.setUint32(22, size, true);
    view.setUint16(26, name.length, true);
    view.setUint16(28, 0, true);
    header.set(name, 30);
    return header;
  }

  function centralHeader(name, size, checksum, stamp, offset) {
    const header = new Uint8Array(46 + name.length);
    const view = new DataView(header.buffer);
    view.setUint32(0, 0x02014b50, true);
    view.setUint16(4, 20, true);
    view.setUint16(6, 20, true);
    view.setUint16(8, 0x0800, true);
    view.setUint16(10, 0, true);
    view.setUint16(12, stamp.time, true);
    view.setUint16(14, stamp.date, true);
    view.setUint32(16, checksum, true);
    view.setUint32(20, size, true);
    view.setUint32(24, size, true);
    view.setUint16(28, name.length, true);
    view.setUint16(30, 0, true);
    view.setUint16(32, 0, true);
    view.setUint16(34, 0, true);
    view.setUint16(36, 0, true);
    view.setUint32(38, 0, true);
    view.setUint32(42, offset, true);
    header.set(name, 46);
    return header;
  }

  function endRecord(entryCount, centralSize, centralOffset) {
    const record = new Uint8Array(22);
    const view = new DataView(record.buffer);
    view.setUint32(0, 0x06054b50, true);
    view.setUint16(4, 0, true);
    view.setUint16(6, 0, true);
    view.setUint16(8, entryCount, true);
    view.setUint16(10, entryCount, true);
    view.setUint32(12, centralSize, true);
    view.setUint32(16, centralOffset, true);
    view.setUint16(20, 0, true);
    return record;
  }

  async function createZip(entries) {
    if (!Array.isArray(entries) || entries.length === 0) throw new Error('empty-zip');
    if (entries.length > 65535) throw new Error('too-many-zip-entries');
    const files = [];
    let totalSize = 0;
    for (const entry of entries) {
      const name = encoder.encode(String(entry.name || 'file'));
      const bytes = new Uint8Array(await entry.blob.arrayBuffer());
      totalSize += bytes.length;
      if (totalSize > 1_500_000_000) throw new Error('zip-too-large');
      files.push({ name, bytes, checksum: crc32(bytes), stamp: dosDateTime(entry.modifiedAt) });
    }

    const chunks = [];
    const central = [];
    let offset = 0;
    for (const file of files) {
      const header = localHeader(file.name, file.bytes.length, file.checksum, file.stamp);
      chunks.push(header, file.bytes);
      central.push(centralHeader(file.name, file.bytes.length, file.checksum, file.stamp, offset));
      offset += header.length + file.bytes.length;
    }
    const centralSize = central.reduce((sum, part) => sum + part.length, 0);
    return new Blob([...chunks, ...central, endRecord(files.length, centralSize, offset)], { type: 'application/zip' });
  }

  globalThis.QDZip = { createZip, crc32 };
})();
