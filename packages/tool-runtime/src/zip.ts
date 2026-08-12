// Minimal ZIP reader (STORE + DEFLATE, no encryption) — pure Node, no deps.
// Used for archive extraction inside the sandboxed tool runtime.
import { inflateRawSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, normalize, isAbsolute } from "node:path";

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

export function extractZipEntry(buf: Buffer, entry: ZipEntry): Buffer {
  if (entry.encrypted) throw new Error(`Encrypted entry not supported: ${entry.name}`);
  if (entry.method !== 0 && entry.method !== 8) {
    throw new Error(`Unsupported zip method ${entry.method} for ${entry.name}`);
  }
  // local header: sig(4) + ... nameLen(26) extraLen(28) then data
  const local = entry.localHeaderOffset;
  if (buf.readUInt32LE(local) !== 0x04034b50) throw new Error(`Bad local header for ${entry.name}`);
  const nameLen = buf.readUInt16LE(local + 26);
  const extraLen = buf.readUInt16LE(local + 28);
  const dataStart = local + 30 + nameLen + extraLen;
  const compressed = buf.subarray(dataStart, dataStart + entry.compressedSize);
  if (entry.method === 0) return Buffer.from(compressed);
  return inflateRawSync(compressed);
}

export interface ExtractOptions {
  maxDepth: number;
  maxFiles: number;
  maxExpandedBytes: number;
}

const DEFAULT_OPTS: ExtractOptions = { maxDepth: 8, maxFiles: 10_000, maxExpandedBytes: 2 * 1024 ** 3 };

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
  if (entries.length > o.maxFiles) throw new Error(`Zip has too many entries (${entries.length})`);
  const out: ExtractedFile[] = [];
  let total = 0;
  let count = 0;
  for (const entry of entries) {
    count++;
    if (count > o.maxFiles) throw new Error("maxFiles exceeded");
    const rel = safeEntryPath(entry.name);
    if (entry.isDirectory || rel === "") continue;
    const data = extractZipEntry(buf, entry);
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
