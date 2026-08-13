// Solver system prompts (§62) — one common core + per-domain sections.
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const PROMPTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "prompts");

function load(name: string): string {
  return readFileSync(join(PROMPTS_DIR, name), "utf8");
}

export const COMMON_PROMPT = load("common.md");
export const MISC_PROMPT = load("misc.md");
export const CRYPTO_PROMPT = load("crypto.md");
export const TRIAGE_PROMPT = load("triage.md");
export const REFLECTION_PROMPT = load("reflection.md");

export function systemPromptFor(solverType: "MISC" | "CRYPTO"): string {
  const domain = solverType === "MISC" ? MISC_PROMPT : CRYPTO_PROMPT;
  return `${COMMON_PROMPT}\n\n${domain}`;
}

/** First user message: inline the statement so the model does not have to discover the disk. */
export function buildKickoffMessage(opts: {
  challengeText: string;
  inputFiles: { name: string; sizeBytes: number | null }[];
  extraNote?: string;
}): string {
  const files =
    opts.inputFiles.length === 0
      ? "(none — data may be entirely in the description)"
      : opts.inputFiles.map((f) => `- input/${f.name}${f.sizeBytes !== null ? ` (${f.sizeBytes} bytes)` : ""}`).join("\n");
  const extra = opts.extraNote ? `\n${opts.extraNote}\n` : "";
  return `You are already inside this challenge's workspace. Do not search for the project root.

LAYOUT (paths for every tool are relative to this root):
  challenge.txt   — problem statement (also inlined below)
  input/          — original attachments (treat as read-only)
  work/           — write scripts here
  artifacts/      — extracted / generated files
  results/        — long tool outputs

INPUT FILES:
${files}

CHALLENGE:
${opts.challengeText}
${extra}
Start with list_workspace path="." and inspect_file / extract_archive on the attachments.
Python cwd is the workspace root: open("input/<file>") works. Do not os.listdir(".") hoping to find the flag.
When you have a credible flag, call submit_flag_candidate (do not try to submit to the contest yourself).
Call report_progress when direction changes.`;
}

/** challenge.txt written into each challenge workspace for the solver. */
export function buildChallengeFile(opts: {
  title: string;
  description: string;
  category: string;
  attachments: { name: string; localPath: string | null; sizeBytes: number | null }[];
  hints: string[];
  wrongFlags: string[];
}): string {
  const lines: string[] = [];
  lines.push(`# CHALLENGE: ${opts.title}`);
  lines.push(`CATEGORY: ${opts.category}`);
  lines.push("");
  lines.push("## DESCRIPTION");
  lines.push(opts.description);
  lines.push("");
  lines.push("## ATTACHMENTS");
  if (opts.attachments.length === 0) {
    lines.push("(none — all data is in the description)");
  }
  for (const a of opts.attachments) {
    const rel = a.localPath ? a.localPath.replaceAll("\\", "/") : a.name;
    lines.push(`- ${a.name} → ${rel} (${a.sizeBytes ?? "?"} bytes)`);
  }
  if (opts.hints.length > 0) {
    lines.push("");
    lines.push("## OFFICIAL HINTS");
    for (const h of opts.hints) lines.push(`- ${h}`);
  }
  if (opts.wrongFlags.length > 0) {
    lines.push("");
    lines.push("## REJECTED SUBMISSIONS (do not submit again)");
    for (const f of opts.wrongFlags) lines.push(`- ${f}`);
  }
  return lines.join("\n");
}
