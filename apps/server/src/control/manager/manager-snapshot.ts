import { createHash } from "node:crypto";
import type { Repositories } from "@rio/database";
import type { Challenge } from "@rio/domain";
import { SOLVER_CATEGORIES } from "@rio/domain";
import { computePriorityScore } from "@rio/scheduler";
import type { RuntimeConfig } from "@rio/shared";
import { resolveReflectionEnabled, resolveReflectionMode } from "../reflection/reflection-gate.js";
import type { ManagerChallengeSummary, ManagerSnapshot } from "./manager-types.js";

function attachmentSummary(repos: Repositories, challengeId: string): ManagerChallengeSummary["attachmentSummary"] {
  const atts = repos.attachments.listByChallenge(challengeId);
  const types = [...new Set(atts.map((a) => (a.mime || a.name.split(".").pop() || "unknown").toLowerCase()))].slice(0, 8);
  const total = atts.reduce((n, a) => n + (a.sizeBytes ?? 0), 0);
  return {
    count: atts.length,
    totalBytes: atts.some((a) => a.sizeBytes != null) ? total : null,
    types,
  };
}

export function basePriorityOf(c: Challenge, now = Date.now()): number {
  return computePriorityScore(
    {
      challengeId: c.id,
      category: c.category,
      manualPriority: c.priority,
      score: c.score,
      solveCount: c.solveCount,
      difficulty: c.difficultyEstimate,
      attempts: c.solverRestartCount,
      progress: c.progressStatus,
      elapsedActiveMs: c.activeSolveMs,
      hintStatus: c.hintStatus,
      requiredResources: { resourceClass: "NORMAL", resourceTypes: ["LLM"] },
      discoveredAt: c.discoveredAt,
    },
    undefined,
    now,
  );
}

export function summarizeChallenge(
  repos: Repositories,
  c: Challenge,
  config: RuntimeConfig,
  now = Date.now(),
): ManagerChallengeSummary | null {
  if (c.category !== "MISC" && c.category !== "CRYPTO") return null;
  const orch = repos.orchestration.getOrCreate(c.id);
  const latest = repos.progress.latestForChallenge(c.id);
  const lastRun = repos.reflectionRuns.latestForChallenge(c.id);
  let lastReflection: ManagerChallengeSummary["lastReflection"] = null;
  if (lastRun?.completedAt && lastRun.resultJson) {
    try {
      const r = JSON.parse(lastRun.resultJson) as { diagnosis?: string; shouldContinueCurrentDirection?: boolean; confidence?: number };
      lastReflection = {
        at: lastRun.completedAt,
        diagnosisSummary: String(r.diagnosis ?? "").slice(0, 160),
        continueDirection: typeof r.shouldContinueCurrentDirection === "boolean" ? r.shouldContinueCurrentDirection : null,
        confidence: typeof r.confidence === "number" ? r.confidence : null,
      };
    } catch {
      lastReflection = { at: lastRun.completedAt, diagnosisSummary: "", continueDirection: null, confidence: null };
    }
  }
  const enabled = resolveReflectionEnabled({
    globalEnabled: config.reflection.enabledByDefault,
    managerRecommendation: orch.managerReflectionEnabled,
    override: orch.reflectionOverride,
  });
  const mode = resolveReflectionMode({ globalMode: config.reflection.mode, override: orch.reflectionModeOverride });
  return {
    challengeId: c.id,
    title: c.title.slice(0, 80),
    category: c.category,
    score: c.score,
    solveCount: c.solveCount,
    lifecycleStatus: c.lifecycleStatus,
    progressStatus: c.progressStatus,
    difficulty: c.difficultyEstimate,
    subcategories: c.subcategory ? c.subcategory.split(",").map((s) => s.trim()).filter(Boolean).slice(0, 6) : [],
    triageSummary: null,
    basePriorityScore: c.lastPriorityScore ?? basePriorityOf(c, now),
    activeSolveMs: c.activeSolveMs,
    latestProgress: latest
      ? {
          summary: latest.summary.slice(0, 200),
          confidence: latest.confidence,
          stalled: Boolean(latest.stalled),
          progressLevel: latest.progressLevel,
        }
      : null,
    hint: { status: c.hintStatus, fetched: c.hintStatus === "FETCHED" },
    wrongSubmissionCount: c.wrongSubmissionCount,
    attachmentSummary: attachmentSummary(repos, c.id),
    reflection: { enabled, mode, lastRunAt: lastRun?.completedAt ?? null },
    lastReflection,
    manuallyLocked: orch.strategyLocked,
  };
}

