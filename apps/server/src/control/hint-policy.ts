// Stall clock for auto-hint: last meaningful progress, not solverStartedAt alone.

export function isMeaningfulProgress(p: { progressLevel: string; stalled: boolean | number }): boolean {
  const stalled = Boolean(p.stalled);
  return p.progressLevel === "SIGNIFICANT" || (p.progressLevel === "MINOR" && !stalled);
}

export function lastMeaningfulActivityAt(
  challenge: { solverStartedAt: number | null; startedAt: number | null },
  latest: { progressLevel: string; stalled: boolean | number; createdAt: number } | null,
): number | null {
  if (latest && isMeaningfulProgress(latest) && typeof latest.createdAt === "number") {
    return latest.createdAt;
  }
  return challenge.solverStartedAt ?? challenge.startedAt;
}

export function isStalledForHint(
  challenge: {
    progressStatus: string;
    solverStartedAt: number | null;
    startedAt: number | null;
  },
  latest: { progressLevel: string; stalled: boolean | number; createdAt: number } | null,
  now: number,
  stallThresholdMs: number,
): boolean {
  if (challenge.progressStatus === "STALLED") return true;
  const at = lastMeaningfulActivityAt(challenge, latest);
  if (at == null) return false;
  return now - at >= stallThresholdMs;
}

export function hintBackoffMs(failures: number): number {
  const n = Math.max(1, failures);
  return Math.min(15_000 * 2 ** (n - 1), 5 * 60_000);
}
