// Challenge State Machine (§11-12).
// All lifecycle transitions MUST go through transition(); direct status writes
// are forbidden elsewhere. Transition + event append happen in one transaction.
import type {
  Challenge,
  ChallengeLifecycleStatus,
  DomainEvent,
  SolverType,
} from "@rio/domain";
import type { Repositories } from "@rio/database";

export type TransitionEvent =
  | "PREPARE_START"
  | "PREPARE_DONE"
  | "PREPARE_FAILED"
  | "PREPARE_RETRY"
  | "UNSUPPORTED"
  | "QUEUE"
  | "SCHEDULE"
  | "PAUSE"
  | "RESUME"
  | "PARK"
  | "UNPARK"
  | "CANDIDATE_FOUND"
  | "VERIFY_FAIL"
  | "VERIFY_OK"
  | "SUBMIT_CORRECT"
  | "SUBMIT_WRONG"
  | "SUBMIT_RATE_LIMIT"
  | "SOLVER_ERROR"
  | "SOLVER_STOPPED"
  | "RESTART_SOLVER"
  | "REOPEN"
  | "RECOVER_PREPARING"
  | "RECOVER_ACTIVE"
  | "RECOVER_VERIFYING"
  | "RECOVER_SUBMITTING";

export type LifecycleEventName =
  | "CHALLENGE_DISCOVERED"
  | "CHALLENGE_PREPARE_STARTED"
  | "CHALLENGE_READY"
  | "CHALLENGE_QUEUED"
  | "CHALLENGE_PAUSED"
  | "CHALLENGE_RESUMED"
  | "CHALLENGE_PARKED"
  | "CHALLENGE_UNPARKED"
  | "CHALLENGE_ACTIVE"
  | "CHALLENGE_VERIFYING"
  | "CHALLENGE_SUBMITTING"
  | "CHALLENGE_SOLVED"
  | "CHALLENGE_UNSUPPORTED"
  | "CHALLENGE_ERROR"
  | "CHALLENGE_RECOVERY_RESET_PREPARATION"
  | "CHALLENGE_RECOVERY_REQUEUED"
  | "CHALLENGE_RECOVERY_VERIFY_INTERRUPTED"
  | "CHALLENGE_RECOVERY_SUBMIT_INTERRUPTED";

const T: Partial<Record<ChallengeLifecycleStatus, Partial<Record<TransitionEvent, ChallengeLifecycleStatus>>>> = {
  DISCOVERED: {
    PREPARE_START: "PREPARING",
    UNSUPPORTED: "UNSUPPORTED",
    PREPARE_FAILED: "ERROR",
  },
  PREPARING: {
    PREPARE_DONE: "READY",
    PREPARE_FAILED: "ERROR",
    PREPARE_RETRY: "DISCOVERED",
    UNSUPPORTED: "UNSUPPORTED",
    RECOVER_PREPARING: "DISCOVERED",
  },
  READY: {
    QUEUE: "QUEUED",
    PAUSE: "PAUSED",
    UNSUPPORTED: "UNSUPPORTED",
    CANDIDATE_FOUND: "VERIFYING",
  },
  QUEUED: {
    SCHEDULE: "ACTIVE",
    PAUSE: "PAUSED",
    PARK: "PARKED",
    UNSUPPORTED: "UNSUPPORTED",
    SOLVER_ERROR: "QUEUED",
    CANDIDATE_FOUND: "VERIFYING",
  },
  ACTIVE: {
    PAUSE: "PAUSED",
    PARK: "PARKED",
    CANDIDATE_FOUND: "VERIFYING",
    SUBMIT_WRONG: "ACTIVE",
    SOLVER_ERROR: "QUEUED",
    SOLVER_STOPPED: "QUEUED",
    RESTART_SOLVER: "QUEUED",
    RECOVER_ACTIVE: "QUEUED",
  },
  VERIFYING: {
    VERIFY_FAIL: "ACTIVE",
    VERIFY_OK: "SUBMITTING",
    PAUSE: "PAUSED",
    SOLVER_ERROR: "QUEUED",
    RECOVER_VERIFYING: "QUEUED",
  },
  SUBMITTING: {
    SUBMIT_CORRECT: "SOLVED",
    SUBMIT_WRONG: "ACTIVE",
    SUBMIT_RATE_LIMIT: "SUBMITTING",
    PAUSE: "PAUSED",
    RECOVER_SUBMITTING: "QUEUED",
  },
  PAUSED: {
    RESUME: "QUEUED",
    PARK: "PARKED",
  },
  PARKED: {
    UNPARK: "QUEUED",
  },
  SOLVED: {
    REOPEN: "QUEUED",
  },
  // ERROR, UNSUPPORTED are terminal.
};

