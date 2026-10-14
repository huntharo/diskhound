import * as Zlib from "node:zlib";

export interface UnzippedEntry {
  name: string;
  data: Buffer;
  /** Unix mode bits from the central directory. */
  mode: number;
}

/** Read a zip through its central directory, inflating each entry and checking its CRC. */
export function unzip(archive: Buffer): UnzippedEntry[] {
  const end = archive.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end < 0) throw new Error("No end of central directory");
  const count = archive.readUInt16LE(end + 10);
  let at = archive.readUInt32LE(end + 16);
  const entries: UnzippedEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (archive.readUInt32LE(at) !== 0x02014b50) throw new Error(`Bad central directory entry at ${at}`);
    const method = archive.readUInt16LE(at + 10);
    const crc = archive.readUInt32LE(at + 16);
    const compressed = archive.readUInt32LE(at + 20);
    const nameLength = archive.readUInt16LE(at + 28);
    const extraLength = archive.readUInt16LE(at + 30);
    const commentLength = archive.readUInt16LE(at + 32);
    const external = archive.readUInt32LE(at + 38);
    const local = archive.readUInt32LE(at + 42);
    const name = archive.toString("utf8", at + 46, at + 46 + nameLength);
    if (archive.readUInt32LE(local) !== 0x04034b50) throw new Error(`Bad local header for ${name}`);
    const start = local + 30 + archive.readUInt16LE(local + 26) + archive.readUInt16LE(local + 28);
    const raw = archive.subarray(start, start + compressed);
    const data = method === 8 ? Zlib.inflateRawSync(raw) : Buffer.from(raw);
    if (Zlib.crc32(data) !== crc) throw new Error(`CRC mismatch for ${name}`);
    entries.push({ name, data, mode: (external >>> 16) & 0o7777 });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}
