import type { Repositories } from "@rio/database";
import type { ActionCost, ProposedTest, SolverCheckpoint } from "@rio/domain";

export function scoreProposedTest(test: ProposedTest, alreadySimilar: boolean): number {
  const info = /high/i.test(test.expectedInformation) ? 3 : /low/i.test(test.expectedInformation) ? 1 : 2;
  const cost = test.estimatedCost === "CHEAP" ? 0 : test.estimatedCost === "NORMAL" ? 1 : 2;
  const red = alreadySimilar ? 4 : 0;
  return info - cost - red;
}

export function buildPlannerInjection(repos: Repositories, challengeId: string): string {
  const hyps = repos.hypotheses.listByChallenge(challengeId);
  const exps = repos.experiments.listByChallenge(challengeId);
  const facts = hyps.filter((h) => h.status === "CONFIRMED" || h.status === "SUPPORTED").map((h) => h.description);
  const active = hyps.filter((h) => h.status === "CANDIDATE" || h.status === "TESTING");
  const rejected = hyps.filter((h) => h.status === "REJECTED").map((h) => h.description);
  const recent = exps.slice(-8).map((e) => `${e.tool} → ${e.outcome}: ${e.resultSummary.slice(0, 80)}`);
  const wrong = repos.submissions.listByChallenge(challengeId).filter((s) => s.status === "WRONG").map((s) => s.flagValue);
  const hints = repos.hints.listForChallenge(challengeId).map((h) => h.content);
  return `CURRENT CHALLENGE STATE
Confirmed facts:
${facts.length ? facts.map((f) => `- ${f}`).join("\n") : "- (none)"}
Active hypotheses:
${active.length ? active.map((h) => `- [${h.status} ${h.confidence}] ${h.description}`).join("\n") : "- (none)"}
Rejected hypotheses:
${rejected.length ? rejected.map((r) => `- ${r}`).join("\n") : "- (none)"}
Recent experiments:
${recent.length ? recent.map((r) => `- ${r}`).join("\n") : "- (none)"}
Hints:
${hints.length ? hints.map((h) => `- ${h}`).join("\n") : "- (none)"}
Wrong flags:
${wrong.length ? wrong.map((w) => `- ${w}`).join("\n") : "- (none)"}

Do not repeat an experiment on the same artifact with the same parameters unless force=true.`;
}

export function buildCheckpoint(repos: Repositories, challengeId: string, solverType: SolverCheckpoint["solverType"]): SolverCheckpoint {
  const hyps = repos.hypotheses.listByChallenge(challengeId);
  const arts = repos.artifacts.listByChallenge(challengeId);
  const vis = repos.visualEvidence.listByChallenge(challengeId);
  const wrong = repos.submissions.listByChallenge(challengeId).filter((s) => s.status === "WRONG").map((s) => s.flagValue);
  return {
    challengeId,
    solverType,
    confirmedFacts: hyps.filter((h) => h.status === "CONFIRMED").map((h) => h.description),
    activeHypotheses: hyps.filter((h) => h.status === "CANDIDATE" || h.status === "TESTING").map((h) => h.description),
    rejectedHypotheses: hyps.filter((h) => h.status === "REJECTED").map((h) => h.description),
    importantArtifacts: arts.slice(-12).map((a) => a.path),
    visualEvidenceIds: vis.map((v) => v.id),
    wrongFlags: wrong,
    currentPlan: [],
    unresolvedQuestions: [],
    createdAt: Date.now(),
  };
}

export function shouldReflect(input: {
  noSignalStreak: number;
  secondsSinceProgress: number;
  wrongFlags: number;
  repeatedTool: boolean;
}): string | null {
  if (input.wrongFlags >= 1) return "wrong_flag";
  if (input.noSignalStreak >= 3) return "no_signal_streak";
  if (input.secondsSinceProgress >= 120) return "stalled_120s";
  if (input.repeatedTool) return "tool_repetition";
  return null;
}

export type { ActionCost };
