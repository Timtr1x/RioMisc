import { createHash } from "node:crypto";
import type { ReflectionMode, ReflectionOverride, ReflectionTrigger } from "@rio/domain";

export interface ReflectionGateInput {
  noSignalStreak: number;
  secondsSinceProgress: number;
  wrongFlags: number;
  repeatedTool: boolean;
  stalledMs?: number;
  noSignalThreshold?: number;
  wrongFlagEnabled?: boolean;
  repeatedExperimentEnabled?: boolean;
}

export function evaluateReflectionGate(input: ReflectionGateInput): ReflectionTrigger | null {
  const stalledMs = input.stalledMs ?? 120_000;
  const noSignal = input.noSignalThreshold ?? 3;
  if ((input.wrongFlagEnabled ?? true) && input.wrongFlags >= 1) return "WRONG_FLAG";
  if (input.noSignalStreak >= noSignal) return "NO_SIGNAL_STREAK";
  if (input.secondsSinceProgress * 1000 >= stalledMs && input.secondsSinceProgress > 0) return "STALLED";
  if ((input.repeatedExperimentEnabled ?? true) && input.repeatedTool) return "REPEATED_EXPERIMENT";
  return null;
}

/** Legacy string codes kept for existing planner tests / callers. */
export function shouldReflectLegacy(input: {
  noSignalStreak: number;
  secondsSinceProgress: number;
  wrongFlags: number;
  repeatedTool: boolean;
}): string | null {
  const t = evaluateReflectionGate(input);
  if (t === "WRONG_FLAG") return "wrong_flag";
  if (t === "NO_SIGNAL_STREAK") return "no_signal_streak";
  if (t === "STALLED") return "stalled_120s";
  if (t === "REPEATED_EXPERIMENT") return "tool_repetition";
  return null;
}

export function normalizeReflectionTrigger(raw: string): ReflectionTrigger {
  const u = raw.toUpperCase().replaceAll("-", "_");
  if (u === "WRONG_FLAG" || u === "WRONG_FLAG" || raw === "wrong_flag") return "WRONG_FLAG";
  if (u === "NO_SIGNAL_STREAK" || raw === "no_signal_streak") return "NO_SIGNAL_STREAK";
  if (u === "STALLED" || raw === "stalled" || raw === "stalled_120s") return "STALLED";
  if (u === "REPEATED_EXPERIMENT" || raw === "tool_repetition") return "REPEATED_EXPERIMENT";
  if (u === "SOLVER_REQUEST" || raw === "solver_request") return "SOLVER_REQUEST";
  if (u === "MANUAL" || raw === "manual") return "MANUAL";
  return "STALLED";
}

export function buildReflectionFingerprint(input: {
  latestProgressId: string | null;
  latestExperimentId: string | null;
  wrongSubmissionCount: number;
  hintCount: number;
  hypothesisUpdatedAt: number | null;
}): string {
  const payload = JSON.stringify({
    p: input.latestProgressId ?? "",
    e: input.latestExperimentId ?? "",
    w: input.wrongSubmissionCount,
    h: input.hintCount,
    u: input.hypothesisUpdatedAt ?? 0,
  });
  return createHash("sha256").update(payload).digest("hex");
}

export function resolveReflectionEnabled(input: {
  globalEnabled: boolean;
  managerRecommendation: boolean | null;
  override: ReflectionOverride;
}): boolean {
  if (input.override === "ON") return true;
  if (input.override === "OFF") return false;
  if (input.managerRecommendation !== null) return input.managerRecommendation;
  return input.globalEnabled;
}

export function resolveReflectionMode(input: {
  globalMode: ReflectionMode;
  override: ReflectionMode | null;
}): ReflectionMode {
  return input.override ?? input.globalMode;
}

export function shouldBypassReflectionCooldown(trigger: ReflectionTrigger): boolean {
  return trigger === "MANUAL" || trigger === "WRONG_FLAG";
}

export function shouldSkipDuplicateFingerprint(input: {
  current: string;
  previous: string | null;
}): boolean {
  return Boolean(input.previous && input.previous === input.current);
}
