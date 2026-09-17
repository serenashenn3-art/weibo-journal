// 流式 ZIP 打包：CompressionStream 压缩 + OPFS 增量落盘，全程常数内存。
// 产出 OPFS File（磁盘支持），供 chrome.downloads 一次性下载；下载完成后调用 cleanup() 清理临时文件。

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32Step(c, u8) {
  for (let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xff] ^ (c >>> 8);
  return c >>> 0;
}

function dosDateTime(d = new Date()) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = (((d.getFullYear() - 1980) & 0x7f) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

// entries: [{ name: 'images/2025/09/x.jpg', blob: Blob }], onProgress(done, total) 可选
// 返回 { file, cleanup }；file.size 可能超过内存承载，请以磁盘视角对待
export async function createZipStreaming(entries, onProgress) {
  if (!navigator.storage || !navigator.storage.getDirectory) throw new Error('当前环境不支持 OPFS');
  const useDeflate = typeof CompressionStream !== 'undefined';
  const method = useDeflate ? 8 : 0; // 8=deflate-raw, 0=store
  const root = await navigator.storage.getDirectory();
  const tmpName = `wj-${Date.now()}.zip`;
  const fh = await root.getFileHandle(tmpName, { create: true });
  const sink = await fh.createWritable();
  const enc = new TextEncoder();
  const central = [];
  let offset = 0;
  const { time, date } = dosDateTime();

  try {
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      const name = enc.encode(e.name);
      // 本地文件头（flag bit3：crc 与大小写在数据后的 data descriptor 里）
      const h = new DataView(new ArrayBuffer(30));
      h.setUint32(0, 0x04034b50, true);
      h.setUint16(4, 20, true);
      h.setUint16(6, 0x0808, true); // UTF-8 文件名 + data descriptor
      h.setUint16(8, method, true);
      h.setUint16(10, time, true);
      h.setUint16(12, date, true);
      h.setUint16(26, name.length, true);
      await sink.write(new Uint8Array(h.buffer));
      await sink.write(name);

      let crc = 0xffffffff;
      let usize = 0;
      let csize = 0;
      if (useDeflate) {
        const cs = new CompressionStream('deflate-raw');
        const pump = (async () => {
          const w = cs.writable.getWriter();
          try {
            for await (const chunk of e.blob.stream()) {
              crc = crc32Step(crc, chunk);
              usize += chunk.length;
              await w.write(chunk);
            }
          } finally {
            await w.close();
          }
        })();
        const r = cs.readable.getReader();
        try {
          for (;;) {
            const { done, value } = await r.read();
            if (done) break;
            await sink.write(value);
            csize += value.length;
          }
        } finally {
          r.releaseLock();
        }
        await pump;
      } else {
        for await (const chunk of e.blob.stream()) {
          crc = crc32Step(crc, chunk);
          usize += chunk.length;
          csize += chunk.length;
          await sink.write(chunk);
        }
      }
      crc = (crc ^ 0xffffffff) >>> 0;

      const dd = new DataView(new ArrayBuffer(16));
      dd.setUint32(0, 0x08074b50, true);
      dd.setUint32(4, crc, true);
      dd.setUint32(8, csize, true);
      dd.setUint32(12, usize, true);
      await sink.write(new Uint8Array(dd.buffer));

      central.push({ name, crc, csize, usize, offset });
      offset += 30 + name.length + csize + 16;
      if (onProgress && (i + 1) % 100 === 0) onProgress(i + 1, entries.length);
    }

    const cdStart = offset;
    for (const c of central) {
      const h = new DataView(new ArrayBuffer(46));
      h.setUint32(0, 0x02014b50, true);
      h.setUint16(4, 20, true);
      h.setUint16(6, 20, true);
      h.setUint16(8, 0x0808, true);
      h.setUint16(10, method, true);
      h.setUint16(12, time, true);
      h.setUint16(14, date, true);
      h.setUint32(16, c.crc, true);
      h.setUint32(20, c.csize, true);
      h.setUint32(24, c.usize, true);
      h.setUint16(28, c.name.length, true);
      h.setUint32(42, c.offset, true);
      await sink.write(new Uint8Array(h.buffer));
      await sink.write(c.name);
      offset += 46 + c.name.length;
    }
    const cdSize = offset - cdStart;
    const eocd = new DataView(new ArrayBuffer(22));
    eocd.setUint32(0, 0x06054b50, true);
    eocd.setUint16(8, central.length, true);
    eocd.setUint16(10, central.length, true);
    eocd.setUint32(12, cdSize, true);
    eocd.setUint32(16, cdStart, true);
    await sink.write(new Uint8Array(eocd.buffer));
  } finally {
    await sink.close();
  }

  const file = await fh.getFile();
  const cleanup = async () => {
    try { await root.removeEntry(tmpName); } catch (e) { /* 清理失败无碍 */ }
  };
  return { file, cleanup };
}
