// Minimal ZIP reader (STORE + DEFLATE, no encryption) — pure Node, no deps.
// Used for archive extraction inside the sandboxed tool runtime.
import { inflateRawSync, createInflateRaw } from "node:zlib";
import { createReadStream, createWriteStream, mkdirSync, writeFileSync, openSync, readSync, closeSync, statSync } from "node:fs";
import { join, normalize, isAbsolute } from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";

export interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
  crc32: number;
  encrypted: boolean;
  isDirectory: boolean;
}

export function listZipEntries(buf: Buffer): ZipEntry[] {
  // Find EOCD (0x06054b50) scanning backwards within the last 65557 bytes.
  let eocd = -1;
  const start = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= start; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("Not a zip file (no EOCD)");
  const count = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  const entries: ZipEntry[] = [];
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("Corrupt central directory");
    const method = buf.readUInt16LE(p + 10);
    const flags = buf.readUInt16LE(p + 8);
    const crc = buf.readUInt32LE(p + 16);
    const compSize = buf.readUInt32LE(p + 20);
    const uncompSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    entries.push({
      name,
      method,
      compressedSize: compSize,
      uncompressedSize: uncompSize,
      localHeaderOffset: localOffset,
      crc32: crc,
      encrypted: (flags & 1) === 1,
      isDirectory: name.endsWith("/"),
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

export function extractZipEntry(buf: Buffer, entry: ZipEntry, maxOutputLength?: number): Buffer {
  if (entry.encrypted) throw new Error(`Encrypted entry not supported: ${entry.name}`);
  if (entry.method !== 0 && entry.method !== 8) {
    throw new Error(`Unsupported zip method ${entry.method} for ${entry.name}`);
  }
  const local = entry.localHeaderOffset;
  if (buf.readUInt32LE(local) !== 0x04034b50) throw new Error(`Bad local header for ${entry.name}`);
  const nameLen = buf.readUInt16LE(local + 26);
  const extraLen = buf.readUInt16LE(local + 28);
  const dataStart = local + 30 + nameLen + extraLen;
  const compressed = buf.subarray(dataStart, dataStart + entry.compressedSize);
  if (entry.method === 0) {
    if (maxOutputLength !== undefined && compressed.length > maxOutputLength) {
      throw new Error(`maxExpandedBytes exceeded (zip bomb?): ${entry.name}`);
    }
    return Buffer.from(compressed);
  }
  const cap = maxOutputLength ?? entry.uncompressedSize + 64;
  return inflateRawSync(compressed, { maxOutputLength: cap });
}

export interface ExtractOptions {
  maxDepth: number;
  maxFiles: number;
  maxExpandedBytes: number;
  maxSingleFile: number;
}

const DEFAULT_OPTS: ExtractOptions = {
  maxDepth: 8,
  maxFiles: 10_000,
  maxExpandedBytes: 2 * 1024 ** 3,
  maxSingleFile: 1 * 1024 ** 3,
};

function assertZipBudget(entries: ZipEntry[], o: ExtractOptions): void {
  if (entries.length > o.maxFiles) throw new Error(`Zip has too many entries (${entries.length})`);
  let declared = 0;
  for (const e of entries) {
    if (e.encrypted) throw new Error(`Encrypted entry not supported: ${e.name}`);
    if (e.uncompressedSize > o.maxSingleFile) {
      throw new Error(`Zip entry exceeds maxSingleFile: ${e.name} (${e.uncompressedSize})`);
    }
    declared += e.uncompressedSize;
    if (declared > o.maxExpandedBytes) throw new Error("maxExpandedBytes exceeded (zip bomb?)");
  }
}

function safeEntryPath(entryName: string): string {
  const normalized = entryName.replaceAll("\\", "/");
  const parts = normalized.split("/").filter((p) => p !== "" && p !== ".");
  if (parts.some((p) => p === ".." || isAbsolute(p) || /^[a-zA-Z]:/.test(p))) {
    throw new Error(`Unsafe zip entry name: ${entryName}`);
  }
  return parts.join("/");
}

export interface ExtractedFile {
  path: string; // relative to destRoot
  size: number;
  nestedArchive: boolean;
}

/**
 * Recursively extract a zip into destRoot with bomb limits.
 * Nested archives (zip/7z/rar/gz) are reported so the caller can recurse.
 */
export function extractZip(
  buf: Buffer,
  destRoot: string,
  opts: Partial<ExtractOptions> = {},
  depth = 0,
): ExtractedFile[] {
  const o = { ...DEFAULT_OPTS, ...opts };
  if (depth > o.maxDepth) throw new Error(`Zip nesting exceeds maxDepth ${o.maxDepth}`);
  const entries = listZipEntries(buf);
  assertZipBudget(entries, o);
  const out: ExtractedFile[] = [];
  let total = 0;
  for (const entry of entries) {
    const rel = safeEntryPath(entry.name);
    if (entry.isDirectory || rel === "") continue;
    const remaining = o.maxExpandedBytes - total;
    const cap = Math.min(o.maxSingleFile, remaining + 1);
    const data = extractZipEntry(buf, entry, cap);
    total += data.length;
    if (total > o.maxExpandedBytes) throw new Error("maxExpandedBytes exceeded (zip bomb?)");
    const destPath = join(destRoot, rel);
    mkdirSync(join(destPath, ".."), { recursive: true });
    writeFileSync(destPath, data);
    const lower = entry.name.toLowerCase();
    out.push({
      path: rel,
      size: data.length,
      nestedArchive: /\.(zip|7z|rar|gz|bz2|xz|tar)$/.test(lower),
    });
  }
  return out;
}

export function isZip(buf: Buffer): boolean {
  return buf.length > 4 && buf.readUInt32LE(0) === 0x04034b50;
}

export function isGzip(buf: Buffer): boolean {
  return buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b;
}

export function normalizePathForExport(p: string): string {
  return normalize(p).replaceAll("\\", "/");
}

function readFileRange(path: string, start: number, length: number): Buffer {
  const st = statSync(path);
  if (start >= st.size || length <= 0) return Buffer.alloc(0);
  const fd = openSync(path, "r");
  try {
    const want = Math.min(length, st.size - start);
    const buf = Buffer.alloc(want);
    const n = readSync(fd, buf, 0, want, start);
    return n === want ? buf : buf.subarray(0, n);
  } finally {
    closeSync(fd);
  }
}

function parseCentralDirectory(buf: Buffer, cdOffsetInBuf: number, count: number): ZipEntry[] {
  const entries: ZipEntry[] = [];
  let p = cdOffsetInBuf;
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new Error("Corrupt central directory");
    const method = buf.readUInt16LE(p + 10);
    const flags = buf.readUInt16LE(p + 8);
    const crc = buf.readUInt32LE(p + 16);
    const compSize = buf.readUInt32LE(p + 20);
    const uncompSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    entries.push({
      name,
      method,
      compressedSize: compSize,
      uncompressedSize: uncompSize,
      localHeaderOffset: localOffset,
      crc32: crc,
      encrypted: (flags & 1) === 1,
      isDirectory: name.endsWith("/"),
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** List zip entries by reading EOCD + central directory from disk (not the whole file). */
export function listZipEntriesFromFile(path: string): ZipEntry[] {
  const size = statSync(path).size;
  const tailLen = Math.min(size, 65557);
  const tail = readFileRange(path, size - tailLen, tailLen);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("Not a zip file (no EOCD)");
  const count = tail.readUInt16LE(eocd + 10);
  const cdSize = tail.readUInt32LE(eocd + 12);
  const cdOffset = tail.readUInt32LE(eocd + 16);
  const cd = readFileRange(path, cdOffset, cdSize || count * 256 + 1024);
  return parseCentralDirectory(cd, 0, count);
}

async function inflateEntryToFile(
  src: string,
  entry: ZipEntry,
  destPath: string,
  remaining: number,
): Promise<number> {
  const local = readFileRange(src, entry.localHeaderOffset, 30);
  if (local.length < 30 || local.readUInt32LE(0) !== 0x04034b50) throw new Error(`Bad local header for ${entry.name}`);
  const nameLen = local.readUInt16LE(26);
  const extraLen = local.readUInt16LE(28);
  const dataStart = entry.localHeaderOffset + 30 + nameLen + extraLen;
  const dataEnd = dataStart + entry.compressedSize - 1;
  mkdirSync(join(destPath, ".."), { recursive: true });
  let bytes = 0;
  const counter = new Transform({
    transform(chunk, _enc, cb) {
      bytes += (chunk as Buffer).length;
      if (bytes > remaining) {
        cb(new Error(`maxExpandedBytes exceeded (zip bomb?): ${entry.name}`));
        return;
      }
      cb(null, chunk);
    },
  });
  const input = createReadStream(src, { start: dataStart, end: Math.max(dataStart, dataEnd) });
  const out = createWriteStream(destPath);
  if (entry.method === 0) {
    await pipeline(input, counter, out);
  } else if (entry.method === 8) {
    await pipeline(input, createInflateRaw(), counter, out);
  } else {
    throw new Error(`Unsupported zip method ${entry.method} for ${entry.name}`);
  }
  return bytes;
}

/** Stream-extract a zip from disk. Aborts before holding the expanded archive in RAM. */
export async function extractZipFromFile(
  src: string,
  destRoot: string,
  opts: Partial<ExtractOptions> = {},
): Promise<ExtractedFile[]> {
  const o = { ...DEFAULT_OPTS, ...opts };
  const entries = listZipEntriesFromFile(src);
  assertZipBudget(entries, o);
  const out: ExtractedFile[] = [];
  let total = 0;
  for (const entry of entries) {
    const rel = safeEntryPath(entry.name);
    if (entry.isDirectory || rel === "") continue;
    const destPath = join(destRoot, rel);
    const remaining = Math.min(o.maxSingleFile, o.maxExpandedBytes - total);
    const size = await inflateEntryToFile(src, entry, destPath, remaining);
    total += size;
    if (total > o.maxExpandedBytes) throw new Error("maxExpandedBytes exceeded (zip bomb?)");
    const lower = entry.name.toLowerCase();
    out.push({
      path: rel,
      size,
      nestedArchive: /\.(zip|7z|rar|gz|bz2|xz|tar)$/.test(lower),
    });
  }
  return out;
}
