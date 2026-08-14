// VERIFYING crash: VERIFIED candidate → submit pipeline; otherwise QUEUED. Never orphan ACTIVE.
import { describe, it, expect, afterEach } from "vitest";
import { createRepositories } from "@rio/database";
import { createLogger } from "@rio/shared";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StateMachine } from "../../apps/server/src/state-machine.ts";
import { RecoveryManager } from "../../apps/server/src/control/recovery.ts";
import { SubmissionManager } from "../../apps/server/src/control/submission.ts";
import { EventBus } from "../../apps/server/src/control/bus.ts";
import { seedChallenge } from "../helpers.ts";

describe("VERIFYING crash E2E", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
  });

  function setup() {
    const dir = mkdtempSync(join(tmpdir(), "rio-ver-e2e-"));
    dirs.push(dir);
    const repos = createRepositories(join(dir, "t.sqlite"));
    const sm = new StateMachine(repos);
    const bus = new EventBus();
    const logger = createLogger("silent");
    const submission = new SubmissionManager({
      repos,
      adapter: { kind: "mock", submitFlag: async () => ({ ok: true, correct: true, status: "CORRECT", raw: {} }) } as never,
      stateMachine: sm,
      bus,
      logger,
      autoSubmit: true,
      confidenceThreshold: 0.85,
      localMaxWrong: 3,
      defaultCooldownMs: 0,
      inject: () => {},
      onAutoSubmitDisabled: () => {},
      onCorrect: () => {},
    });
    const recovery = new RecoveryManager({
      repos,
      stateMachine: sm,
      bus,
      logger,
      submissionManager: submission,
      preparation: { refreshChallengeFile: () => {} } as never,
      workspacesRoot: join(dir, "ws"),
    });
    return { repos, recovery, submission };
  }

  it("does not leave VERIFYING as ACTIVE with zero workers", async () => {
    const { repos, recovery, submission } = setup();
    repos.challenges.create(seedChallenge({ id: "ch_v", lifecycleStatus: "VERIFYING" }));
    await recovery.start();
    expect(repos.challenges.get("ch_v")!.lifecycleStatus).not.toBe("ACTIVE");
    expect(repos.challenges.get("ch_v")!.lifecycleStatus).not.toBe("VERIFYING");
    submission.stop();
    repos.db.close();
  });

  it("resumes submission when a VERIFIED candidate exists", async () => {
    const { repos, recovery, submission } = setup();
    repos.challenges.create(seedChallenge({ id: "ch_ok", lifecycleStatus: "VERIFYING" }));
    repos.candidates.create({
      challengeId: "ch_ok",
      sessionId: null,
      value: "flag{verified}",
      confidence: 1,
      reason: "local",
      evidenceJson: "[]",
      status: "VERIFIED",
    });
    await recovery.start();
    expect(repos.challenges.get("ch_ok")!.lifecycleStatus).toBe("SUBMITTING");
    submission.stop();
    repos.db.close();
  });
});
