// Minimal ZIP/ZIP64 generator (store method, no compression, UTF-8 filenames).
// ZIP64 is used automatically when a file, offset, central directory,
// or entry count exceeds ZIP32 limits.
(() => {
  const U32_MAX = 0xffffffffn;
  const U16_MAX = 0xffff;
  const CRC_TABLE = new Uint32Array(256).map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });

  function crc32(bytes) {
    let crc = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  }

  function dosDateTime(date) {
    const year = Math.max(1980, Math.min(2107, date.getFullYear()));
    const time = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
    const day = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
    return { time, day };
  }

  function asBytes(content, enc) {
    if (typeof content === "string") return enc.encode(content);
    if (content instanceof Uint8Array) return content;
    if (content instanceof ArrayBuffer) return new Uint8Array(content);
    if (ArrayBuffer.isView(content)) return new Uint8Array(content.buffer, content.byteOffset, content.byteLength);
    throw new TypeError("Contenu ZIP non pris en charge");
  }

  function zip64Extra(values) {
    if (!values.length) return new Uint8Array(0);
    const b = new ArrayBuffer(4 + values.length * 8);
    const v = new DataView(b);
    v.setUint16(0, 0x0001, true);
    v.setUint16(2, values.length * 8, true);
    values.forEach((x, i) => v.setBigUint64(4 + i * 8, BigInt(x), true));
    return new Uint8Array(b);
  }

  // files : tableau de { name: string, content: string | Uint8Array | ArrayBuffer }
  function buildZip(files) {
    const enc = new TextEncoder();
    const { time, day } = dosDateTime(new Date());
    const chunks = [];
    const central = [];
    let offset = 0n;
    let anyZip64Entry = false;

    for (const file of files) {
      const name = enc.encode(file.name);
      if (name.length > U16_MAX) throw new Error(`ZIP filename is too long: ${file.name.slice(0, 80)}`);
      const data = asBytes(file.content, enc);
      const size = BigInt(data.byteLength);
      const largeSize = size > U32_MAX;
      const largeOffset = offset > U32_MAX;
      const needsZip64 = largeSize || largeOffset;
      anyZip64Entry ||= needsZip64;
      const crc = crc32(data);

      const localExtra = largeSize ? zip64Extra([size, size]) : new Uint8Array(0);
      const local = new DataView(new ArrayBuffer(30));
      local.setUint32(0, 0x04034b50, true);
      local.setUint16(4, needsZip64 ? 45 : 20, true);
      local.setUint16(6, 0x0800, true);
      local.setUint16(8, 0, true);
      local.setUint16(10, time, true);
      local.setUint16(12, day, true);
      local.setUint32(14, crc, true);
      local.setUint32(18, largeSize ? 0xffffffff : Number(size), true);
      local.setUint32(22, largeSize ? 0xffffffff : Number(size), true);
      local.setUint16(26, name.length, true);
      local.setUint16(28, localExtra.length, true);
      chunks.push(local.buffer, name, localExtra, data);

      const centralValues = [];
      if (largeSize) centralValues.push(size, size);
      if (largeOffset) centralValues.push(offset);
      const centralExtra = zip64Extra(centralValues);
      const cd = new DataView(new ArrayBuffer(46));
      cd.setUint32(0, 0x02014b50, true);
      cd.setUint16(4, needsZip64 ? 45 : 20, true);
      cd.setUint16(6, needsZip64 ? 45 : 20, true);
      cd.setUint16(8, 0x0800, true);
      cd.setUint16(10, 0, true);
      cd.setUint16(12, time, true);
      cd.setUint16(14, day, true);
      cd.setUint32(16, crc, true);
      cd.setUint32(20, largeSize ? 0xffffffff : Number(size), true);
      cd.setUint32(24, largeSize ? 0xffffffff : Number(size), true);
      cd.setUint16(28, name.length, true);
      cd.setUint16(30, centralExtra.length, true);
      cd.setUint16(32, 0, true);
      cd.setUint16(34, 0, true);
      cd.setUint16(36, 0, true);
      cd.setUint32(38, 0, true);
      cd.setUint32(42, largeOffset ? 0xffffffff : Number(offset), true);
      central.push(cd.buffer, name, centralExtra);

      offset += BigInt(30 + name.length + localExtra.length) + size;
    }

    const cdOffset = offset;
    let cdSize = 0n;
    for (const c of central) cdSize += BigInt(c.byteLength);
    const count = BigInt(files.length);
    const needsZip64Archive = anyZip64Entry || count > BigInt(U16_MAX) || cdOffset > U32_MAX || cdSize > U32_MAX;
    const trailer = [];

    if (needsZip64Archive) {
      const zip64Offset = cdOffset + cdSize;
      const z64 = new DataView(new ArrayBuffer(56));
      z64.setUint32(0, 0x06064b50, true);
      z64.setBigUint64(4, 44n, true); // record size after this field
      z64.setUint16(12, 45, true);
      z64.setUint16(14, 45, true);
      z64.setUint32(16, 0, true);
      z64.setUint32(20, 0, true);
      z64.setBigUint64(24, count, true);
      z64.setBigUint64(32, count, true);
      z64.setBigUint64(40, cdSize, true);
      z64.setBigUint64(48, cdOffset, true);
      trailer.push(z64.buffer);

      const loc = new DataView(new ArrayBuffer(20));
      loc.setUint32(0, 0x07064b50, true);
      loc.setUint32(4, 0, true);
      loc.setBigUint64(8, zip64Offset, true);
      loc.setUint32(16, 1, true);
      trailer.push(loc.buffer);
    }

    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(4, 0, true);
    end.setUint16(6, 0, true);
    end.setUint16(8, count > BigInt(U16_MAX) ? U16_MAX : Number(count), true);
    end.setUint16(10, count > BigInt(U16_MAX) ? U16_MAX : Number(count), true);
    end.setUint32(12, cdSize > U32_MAX ? 0xffffffff : Number(cdSize), true);
    end.setUint32(16, cdOffset > U32_MAX ? 0xffffffff : Number(cdOffset), true);
    end.setUint16(20, 0, true);
    trailer.push(end.buffer);

    return new Blob([...chunks, ...central, ...trailer], { type: "application/zip" });
  }

  function tarBytes(content, enc) {
    if (typeof content === "string") return enc.encode(content);
    if (content instanceof Uint8Array) return content;
    if (content instanceof ArrayBuffer) return new Uint8Array(content);
    if (ArrayBuffer.isView(content)) return new Uint8Array(content.buffer, content.byteOffset, content.byteLength);
    throw new TypeError("Unsupported TAR content");
  }

  function tarField(value, length, enc, numeric = false) {
    const text = numeric ? `${Number(value).toString(8).padStart(length - 1, "0")}\0` : String(value || "");
    const bytes = enc.encode(text).subarray(0, length);
    const out = new Uint8Array(length);
    out.set(bytes);
    return out;
  }

  function buildTar(files) {
    const enc = new TextEncoder();
    const chunks = [];
    for (const file of files) {
      const data = tarBytes(file.content, enc);
      const name = enc.encode(file.name);
      if (name.length > 100) throw new Error(`TAR filename is too long: ${file.name}`);
      const header = new Uint8Array(512);
      header.set(tarField(file.name, 100, enc), 0);
      header.set(tarField(0o644, 8, enc, true), 100);
      header.set(tarField(0, 8, enc, true), 108);
      header.set(tarField(0, 8, enc, true), 116);
      header.set(tarField(data.byteLength, 12, enc, true), 124);
      header.set(tarField(Math.floor(Date.now() / 1000), 12, enc, true), 136);
      header.fill(0x20, 148, 156);
      header[156] = 0x30;
      header.set(tarField("ustar", 6, enc), 257);
      header.set(tarField("00", 2, enc), 263);
      let checksum = 0;
      for (const byte of header) checksum += byte;
      // POSIX TAR checksums use six octal digits, a NUL byte, and a space.
      // Padding this field is important because Joplin validates it strictly.
      const checksumField = `${checksum.toString(8).padStart(6, "0")}\0 `;
      header.set(tarField(checksumField, 8, enc), 148);
      chunks.push(header, data);
      const padding = (512 - (data.byteLength % 512)) % 512;
      if (padding) chunks.push(new Uint8Array(padding));
    }
    chunks.push(new Uint8Array(1024));
    return new Blob(chunks, { type: "application/x-tar" });
  }

  globalThis.CGX_buildZip = buildZip;
  globalThis.CGX_buildTar = buildTar;
})();
