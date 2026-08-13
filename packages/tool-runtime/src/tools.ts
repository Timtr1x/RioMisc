// The Agent Tool Registry (§45, §48, §49).
// Every tool: zod-validated params → safeResolve inside workspace → bounded output.
// Long outputs are saved to results/tool-<n>.txt and referenced, never inline.
import { writeFileSync, readdirSync, statSync, mkdirSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { z } from "zod";
import {
  readFileParamsSchema,
  listWorkspaceParamsSchema,
  writeWorkFileParamsSchema,
  inspectFileParamsSchema,
  extractArchiveParamsSchema,
  runPythonParamsSchema,
  reportProgressParamsSchema,
  submitFlagCandidateParamsSchema,
  requestHandoffParamsSchema,
  requestReflectionParamsSchema,
} from "@rio/domain";
import { WorkspaceManager, type WorkspaceLayout } from "./workspace.js";
import { ProcessRunner, type ProcessResult, DEFAULT_TIMEOUTS } from "./process.js";
import { inspectFilePath, detectMagic } from "./inspect.js";
import { extractZipFromFile, isZip, isGzip } from "./zip.js";
import { sha256File, readFileWindow, readFileChunk, searchFileStream, extractGzipFile } from "./stream-io.js";

export const MAX_INLINE_CHARS = 12_000;
export const MAX_TOOL_OUTPUT_BYTES = 64 * 1024 * 1024;

export interface ArtifactRef {
  path: string;
  size: number;
  sha256: string;
}

export interface ToolResult<T = unknown> {
  ok: boolean;
  summary: string;
  data?: T;
  artifacts?: ArtifactRef[];
  fullOutputPath?: string | null;
  truncated?: boolean;
  durationMs: number;
  error?: { code: string; message: string };
}

export interface ToolCall<T = unknown> {
  name: string;
  params: T;
}

export interface AgentEmit {
  (kind: "progress" | "candidate" | "handoff" | "reflection" | "error", payload: Record<string, unknown>): void;
}

export interface ToolContext {
  challengeId: string;
  workspace: WorkspaceLayout;
  sessionId: string | null;
  safeResolve(path: string): string;
  emit: AgentEmit;
  recordArtifact(op: string, absPath: string, parent?: string | null): ArtifactRef | null;
  nextResultFile(): string;
  pythonExecutable: string;
  /** Deprecated: native mode cannot enforce this. Kept so old callers compile. */
  allowNetwork?: boolean;
  networkIsolation?: "NONE";
}

function ok<T>(summary: string, data: T, durationMs: number, extra: Partial<ToolResult<T>> = {}): ToolResult<T> {
  return { ok: true, summary, data, durationMs, ...extra };
}

/**
 * Text the LLM actually sees. Must include `data` (file contents, listings,
 * python stdout). Sending only `summary` ("file read" / "command finished")
 * makes the model wander the empty work/ directory forever.
 */
export function formatToolResultForModel(result: ToolResult, maxChars = MAX_INLINE_CHARS): string {
  const payload: Record<string, unknown> = {
    ok: result.ok,
    summary: result.summary,
  };
  if (result.data !== undefined) payload.data = result.data;
  if (result.fullOutputPath) payload.fullOutputPath = result.fullOutputPath;
  if (result.truncated) payload.truncated = true;
  if (result.error) payload.error = result.error;
  if (result.artifacts?.length) payload.artifacts = result.artifacts;
  let text = JSON.stringify(payload, null, 2);
  if (text.length > maxChars) text = `${text.slice(0, maxChars)}\n…(truncated, ${text.length} chars total)`;
  return text;
}

/** Scripts/notes go under work/ unless the caller already picked a writable dir. */
export function normalizeWorkPath(requested: string): string {
  const norm = requested.replaceAll("\\", "/").replace(/^\.\//, "");
  if (!norm || norm === ".") return "work/untitled.txt";
  if (
    norm.startsWith("work/") ||
    norm.startsWith("artifacts/") ||
    norm.startsWith("results/") ||
    norm.startsWith("tmp/") ||
    norm.startsWith("state/")
  ) {
    return norm;
  }
  if (norm.startsWith("input/") || norm === "challenge.txt") {
    return `work/${norm.replace(/^input\//, "")}`;
  }
  return `work/${norm}`;
}

function fail(code: string, message: string, durationMs: number, extra: Partial<ToolResult> = {}): ToolResult {
  return { ok: false, summary: message, durationMs, error: { code, message }, ...extra };
}

function fileArtifact(ctx: ToolContext, absPath: string): ArtifactRef {
  const st = statSync(absPath);
  return { path: relative(ctx.workspace.root, absPath).replaceAll("\\", "/"), size: st.size, sha256: sha256File(absPath) };
}



// ---------------------------------------------------------------------------
// Individual tools
// ---------------------------------------------------------------------------

export interface ToolImpl {
  name: string;
  description: string;
  schema: z.ZodType;
  maxInlineChars?: number;
  run(ctx: ToolContext, params: unknown, meta: { toolIndex: number; startedAt: number }): Promise<ToolResult>;
}

export function readChallengeFile(ctx: ToolContext, params: unknown): Promise<ToolResult> {
  const started = Date.now();
  const p = readFileParamsSchema.safeParse(params);
  if (!p.success) return Promise.resolve(fail("VALIDATION", p.error.issues[0]?.message ?? "bad params", 0));
  try {
    const abs = ctx.safeResolve(p.data.path);
    if (!existsSync(abs) || !statSync(abs).isFile()) return Promise.resolve(fail("NOT_FOUND", `no such file: ${p.data.path}`, Date.now() - started));
    const st = statSync(abs);
    const max = p.data.maxChars ?? MAX_INLINE_CHARS;
    const buf = readFileWindow(abs, 0, max + 1);
    const text = buf.toString("utf8");
    const truncated = st.size > max || text.length > max;
    const out = truncated ? text.slice(0, max) + `\n... [truncated, file is ${st.size} bytes]` : text;
    return Promise.resolve(ok("file read", { path: p.data.path, size: st.size, text: out }, Date.now() - started, { truncated }));
  } catch (e) {
    return Promise.resolve(fail("FS", String(e), Date.now() - started));
  }
}

export function listWorkspace(ctx: ToolContext, params: unknown): Promise<ToolResult> {
  const started = Date.now();
  const p = listWorkspaceParamsSchema.safeParse(params);
  if (!p.success) return Promise.resolve(fail("VALIDATION", p.error.issues[0]?.message ?? "bad params", 0));
  try {
    const abs = ctx.safeResolve(p.data.path ?? ".");
    if (!existsSync(abs)) return Promise.resolve(fail("NOT_FOUND", `no such dir: ${p.data.path ?? "."}`, Date.now() - started));
    const entries = readdirSync(abs).map((name) => {
      const st = statSync(join(abs, name));
      return { name, dir: st.isDirectory(), size: st.isFile() ? st.size : null };
    });
    const rel = relative(ctx.workspace.root, abs).replaceAll("\\", "/") || ".";
    const names = entries.map((e) => (e.dir ? `${e.name}/` : `${e.name}${e.size !== null ? ` (${e.size}B)` : ""}`)).join(", ");
    // Root listing also peeks into input/ so the model sees attachments immediately.
    const children: Record<string, { name: string; dir: boolean; size: number | null }[]> = {};
    if (rel === ".") {
      for (const peek of ["input", "work", "artifacts"]) {
        const peekAbs = join(abs, peek);
        if (existsSync(peekAbs) && statSync(peekAbs).isDirectory()) {
          children[peek] = readdirSync(peekAbs).map((name) => {
            const st = statSync(join(peekAbs, name));
            return { name, dir: st.isDirectory(), size: st.isFile() ? st.size : null };
          });
        }
      }
    }
    const peekSummary = Object.entries(children)
      .map(([dir, list]) => `${dir}/: ${list.map((e) => e.name).join(", ") || "(empty)"}`)
      .join("; ");
    return Promise.resolve(
      ok(
        `listed ${entries.length} entries in ${rel}: ${names || "(empty)"}${peekSummary ? ` | ${peekSummary}` : ""}`,
        { path: rel, entries, children: Object.keys(children).length ? children : undefined },
        Date.now() - started,
      ),
    );
  } catch (e) {
    return Promise.resolve(fail("FS", String(e), Date.now() - started));
  }
}

export function writeWorkFile(ctx: ToolContext, params: unknown): Promise<ToolResult> {
  const started = Date.now();
  const p = writeWorkFileParamsSchema.safeParse(params);
  if (!p.success) return Promise.resolve(fail("VALIDATION", p.error.issues[0]?.message ?? "bad params", 0));
  try {
    const dest = normalizeWorkPath(p.data.path);
    const abs = ctx.safeResolve(dest);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, p.data.content, "utf8");
    const ref = ctx.recordArtifact("write_work_file", abs) ?? fileArtifact(ctx, abs);
    return Promise.resolve(ok(`wrote ${dest} (${p.data.content.length} bytes)`, { path: dest }, Date.now() - started, { artifacts: [ref] }));
  } catch (e) {
    return Promise.resolve(fail("FS", String(e), Date.now() - started));
  }
}

export function inspectFileTool(ctx: ToolContext, params: unknown): Promise<ToolResult> {
  const started = Date.now();
  const p = inspectFileParamsSchema.safeParse(params);
  if (!p.success) return Promise.resolve(fail("VALIDATION", p.error.issues[0]?.message ?? "bad params", 0));
  try {
    const abs = ctx.safeResolve(p.data.path);
    if (!existsSync(abs) || !statSync(abs).isFile()) return Promise.resolve(fail("NOT_FOUND", `no such file: ${p.data.path}`, Date.now() - started));
    const insp = inspectFilePath(abs);
    return Promise.resolve(ok("inspection done", insp, Date.now() - started));
  } catch (e) {
    return Promise.resolve(fail("FS", String(e), Date.now() - started));
  }
}

export async function extractArchive(ctx: ToolContext, params: unknown): Promise<ToolResult> {
  const started = Date.now();
  const p = extractArchiveParamsSchema.safeParse(params);
  if (!p.success) return fail("VALIDATION", p.error.issues[0]?.message ?? "bad params", 0);
  try {
    const abs = ctx.safeResolve(p.data.path);
    if (!existsSync(abs) || !statSync(abs).isFile()) return fail("NOT_FOUND", `no such file: ${p.data.path}`, Date.now() - started);
    const destRel = p.data.destPath ?? "artifacts/extracted";
    const destAbs = ctx.safeResolve(destRel);
    mkdirSync(destAbs, { recursive: true });
    const head = readFileWindow(abs, 0, 8);
    if (isZip(head)) {
      const files = await extractZipFromFile(abs, destAbs, { maxDepth: p.data.maxDepth ?? 8 });
      const refs = files.slice(0, 50).map((f) => fileArtifact(ctx, join(destAbs, f.path)));
      return ok(
        `extracted ${files.length} entries to ${destRel}${files.some((f) => f.nestedArchive) ? " (nested archives present — extract again)" : ""}`,
        { dest: destRel, count: files.length, nested: files.filter((f) => f.nestedArchive).map((f) => f.path) },
        Date.now() - started,
        { artifacts: refs },
      );
    }
    if (isGzip(head)) {
      const outPath = join(destAbs, (p.data.path.split(/[\\/]/).pop() ?? "file").replace(/\.gz$/i, "") || "gunzipped.bin");
      await extractGzipFile(abs, outPath, 2 * 1024 ** 3);
      const ref = ctx.recordArtifact("extract_archive", outPath) ?? fileArtifact(ctx, outPath);
      return ok(`gunzipped to ${relative(ctx.workspace.root, outPath).replaceAll("\\", "/")}`, { dest: destRel }, Date.now() - started, { artifacts: [ref] });
    }
    return fail("UNSUPPORTED_ARCHIVE", `not a supported archive: ${detectMagic(head)}`, Date.now() - started);
  } catch (e) {
    return fail("ARCHIVE", String(e), Date.now() - started);
  }
}

export function runPython(ctx: ToolContext, params: unknown, meta: { toolIndex: number; startedAt: number }): Promise<ToolResult> {
  const started = meta.startedAt;
  const p = runPythonParamsSchema.safeParse(params);
  if (!p.success) return Promise.resolve(fail("VALIDATION", p.error.issues[0]?.message ?? "bad params", 0));
  const runner = new ProcessRunner();
  const timeout = p.data.timeoutMs ?? DEFAULT_TIMEOUTS.python;
  const fullPath = ctx.nextResultFile();
  const envAllowlist = ["PATH", "PYTHONPATH", "HOME", "USERPROFILE", "APPDATA", "SystemRoot", "TEMP", "TMP"];
  const pyp = ctx.pythonExecutable;
  try {
    // cwd = workspace root so open("input/foo.zip") and open("work/solve.py") both work.
    // Running in empty work/ made every real model session spend itself on os.listdir(".").
    const cwd = ctx.workspace.root;
    if (p.data.code) {
      return runner
        .run(pyp, ["-c", p.data.code, ...(p.data.args ?? [])], { cwd, timeoutMs: timeout, maxStdoutBytes: MAX_TOOL_OUTPUT_BYTES, maxStderrBytes: 1024 * 1024, envAllowlist }, fullPath)
        .then((r) => processResult(ctx, "run_python", r, started, timeout));
    }
    const abs = ctx.safeResolve(p.data.scriptPath!);
    return runner
      .run(pyp, [abs, ...(p.data.args ?? [])], { cwd, timeoutMs: timeout, maxStdoutBytes: MAX_TOOL_OUTPUT_BYTES, maxStderrBytes: 1024 * 1024, envAllowlist }, fullPath)
      .then((r) => processResult(ctx, "run_python", r, started, timeout));
  } catch (e) {
    return Promise.resolve(fail("FS", String(e), Date.now() - started));
  }
}

function processResult(ctx: ToolContext, op: string, r: ProcessResult, started: number, timeout: number): ToolResult {
  const elapsed = Date.now() - started;
  const out = combineOutput(r);
  if (!r.ok) {
    return fail("EXIT", r.timedOut ? `timed out after ${timeout}ms` : `exit code ${r.exitCode ?? "?"}`, elapsed, {
      data: { stdout: r.stdout, stderr: r.stderr },
      fullOutputPath: r.fullOutputPath,
      truncated: r.stdoutTruncated || r.stderrTruncated,
    });
  }
  const truncated = out.length > MAX_INLINE_CHARS;
  const stdout = truncated ? out.slice(0, MAX_INLINE_CHARS) : out;
  return {
    ok: true,
    summary: truncated
      ? `command finished (${elapsed}ms, exit 0) — output truncated, use search_tool_output / read_tool_output_chunk`
      : `command finished (${elapsed}ms, exit 0)\n${stdout.slice(0, 2000)}`,
    data: { stdout, stderr: r.stderr, truncated },
    fullOutputPath: r.fullOutputPath,
    truncated,
    durationMs: elapsed,
  };
}

function combineOutput(r: ProcessResult): string {
  const parts: string[] = [];
  if (r.stdout) parts.push(r.stdout);
  if (r.stderr) parts.push(r.stderr);
  return parts.join("\n");
}

export async function searchToolOutput(ctx: ToolContext, params: unknown): Promise<ToolResult> {
  const started = Date.now();
  const schema = z.object({ path: z.string().max(1000), query: z.string().min(1).max(200), maxMatches: z.number().int().min(1).max(200).optional() });
  const p = schema.safeParse(params);
  if (!p.success) return Promise.resolve(fail("VALIDATION", p.error.issues[0]?.message ?? "bad params", 0));
  try {
    const abs = ctx.safeResolve(p.data.path);
    if (!existsSync(abs) || !statSync(abs).isFile()) return Promise.resolve(fail("NOT_FOUND", `no such file: ${p.data.path}`, Date.now() - started));
    const max = p.data.maxMatches ?? 50;
    const matches = await searchFileStream(abs, p.data.query, max);
    return ok(`found ${matches.length} matches for "${p.data.query}"`, { path: p.data.path, matches }, Date.now() - started);
  } catch (e) {
    return Promise.resolve(fail("FS", String(e), Date.now() - started));
  }
}

export async function readToolOutputChunk(ctx: ToolContext, params: unknown): Promise<ToolResult> {
  const started = Date.now();
  const schema = z.object({ path: z.string().max(1000), offset: z.number().int().min(0).optional(), maxChars: z.number().int().min(100).max(100_000).optional() });
  const p = schema.safeParse(params);
  if (!p.success) return Promise.resolve(fail("VALIDATION", p.error.issues[0]?.message ?? "bad params", 0));
  try {
    const abs = ctx.safeResolve(p.data.path);
    if (!existsSync(abs) || !statSync(abs).isFile()) return Promise.resolve(fail("NOT_FOUND", `no such file: ${p.data.path}`, Date.now() - started));
    const offset = p.data.offset ?? 0;
    const max = p.data.maxChars ?? 8000;
    const { chunk, total } = await readFileChunk(abs, offset, max);
    const text = chunk.toString("utf8");
    return ok(`chunk ${offset}..${offset + text.length}/${total}`, { path: p.data.path, offset, chunk: text, totalLength: total }, Date.now() - started);
  } catch (e) {
    return Promise.resolve(fail("FS", String(e), Date.now() - started));
  }
}

export function reportProgressTool(ctx: ToolContext, params: unknown): Promise<ToolResult> {
  const started = Date.now();
  const p = reportProgressParamsSchema.safeParse(params);
  if (!p.success) return Promise.resolve(fail("VALIDATION", p.error.issues[0]?.message ?? "bad params", 0));
  ctx.emit("progress", {
    challengeId: ctx.challengeId,
    sessionId: ctx.sessionId,
    ...p.data,
    hypotheses: p.data.hypotheses ?? [],
    confirmedFacts: p.data.confirmedFacts ?? [],
    rejectedHypotheses: p.data.rejectedHypotheses ?? [],
    nextActions: p.data.nextActions ?? [],
    progress: p.data.progress ?? "NONE",
    stalled: p.data.stalled ?? false,
  });
  return Promise.resolve(ok("progress reported", { acknowledged: true }, Date.now() - started));
}

export function submitFlagCandidateTool(ctx: ToolContext, params: unknown): Promise<ToolResult> {
  const started = Date.now();
  const p = submitFlagCandidateParamsSchema.safeParse(params);
  if (!p.success) return Promise.resolve(fail("VALIDATION", p.error.issues[0]?.message ?? "bad params", 0));
  ctx.emit("candidate", {
    challengeId: ctx.challengeId,
    sessionId: ctx.sessionId,
    ...p.data,
    evidence: p.data.evidence ?? [],
  });
  return Promise.resolve(ok("candidate submitted for verification", { acknowledged: true }, Date.now() - started));
}

export function requestHandoffTool(ctx: ToolContext, params: unknown): Promise<ToolResult> {
  const started = Date.now();
  const p = requestHandoffParamsSchema.safeParse(params);
  if (!p.success) return Promise.resolve(fail("VALIDATION", p.error.issues[0]?.message ?? "bad params", 0));
  ctx.emit("handoff", { challengeId: ctx.challengeId, sessionId: ctx.sessionId, ...p.data });
  return Promise.resolve(ok("handoff requested", { acknowledged: true }, Date.now() - started));
}

export function requestReflectionTool(ctx: ToolContext, params: unknown): Promise<ToolResult> {
  const started = Date.now();
  const p = requestReflectionParamsSchema.safeParse(params);
  if (!p.success) return Promise.resolve(fail("VALIDATION", p.error.issues[0]?.message ?? "bad params", 0));
  ctx.emit("reflection", { challengeId: ctx.challengeId, sessionId: ctx.sessionId, ...p.data });
  return Promise.resolve(ok("reflection requested", { acknowledged: true }, Date.now() - started));
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export const TOOL_IMPLS: ToolImpl[] = [
  { name: "read_challenge_file", description: "Read a file in the workspace. Paths are relative to the workspace ROOT (not work/). Examples: challenge.txt, input/task.zip, artifacts/extracted/flag.txt", schema: readFileParamsSchema, run: readChallengeFile },
  { name: "list_workspace", description: "List a directory in the workspace. Omit path or use '.' for the root (challenge.txt, input/, work/, artifacts/). Do not use Python os.listdir to find files — use this tool.", schema: listWorkspaceParamsSchema, run: listWorkspace },
  { name: "write_work_file", description: "Write a script or note. Bare names are placed under work/ (solve.py → work/solve.py).", schema: writeWorkFileParamsSchema, run: writeWorkFile },
  { name: "inspect_file", description: "Magic bytes, size, sha256, entropy, image dims, pcap summary. Use on every attachment first.", schema: inspectFileParamsSchema, run: inspectFileTool },
  { name: "extract_archive", description: "Extract a zip (or gunzip) into artifacts/ with zip-bomb limits. path e.g. input/task.zip", schema: extractArchiveParamsSchema, run: extractArchive },
  { name: "run_python", description: "Run Python. cwd is the workspace ROOT, so open('input/foo.zip') and open('work/solve.py') both work. Prefer writing work/solve.py then scriptPath='work/solve.py'.", schema: runPythonParamsSchema, run: runPython },
  { name: "search_tool_output", description: "Search a saved tool output file for a substring", schema: z.object({ path: z.string().max(1000), query: z.string().min(1).max(200), maxMatches: z.number().int().min(1).max(200).optional() }), run: searchToolOutput },
  { name: "read_tool_output_chunk", description: "Read a chunk of a saved tool output file", schema: z.object({ path: z.string().max(1000), offset: z.number().int().min(0).optional(), maxChars: z.number().int().min(100).max(100_000).optional() }), run: readToolOutputChunk },
  { name: "report_progress", description: "Report progress/hypotheses to the control plane (~every 2 minutes or on major discoveries)", schema: reportProgressParamsSchema, run: reportProgressTool },
  { name: "submit_flag_candidate", description: "Propose a flag candidate (confidence 0..1, reason required). You cannot submit to the contest yourself — the control plane verifies and submits.", schema: submitFlagCandidateParamsSchema, run: submitFlagCandidateTool },
  { name: "request_handoff", description: "Ask the control plane to hand off to another solver domain (MISC or CRYPTO)", schema: requestHandoffParamsSchema, run: requestHandoffTool },
  { name: "request_reflection", description: "Request a reflection pass when stuck", schema: requestReflectionParamsSchema, run: requestReflectionTool },
];

export function toolNames(): string[] {
  return TOOL_IMPLS.map((t) => t.name);
}

export async function runTool(ctx: ToolContext, name: string, params: unknown): Promise<ToolResult> {
  const impl = TOOL_IMPLS.find((t) => t.name === name);
  if (!impl) return { ok: false, summary: `unknown tool ${name}`, durationMs: 0, error: { code: "UNKNOWN_TOOL", message: name } };
  return impl.run(ctx, params, { toolIndex: 0, startedAt: Date.now() });
}
