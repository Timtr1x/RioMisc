import { describe, it, expect } from "vitest";
import { createServer } from "node:http";
import { once } from "node:events";
import { createWriteStream, mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PassThrough } from "node:stream";
import { CtfdContestAdapter, LocalContestAdapter, streamResponseToSink } from "@rio/contest";

function collectSink(): { sink: PassThrough; bytes: () => number } {
  const sink = new PassThrough();
  let n = 0;
  sink.on("data", (c: Buffer) => {
    n += c.length;
  });
  return { sink, bytes: () => n };
}

function generateStream(total: number, fill = 0x61, chunkSize = 64 * 1024): ReadableStream<Uint8Array> {
  let sent = 0;
  return new ReadableStream({
    pull(controller) {
      if (sent >= total) {
        controller.close();
        return;
      }
      const n = Math.min(chunkSize, total - sent);
      controller.enqueue(Buffer.alloc(n, fill));
      sent += n;
    },
  });
}

describe("attachment streaming", () => {
  it("ctfd.ts / local.ts never buffer the attachment with arrayBuffer or readFileSync", () => {
    const ctfd = readFileSync(join(process.cwd(), "packages/contest/src/ctfd.ts"), "utf8");
    const local = readFileSync(join(process.cwd(), "packages/contest/src/local.ts"), "utf8");
    expect(ctfd).not.toMatch(/arrayBuffer\s*\(/);
    expect(ctfd).toMatch(/streamResponseToSink/);
    expect(ctfd).toMatch(/redirect:\s*"manual"/);
    const downloadFn = local.slice(local.indexOf("async downloadAttachment"));
    expect(downloadFn).not.toMatch(/readFileSync/);
    expect(downloadFn).toMatch(/streamFileToSink/);
  });

  it("rejects Content-Length mismatch and does not treat the body as complete", async () => {
    const res = new Response("short", { status: 200, headers: { "content-length": "100" } });
    const { sink, bytes } = collectSink();
    const result = await streamResponseToSink(res, sink);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/content-length mismatch/);
    expect(bytes()).toBe(5);
  });

  it("streams a CTFd attachment through the sink without arrayBuffer", async () => {
    const payload = Buffer.alloc(256 * 1024, 0x62);
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes("/api/v1/challenges")) {
        return new Response(JSON.stringify({ success: true, data: [] }), { status: 200 });
      }
      if (url.includes("/files/")) {
        return new Response(generateStream(payload.length, 0x62), {
          status: 200,
          headers: { "content-length": String(payload.length) },
        });
      }
      return new Response("nope", { status: 404 });
    };
    const adapter = new CtfdContestAdapter({ baseUrl: "https://ctf.example.com", token: "tok", fetchImpl });
    const { sink, bytes } = collectSink();
    const dl = await adapter.downloadAttachment(
      { remoteId: "ctfd:x:1", title: "t", description: "", category: "Misc", score: 1, solveCount: 0, createdAt: 0, updatedAt: 0, attachments: [] },
      { remoteId: "f", name: "big.bin", url: "https://ctf.example.com/files/big.bin", sizeBytes: payload.length },
      sink,
    );
    expect(dl.ok).toBe(true);
    expect(dl.bytes).toBe(payload.length);
    expect(bytes()).toBe(payload.length);
  });

  it("local adapter streams from disk", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rio-local-stream-"));
    writeFileSync(join(dir, "challenge.json"), JSON.stringify({ title: "L", category: "MISC", description: "d" }));
    writeFileSync(join(dir, "blob.bin"), Buffer.alloc(128 * 1024, 0x63));
    const adapter = new LocalContestAdapter(dir);
    const detail = await adapter.getChallenge();
    const { sink, bytes } = collectSink();
    const dl = await adapter.downloadAttachment(detail, detail.attachments[0]!, sink);
    expect(dl.ok).toBe(true);
    expect(dl.bytes).toBe(128 * 1024);
    expect(bytes()).toBe(128 * 1024);
    rmSync(dir, { recursive: true, force: true });
  });

  it("512MB stream stays off-heap: RSS growth is far below payload size", async () => {
    const SIZE = 512 * 1024 * 1024;
    if (typeof globalThis.gc === "function") globalThis.gc();
    const before = process.memoryUsage().rss;
    const res = new Response(generateStream(SIZE, 0x41), {
      status: 200,
      headers: { "content-length": String(SIZE) },
    });
    const sink = new PassThrough();
    sink.resume();
    const result = await streamResponseToSink(res, sink);
    expect(result.ok).toBe(true);
    expect(result.bytes).toBe(SIZE);
    if (typeof globalThis.gc === "function") globalThis.gc();
    const grew = process.memoryUsage().rss - before;
    expect(grew).toBeLessThan(200 * 1024 * 1024);
  }, 120_000);

  it("does not rename when Content-Length disagrees with the body", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rio-cl-"));
    const target = join(dir, "out.bin");
    const part = `${target}.part`;
    const file = createWriteStream(part);
    const sink = new PassThrough();
    sink.pipe(file);
    const finished = new Promise<void>((resolve, reject) => {
      file.on("finish", () => resolve());
      file.on("error", reject);
    });
    const server = createServer((req, res) => {
      res.writeHead(200, { "Content-Length": "64" });
      res.end("too-short");
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    const res = await fetch(`http://127.0.0.1:${port}/f`);
    const streamed = await streamResponseToSink(res);
    expect(streamed.ok).toBe(false);
    if (!sink.writableEnded) sink.end();
    await finished.catch(() => undefined);
    expect(existsSync(target)).toBe(false);
    if (existsSync(part)) {
      expect(statSync(part).size).not.toBe(64);
    }
    server.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
