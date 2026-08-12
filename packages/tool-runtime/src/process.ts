// ProcessRunner — every command execution goes through here (§50).
// Never uses shell:true with user strings; executable + args[], timeouts,
// output caps, resource classes.
import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { ResourceType } from "@rio/domain";

export interface ProcessOptions {
  cwd: string;
  timeoutMs: number;
  maxStdoutBytes: number;
  maxStderrBytes: number;
  envAllowlist: string[];
  extraEnv?: Record<string, string>;
  resourceTypes?: ResourceType[];
}

export interface ProcessResult {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  durationMs: number;
  fullOutputPath: string | null;
  timedOut: boolean;
  signal: NodeJS.Signals | null;
}

export const DEFAULT_TIMEOUTS = {
  tool: 30_000,
  python: 60_000,
  sage: 180_000,
  heavy: 300_000,
};

function cap(s: string, max: number): { text: string; truncated: boolean } {
  if (s.length <= max) return { text: s, truncated: false };
  return { text: s.slice(0, max), truncated: true };
}

export class ProcessRunner {
  /**
   * Run `executable args[]` in cwd. Returns bounded stdout/stderr inline;
   * when output exceeds limits it is also written to fullOutputPath.
   */
  run(executable: string, args: string[], opts: ProcessOptions, fullOutputPath?: string): Promise<ProcessResult> {
    return new Promise((resolvePromise) => {
      const start = Date.now();
      let stdoutChunks: Buffer[] = [];
      let stderrChunks: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let stdoutTruncated = false;
      let stderrTruncated = false;
      let timedOut = false;
      let fullStream: ReturnType<typeof createWriteStream> | null = null;

      if (fullOutputPath) {
        mkdirSync(dirname(resolve(fullOutputPath)), { recursive: true });
        fullStream = createWriteStream(resolve(fullOutputPath));
      }

      const env: Record<string, string> = {};
      for (const key of opts.envAllowlist) {
        if (process.env[key] !== undefined) env[key] = process.env[key]!;
      }
      Object.assign(env, opts.extraEnv);

      let child: ChildProcess;
      try {
        child = spawn(executable, args, {
          cwd: opts.cwd,
          env,
          shell: false,
          windowsHide: true,
        });
      } catch (e) {
        resolvePromise({
          ok: false,
          exitCode: null,
          stdout: "",
          stderr: String(e),
          stdoutTruncated: false,
          stderrTruncated: false,
          durationMs: Date.now() - start,
          fullOutputPath: null,
          timedOut: false,
          signal: null,
        });
        return;
      }

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, opts.timeoutMs);

      const collect = (chunk: Buffer, isStdout: boolean) => {
        const current = isStdout ? stdoutBytes : stderrBytes;
        const max = isStdout ? opts.maxStdoutBytes : opts.maxStderrBytes;
        if (current < max) {
          const slice = chunk.subarray(0, max - current);
          if (isStdout) {
            stdoutChunks.push(slice);
            stdoutBytes += slice.length;
          } else {
            stderrChunks.push(slice);
            stderrBytes += slice.length;
          }
          if (current + chunk.length > max) {
            if (isStdout) stdoutTruncated = true;
            else stderrTruncated = true;
          }
        } else {
          if (isStdout) stdoutTruncated = true;
          else stderrTruncated = true;
        }
        fullStream?.write(chunk);
      };

      child.stdout?.on("data", (c: Buffer) => collect(c, true));
      child.stderr?.on("data", (c: Buffer) => collect(c, false));

      child.on("error", (e) => {
        clearTimeout(timer);
        fullStream?.end();
        resolvePromise({
          ok: false,
          exitCode: null,
          stdout: cap(Buffer.concat(stdoutChunks).toString("utf8"), opts.maxStdoutBytes).text,
          stderr: `${stderrChunks.length ? cap(Buffer.concat(stderrChunks).toString("utf8"), opts.maxStderrBytes).text + "\n" : ""}spawn error: ${e.message}`,
          stdoutTruncated,
          stderrTruncated,
          durationMs: Date.now() - start,
          fullOutputPath: fullOutputPath ?? null,
          timedOut,
          signal: null,
        });
      });

      child.on("close", (code, signal) => {
        clearTimeout(timer);
        fullStream?.end();
        const out = cap(Buffer.concat(stdoutChunks).toString("utf8"), opts.maxStdoutBytes);
        const err = cap(Buffer.concat(stderrChunks).toString("utf8"), opts.maxStderrBytes);
        resolvePromise({
          ok: code === 0 && !timedOut,
          exitCode: code,
          stdout: out.text,
          stderr: err.text,
          stdoutTruncated: out.truncated || stdoutTruncated,
          stderrTruncated: err.truncated || stderrTruncated,
          durationMs: Date.now() - start,
          fullOutputPath: fullOutputPath ?? null,
          timedOut,
          signal,
        });
      });
    });
  }
}
