// Submission-timeout integration: judge receives once, never responds → UNKNOWN, received==1.
import { describe, it, expect } from "vitest";
import { createRepositories } from "@rio/database";
import { createLogger } from "@rio/shared";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StateMachine } from "../../apps/server/src/state-machine.ts";
import { SubmissionManager } from "../../apps/server/src/control/submission.ts";
import { EventBus } from "../../apps/server/src/control/bus.ts";
import { seedChallenge } from "../helpers.ts";

describe("submission unknown integration", () => {
  it("hanging judge records received once and never auto-retries", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rio-unk-"));
    const repos = createRepositories(join(dir, "t.sqlite"));
    const sm = new StateMachine(repos);
    repos.challenges.create(seedChallenge({ id: "ch_j", remoteId: "judge-1", lifecycleStatus: "ACTIVE" }));
    let received = 0;
    const mgr = new SubmissionManager({
      repos,
      adapter: {
        kind: "mock",
        submitFlag: () => {
          received += 1;
          return new Promise(() => {});
        },
      } as never,
      stateMachine: sm,
      bus: new EventBus(),
      logger: createLogger("silent"),
      autoSubmit: true,
      confidenceThreshold: 0.5,
      localMaxWrong: 5,
      defaultCooldownMs: 0,
      submitTimeoutMs: 300,
      inject: () => {},
      onAutoSubmitDisabled: () => {},
      onCorrect: () => {},
    });
    await mgr.onCandidate({
      challengeId: "ch_j",
      sessionId: "s",
      value: "flag{once}",
      confidence: 0.99,
      reason: "derived from analysis",
      evidence: [{ type: "tool_output", text: "ok" }],
    });
    expect(repos.submissions.listByChallenge("ch_j")[0]!.status).toBe("UNKNOWN");
    expect(mgr.hasRetryTimer(repos.submissions.listByChallenge("ch_j")[0]!.id)).toBe(false);
    await new Promise((r) => setTimeout(r, 1200));
    expect(received).toBe(1);
    mgr.stop();
    repos.db.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
