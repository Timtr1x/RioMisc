import type { Challenge, ChallengeOrchestration, DispatchPlan } from "@rio/domain";
import { SOLVER_CATEGORIES } from "@rio/domain";
import type { AppliedDecision, AppliedDispatchPlan, ManagerSnapshot } from "./manager-types.js";

export function clampPriority(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

export function isPlanFresh(
  plan: { completedAt: number | null; status: string } | null | undefined,
  now: number,
  ttlMs: number,
): boolean {
  if (!plan?.completedAt) return false;
  if (plan.status !== "APPLIED" && plan.status !== "PARTIAL") return false;
  return now - plan.completedAt < ttlMs;
}

export function shouldUseManagerGate(mode: "OFF" | "SHADOW" | "ACTIVE", livePlanFresh: boolean): boolean {
  return mode === "ACTIVE" && livePlanFresh;
}

export function validateAndApply(
  snapshot: ManagerSnapshot,
  plan: DispatchPlan,
  challenges: Map<string, Pick<Challenge, "id" | "category" | "lifecycleStatus">>,
  orchestrations: Map<string, Pick<ChallengeOrchestration, "strategyLocked">>,
): AppliedDispatchPlan {
  const knownIds = new Set([
    ...snapshot.activeChallenges.map((c) => c.challengeId),
    ...snapshot.candidates.map((c) => c.challengeId),
    ...challenges.keys(),
  ]);
  const applied: AppliedDecision[] = [];

  for (const d of plan.decisions) {
    const ch = challenges.get(d.challengeId);
    if (!ch && !knownIds.has(d.challengeId)) {
      applied.push({
        challengeId: d.challengeId,
        action: d.action,
        priority: clampPriority(d.priority),
        reflectionEnabled: d.reflectionEnabled,
        reason: d.reason,
        status: "REJECTED",
        rejectionReason: "UNKNOWN_CHALLENGE",
      });
      continue;
    }
    const category = ch?.category ?? snapshot.activeChallenges.find((c) => c.challengeId === d.challengeId)?.category
      ?? snapshot.candidates.find((c) => c.challengeId === d.challengeId)?.category;
    const lifecycle = ch?.lifecycleStatus
      ?? snapshot.activeChallenges.find((c) => c.challengeId === d.challengeId)?.lifecycleStatus
      ?? snapshot.candidates.find((c) => c.challengeId === d.challengeId)?.lifecycleStatus
      ?? "UNKNOWN";

    if (category && !SOLVER_CATEGORIES.includes(category as (typeof SOLVER_CATEGORIES)[number])) {
      applied.push({
        challengeId: d.challengeId,
        action: d.action,
        priority: clampPriority(d.priority),
        reflectionEnabled: d.reflectionEnabled,
        reason: d.reason,
        status: "REJECTED",
        rejectionReason: "UNSUPPORTED_CATEGORY",
      });
      continue;
    }
    if (lifecycle === "SOLVED" && d.action === "START") {
      applied.push({
        challengeId: d.challengeId,
        action: d.action,
        priority: clampPriority(d.priority),
        reflectionEnabled: d.reflectionEnabled,
        reason: d.reason,
        status: "REJECTED",
        rejectionReason: "ALREADY_SOLVED",
      });
      continue;
    }
    if (lifecycle === "UNSUPPORTED" && d.action === "START") {
      applied.push({
        challengeId: d.challengeId,
        action: d.action,
        priority: clampPriority(d.priority),
        reflectionEnabled: d.reflectionEnabled,
        reason: d.reason,
        status: "REJECTED",
        rejectionReason: "UNSUPPORTED_CATEGORY",
      });
      continue;
    }

    const orch = orchestrations.get(d.challengeId);
    if (orch?.strategyLocked) {
      applied.push({
        challengeId: d.challengeId,
        action: d.action,
        priority: clampPriority(d.priority),
        reflectionEnabled: d.reflectionEnabled,
        reason: d.reason,
        status: "REJECTED",
        rejectionReason: "STRATEGY_LOCKED",
      });
      continue;
    }

    const priority = clampPriority(d.priority);
    const clamped = priority !== Math.round(d.priority) || d.priority < 0 || d.priority > 100;
    applied.push({
      challengeId: d.challengeId,
      action: d.action,
      priority,
      reflectionEnabled: d.reflectionEnabled,
      reason: d.reason,
      status: clamped ? "CLAMPED" : "APPLIED",
      rejectionReason: clamped ? "PRIORITY_CLAMPED" : null,
    });
  }

  const slots = snapshot.resources.solverSlotsAvailable;
  const starts = applied
    .filter((d) => d.status !== "REJECTED" && d.action === "START")
    .sort((a, b) => b.priority - a.priority || a.challengeId.localeCompare(b.challengeId));
  if (starts.length > slots) {
    for (const extra of starts.slice(slots)) {
      extra.action = "HOLD";
      extra.status = "CLAMPED";
      extra.rejectionReason = "SLOT_CLAMPED";
    }
  }

  const startIds = applied.filter((d) => d.status !== "REJECTED" && d.action === "START").map((d) => d.challengeId);
  const holdIds = applied.filter((d) => d.status !== "REJECTED" && d.action === "HOLD").map((d) => d.challengeId);
  const continueIds = applied.filter((d) => d.status !== "REJECTED" && d.action === "CONTINUE").map((d) => d.challengeId);
  return {
    summary: plan.summary,
    decisions: applied,
    startIds,
    holdIds,
    continueIds,
    rejectedCount: applied.filter((d) => d.status === "REJECTED").length,
    clampedCount: applied.filter((d) => d.status === "CLAMPED").length,
  };
}

export function plannedActionFor(
  challengeId: string,
  lifecycleStatus: string,
  applied: AppliedDispatchPlan | null,
): "START" | "HOLD" | "CONTINUE" | null {
  if (!applied) return null;
  const d = applied.decisions.find((x) => x.challengeId === challengeId && x.status !== "REJECTED");
  if (d) return d.action;
  if (lifecycleStatus === "ACTIVE") return "CONTINUE";
  if (lifecycleStatus === "QUEUED" || lifecycleStatus === "READY") return "HOLD";
  return null;
}
