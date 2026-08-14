// Stream a large file through inspect / sha256 / search without slurping it.
// Default 256MB (guide §83). Override with RIO_LARGE_MB=1024 for a 1GB local soak.
import { openSync, writeSync, closeSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { inspectFile, sha256File, searchFileStream } from "@rio/tool-runtime";

const MB = Number(process.env.RIO_LARGE_MB ?? 256);
const NEEDLE = "RIO_LARGE_NEEDLE_FLAG{bounded_io}";

function rssMb(): number {
  return process.memoryUsage().rss / 1024 / 1024;
}

function writeChunked(path: string, megabytes: number): void {
  const fd = openSync(path, "w");
  try {
    const chunk = Buffer.alloc(1024 * 1024, 65); // 'A'
    for (let i = 0; i < megabytes; i++) {
      if (i === megabytes - 1) {
        const last = Buffer.alloc(1024 * 1024, 65);
        const tag = Buffer.from(`\n${NEEDLE}\n`);
        tag.copy(last, last.length - tag.length);
        writeSync(fd, last);
      } else {
        writeSync(fd, chunk);
      }
    }
  } finally {
    closeSync(fd);
  }
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "rio-large-"));
  const path = join(dir, "blob.bin");
  const t0 = Date.now();
  const rss0 = rssMb();
  writeChunked(path, MB);

  const heapBefore = process.memoryUsage().heapUsed;
  const tInspect0 = Date.now();
  const info = inspectFile(path);
  const inspectMs = Date.now() - tInspect0;

  const tHash0 = Date.now();
  const hash = sha256File(path);
  const hashMs = Date.now() - tHash0;

  const tSearch0 = Date.now();
  const hits = await searchFileStream(path, "RIO_LARGE_NEEDLE", 5);
  const searchMs = Date.now() - tSearch0;
  const heapAfter = process.memoryUsage().heapUsed;
  const heapDeltaMb = (heapAfter - heapBefore) / 1024 / 1024;
  const rss1 = rssMb();

  console.log(
    JSON.stringify(
      {
        sizeMB: MB,
        inspectSize: info.size,
        magic: info.magic,
        partialInspection: info.partialInspection === true,
        sha256: hash,
        hits: hits.length,
        inspectMs,
        hashMs,
        searchMs,
        heapDeltaMB: Number(heapDeltaMb.toFixed(1)),
        rssDeltaMB: Number((rss1 - rss0).toFixed(1)),
        peakRssMB: Number(rss1.toFixed(1)),
        durationMs: Date.now() - t0,
      },
      null,
      2,
    ),
  );

  rmSync(dir, { recursive: true, force: true });

  if (info.size !== MB * 1024 * 1024) throw new Error(`inspect size ${info.size} != ${MB}MB`);
  if (MB > 1 && info.partialInspection !== true) throw new Error("expected partialInspection for large file");
  if (hash.length !== 64) throw new Error("sha256 missing");
  if (hits.length < 1) throw new Error("search missed the needle at end of file");
  // Must not have loaded the whole file into V8 heap.
  if (heapDeltaMb > Math.min(64, MB / 2)) {
    throw new Error(`heap grew ${heapDeltaMb.toFixed(1)}MB while scanning ${MB}MB — not bounded`);
  }
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
