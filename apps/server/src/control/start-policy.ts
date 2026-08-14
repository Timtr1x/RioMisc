// ChallengeStartService: ON_DISCOVERY / ON_PREPARATION / ON_SOLVER_ASSIGNMENT.
// Temporary contest failures stay retryable (NOT_STARTED); only fatal errors become FAILED.
import type { Challenge, StartPolicy } from "@rio/domain";
import type { ContestAdapter } from "@rio/contest";
import type { Repositories } from "@rio/database";
import type { EventBus } from "./bus.js";
import type { RioLogger } from "@rio/shared";

export type StartPhase = "discovery" | "preparation" | "solver";

export class ContestOperationError extends Error {
  readonly retryable: boolean;
  constructor(message: string, opts: { retryable?: boolean; cause?: unknown } = {}) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = "ContestOperationError";
    this.retryable = opts.retryable ?? true;
  }
}

export function shouldStartOn(policy: StartPolicy, phase: StartPhase): boolean {
  if (policy === "ON_DISCOVERY") return phase === "discovery";
  if (policy === "ON_PREPARATION") return phase === "preparation";
  return phase === "solver";
}

export function isRetryableContestError(err: unknown): boolean {
  if (err instanceof ContestOperationError) return err.retryable;
  const msg = err instanceof Error ? err.message : String(err);
  if (/HTTP 401|HTTP 403|unauthorized|forbidden|not found|HTTP 404|unsupported|fatal/i.test(msg)) return false;
  if (/timeout|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|network|429|rate.?limit|HTTP 5\d\d|fetch failed|aborted|socket/i.test(msg)) {
    return true;
  }
  return true;
}

export class ChallengeStartService {
  constructor(
    private deps: {
      adapter: ContestAdapter;
      repos: Repositories;
      bus: EventBus;
      policy: StartPolicy;
      logger?: RioLogger;
    },
  ) {}

  replaceAdapter(adapter: ContestAdapter): void {
    this.deps.adapter = adapter;
  }

  async ensure(challenge: Challenge, phase: StartPhase): Promise<void> {
    if (!shouldStartOn(this.deps.policy, phase)) return;
    const latest = this.deps.repos.challenges.get(challenge.id);
    if (!latest) return;
    if (latest.startStatus === "STARTED" || latest.startStatus === "NOT_REQUIRED") return;
    if (latest.startStatus === "FAILED") {
      throw new ContestOperationError(`startChallenge permanently failed for ${latest.id}`, { retryable: false });
    }
    if (latest.startStatus === "STARTING") return;

    this.deps.repos.challenges.update(latest.id, { startStatus: "STARTING" });
    const remoteId = latest.remoteId;
    if (this.deps.adapter.startChallenge && remoteId && remoteId !== "local") {
      try {
        const result = await this.deps.adapter.startChallenge(remoteId);
        if (!result.ok) {
          const retryable = isRetryableContestError(new Error(result.message ?? "start failed"));
          this.deps.repos.challenges.update(latest.id, { startStatus: retryable ? "NOT_STARTED" : "FAILED" });
          throw new ContestOperationError(result.message ?? "startChallenge failed", { retryable });
        }
      } catch (e) {
        if (e instanceof ContestOperationError) throw e;
        const retryable = isRetryableContestError(e);
        this.deps.repos.challenges.update(latest.id, { startStatus: retryable ? "NOT_STARTED" : "FAILED" });
        throw new ContestOperationError(e instanceof Error ? e.message : String(e), { retryable, cause: e });
      }
    }
    this.deps.repos.challenges.update(latest.id, { startStatus: "STARTED", startedAt: Date.now() });
    this.deps.bus.publish({ type: "CHALLENGE_STARTED", challengeId: latest.id, payload: { phase } });
  }
}

/** @deprecated use ChallengeStartService.ensure */
export async function ensureChallengeStarted(opts: {
  policy: StartPolicy;
  phase: StartPhase;
  challenge: Challenge;
  adapter: ContestAdapter;
  repos: Repositories;
  bus: EventBus;
}): Promise<void> {
  await new ChallengeStartService({
    adapter: opts.adapter,
    repos: opts.repos,
    bus: opts.bus,
    policy: opts.policy,
  }).ensure(opts.challenge, opts.phase);
}
