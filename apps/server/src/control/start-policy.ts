// StartChallenge policy: ON_DISCOVERY / ON_PREPARATION / ON_SOLVER_ASSIGNMENT.
import type { Challenge, StartPolicy } from "@rio/domain";
import type { ContestAdapter } from "@rio/contest";
import type { Repositories } from "@rio/database";
import type { EventBus } from "./bus.js";

export function shouldStartOn(policy: StartPolicy, phase: "discovery" | "preparation" | "solver"): boolean {
  if (policy === "ON_DISCOVERY") return phase === "discovery";
  if (policy === "ON_PREPARATION") return phase === "preparation";
  return phase === "solver";
}

export async function ensureChallengeStarted(opts: {
  policy: StartPolicy;
  phase: "discovery" | "preparation" | "solver";
  challenge: Challenge;
  adapter: ContestAdapter;
  repos: Repositories;
  bus: EventBus;
}): Promise<void> {
  if (!shouldStartOn(opts.policy, opts.phase)) return;
  const latest = opts.repos.challenges.get(opts.challenge.id);
  if (!latest || latest.startStatus === "STARTED" || latest.startStatus === "STARTING") return;
  opts.repos.challenges.update(latest.id, { startStatus: "STARTING" });
  const remoteId = latest.remoteId;
  if (opts.adapter.startChallenge && remoteId && remoteId !== "local") {
    try {
      await opts.adapter.startChallenge(remoteId);
    } catch (e) {
      opts.repos.challenges.update(latest.id, { startStatus: "FAILED" });
      throw new Error(`startChallenge failed: ${e}`);
    }
  }
  opts.repos.challenges.update(latest.id, { startStatus: "STARTED", startedAt: Date.now() });
  opts.bus.publish({ type: "CHALLENGE_STARTED", challengeId: latest.id, payload: { phase: opts.phase } });
}
