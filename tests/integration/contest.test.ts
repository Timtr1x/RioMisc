// Integration tests: MockContest → repos; SubmissionManager wrong→correct flow (§111).
import { describe, it, expect } from "vitest";
import { MockContestAdapter } from "@rio/contest";
import { createRepositories } from "@rio/database";
import { StateMachine } from "../../apps/server/src/state-machine.ts";
import { SubmissionManager } from "../../apps/server/src/control/submission.ts";
import { EventBus } from "../../apps/server/src/control/bus.ts";
import { createLogger } from "@rio/shared";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("mock contest → challenge repo", () => {
  it("discovers all released challenges through the adapter", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rio-int-"));
    const repos = createRepositories(join(dir, "t.sqlite"));
    const mock = new MockContestAdapter();
    mock.loadFixtures();
    await mock.authenticate();
    await mock.applySchedule();
    const list = await mock.listChallenges();
    expect(list.length).toBe(22);
    const detail = await mock.getChallenge("misc-001");
    expect(detail.attachments.length).toBe(1);
    expect(detail.attachments[0]!.name).toBe("message.txt");
    await mock.close();
    repos.db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("hints unlock only after start + delay", async () => {
    let now = Date.now();
    const mock = new MockContestAdapter({ hintDelayMs: 600_000 }, () => now);
    mock.loadFixtures();
    await mock.authenticate();
    await mock.applySchedule();
    await mock.startChallenge("crypto-001");
    const locked = await mock.getHint("crypto-001");
    expect(locked.notAvailable).toBe(true);
    now += 601_000;
    const unlocked = await mock.getHint("crypto-001");
    expect(unlocked.ok).toBe(true);
    expect(unlocked.hint).toBeTruthy();
    await mock.close();
  });

  it("mock submit: wrong then correct, dedup on repeat", async () => {
    const mock = new MockContestAdapter();
    mock.loadFixtures();
    await mock.authenticate();
    const wrong = await mock.submitFlag("crypto-002", "flag{not_the_flag}");
    expect(wrong.status).toBe("WRONG");
    const dup = await mock.submitFlag("crypto-002", "flag{not_the_flag}");
    expect(dup.status).toBe("RATE_LIMITED"); // duplicate
    const correct = await mock.submitFlag("crypto-002", "flag{rsa_needs_big_primes}");
    expect(correct.correct).toBe(true);
    await mock.close();
  });
});

describe("SubmissionManager", () => {
  it("wrong flag → feedback injected → auto-submit disabled at max wrong", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rio-submgr-"));
    const repos = createRepositories(join(dir, "t.sqlite"));
    const sm = new StateMachine(repos);
    const bus = new EventBus();
    const logger = createLogger("silent");
    const mock = new MockContestAdapter();
    mock.loadFixtures();
    await mock.authenticate();

    const injected: string[] = [];
    let disabled = false;
    const manager = new SubmissionManager({
      repos,
      adapter: mock,
      stateMachine: sm,
      bus,
      logger,
      autoSubmit: true,
      confidenceThreshold: 0.85,
      localMaxWrong: 3,
      defaultCooldownMs: 0,
      inject: (_id, msg) => injected.push(msg),
      onAutoSubmitDisabled: () => {
        disabled = true;
      },
      onCorrect: () => {},
    });

    // set up challenge in DB
    repos.challenges.create({
      id: "ch_x",
      remoteId: "crypto-002",
      title: "Baby RSA",
      description: "n = 1\ne = 1\nc = 1\nclose primes. Decrypt.",
      category: "CRYPTO",
      subcategory: null,
      score: 100,
      solveCount: null,
      lifecycleStatus: "ACTIVE",
      startStatus: "STARTED",
      hintStatus: "LOCKED",
      progressStatus: "UNKNOWN",
      priority: 0,
      lastPriorityScore: null,
      difficultyEstimate: 2,
      currentSolverType: "CRYPTO",
      currentSessionId: "sess_x",
      wrongSubmissionCount: 0,
      solverRestartCount: 0,
      pausedReason: null,
      parkedReason: null,
      blockedReason: null,
      contentHash: "h",
      discoveredAt: Date.now(),
      updatedAt: Date.now(),
      startedAt: Date.now(),
      solverStartedAt: Date.now(),
      wallClockSolveMs: 0,
      activeSolveMs: 0,
      remoteCreatedAt: null,
      remoteUpdatedAt: null,
    });

    // wrong candidate
    await manager.onCandidate({ challengeId: "ch_x", sessionId: "sess_x", value: "flag{wrong_one}", confidence: 0.9, reason: "derived from analysis", evidence: [{ type: "tool_output", text: "x" }] });
    let c = repos.challenges.get("ch_x")!;
    expect(c.lifecycleStatus).toBe("ACTIVE");
    expect(repos.submissions.countWrong("ch_x")).toBe(1);
    expect(injected.some((m) => m.includes("flag{wrong_one}") && m.includes("OFFICIAL SUBMISSION FEEDBACK"))).toBe(true);

    // second wrong → reflection trigger path (feedback)
    await manager.onCandidate({ challengeId: "ch_x", sessionId: "sess_x", value: "flag{wrong_two}", confidence: 0.9, reason: "derived from analysis 2", evidence: [{ type: "tool_output", text: "y" }] });
    expect(repos.submissions.countWrong("ch_x")).toBe(2);

    // third wrong → auto submit disabled
    await manager.onCandidate({ challengeId: "ch_x", sessionId: "sess_x", value: "flag{wrong_three}", confidence: 0.9, reason: "derived from analysis 3", evidence: [{ type: "tool_output", text: "z" }] });
    c = repos.challenges.get("ch_x")!;
    expect(disabled).toBe(true);
    expect(c.blockedReason).toBe("MANUAL_REVIEW_REQUIRED");

    // correct flag: auto-submit is now disabled → candidate stays PENDING → manual submit
    await manager.onCandidate({ challengeId: "ch_x", sessionId: "sess_x", value: "flag{rsa_needs_big_primes}", confidence: 0.95, reason: "fermat factorization", evidence: [{ type: "tool_output", text: "ok" }] });
    const correct = repos.candidates.listByChallenge("ch_x").find((k) => k.value === "flag{rsa_needs_big_primes}")!;
    expect(correct.status).toBe("PENDING");
    await manager.manualSubmit("ch_x", correct.id);
    const solved = repos.challenges.get("ch_x")!;
    expect(solved.lifecycleStatus).toBe("SOLVED");
    expect(repos.submissions.listByChallenge("ch_x").some((s) => s.status === "CORRECT")).toBe(true);

    manager.stop();
    await mock.close();
    repos.db.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
