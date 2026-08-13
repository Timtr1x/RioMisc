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

  /** Called on a timer (e.g. every 15s). Must never throw — control plane survival. */
  async tick(): Promise<void> {
    const now = Date.now();
    for (const challenge of this.deps.repos.challenges.list()) {
      try {
        await this.#tickOne(challenge, now);
      } catch (e) {
        this.deps.logger.warn({ event: "hint_tick_error", challengeId: challenge.id, err: String(e) });
      }
    }
  }

  async #tickOne(challenge: import("@rio/domain").Challenge, now: number): Promise<void> {
    if (challenge.lifecycleStatus === "SOLVED" || challenge.lifecycleStatus === "UNSUPPORTED") return;
    if (!challenge.startedAt || challenge.startStatus !== "STARTED") return;
    if (challenge.hintStatus === "FETCHED" || challenge.hintStatus === "DECLINED" || challenge.hintStatus === "NOT_SUPPORTED") return;
    if (challenge.hintStatus === "FETCHING") return;

    const eligible = now >= challenge.startedAt + this.deps.eligibleAfterStartMs;
    if (!eligible) return;

    if (challenge.hintStatus === "LOCKED") {
      this.deps.repos.challenges.update(challenge.id, { hintStatus: "ELIGIBLE" });
      this.deps.bus.publish({ type: "HINT_ELIGIBLE", challengeId: challenge.id, payload: { startedAt: challenge.startedAt, delayMs: this.deps.eligibleAfterStartMs } });
      this.deps.logger.info({ event: "hint_eligible", challengeId: challenge.id });
    }

    if (!this.deps.autoFetch) return;
    if (challenge.lifecycleStatus !== "ACTIVE" && challenge.lifecycleStatus !== "VERIFYING") return;
    const stalled = challenge.progressStatus === "STALLED" || (challenge.solverStartedAt !== null && now - challenge.solverStartedAt > this.deps.stallThresholdMs);
    if (this.deps.requireStalled && !stalled) return;
    if (!challenge.remoteId || challenge.remoteId === "local") return;

    await this.fetchHint(challenge.id);
  }

  /** Fetch + persist + inject a hint. Also used by Dashboard "Force Hint". */
  async fetchHint(challengeId: string): Promise<string | null> {
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
      // notAvailable / 未知挑战等：不致命，退回 LOCKED 等待下一轮（避免反复请求）
      repos.challenges.update(challengeId, { hintStatus: result.notAvailable ? "LOCKED" : "DECLINED" });
      this.deps.bus.publish({ type: "HINT_FETCH_FAILED", challengeId, payload: { message: result.message } });
      this.deps.logger.info({ event: "hint_fetch_failed", challengeId, message: result.message });
      return null;
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
