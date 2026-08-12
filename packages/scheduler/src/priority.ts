// Priority score per §35: manual + unattempted + easy + score + age + progress
// - stalled - heavy resource - repeated failure.
import type { SchedulingCandidate } from "@rio/domain";

export interface PriorityWeights {
  unattemptedBonus: number;
  easyBonusByDifficulty: Record<1 | 2 | 3 | 4 | 5, number>;
  scoreBonusMax: number;
  ageBonusPer10Min: number;
  ageBonusMax: number;
  progressActiveBonus: number;
  progressStalledPenalty: number;
  heavyResourcePenalty: number;
  normalResourcePenalty: number;
  restartPenalty: number;
}

export const DEFAULT_WEIGHTS: PriorityWeights = {
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

export function computePriorityScore(
  c: SchedulingCandidate,
  weights: PriorityWeights = DEFAULT_WEIGHTS,
  now = Date.now(),
): number {
  let score = c.manualPriority ?? 0;

  // unattempted
  if (c.attempts === 0) score += weights.unattemptedBonus;

  // easy bonus by difficulty
  if (c.difficulty !== null && c.difficulty >= 1 && c.difficulty <= 5) {
    score += weights.easyBonusByDifficulty[c.difficulty as 1 | 2 | 3 | 4 | 5]!;
  }

  // score bonus 0..max (score 0 or null → 0)
  if (c.score !== null && c.score > 0) {
    score += Math.min(weights.scoreBonusMax, Math.round((c.score / 500) * weights.scoreBonusMax));
  }

  // age bonus
  const ageMin = (now - c.discoveredAt) / 60_000;
  score += Math.min(weights.ageBonusMax, Math.floor(ageMin / 10) * weights.ageBonusPer10Min);

  // progress
  if (c.progress === "ACTIVE") score += weights.progressActiveBonus;
  if (c.progress === "STALLED") score += weights.progressStalledPenalty;

  // resource penalty
  if (c.requiredResources.resourceClass === "HEAVY") score += weights.heavyResourcePenalty;
  if (c.requiredResources.resourceClass === "NORMAL") score += weights.normalResourcePenalty;

  // repeated failure
  score -= c.attempts * weights.restartPenalty;

  return Math.round(score);
}

export const MANUAL_PRIORITY: Record<"LOW" | "NORMAL" | "HIGH" | "CRITICAL", number> = {
  LOW: -30,
  NORMAL: 0,
  HIGH: 50,
  CRITICAL: 100,
};
