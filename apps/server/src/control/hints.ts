// HintManager: stall clock from last meaningful progress; fetch errors
// return ELIGIBLE + backoff; missing getHint → NOT_SUPPORTED.
import type { RioLogger } from "@rio/shared";
import type { Repositories } from "@rio/database";
import type { ContestAdapter } from "@rio/contest";
import type { EventBus } from "./bus.js";
import type { StateMachine } from "../state-machine.js";
import { hintBackoffMs, isStalledForHint } from "./hint-policy.js";

export class HintManager {
  private hintRetry = new Map<string, { failures: number; nextAt: number }>();

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

  replaceAdapter(adapter: ContestAdapter): void {
    this.deps.adapter = adapter;
  }

  clearChallenge(challengeId: string): void {
    this.hintRetry.delete(challengeId);
  }

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
    if (typeof this.deps.adapter.getHint !== "function") {
      if (challenge.hintStatus !== "NOT_SUPPORTED") {
        this.deps.repos.challenges.update(challenge.id, { hintStatus: "NOT_SUPPORTED" });
      }
      return;
    }
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
    if (!challenge.remoteId || challenge.remoteId === "local" || challenge.remoteId.startsWith("url_")) return;

    const retry = this.hintRetry.get(challenge.id);
    if (retry && now < retry.nextAt) return;

    const latest = this.deps.repos.progress.latestForChallenge(challenge.id);
    const stalled = isStalledForHint(challenge, latest, now, this.deps.stallThresholdMs);
    if (this.deps.requireStalled && !stalled) return;

    await this.fetchHint(challenge.id, { force: false });
  }

  /**
   * Fetch + persist + inject a hint.
   * Force bypasses the stall policy, not unsupported / not-started / missing remote id.
   */
  async fetchHint(challengeId: string, opts: { force?: boolean } = {}): Promise<string | null> {
    const { repos } = this.deps;
    const challenge = repos.challenges.get(challengeId);
    if (!challenge) throw new Error("unknown challenge");
    if (typeof this.deps.adapter.getHint !== "function") {
      repos.challenges.update(challengeId, { hintStatus: "NOT_SUPPORTED" });
      return null;
    }
    if (!challenge.remoteId) throw new Error("no remote id");
    if (challenge.startStatus !== "STARTED" && !challenge.startedAt) {
      throw new Error("challenge not started");
    }
    if (challenge.hintStatus === "FETCHED") {
      const hints = repos.hints.listForChallenge(challengeId);
      if (hints.length > 0) return hints[hints.length - 1]!.content;
    }
    repos.challenges.update(challengeId, { hintStatus: "FETCHING" });
    this.deps.bus.publish({ type: "HINT_FETCH_REQUESTED", challengeId, payload: { force: Boolean(opts.force) } });

    let result: Awaited<ReturnType<NonNullable<ContestAdapter["getHint"]>>>;
    try {
      result = await this.deps.adapter.getHint(challenge.remoteId);
    } catch (e) {
      repos.challenges.update(challengeId, { hintStatus: "ELIGIBLE" });
      const prev = this.hintRetry.get(challengeId);
      const failures = (prev?.failures ?? 0) + 1;
      const wait = hintBackoffMs(failures);
      this.hintRetry.set(challengeId, { failures, nextAt: Date.now() + wait });
      this.deps.logger.warn(
        { event: "hint_retry_scheduled", challengeId, failures, waitMs: wait, err: String(e) },
        "hint fetch failed — backoff, status ELIGIBLE",
      );
      this.deps.bus.publish({ type: "HINT_FETCH_FAILED", challengeId, payload: { message: String(e), retryMs: wait } });
      return null;
    }

    if (!result.ok || !result.hint) {
      repos.challenges.update(challengeId, { hintStatus: result.notAvailable ? "LOCKED" : "DECLINED" });
      this.deps.bus.publish({ type: "HINT_FETCH_FAILED", challengeId, payload: { message: result.message } });
      this.deps.logger.info({ event: "hint_fetch_failed", challengeId, message: result.message });
      return null;
    }
    this.hintRetry.delete(challengeId);
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
