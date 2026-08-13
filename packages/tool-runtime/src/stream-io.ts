// Bounded / streaming IO for files whose size is not under our control.
import { createHash } from "node:crypto";
import {
  createReadStream,
  createWriteStream,
  openSync,
  readSync,
  closeSync,
  statSync,
  existsSync,
} from "node:fs";
import { createGunzip } from "node:zlib";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

const SAMPLE = 64 * 1024;

/** Streaming SHA-256. Never loads the whole file into one Buffer. */
export function sha256File(path: string): string {
  const fd = openSync(path, "r");
  const hash = createHash("sha256");
  const buf = Buffer.alloc(64 * 1024);
  try {
    let n: number;
    while ((n = readSync(fd, buf, 0, buf.length, null)) > 0) {
      hash.update(buf.subarray(0, n));
    }
    return hash.digest("hex");
  } finally {
    closeSync(fd);
  }
}

export async function sha256FileStream(path: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(
    createReadStream(path),
    new Transform({
      transform(chunk, _enc, cb) {
        hash.update(chunk as Buffer);
        cb();
      },
    }),
  );
  return hash.digest("hex");
}

export function readFileWindow(path: string, start: number, length: number): Buffer {
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

export async function readFileChunk(path: string, start: number, maxBytes: number): Promise<{ chunk: Buffer; total: number }> {
  const total = statSync(path).size;
  if (start >= total || maxBytes <= 0) return { chunk: Buffer.alloc(0), total };
  const end = Math.min(start + maxBytes, total) - 1;
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    const s = createReadStream(path, { start, end });
    s.on("data", (c: string | Buffer) => chunks.push(typeof c === "string" ? Buffer.from(c) : c));
    s.on("end", () => resolve());
    s.on("error", reject);
  });
  return { chunk: Buffer.concat(chunks), total };
}

export async function searchFileStream(
  path: string,
  query: string,
  maxMatches: number,
): Promise<{ line: number; text: string }[]> {
  const matches: { line: number; text: string }[] = [];
  const q = query.toLowerCase();
  const maxLine = 256 * 1024;
  await new Promise<void>((resolve, reject) => {
    const s = createReadStream(path, { encoding: "utf8", highWaterMark: 64 * 1024 });
    let carry = "";
    let lineNo = 1;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    const consider = (line: string) => {
      if (line.toLowerCase().includes(q)) {
        matches.push({ line: lineNo, text: line.slice(0, 500) });
      }
      lineNo += 1;
      if (matches.length >= maxMatches) {
        s.destroy();
        finish();
      }
    };
    s.on("data", (chunk: string | Buffer) => {
      if (done) return;
      carry += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      let start = 0;
      while (start < carry.length) {
        const nl = carry.indexOf("\n", start);
        if (nl < 0) break;
        consider(carry.slice(start, nl).replace(/\r$/, ""));
        if (done) return;
        start = nl + 1;
      }
      carry = carry.slice(start);
      while (carry.length > maxLine && !done) {
        consider(carry.slice(0, maxLine));
        carry = carry.slice(maxLine - Math.max(q.length, 1));
      }
    });
    s.on("end", () => {
      if (!done && carry.length) consider(carry.replace(/\r$/, ""));
      finish();
    });
    s.on("error", (e) => {
      if (!done) {
        done = true;
        reject(e);
      }
    });
    s.on("close", finish);
  });
  return matches;
}

export interface BoundedSamples {
  size: number;
  head: Buffer<ArrayBufferLike>;
  middle: Buffer<ArrayBufferLike> | null;
  tail: Buffer<ArrayBufferLike>;
  inspectionSampleBytes: number;
  partialInspection: boolean;
}

export function sampleFileWindows(path: string, window = SAMPLE): BoundedSamples {
  const size = statSync(path).size;
  const head = readFileWindow(path, 0, Math.min(window, size));
  let middle: Buffer<ArrayBufferLike> | null = null;
  let tail: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  let sampled = head.length;
  if (size > window * 2) {
    const midStart = Math.max(0, Math.floor(size / 2) - Math.floor(window / 2));
    middle = readFileWindow(path, midStart, window);
    sampled += middle.length;
    tail = readFileWindow(path, Math.max(0, size - window), window);
    sampled += tail.length;
  } else if (size > window) {
    tail = readFileWindow(path, Math.max(0, size - window), window);
    sampled += tail.length;
  } else {
    tail = head;
  }
  return {
    size,
    head,
    middle,
    tail,
    inspectionSampleBytes: sampled,
    partialInspection: size > sampled,
  };
}

/** Stream-gunzip to dest. Aborts if expanded bytes exceed maxExpandedBytes. */
export async function extractGzipFile(src: string, dest: string, maxExpandedBytes: number): Promise<{ bytes: number }> {
  if (!existsSync(src)) throw new Error(`no such file: ${src}`);
  let bytes = 0;
  const counter = new Transform({
    transform(chunk, _enc, cb) {
      bytes += (chunk as Buffer).length;
      if (bytes > maxExpandedBytes) {
        cb(new Error(`maxExpandedBytes exceeded (gzip bomb?): ${bytes}`));
        return;
      }
      cb(null, chunk);
    },
  });
  try {
    await pipeline(createReadStream(src), createGunzip(), counter, createWriteStream(dest));
  } catch (e) {
    try {
      const { unlinkSync } = await import("node:fs");
      unlinkSync(dest);
    } catch {
      /* ignore */
    }
    throw e;
  }
  return { bytes };
}