/** QUEUED candidates: top 25 overall + top 10 Misc + top 10 Crypto, deduped, capped. */
export function prefilterCandidates(queued: ManagerChallengeSummary[], maxCandidates: number): ManagerChallengeSummary[] {
  const byScore = [...queued].sort((a, b) => b.basePriorityScore - a.basePriorityScore || a.challengeId.localeCompare(b.challengeId));
  const topOverall = byScore.slice(0, 25);
  const topMisc = byScore.filter((c) => c.category === "MISC").slice(0, 10);
  const topCrypto = byScore.filter((c) => c.category === "CRYPTO").slice(0, 10);
  const seen = new Set<string>();
  const out: ManagerChallengeSummary[] = [];
  for (const c of [...topOverall, ...topMisc, ...topCrypto]) {
    if (seen.has(c.challengeId)) continue;
    seen.add(c.challengeId);
    out.push(c);
    if (out.length >= maxCandidates) break;
  }
  return out;
}

export function buildManagerSnapshot(input: {
  repos: Repositories;
  config: RuntimeConfig;
  contestConnected: boolean;
  solverSlotsUsed: number;
  reflectionSlotsUsed: number;
  now?: number;
}): ManagerSnapshot {
  const now = input.now ?? Date.now();
  const all = input.repos.challenges.list();
  const count = (s: string) => all.filter((c) => c.lifecycleStatus === s).length;
  const active: ManagerChallengeSummary[] = [];
  const queuedRaw: ManagerChallengeSummary[] = [];
  for (const c of all) {
    if (!SOLVER_CATEGORIES.includes(c.category)) continue;
    const sum = summarizeChallenge(input.repos, c, input.config, now);
    if (!sum) continue;
    if (c.lifecycleStatus === "ACTIVE") active.push(sum);
    else if (c.lifecycleStatus === "QUEUED" || c.lifecycleStatus === "READY") queuedRaw.push(sum);
  }
  const max = input.config.manager.maxCandidates;
  const candidates = prefilterCandidates(queuedRaw, max);
  const total = input.config.workers.solverConcurrency;
  const used = input.solverSlotsUsed;
  return {
    generatedAt: now,
    contest: {
      connected: input.contestConnected,
      totalChallenges: all.length,
      solved: count("SOLVED"),
      active: count("ACTIVE"),
      queued: count("QUEUED"),
      preparing: count("PREPARING"),
      parked: count("PARKED"),
      unsupported: count("UNSUPPORTED"),
    },
    resources: {
      solverSlotsTotal: total,
      solverSlotsUsed: used,
      solverSlotsAvailable: Math.max(0, total - used),
      reflectionSlotsTotal: input.config.reflection.maxConcurrent,
      reflectionSlotsUsed: input.reflectionSlotsUsed,
    },
    activeChallenges: active,
    candidates,
    omittedCandidateCount: Math.max(0, queuedRaw.length - candidates.length),
  };
}

export function hashManagerSnapshot(snapshot: ManagerSnapshot): string {
  const key = {
    active: snapshot.activeChallenges.map((c) => [
      c.challengeId,
      c.lifecycleStatus,
      c.progressStatus,
      c.latestProgress?.confidence ?? null,
      c.latestProgress?.stalled ?? null,
    ]),
    cand: snapshot.candidates.map((c) => [c.challengeId, c.score, c.solveCount, c.difficulty, c.basePriorityScore]),
    slots: snapshot.resources.solverSlotsAvailable,
  };
  return createHash("sha256").update(JSON.stringify(key)).digest("hex");
}

export function snapshotContainsUnsupportedDetails(snapshot: ManagerSnapshot): boolean {
  return (
    snapshot.activeChallenges.some((c) => c.category !== "MISC" && c.category !== "CRYPTO") ||
    snapshot.candidates.some((c) => c.category !== "MISC" && c.category !== "CRYPTO")
  );
}

export function snapshotHasAttachmentBytes(snapshot: ManagerSnapshot): boolean {
  const blob = JSON.stringify(snapshot);
  return /"data":|"content":|"bytes":\s*"/.test(blob);
}
