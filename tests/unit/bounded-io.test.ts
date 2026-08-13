// Streaming / bounded inspect-hash-search-chunk and zip/gzip limits.
import { describe, it, expect } from "vitest";
import { closeSync, ftruncateSync, mkdtempSync, openSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { gzipSync } from "node:zlib";
import { inspectFilePath, sha256File, searchFileStream, readFileChunk, extractGzipFile, extractZip } from "@rio/tool-runtime";

describe("bounded file IO", () => {
  it("hash / inspect / search / chunk on a ≥256MB sparse file do not load it whole", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rio-big-"));
    const path = join(dir, "huge.bin");
    const fd = openSync(path, "w");
    const size = 256 * 1024 * 1024;
    ftruncateSync(fd, size);
    writeSync(fd, Buffer.from("HEADHEADHEAD flag{head}"), 0, 23, 0);
    writeSync(fd, Buffer.from("TAILTAIL find-me"), 0, 16, size - 16);
    closeSync(fd);

    const t0 = Date.now();
    const hash = sha256File(path);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    const insp = inspectFilePath(path);
    expect(insp.size).toBe(size);
    expect(insp.partialInspection).toBe(true);
    expect(insp.inspectionSampleBytes!).toBeLessThan(size / 10);
    const matches = await searchFileStream(path, "find-me", 5);
    expect(matches.length).toBeGreaterThan(0);
    const { chunk, total } = await readFileChunk(path, 0, 32);
    expect(total).toBe(size);
    expect(chunk.length).toBeLessThanOrEqual(32);
    expect(chunk.length).toBeLessThan(size);
    expect(Date.now() - t0).toBeLessThan(30_000);
    rmSync(dir, { recursive: true, force: true });
  });

  it("ZIP/GZIP over expanded limit abort without holding the archive in RAM", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rio-bomb-"));
    const { makeZip } = await import("@rio/contest");
    const zip = makeZip([{ name: "tiny.txt", data: Buffer.from("x") }]);
    // Patch declared uncompressed size in CD (offset 24 of first CDH after EOCD scan).
    // Safer: extractZip checks declared sizes — craft via helper that sets uncompressedSize huge.
    const dest = join(dir, "out");
    expect(() => extractZipWithHugeDeclared(zip, dest)).toThrow(/maxExpandedBytes|maxSingleFile|zip bomb/i);

    const gz = gzipSync(Buffer.alloc(2 * 1024 * 1024, 65));
    const gzPath = join(dir, "a.gz");
    writeFileSync(gzPath, gz);
    await expect(extractGzipFile(gzPath, join(dir, "a.out"), 64 * 1024)).rejects.toThrow(/maxExpandedBytes|gzip bomb/i);
    rmSync(dir, { recursive: true, force: true });
  });
});

function extractZipWithHugeDeclared(zip: Buffer, dest: string): void {
  // Mutate first central-directory uncompressed size to 3GB so shipped extractZip aborts on metadata.
  let eocd = -1;
  for (let i = zip.length - 22; i >= 0; i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("no eocd");
  const cdOffset = zip.readUInt32LE(eocd + 16);
  zip.writeUInt32LE(3 * 1024 ** 3, cdOffset + 24);
  extractZip(zip, dest, { maxExpandedBytes: 2 * 1024 ** 3, maxSingleFile: 1 * 1024 ** 3 });
}
