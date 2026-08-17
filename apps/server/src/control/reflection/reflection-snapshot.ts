import type { Repositories } from "@rio/database";
import type { ReflectionTrigger } from "@rio/domain";

export interface ReflectionSnapshot {
  challenge: {
    id: string;
    title: string;
    category: string;
    description: string;
  };
  progress: {
    summary: string;
    confidence: number;
    stalled: boolean;
    progressLevel: string;
    nextActions: string[];
  } | null;
  confirmedFacts: string[];
  activeHypotheses: {
    description: string;
    confidence: number;
    status: string;
  }[];
  rejectedHypotheses: string[];
  recentExperiments: {
    tool: string;
    result: string;
    outcome: string;
  }[];
  specialistConclusions: {
    kind: string;
    conclusion: string;
    confidence: number;
  }[];
  importantArtifacts: {
    path: string;
    operation: string;
  }[];
  hints: string[];
  wrongFlags: string[];
  trigger: ReflectionTrigger;
}

function safeJsonArray(raw: string): string[] {
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

export function buildReflectionSnapshot(repos: Repositories, challengeId: string, trigger: ReflectionTrigger): ReflectionSnapshot | null {
  const challenge = repos.challenges.get(challengeId);
  if (!challenge) return null;
  const latest = repos.progress.latestForChallenge(challengeId);
  const hyps = repos.hypotheses.listByChallenge(challengeId);
  const experiments = repos.experiments.listByChallenge(challengeId);
  const specialists = repos.specialists.listByChallenge(challengeId);
  const artifacts = repos.artifacts.listByChallenge(challengeId);
  return {
    challenge: {
      id: challenge.id,
      title: challenge.title,
      category: challenge.category,
      description: challenge.description,
    },
    progress: latest
      ? {
          summary: latest.summary,
          confidence: latest.confidence,
          stalled: Boolean(latest.stalled),
          progressLevel: latest.progressLevel,
          nextActions: safeJsonArray(latest.nextActionsJson).slice(0, 12),
        }
      : null,
    confirmedFacts: latest ? safeJsonArray(latest.confirmedFactsJson).slice(0, 20) : [],
    activeHypotheses: hyps
      .filter((h) => h.status === "CANDIDATE" || h.status === "TESTING")
      .slice(0, 10)
      .map((h) => ({ description: h.description, confidence: h.confidence, status: h.status })),
    rejectedHypotheses: hyps
      .filter((h) => h.status === "REJECTED")
      .slice(0, 15)
      .map((h) => h.description),
    recentExperiments: experiments.slice(-12).map((e) => ({
      tool: e.tool,
      result: e.resultSummary.slice(0, 240),
      outcome: e.outcome,
    })),
    specialistConclusions: specialists.slice(-8).map((s) => ({
      kind: s.kind,
      conclusion: s.conclusion.slice(0, 400),
      confidence: s.confidence,
    })),
    importantArtifacts: artifacts.slice(-12).map((a) => ({ path: a.path, operation: a.operation })),
    hints: repos.hints.listForChallenge(challengeId).map((h) => h.content),
    wrongFlags: repos.submissions.listByChallenge(challengeId).filter((s) => s.status === "WRONG").map((s) => s.flagValue),
    trigger,
  };
}

export function snapshotFingerprintParts(repos: Repositories, challengeId: string): {
  latestProgressId: string | null;
  latestExperimentId: string | null;
  wrongSubmissionCount: number;
  hintCount: number;
  hypothesisUpdatedAt: number | null;
} {
  const latest = repos.progress.latestForChallenge(challengeId);
  const experiments = repos.experiments.listByChallenge(challengeId);
  const hyps = repos.hypotheses.listByChallenge(challengeId);
  const latestHyp = hyps.reduce<number | null>((acc, h) => {
    const t = Math.max(h.updatedAt, h.createdAt);
    return acc === null || t > acc ? t : acc;
  }, null);
  return {
    latestProgressId: latest?.id ?? null,
    latestExperimentId: experiments.at(-1)?.id ?? null,
    wrongSubmissionCount: repos.challenges.get(challengeId)?.wrongSubmissionCount ?? 0,
    hintCount: repos.hints.listForChallenge(challengeId).length,
    hypothesisUpdatedAt: latestHyp,
  };
}
