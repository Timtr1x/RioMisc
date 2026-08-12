// The Agent Tool Registry (§45, §48, §49).
// Every tool: zod-validated params → safeResolve inside workspace → bounded output.
// Long outputs are saved to results/tool-<n>.txt and referenced, never inline.
import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { createHash } from "node:crypto";
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
import { inspectFile, entropy, pcapSummary, pngDimensions, detectMagic } from "./inspect.js";
import { extractZip, isZip, isGzip } from "./zip.js";

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
  allowNetwork: boolean;
}

function ok<T>(summary: string, data: T, durationMs: number, extra: Partial<ToolResult<T>> = {}): ToolResult<T> {
  return { ok: true, summary, data, durationMs, ...extra };
}

function fail(code: string, message: string, durationMs: number, extra: Partial<ToolResult> = {}): ToolResult {
  return { ok: false, summary: message, durationMs, error: { code, message }, ...extra };
}

function fileArtifact(ctx: ToolContext, absPath: string): ArtifactRef {
  const st = statSync(absPath);
  return { path: relative(ctx.workspace.root, absPath).replaceAll("\\", "/"), size: st.size, sha256: sha256File(absPath) };
}

export function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
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
    const buf = readFileSync(abs);
    const max = p.data.maxChars ?? MAX_INLINE_CHARS;
    const text = buf.toString("utf8");
    const truncated = text.length > max;
    const out = truncated ? text.slice(0, max) + `\n... [truncated ${text.length - max} chars]` : text;
    return Promise.resolve(ok("file read", { path: p.data.path, size: buf.length, text: out }, Date.now() - started, { truncated }));
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
    return Promise.resolve(ok(`listed ${entries.length} entries in ${rel}`, { path: rel, entries }, Date.now() - started));
  } catch (e) {
    return Promise.resolve(fail("FS", String(e), Date.now() - started));
  }
}

