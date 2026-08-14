// Stream an HTTP body or Node readable into an optional sink without
// buffering the whole payload. Content-Length mismatch is a hard fail so
// the caller never atomically promotes a truncated .part file.
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createReadStream } from "node:fs";
import type { Readable, Writable } from "node:stream";

export interface StreamBodyResult {
  ok: boolean;
  bytes: number;
  sha256: string;
  contentLength: number | null;
  retryable: boolean;
  message?: string;
}

export async function writeChunk(sink: Writable | undefined, chunk: Buffer): Promise<void> {
  if (!sink) return;
  if (sink.destroyed || sink.writableEnded) return;
  const ok = sink.write(chunk);
  if (!ok) await once(sink, "drain");
}

export async function streamResponseToSink(
  res: Response,
  sink?: Writable,
  opts: { maxBytes?: number } = {},
): Promise<StreamBodyResult> {
  const rawLen = res.headers.get("content-length");
  const contentLength = rawLen != null && rawLen !== "" ? Number(rawLen) : null;
  if (contentLength !== null && !Number.isFinite(contentLength)) {
    return { ok: false, bytes: 0, sha256: "", contentLength: null, retryable: false, message: "invalid Content-Length" };
  }
  if (contentLength !== null && opts.maxBytes != null && contentLength > opts.maxBytes) {
    return {
      ok: false,
      bytes: 0,
      sha256: "",
      contentLength,
      retryable: false,
      message: `Content-Length ${contentLength} exceeds max ${opts.maxBytes}`,
    };
  }

  const hash = createHash("sha256");
  let bytes = 0;

  if (!res.body) {
    const sha256 = hash.digest("hex");
    if (contentLength !== null && contentLength !== 0) {
      return { ok: false, bytes: 0, sha256, contentLength, retryable: true, message: `content-length mismatch: got 0, expected ${contentLength}` };
    }
    return { ok: true, bytes: 0, sha256, contentLength, retryable: false };
  }

  const reader = res.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      hash.update(chunk);
      bytes += chunk.length;
      if (opts.maxBytes != null && bytes > opts.maxBytes) {
        try {
          await reader.cancel();
        } catch {
          /* ignore */
        }
        return {
          ok: false,
          bytes,
          sha256: hash.digest("hex"),
          contentLength,
          retryable: false,
          message: `response exceeded max ${opts.maxBytes}`,
        };
      }
      await writeChunk(sink, chunk);
    }
  } catch (e) {
    return {
      ok: false,
      bytes,
      sha256: hash.digest("hex"),
      contentLength,
      retryable: true,
      message: e instanceof Error ? e.message : String(e),
    };
  }

  const sha256 = hash.digest("hex");
  if (contentLength !== null && bytes !== contentLength) {
    return {
      ok: false,
      bytes,
      sha256,
      contentLength,
      retryable: true,
      message: `content-length mismatch: got ${bytes}, expected ${contentLength}`,
    };
  }
  return { ok: true, bytes, sha256, contentLength, retryable: false };
}

export async function streamFileToSink(path: string, sink?: Writable): Promise<StreamBodyResult> {
  const hash = createHash("sha256");
  let bytes = 0;
  const readable: Readable = createReadStream(path);
  try {
    for await (const chunk of readable) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      hash.update(buf);
      bytes += buf.length;
      await writeChunk(sink, buf);
    }
  } catch (e) {
    return {
      ok: false,
      bytes,
      sha256: hash.digest("hex"),
      contentLength: null,
      retryable: true,
      message: e instanceof Error ? e.message : String(e),
    };
  }
  return { ok: true, bytes, sha256: hash.digest("hex"), contentLength: null, retryable: false };
}