export const EVENT_FOR_TRANSITION: Partial<Record<TransitionEvent, LifecycleEventName>> = {
  PREPARE_START: "CHALLENGE_PREPARE_STARTED",
  PREPARE_DONE: "CHALLENGE_READY",
  PREPARE_FAILED: "CHALLENGE_ERROR",
  PREPARE_RETRY: "CHALLENGE_RECOVERY_RESET_PREPARATION",
  UNSUPPORTED: "CHALLENGE_UNSUPPORTED",
  QUEUE: "CHALLENGE_QUEUED",
  SCHEDULE: "CHALLENGE_ACTIVE",
  PAUSE: "CHALLENGE_PAUSED",
  RESUME: "CHALLENGE_RESUMED",
  PARK: "CHALLENGE_PARKED",
  UNPARK: "CHALLENGE_UNPARKED",
  CANDIDATE_FOUND: "CHALLENGE_VERIFYING",
  VERIFY_OK: "CHALLENGE_SUBMITTING",
  SUBMIT_CORRECT: "CHALLENGE_SOLVED",
  SUBMIT_WRONG: "CHALLENGE_ACTIVE",
  VERIFY_FAIL: "CHALLENGE_ACTIVE",
  SOLVER_ERROR: "CHALLENGE_QUEUED",
  SOLVER_STOPPED: "CHALLENGE_QUEUED",
  RESTART_SOLVER: "CHALLENGE_QUEUED",
  REOPEN: "CHALLENGE_QUEUED",
  RECOVER_PREPARING: "CHALLENGE_RECOVERY_RESET_PREPARATION",
  RECOVER_ACTIVE: "CHALLENGE_RECOVERY_REQUEUED",
  RECOVER_VERIFYING: "CHALLENGE_RECOVERY_VERIFY_INTERRUPTED",
  RECOVER_SUBMITTING: "CHALLENGE_RECOVERY_SUBMIT_INTERRUPTED",
};

export interface TransitionContext {
  payload?: Record<string, unknown>;
  solverType?: SolverType;
  sessionId?: string | null;
  reason?: string | null;
  startedAt?: number | null;
}

export interface TransitionResult {
  from: ChallengeLifecycleStatus;
  to: ChallengeLifecycleStatus;
  allowed: boolean;
  events: DomainEvent[];
}

export class StateMachine {
  constructor(private repos: Repositories) {}

  transition(challengeId: string, event: TransitionEvent, ctx: TransitionContext = {}): TransitionResult {
    const challenge = this.repos.challenges.get(challengeId);
    if (!challenge) {
      throw new Error(`transition on unknown challenge ${challengeId}`);
    }
    const target = T[challenge.lifecycleStatus]?.[event];
    if (!target) {
      return {
        from: challenge.lifecycleStatus,
        to: challenge.lifecycleStatus,
        allowed: false,
        events: [],
      };
    }
    const now = Date.now();
    const patch: Partial<Challenge> = { lifecycleStatus: target };
    if (ctx.payload) {
      if (ctx.payload.pausedReason !== undefined) patch.pausedReason = String(ctx.payload.pausedReason);
      if (ctx.payload.parkedReason !== undefined) patch.parkedReason = String(ctx.payload.parkedReason);
      if (ctx.payload.blockedReason !== undefined) patch.blockedReason = String(ctx.payload.blockedReason);
    }
    if (ctx.solverType !== undefined) patch.currentSolverType = ctx.solverType;
    if (ctx.sessionId !== undefined) patch.currentSessionId = ctx.sessionId;
    if (event === "SCHEDULE" && patch.lifecycleStatus === "ACTIVE" && challenge.solverStartedAt === null) {
      patch.solverStartedAt = now;
    }
    if (event === "SUBMIT_CORRECT") {
      patch.wallClockSolveMs = now - challenge.discoveredAt;
      patch.currentSessionId = null;
    }
    if (event === "PAUSE" && ctx.reason) patch.pausedReason = ctx.reason;
    if (event === "RESUME" || event === "UNPARK") {
      patch.pausedReason = null;
      patch.parkedReason = null;
    }
    if (event === "SOLVER_ERROR" || event === "SOLVER_STOPPED" || event === "RESTART_SOLVER" || event === "REOPEN") {
      patch.currentSessionId = null;
      patch.currentSolverType = null;
      if (event === "RESTART_SOLVER" || event === "REOPEN") patch.solverRestartCount = (challenge.solverRestartCount ?? 0) + 1;
    }
    // Recovery events keep the session row so Pi can resume.

    const eventName = EVENT_FOR_TRANSITION[event];
    const events = this.repos.db.tx(() => {
      this.repos.challenges.update(challengeId, patch);
      const list: DomainEvent[] = [];
      if (eventName) {
        list.push(this.repos.events.append(eventName, challengeId, { from: challenge.lifecycleStatus, to: target, ...ctx.payload }));
      }
      if (event === "UNSUPPORTED") {
        list.push(this.repos.events.append("CHALLENGE_UNSUPPORTED", challengeId, { category: challenge.category }));
      }
      return list;
    });

    return { from: challenge.lifecycleStatus, to: target, allowed: true, events };
  }
}
