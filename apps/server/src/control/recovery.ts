// RecoveryManager (§41): runs at startup. Restores every challenge to a
// consistent state after a crash (leases stale, sessions preserved).
import type { RioLogger } from "@rio/shared";
import type { Repositories } from "@rio/database";
import type { EventBus } from "./bus.js";
import type { StateMachine } from "../state-machine.js";
import type { SubmissionManager } from "./submission.js";
import type { PreparationService } from "./preparation.js";

export class RecoveryManager {
  constructor(
    private deps: {
      repos: Repositories;
      stateMachine: StateMachine;
      bus: EventBus;
      logger: RioLogger;
      submissionManager: SubmissionManager;
      preparation: PreparationService;
    },
  ) {}

  async start(): Promise<void> {
    const { repos, logger } = this.deps;

    // 1. All leases are stale after a restart (old worker processes are gone).
    const stale = repos.leases.expired(Date.now() + 365 * 24 * 3600 * 1000);
    const staleChallengeIds = new Set(repos.challenges.listByStatus("ACTIVE").map((c) => c.id));
    for (const lease of stale) {
      repos.leases.release(lease.challengeId);
      staleChallengeIds.add(lease.challengeId);
      this.deps.bus.publish({ type: "WORKER_LOST", challengeId: lease.challengeId, payload: { reason: "recovery: stale lease" } });
    }
    for (const challengeId of staleChallengeIds) {
      const c = repos.challenges.get(challengeId);
      if (!c) continue;
      if (c.lifecycleStatus === "ACTIVE") {
        const res = this.deps.stateMachine.transition(challengeId, "SOLVER_STOPPED", { payload: { reason: "recovery: worker lost" } });
        if (res.allowed) logger.info({ event: "recovery_requeued", challengeId }, "challenge requeued after crash");
      } else if (c.lifecycleStatus === "VERIFYING") {
        this.deps.stateMachine.transition(challengeId, "VERIFY_FAIL", { payload: { reason: "recovery: interrupted verification" } });
        logger.info({ event: "recovery_verifying", challengeId }, "verification interrupted — back to ACTIVE");
      } else if (c.lifecycleStatus === "PREPARING") {
        logger.info({ event: "recovery_preparing", challengeId }, "preparation interrupted — will re-run");
      }
    }

    // 2. SUBMITTING challenges: drive pending/unknown submissions.
    for (const c of repos.challenges.listByStatus("SUBMITTING")) {
      await this.deps.submissionManager.recoverSubmitting(c.id);
    }

    // 3. PAUSED stay paused. PARKED stay parked. ERROR stays error (manual).
    // 4. Refresh challenge.txt for any active-ish challenge (hints/wrong may have changed).
    for (const c of [...repos.challenges.listByStatus("QUEUED"), ...repos.challenges.listByStatus("ACTIVE"), ...repos.challenges.listByStatus("PAUSED")]) {
      this.deps.preparation.refreshChallengeFile(c.id);
    }

    logger.info({ event: "recovery_done" }, "recovery completed");
  }
}
