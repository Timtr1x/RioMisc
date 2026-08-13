// Submission safety: trim, UNKNOWN no retry, RATE_LIMITED timer, SENDING→UNKNOWN.
import { describe, it, expect, afterEach } from "vitest";
import { createRepositories } from "@rio/database";
import { createLogger } from "@rio/shared";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StateMachine } from "../../apps/server/src/state-machine.ts";
import { SubmissionManager } from "../../apps/server/src/control/submission.ts";
import { EventBus } from "../../apps/server/src/control/bus.ts";
import { normalizeFlagValue } from "../../apps/server/src/control/flag.ts";
import { seedChallenge } from "../helpers.ts";

function makeMgr(
  repos: ReturnType<typeof createRepositories>,
  sm: StateMachine,
  adapter: { submitFlag: (id: string, flag: string) => Promise<unknown>; kind?: string },
) {
  return new SubmissionManager({
    repos,
    adapter: { kind: adapter.kind ?? "mock", submitFlag: adapter.submitFlag } as never,
    stateMachine: sm,
    bus: new EventBus(),
    logger: createLogger("silent"),
    autoSubmit: true,
    confidenceThreshold: 0.5,
    localMaxWrong: 5,
    defaultCooldownMs: 0,
    submitTimeoutMs: 400,
    inject: () => {},
    onAutoSubmitDisabled: () => {},
    onCorrect: () => {},
  });
}

describe("submission safety", () => {
  const dirs: string[] = [];
  const dbs: { close(): void }[] = [];
  afterEach(() => {
    for (const db of dbs) {
      try {
        db.close();
      } catch {
        /* ignore */
      }
    }
    dbs.length = 0;
    for (const d of dirs) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        /* windows file lock */
      }
    }
    dirs.length = 0;
  });

  function boot() {
    const dir = mkdtempSync(join(tmpdir(), "rio-ss-"));
    dirs.push(dir);
    const repos = createRepositories(join(dir, "t.sqlite"));
    dbs.push(repos.db);
    const sm = new StateMachine(repos);
    repos.challenges.create(seedChallenge({ id: "ch_x", remoteId: "r1", lifecycleStatus: "ACTIVE" }));
    return { repos, sm };
  }

  it("normalizeFlagValue trims so padded and bare flags collide", () => {
    expect(normalizeFlagValue(" flag{x} ")).toBe("flag{x}");
    expect(normalizeFlagValue("flag{x}")).toBe("flag{x}");
  });

  it("trim makes \" flag{x} \" and flag{x} the same candidate", async () => {
    const { repos, sm } = boot();
    const mgr = makeMgr(repos, sm, { submitFlag: async () => ({ ok: false, correct: false, status: "WRONG", raw: {} }) });
    await mgr.onCandidate({
      challengeId: "ch_x",
      sessionId: "s",
      value: " flag{x} ",
      confidence: 0.9,
      reason: "derived from analysis",
      evidence: [{ type: "tool_output", text: "t" }],
    });
    await mgr.onCandidate({
      challengeId: "ch_x",
      sessionId: "s",
      value: "flag{x}",
      confidence: 0.9,
      reason: "derived from analysis",
      evidence: [{ type: "tool_output", text: "t" }],
    });
    expect(repos.candidates.listByChallenge("ch_x").length).toBe(1);
    expect(repos.candidates.listByChallenge("ch_x")[0]!.value).toBe("flag{x}");
    mgr.stop();
  });

  it("adapter throw/timeout → UNKNOWN and no retry timer", async () => {
    const { repos, sm } = boot();
    let received = 0;
    const mgr = makeMgr(repos, sm, {
      submitFlag: async () => {
        received += 1;
        throw new Error("ECONNRESET");
      },
    });
    await mgr.onCandidate({
      challengeId: "ch_x",
      sessionId: "s",
      value: "flag{timeout}",
      confidence: 0.95,
      reason: "derived from analysis",
      evidence: [{ type: "tool_output", text: "t" }],
    });
    const sub = repos.submissions.listByChallenge("ch_x")[0]!;
    expect(sub.status).toBe("UNKNOWN");
    expect(repos.challenges.get("ch_x")!.blockedReason).toBe("SUBMISSION_OUTCOME_UNKNOWN");
    expect(mgr.hasRetryTimer(sub.id)).toBe(false);
    expect(mgr.retryTimerCount()).toBe(0);
    expect(received).toBe(1);
    mgr.stop();
  });

  it("RATE_LIMITED schedules a per-submission retry timer", async () => {
    const { repos, sm } = boot();
    const mgr = makeMgr(repos, sm, {
      submitFlag: async () => ({ ok: false, correct: false, status: "RATE_LIMITED", cooldownMs: 50_000, raw: {} }),
    });
    await mgr.onCandidate({
      challengeId: "ch_x",
      sessionId: "s",
      value: "flag{rate}",
      confidence: 0.95,
      reason: "derived from analysis",
      evidence: [{ type: "tool_output", text: "t" }],
    });
    const sub = repos.submissions.listByChallenge("ch_x")[0]!;
    expect(sub.status).toBe("RATE_LIMITED");
    expect(mgr.hasRetryTimer(sub.id)).toBe(true);
    mgr.stop();
  });

  it("hanging judge: received stays 1 after the old 60s retry window would have fired", async () => {
    const { repos, sm } = boot();
    let received = 0;
    const mgr = makeMgr(repos, sm, {
      submitFlag: () => {
        received += 1;
        return new Promise(() => {});
      },
    });
    const p = mgr.onCandidate({
      challengeId: "ch_x",
      sessionId: "s",
      value: "flag{hang}",
      confidence: 0.95,
      reason: "derived from analysis",
      evidence: [{ type: "tool_output", text: "t" }],
    });
    await p;
    const sub = repos.submissions.listByChallenge("ch_x")[0]!;
    expect(sub.status).toBe("UNKNOWN");
    expect(mgr.hasRetryTimer(sub.id)).toBe(false);
    await new Promise((r) => setTimeout(r, 1500));
    expect(received).toBe(1);
    mgr.stop();
  });
});
