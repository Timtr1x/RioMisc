// Startup recovery matrix against the shipped RecoveryManager (§7).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createRepositories } from "@rio/database";
import { createLogger } from "@rio/shared";
import { mkdirSync, writeFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StateMachine } from "../../apps/server/src/state-machine.ts";
import { RecoveryManager } from "../../apps/server/src/control/recovery.ts";
import { SubmissionManager } from "../../apps/server/src/control/submission.ts";
import { EventBus } from "../../apps/server/src/control/bus.ts";
import { seedChallenge } from "../helpers.ts";

function mockAdapter() {
  return {
    kind: "mock",
    submitFlag: async () => ({ ok: true, correct: true, status: "CORRECT" as const, raw: {} }),
  };
}

describe("RecoveryManager startup matrix", () => {
  let dir: string;
  let repos: ReturnType<typeof createRepositories>;
  let sm: StateMachine;
  let recovery: RecoveryManager;
  let submission: SubmissionManager;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rio-rec-"));
    repos = createRepositories(join(dir, "t.sqlite"));
    sm = new StateMachine(repos);
    const bus = new EventBus();
    const logger = createLogger("silent");
    submission = new SubmissionManager({
      repos,
      adapter: mockAdapter() as never,
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
    recovery = new RecoveryManager({
      repos,
      stateMachine: sm,
      bus,
      logger,
      submissionManager: submission,
      preparation: { refreshChallengeFile: () => {} } as never,
      workspacesRoot: join(dir, "ws"),
    });
  });

  afterEach(() => {
    submission.stop();
    repos.db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("PREPARING → DISCOVERED and resets DOWNLOADING + stale .part", async () => {
    repos.challenges.create(seedChallenge({ id: "ch_prep", lifecycleStatus: "PREPARING" }));
    const att = repos.attachments.create({
      challengeId: "ch_prep",
      remoteId: null,
      name: "big.bin",
      remoteUrl: null,
      localPath: join(dir, "ws", "ch_prep", "input", "big.bin"),
      sizeBytes: 10,
      sha256: null,
      mime: null,
      downloadStatus: "DOWNLOADING",
      downloadedAt: null,
    });
    const input = join(dir, "ws", "ch_prep", "input");
    mkdirSync(input, { recursive: true });
    writeFileSync(`${att.localPath}.part`, "partial");
    await recovery.start();
    expect(repos.challenges.get("ch_prep")!.lifecycleStatus).toBe("DISCOVERED");
    expect(repos.attachments.get(att.id)!.downloadStatus).toBe("PENDING");
    expect(existsSync(`${att.localPath}.part`)).toBe(false);
    const ev = repos.events.recent("ch_prep");
    expect(ev.some((e) => e.type === "CHALLENGE_RECOVERY_RESET_PREPARATION")).toBe(true);
  });

  it("ACTIVE → QUEUED, session INTERRUPTED (kept), leases gone", async () => {
    repos.challenges.create(seedChallenge({ id: "ch_act", lifecycleStatus: "ACTIVE", currentSessionId: "sess_a" }));
    const sess = repos.sessions.create({
      challengeId: "ch_act",
      solverType: "MISC",
      piSessionId: "pi-1",
      piSessionFile: join(dir, "s.jsonl"),
      providerId: null,
      modelId: null,
      status: "ACTIVE",
      startedAt: Date.now(),
      lastActiveAt: Date.now(),
      endedAt: null,
      inputTokens: 0,
      outputTokens: 0,
      toolCalls: 0,
    });
    repos.leases.acquire({
      challengeId: "ch_act",
      workerId: "w1",
      acquiredAt: Date.now(),
      heartbeatAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    });
    await recovery.start();
    const c = repos.challenges.get("ch_act")!;
    expect(c.lifecycleStatus).toBe("QUEUED");
    expect(repos.sessions.get(sess.id)!.status).toBe("INTERRUPTED");
    expect(repos.sessions.get(sess.id)!.piSessionFile).toBe(join(dir, "s.jsonl"));
    expect(repos.leases.getByChallenge("ch_act")).toBeNull();
    expect(repos.events.recent("ch_act").some((e) => e.type === "CHALLENGE_RECOVERY_REQUEUED")).toBe(true);
  });

  it("VERIFYING is not left ACTIVE with zero workers", async () => {
    repos.challenges.create(seedChallenge({ id: "ch_ver", lifecycleStatus: "VERIFYING" }));
    await recovery.start();
    expect(repos.challenges.get("ch_ver")!.lifecycleStatus).toBe("QUEUED");
    expect(repos.challenges.get("ch_ver")!.lifecycleStatus).not.toBe("ACTIVE");
    expect(repos.events.recent("ch_ver").some((e) => e.type === "CHALLENGE_RECOVERY_VERIFY_INTERRUPTED")).toBe(true);
  });

  it("PAUSED / PARKED / SOLVED stay put", async () => {
    repos.challenges.create(seedChallenge({ id: "ch_pause", lifecycleStatus: "PAUSED", pausedReason: "manual" }));
    repos.challenges.create(seedChallenge({ id: "ch_park", lifecycleStatus: "PARKED", parkedReason: "later" }));
    repos.challenges.create(seedChallenge({ id: "ch_sol", lifecycleStatus: "SOLVED" }));
    await recovery.start();
    expect(repos.challenges.get("ch_pause")!.lifecycleStatus).toBe("PAUSED");
    expect(repos.challenges.get("ch_park")!.lifecycleStatus).toBe("PARKED");
    expect(repos.challenges.get("ch_sol")!.lifecycleStatus).toBe("SOLVED");
  });

  it("SENDING at restart becomes UNKNOWN and does not invoke submitFlag", async () => {
    let submits = 0;
    const hanging = new SubmissionManager({
      repos,
      adapter: { kind: "mock", submitFlag: async () => { submits += 1; return { ok: true, correct: true, status: "CORRECT", raw: {} }; } } as never,
      stateMachine: sm,
      bus: new EventBus(),
      logger: createLogger("silent"),
      autoSubmit: true,
      confidenceThreshold: 0.85,
      localMaxWrong: 3,
      defaultCooldownMs: 0,
      inject: () => {},
      onAutoSubmitDisabled: () => {},
      onCorrect: () => {},
    });
    repos.challenges.create(seedChallenge({ id: "ch_sub", lifecycleStatus: "SUBMITTING" }));
    const cand = repos.candidates.create({
      challengeId: "ch_sub",
      sessionId: null,
      value: "flag{x}",
      confidence: 0.9,
      reason: "derived from analysis",
      evidenceJson: "[]",
      status: "SUBMITTED",
    });
    const sub = repos.submissions.createOrGet({
      challengeId: "ch_sub",
      candidateId: cand.id,
      flagHash: "ab",
      flagValue: "flag{x}",
      status: "QUEUED",
    });
    repos.submissions.update(sub.id, { status: "SENDING" });
    const rec = new RecoveryManager({
      repos,
      stateMachine: sm,
      bus: new EventBus(),
      logger: createLogger("silent"),
      submissionManager: hanging,
      preparation: { refreshChallengeFile: () => {} } as never,
      workspacesRoot: join(dir, "ws"),
    });
    await rec.start();
    expect(repos.submissions.get(sub.id)!.status).toBe("UNKNOWN");
    expect(repos.challenges.get("ch_sub")!.blockedReason).toBe("SUBMISSION_OUTCOME_UNKNOWN");
    expect(submits).toBe(0);
    expect(hanging.hasRetryTimer(sub.id)).toBe(false);
    hanging.stop();
  });
});
