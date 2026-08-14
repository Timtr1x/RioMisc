import { describe, it, expect } from "vitest";
import { computePriorityScore, scoreAndRankQueued, type PriorityWeights } from "@rio/scheduler";
import type { SchedulingCandidate } from "@rio/domain";

const NOW = 1_700_000_000_000;

const weights: PriorityWeights = {
  unattemptedBonus: 50,
  easyBonusByDifficulty: { 1: 40, 2: 30, 3: 20, 4: 10, 5: 0 },
  scoreBonusMax: 20,
  ageBonusPer10Min: 2,
  ageBonusMax: 20,
  progressActiveBonus: 10,
  progressStalledPenalty: -10,
  heavyResourcePenalty: -15,
  normalResourcePenalty: -5,
  restartPenalty: 5,
};

function cand(partial: Partial<SchedulingCandidate> & { challengeId: string }): SchedulingCandidate {
  return {
    category: "MISC",
    manualPriority: 0,
    score: 100,
    solveCount: null,
    difficulty: 2,
    attempts: 0,
    progress: "UNKNOWN",
    elapsedActiveMs: 0,
    hintStatus: "LOCKED",
    requiredResources: { resourceClass: "NORMAL", resourceTypes: ["LLM"] },
    discoveredAt: NOW,
    ...partial,
  };
}

describe("scheduler-order A–F", () => {
  const cases: SchedulingCandidate[] = [
    cand({ challengeId: "A", manualPriority: 100, difficulty: 1 }), // critical easy unattempted
    cand({ challengeId: "B", manualPriority: 50, difficulty: 1 }), // high easy unattempted
    cand({ challengeId: "C", manualPriority: 0, difficulty: 1 }), // normal easy unattempted
    cand({ challengeId: "D", manualPriority: 0, difficulty: 5 }), // hard unattempted
    cand({ challengeId: "E", manualPriority: 0, difficulty: 2, progress: "STALLED" }), // stalled
    cand({ challengeId: "F", manualPriority: 0, difficulty: 2, attempts: 3 }), // restarted
  ];

  it("freezes A→B→C→E→D→F at a fixed clock", () => {
    const ranked = scoreAndRankQueued(
      cases,
      (c) => computePriorityScore(c, weights, NOW),
      (c) => c.discoveredAt,
    );
    expect(ranked.map((r) => r.item.challengeId)).toEqual(["A", "B", "C", "E", "D", "F"]);
    const scores = Object.fromEntries(ranked.map((r) => [r.item.challengeId, r.score]));
    expect(scores.A).toBe(189);
    expect(scores.B).toBe(139);
    expect(scores.C).toBe(89);
    expect(scores.E).toBe(69);
    expect(scores.D).toBe(49);
    expect(scores.F).toBe(14);
  });

  it("breaks equal scores by discoveredAt ascending", () => {
    const older = cand({ challengeId: "old", discoveredAt: NOW - 60_000 });
    const newer = cand({ challengeId: "new", discoveredAt: NOW });
    const ranked = scoreAndRankQueued(
      [newer, older],
      (c) => computePriorityScore(c, weights, NOW),
      (c) => c.discoveredAt,
    );
    expect(ranked[0]!.item.challengeId).toBe("old");
    expect(ranked[1]!.item.challengeId).toBe("new");
    expect(ranked[0]!.score).toBe(ranked[1]!.score);
  });
});
