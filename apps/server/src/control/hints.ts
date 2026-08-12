// HintManager (§67-70): hint timer (startedAt + delay → ELIGIBLE), fetch
// policy (stalled + threshold), and injection into the running session.
import type { RioLogger } from "@rio/shared";
import type { Repositories } from "@rio/database";
import type { ContestAdapter } from "@rio/contest";
import type { EventBus } from "./bus.js";
import type { StateMachine } from "../state-machine.js";

export class HintManager {
  constructor(
    private deps: {
      repos: Repositories;
      adapter: ContestAdapter;
      stateMachine: StateMachine;
      bus: EventBus;
      logger: RioLogger;
      autoFetch: boolean;
      requireStalled: boolean;
      eligibleAfterStartMs: number;
      stallThresholdMs: number;
      inject: (challengeId: string, message: string) => void;
    },
  ) {}

  /** Called on a timer (e.g. every 15s). */
  async tick(): Promise<void> {
    const now = Date.now();
    for (const challenge of this.deps.repos.challenges.list()) {
      if (challenge.lifecycleStatus === "SOLVED" || challenge.lifecycleStatus === "UNSUPPORTED") continue;
      if (!challenge.startedAt || challenge.startStatus !== "STARTED") continue;
      if (challenge.hintStatus === "FETCHED" || challenge.hintStatus === "DECLINED" || challenge.hintStatus === "NOT_SUPPORTED") continue;
      if (challenge.hintStatus === "FETCHING") continue;

      const eligible = now >= challenge.startedAt + this.deps.eligibleAfterStartMs;
      if (!eligible) continue;

      if (challenge.hintStatus === "LOCKED") {
        this.deps.repos.challenges.update(challenge.id, { hintStatus: "ELIGIBLE" });
        this.deps.bus.publish({ type: "HINT_ELIGIBLE", challengeId: challenge.id, payload: { startedAt: challenge.startedAt, delayMs: this.deps.eligibleAfterStartMs } });
        this.deps.logger.info({ event: "hint_eligible", challengeId: challenge.id });
      }

      if (!this.deps.autoFetch) continue;
      if (challenge.lifecycleStatus !== "ACTIVE" && challenge.lifecycleStatus !== "VERIFYING") continue;
      const stalled = challenge.progressStatus === "STALLED" || (challenge.solverStartedAt !== null && now - challenge.solverStartedAt > this.deps.stallThresholdMs);
      if (this.deps.requireStalled && !stalled) continue;
      if (!challenge.remoteId || challenge.remoteId === "local") continue;

      await this.fetchHint(challenge.id);
    }
  }

  /** Fetch + persist + inject a hint. Also used by Dashboard "Force Hint". */
  async fetchHint(challengeId: string): Promise<string> {
    const { repos } = this.deps;
    const challenge = repos.challenges.get(challengeId);
    if (!challenge) throw new Error("unknown challenge");
    if (!challenge.remoteId) throw new Error("no remote id");
    if (challenge.hintStatus === "FETCHED") {
      const hints = repos.hints.listForChallenge(challengeId);
      if (hints.length > 0) return hints[hints.length - 1]!.content;
    }
    repos.challenges.update(challengeId, { hintStatus: "FETCHING" });
    this.deps.bus.publish({ type: "HINT_FETCH_REQUESTED", challengeId, payload: {} });
    const result = await this.deps.adapter.getHint!(challenge.remoteId);
    if (!result.ok || !result.hint) {
      repos.challenges.update(challengeId, { hintStatus: "DECLINED" });
      this.deps.bus.publish({ type: "HINT_FETCH_FAILED", challengeId, payload: { message: result.message } });
      throw new Error(result.message ?? "hint unavailable");
    }
    repos.hints.save(challengeId, result.hint);
    repos.challenges.update(challengeId, { hintStatus: "FETCHED" });
    this.deps.bus.publish({ type: "HINT_FETCHED", challengeId, payload: { hint: result.hint } });
    this.deps.logger.info({ event: "hint_fetched", challengeId });

    const msg = `NEW OFFICIAL HINT

The competition has provided the following hint:

<${result.hint}>

Treat this as new evidence.
Re-evaluate your current hypotheses before choosing the next action.`;
    this.deps.inject(challengeId, msg);
    return result.hint;
  }
}
