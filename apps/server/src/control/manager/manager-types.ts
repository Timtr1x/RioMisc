import type { ManagerMode, ManagerTrigger, ReflectionMode } from "@rio/domain";

export interface ManagerChallengeSummary {
  challengeId: string;
  title: string;
  category: "MISC" | "CRYPTO";
  score: number | null;
  solveCount: number | null;
  lifecycleStatus: string;
  progressStatus: string;
  difficulty: number | null;
  subcategories: string[];
  triageSummary: string | null;
  basePriorityScore: number;
  activeSolveMs: number;
  latestProgress: {
    summary: string;
    confidence: number;
    stalled: boolean;
    progressLevel: string;
  } | null;
  hint: {
    status: string;
    fetched: boolean;
  };
  wrongSubmissionCount: number;
  attachmentSummary: {
    count: number;
    totalBytes: number | null;
    types: string[];
  };
  reflection: {
    enabled: boolean;
    mode: ReflectionMode;
    lastRunAt: number | null;
  };
  lastReflection: {
    at: number;
    diagnosisSummary: string;
    continueDirection: boolean | null;
    confidence: number | null;
  } | null;
  manuallyLocked: boolean;
}

export interface ManagerSnapshot {
  generatedAt: number;
  contest: {
    connected: boolean;
    totalChallenges: number;
    solved: number;
    active: number;
    queued: number;
    preparing: number;
    parked: number;
    unsupported: number;
  };
  resources: {
    solverSlotsTotal: number;
    solverSlotsUsed: number;
    solverSlotsAvailable: number;
    reflectionSlotsTotal: number;
    reflectionSlotsUsed: number;
  };
  activeChallenges: ManagerChallengeSummary[];
  candidates: ManagerChallengeSummary[];
  omittedCandidateCount: number;
}

export interface AppliedDecision {
  challengeId: string;
  action: "START" | "HOLD" | "CONTINUE";
  priority: number;
  reflectionEnabled: boolean | null;
  reason: string;
  status: "APPLIED" | "REJECTED" | "CLAMPED";
  rejectionReason: string | null;
}

export interface AppliedDispatchPlan {
  summary: string;
  decisions: AppliedDecision[];
  startIds: string[];
  holdIds: string[];
  continueIds: string[];
  rejectedCount: number;
  clampedCount: number;
}

export interface ManagerHealthView {
  mode: ManagerMode;
  enabled: boolean;
  health: "OFF" | "HEALTHY" | "DEGRADED";
  modelId: string | null;
  lastReplanAt: number | null;
  lastTrigger: string | null;
  livePlanId: string | null;
  livePlanFresh: boolean;
  fallback: boolean;
  inFlight: number;
  solverSlots: { used: number; total: number };
  reflectionSlots: { used: number; total: number };
}

export type { ManagerMode, ManagerTrigger };
