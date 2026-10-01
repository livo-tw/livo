// Minimal read-only ZIP reader with ZIP64 support, built on node:fs random
// access + node:zlib — no dependencies, and no need to unpack a multi-GB Jira
// site backup just to read a few hundred attachments.
//
//   const zip = await openZip('backup.zip');
//   for (const entry of zip.entries) { … entry.name, entry.size … }
//   const bytes = await zip.read(entry);
//   await zip.close();
//
// Supported: stored (0) and deflated (8) entries, data descriptors, ZIP64
// sizes / offsets / end-of-central-directory. Not supported: encryption,
// multi-disk archives.

import fs from 'node:fs/promises';
import zlib from 'node:zlib';
import { promisify } from 'node:util';

const inflateRaw = promisify(zlib.inflateRaw);

const SIG_EOCD = 0x06054b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;
const SIG_ZIP64_EOCD = 0x06064b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;
const U32_MAX = 0xffffffff;
const U16_MAX = 0xffff;

function u64(buf, off) {
  const v = buf.readBigUInt64LE(off);
  if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('ZIP entry too large');
  return Number(v);
}

async function readAt(handle, position, length) {
  const buf = Buffer.alloc(length);
  let done = 0;
  while (done < length) {
    const { bytesRead } = await handle.read(buf, done, length - done, position + done);
    if (bytesRead === 0) throw new Error('Unexpected end of ZIP file');
    done += bytesRead;
  }
  return buf;
}

async function findEndOfCentralDirectory(handle, fileSize) {
  // EOCD is 22 bytes + a comment of up to 65535 bytes, at the very end.
  const tail = Math.min(fileSize, 22 + 0xffff);
  const buf = await readAt(handle, fileSize - tail, tail);
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) return { buf: buf.subarray(i), offset: fileSize - tail + i };
  }
  throw new Error('Not a ZIP file (end of central directory not found)');
}

export async function openZip(file) {
  const handle = await fs.open(file, 'r');
  try {
    const { size: fileSize } = await handle.stat();
    const { buf: eocd, offset: eocdOffset } = await findEndOfCentralDirectory(handle, fileSize);
    if (eocd.readUInt16LE(4) !== 0 && eocd.readUInt16LE(4) !== U16_MAX) {
      throw new Error('Multi-disk ZIP archives are not supported');
    }
    let count = eocd.readUInt16LE(10);
    let cdSize = eocd.readUInt32LE(12);
    let cdOffset = eocd.readUInt32LE(16);

    if (count === U16_MAX || cdSize === U32_MAX || cdOffset === U32_MAX) {
      // ZIP64: the locator sits right before the classic EOCD.
      const loc = await readAt(handle, eocdOffset - 20, 20);
      if (loc.readUInt32LE(0) !== SIG_ZIP64_LOCATOR) throw new Error('ZIP64 locator not found');
      const z64 = await readAt(handle, u64(loc, 8), 56);
      if (z64.readUInt32LE(0) !== SIG_ZIP64_EOCD) throw new Error('ZIP64 end of central directory not found');
      count = u64(z64, 32);
      cdSize = u64(z64, 40);
      cdOffset = u64(z64, 48);
    }

    const cd = await readAt(handle, cdOffset, cdSize);
    const entries = [];
    let p = 0;
    for (let n = 0; n < count; n++) {
      if (cd.readUInt32LE(p) !== SIG_CENTRAL) throw new Error('Corrupt ZIP central directory');
      const flags = cd.readUInt16LE(p + 8);
      const method = cd.readUInt16LE(p + 10);
      const crc32 = cd.readUInt32LE(p + 16);
      let compressedSize = cd.readUInt32LE(p + 20);
      let size = cd.readUInt32LE(p + 24);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      let localOffset = cd.readUInt32LE(p + 42);
      const nameBuf = cd.subarray(p + 46, p + 46 + nameLen);
      // Bit 11 = UTF-8 names; otherwise CP437 (ASCII for Jira's numeric paths).
      const name = flags & 0x800 ? nameBuf.toString('utf8') : nameBuf.toString('latin1');
      const extra = cd.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen);
      for (let e = 0; e + 4 <= extra.length; ) {
        const id = extra.readUInt16LE(e);
        const len = extra.readUInt16LE(e + 2);
        if (id === 0x0001) {
          // ZIP64 extra: only the fields that overflowed, in this order.
          let q = e + 4;
          if (size === U32_MAX) { size = u64(extra, q); q += 8; }
          if (compressedSize === U32_MAX) { compressedSize = u64(extra, q); q += 8; }
          if (localOffset === U32_MAX) { localOffset = u64(extra, q); q += 8; }
        }
        e += 4 + len;
      }
      entries.push({
        name,
        size,
        compressedSize,
        method,
        crc32,
        encrypted: (flags & 0x1) !== 0,
        directory: name.endsWith('/'),
        localOffset,
      });
      p += 46 + nameLen + extraLen + commentLen;
    }

    return {
      entries,
      async read(entry) {
        if (entry.encrypted) throw new Error(`Encrypted ZIP entry: ${entry.name}`);
        const local = await readAt(handle, entry.localOffset, 30);
        if (local.readUInt32LE(0) !== SIG_LOCAL) throw new Error(`Corrupt local header: ${entry.name}`);
        const start = entry.localOffset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
        const data = await readAt(handle, start, entry.compressedSize);
        let out;
        if (entry.method === 0) out = data;
        else if (entry.method === 8) out = await inflateRaw(data);
        else throw new Error(`Unsupported compression method ${entry.method}: ${entry.name}`);
        if (out.length !== entry.size) throw new Error(`Size mismatch: ${entry.name}`);
        if (typeof zlib.crc32 === 'function' && (zlib.crc32(out) >>> 0) !== entry.crc32) {
          throw new Error(`CRC mismatch: ${entry.name}`);
        }
        return out;
      },
      close: () => handle.close(),
    };
  } catch (err) {
    await handle.close();
    throw err;
  }
}
