import { createHash } from "node:crypto";

export function canonicalizeArgs(args: unknown): string {
  return JSON.stringify(sortValue(args ?? {}));
}

export function experimentKey(artifactSha256: string, tool: string, args: unknown): string {
  return createHash("sha256").update(`${artifactSha256}\n${tool}\n${canonicalizeArgs(args)}`).digest("hex");
}

function sortValue(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortValue);
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(o).sort()) {
      if (k === "force") continue;
      out[k] = sortValue(o[k]);
    }
    return out;
  }
  return v;
}

export const LEDGER_SKIP_TOOLS = new Set([
  "report_progress",
  "submit_flag_candidate",
  "request_handoff",
  "request_reflection",
  "request_visual_review",
  "request_specialist",
  "list_workspace",
  "record_hypothesis",
]);
