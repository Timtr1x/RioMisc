// RecoveryManager: deterministic startup normalization from lifecycle +
// session + submission + on-disk files. Every lifecycle write goes through
// the state machine with recovery-specific events.
import { existsSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
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
      workspacesRoot?: string;
    },
  ) {}

  async start(): Promise<void> {
    const { repos, logger } = this.deps;

    this.#resetStaleDownloads();
    this.#clearAllLeases();

    for (const c of repos.challenges.list()) {
      switch (c.lifecycleStatus) {
        case "PREPARING": {
          const res = this.deps.stateMachine.transition(c.id, "RECOVER_PREPARING", {
            payload: { reason: "recovery: preparation interrupted" },
          });
          if (res.allowed) {
            logger.info({ event: "recovery_reset_preparation", challengeId: c.id }, "PREPARING → DISCOVERED");
          }
          break;
        }
        case "ACTIVE": {
          this.#interruptSessions(c.id);
          const res = this.deps.stateMachine.transition(c.id, "RECOVER_ACTIVE", {
            payload: { reason: "recovery: worker lost" },
          });
          if (res.allowed) {
            logger.info({ event: "recovery_requeued", challengeId: c.id }, "ACTIVE → QUEUED");
          }
          break;
        }
        case "VERIFYING": {
          this.#interruptSessions(c.id);
          const res = this.deps.stateMachine.transition(c.id, "RECOVER_VERIFYING", {
            payload: { reason: "recovery: verification interrupted" },
          });
          if (res.allowed) {
            logger.info({ event: "recovery_verify_interrupted", challengeId: c.id }, "VERIFYING → QUEUED");
          }
          break;
        }
        case "SUBMITTING": {
          await this.deps.submissionManager.recoverSubmitting(c.id);
          break;
        }
        default:
          // DISCOVERED / READY / QUEUED / PAUSED / PARKED / SOLVED / UNSUPPORTED / ERROR stay put.
          break;
      }
    }

    for (const c of [...repos.challenges.listByStatus("QUEUED"), ...repos.challenges.listByStatus("PAUSED")]) {
      this.deps.preparation.refreshChallengeFile(c.id);
    }

    logger.info({ event: "recovery_done" }, "recovery completed");
  }

  #interruptSessions(challengeId: string): void {
    const { repos, logger } = this.deps;
    for (const s of repos.sessions.listActive().filter((x) => x.challengeId === challengeId)) {
      repos.sessions.setStatus(s.id, "INTERRUPTED");
      logger.warn({ event: "session_interrupted", challengeId, sessionId: s.id }, "session marked INTERRUPTED");
    }
    const latest = repos.sessions.latestForChallenge(challengeId);
    if (latest && latest.status === "ACTIVE") {
      repos.sessions.setStatus(latest.id, "INTERRUPTED");
      logger.warn({ event: "session_interrupted", challengeId, sessionId: latest.id }, "session marked INTERRUPTED");
    }
  }

  #clearAllLeases(): void {
    const stale = this.deps.repos.leases.expired(Date.now() + 365 * 24 * 3600 * 1000);
    for (const lease of stale) {
      this.deps.repos.leases.release(lease.challengeId);
      this.deps.bus.publish({
        type: "WORKER_LOST",
        challengeId: lease.challengeId,
        payload: { reason: "recovery: stale lease" },
      });
    }
  }

  #resetStaleDownloads(): void {
    const { repos, logger } = this.deps;
    for (const c of repos.challenges.list()) {
      for (const att of repos.attachments.listByChallenge(c.id)) {
        if (att.downloadStatus === "DOWNLOADING") {
          repos.attachments.update(att.id, { downloadStatus: "PENDING" });
        }
        if (att.localPath) {
          const part = att.localPath.endsWith(".part") ? att.localPath : `${att.localPath}.part`;
          try {
            if (existsSync(part)) unlinkSync(part);
          } catch {
            /* ignore */
          }
        }
      }
    }
    const root = this.deps.workspacesRoot;
    if (!root || !existsSync(root)) return;
    let removed = 0;
    try {
      for (const name of readdirSync(root)) {
        const input = join(root, name, "input");
        if (!existsSync(input)) continue;
        for (const f of readdirSync(input)) {
          if (!f.endsWith(".part")) continue;
          try {
            unlinkSync(join(input, f));
            removed += 1;
          } catch {
            /* ignore */
          }
        }
      }
    } catch {
      /* ignore */
    }
    if (removed > 0) logger.info({ event: "recovery_stale_parts_removed", count: removed }, "deleted stale .part files");
  }
}