export function writeWorkFile(ctx: ToolContext, params: unknown): Promise<ToolResult> {
  const started = Date.now();
  const p = writeWorkFileParamsSchema.safeParse(params);
  if (!p.success) return Promise.resolve(fail("VALIDATION", p.error.issues[0]?.message ?? "bad params", 0));
  try {
    const abs = ctx.safeResolve(p.data.path);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, p.data.content, "utf8");
    const ref = ctx.recordArtifact("write_work_file", abs) ?? fileArtifact(ctx, abs);
    return Promise.resolve(ok(`wrote ${p.data.path} (${p.data.content.length} bytes)`, { path: p.data.path }, Date.now() - started, { artifacts: [ref] }));
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
    const insp = inspectFile(abs);
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
    const buf = readFileSync(abs);
    const destRel = p.data.destPath ?? "artifacts/extracted";
    const destAbs = ctx.safeResolve(destRel);
    mkdirSync(destAbs, { recursive: true });
    if (isZip(buf)) {
      const files = extractZip(buf, destAbs, { maxDepth: p.data.maxDepth ?? 8 });
      const refs = files.slice(0, 50).map((f) => fileArtifact(ctx, join(destAbs, f.path)));
      return ok(
        `extracted ${files.length} entries to ${destRel}${files.some((f) => f.nestedArchive) ? " (nested archives present — extract again)" : ""}`,
        { dest: destRel, count: files.length, nested: files.filter((f) => f.nestedArchive).map((f) => f.path) },
        Date.now() - started,
        { artifacts: refs },
      );
    }
    if (isGzip(buf)) {
      // simple .gz — write decompressed next to it
      const { gunzipSync } = await import("node:zlib");
      const outPath = join(destAbs, (p.data.path.split(/[\\/]/).pop() ?? "file").replace(/\.gz$/i, ""));
      writeFileSync(outPath, gunzipSync(buf));
      const ref = ctx.recordArtifact("extract_archive", outPath) ?? fileArtifact(ctx, outPath);
      return ok(`gunzipped to ${relative(ctx.workspace.root, outPath).replaceAll("\\", "/")}`, { dest: destRel }, Date.now() - started, { artifacts: [ref] });
    }
    return fail("UNSUPPORTED_ARCHIVE", `not a supported archive: ${detectMagic(buf)}`, Date.now() - started);
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
    if (p.data.code) {
      return runner
        .run(pyp, ["-c", p.data.code, ...(p.data.args ?? [])], { cwd: ctx.workspace.work, timeoutMs: timeout, maxStdoutBytes: MAX_TOOL_OUTPUT_BYTES, maxStderrBytes: 1024 * 1024, envAllowlist }, fullPath)
        .then((r) => processResult(ctx, "run_python", r, started, timeout));
    }
    const abs = ctx.safeResolve(p.data.scriptPath!);
    return runner
      .run(pyp, [abs, ...(p.data.args ?? [])], { cwd: ctx.workspace.work, timeoutMs: timeout, maxStdoutBytes: MAX_TOOL_OUTPUT_BYTES, maxStderrBytes: 1024 * 1024, envAllowlist }, fullPath)
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
  const summary = truncated ? out.slice(0, 400) : out;
  return {
    ok: true,
    summary: `command finished (${elapsed}ms, exit 0)${truncated ? " — output truncated, use search_tool_output / read_tool_output_chunk" : ""}`,
    data: { stdout: truncated ? out.slice(0, MAX_INLINE_CHARS) : out, truncated },
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

export function searchToolOutput(ctx: ToolContext, params: unknown): Promise<ToolResult> {
  const started = Date.now();
  const schema = z.object({ path: z.string().max(1000), query: z.string().min(1).max(200), maxMatches: z.number().int().min(1).max(200).optional() });
  const p = schema.safeParse(params);
  if (!p.success) return Promise.resolve(fail("VALIDATION", p.error.issues[0]?.message ?? "bad params", 0));
  try {
    const abs = ctx.safeResolve(p.data.path);
    if (!existsSync(abs) || !statSync(abs).isFile()) return Promise.resolve(fail("NOT_FOUND", `no such file: ${p.data.path}`, Date.now() - started));
    const text = readFileSync(abs, "utf8");
    const lines = text.split("\n");
    const matches: { line: number; text: string }[] = [];
    const max = p.data.maxMatches ?? 50;
    for (let i = 0; i < lines.length && matches.length < max; i++) {
      if (lines[i]!.toLowerCase().includes(p.data.query.toLowerCase())) {
        matches.push({ line: i + 1, text: lines[i]!.slice(0, 500) });
      }
    }
    return Promise.resolve(ok(`found ${matches.length} matches for "${p.data.query}"`, { path: p.data.path, matches }, Date.now() - started));
  } catch (e) {
    return Promise.resolve(fail("FS", String(e), Date.now() - started));
  }
}

export function readToolOutputChunk(ctx: ToolContext, params: unknown): Promise<ToolResult> {
  const started = Date.now();
  const schema = z.object({ path: z.string().max(1000), offset: z.number().int().min(0).optional(), maxChars: z.number().int().min(100).max(100_000).optional() });
  const p = schema.safeParse(params);
  if (!p.success) return Promise.resolve(fail("VALIDATION", p.error.issues[0]?.message ?? "bad params", 0));
  try {
    const abs = ctx.safeResolve(p.data.path);
    if (!existsSync(abs) || !statSync(abs).isFile()) return Promise.resolve(fail("NOT_FOUND", `no such file: ${p.data.path}`, Date.now() - started));
    const text = readFileSync(abs, "utf8");
    const offset = p.data.offset ?? 0;
    const max = p.data.maxChars ?? 8000;
    const chunk = text.slice(offset, offset + max);
    return Promise.resolve(ok(`chunk ${offset}..${offset + chunk.length}/${text.length}`, { path: p.data.path, offset, chunk, totalLength: text.length }, Date.now() - started));
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
  { name: "read_challenge_file", description: "Read a file inside the challenge workspace (input/, artifacts/, results/)", schema: readFileParamsSchema, run: readChallengeFile },
  { name: "list_workspace", description: "List files in the challenge workspace", schema: listWorkspaceParamsSchema, run: listWorkspace },
  { name: "write_work_file", description: "Write a script or note into work/ (preserved as reproducible evidence)", schema: writeWorkFileParamsSchema, run: writeWorkFile },
  { name: "inspect_file", description: "Magic bytes, size, sha256, entropy, image dims, pcap summary", schema: inspectFileParamsSchema, run: inspectFileTool },
  { name: "extract_archive", description: "Extract a zip (or gunzip) into artifacts/ with bomb limits", schema: extractArchiveParamsSchema, run: extractArchive },
  { name: "run_python", description: "Run python code or a script inside the workspace (prefer writing solve.py to work/ first)", schema: runPythonParamsSchema, run: runPython },
  { name: "search_tool_output", description: "Search a saved tool output file for a substring", schema: z.object({ path: z.string().max(1000), query: z.string().min(1).max(200), maxMatches: z.number().int().min(1).max(200).optional() }), run: searchToolOutput },
  { name: "read_tool_output_chunk", description: "Read a chunk of a saved tool output file", schema: z.object({ path: z.string().max(1000), offset: z.number().int().min(0).optional(), maxChars: z.number().int().min(100).max(100_000).optional() }), run: readToolOutputChunk },
  { name: "report_progress", description: "Report progress/hypotheses to the control plane (~every 2 minutes or on major discoveries)", schema: reportProgressParamsSchema, run: reportProgressTool },
  { name: "submit_flag_candidate", description: "Propose a flag candidate (confidence 0..1, reason required). The control plane verifies and submits.", schema: submitFlagCandidateParamsSchema, run: submitFlagCandidateTool },
  { name: "request_handoff", description: "Ask the control plane to hand off to another solver domain", schema: requestHandoffParamsSchema, run: requestHandoffTool },
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
