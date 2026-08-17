import type { Challenge, ChallengeOrchestration, ManagerMode } from "@rio/domain";
import { plannedActionFor, shouldUseManagerGate } from "./manager-policy.js";
import type { AppliedDispatchPlan } from "./manager-types.js";

export interface AdmissionInput {
  challenge: Pick<Challenge, "id" | "lifecycleStatus" | "lastPriorityScore" | "discoveredAt">;
  orchestration: Pick<ChallengeOrchestration, "strategyLocked" | "manualDispatch" | "managerAction" | "managerPriority">;
  mode: ManagerMode;
  livePlanFresh: boolean;
  applied: AppliedDispatchPlan | null;
}

export interface AdmissionResult {
  admitted: boolean;
  reason: string;
  sortKey: number;
}

/** Manual lock/override → Manager decision → deterministic scheduler. */
export function admitChallenge(input: AdmissionInput): AdmissionResult {
  const { challenge, orchestration } = input;
  const base = challenge.lastPriorityScore ?? 0;

  if (orchestration.manualDispatch === "FORCE_START") {
    return { admitted: true, reason: "FORCE_START", sortKey: 10_000 + (orchestration.managerPriority ?? base) };
  }
  if (orchestration.manualDispatch === "FORCE_HOLD") {
    return { admitted: false, reason: "FORCE_HOLD", sortKey: base };
  }

  if (!shouldUseManagerGate(input.mode, input.livePlanFresh)) {
    return { admitted: true, reason: input.mode === "SHADOW" ? "SHADOW_DETERMINISTIC" : "DETERMINISTIC", sortKey: base };
  }

  const action = plannedActionFor(challenge.id, challenge.lifecycleStatus, input.applied);
  if (action === "START") {
    const prio = input.applied?.decisions.find((d) => d.challengeId === challenge.id)?.priority ?? orchestration.managerPriority ?? base;
    return { admitted: true, reason: "MANAGER_START", sortKey: 1_000 + prio };
  }
  if (action === "HOLD") {
    return { admitted: false, reason: "MANAGER_HOLD", sortKey: base };
  }
  return { admitted: false, reason: "MANAGER_DEFAULT_HOLD", sortKey: base };
}

export function rankAdmitted<T extends { sortKey: number; discoveredAt: number }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => b.sortKey - a.sortKey || a.discoveredAt - b.discoveredAt);
}
