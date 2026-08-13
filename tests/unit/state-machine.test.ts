// State machine unit tests (§110).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createRepositories } from "@rio/database";
import { StateMachine } from "../../apps/server/src/state-machine.ts";
import type { Challenge } from "@rio/domain";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function makeChallenge(): Challenge {
  return {
    id: "ch_test",
    remoteId: "test",
    title: "T",
    description: "D",
    category: "MISC",
    subcategory: null,
    score: 100,
    solveCount: null,
    lifecycleStatus: "DISCOVERED",
    startStatus: "NOT_STARTED",
    hintStatus: "LOCKED",
    progressStatus: "UNKNOWN",
    priority: 0,
    lastPriorityScore: null,
    difficultyEstimate: null,
    currentSolverType: null,
    currentSessionId: null,
    wrongSubmissionCount: 0,
    solverRestartCount: 0,
    pausedReason: null,
    parkedReason: null,
    blockedReason: null,
    contentHash: "h",
    discoveredAt: Date.now(),
    updatedAt: Date.now(),
    startedAt: null,
    solverStartedAt: null,
    wallClockSolveMs: 0,
    activeSolveMs: 0,
    remoteCreatedAt: null,
    remoteUpdatedAt: null,
  };
}

describe("StateMachine", () => {
  let dir: string;
  let repos: ReturnType<typeof createRepositories>;
  let sm: StateMachine;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rio-sm-"));
    repos = createRepositories(join(dir, "t.sqlite"));
    sm = new StateMachine(repos);
    repos.challenges.create(makeChallenge());
  });

  it("walks the happy path DISCOVERED → PREPARING → READY → QUEUED → ACTIVE → … → SOLVED", () => {
    expect(sm.transition("ch_test", "PREPARE_START").to).toBe("PREPARING");
    expect(sm.transition("ch_test", "PREPARE_DONE").to).toBe("READY");
    expect(sm.transition("ch_test", "QUEUE").to).toBe("QUEUED");
    expect(sm.transition("ch_test", "SCHEDULE", { solverType: "MISC", sessionId: "s1" }).to).toBe("ACTIVE");
    expect(sm.transition("ch_test", "CANDIDATE_FOUND").to).toBe("VERIFYING");
    expect(sm.transition("ch_test", "VERIFY_OK").to).toBe("SUBMITTING");
    expect(sm.transition("ch_test", "SUBMIT_CORRECT").to).toBe("SOLVED");
    const c = repos.challenges.get("ch_test")!;
    expect(c.lifecycleStatus).toBe("SOLVED");
    // session is cleared from the challenge on solve (session row still exists)
    expect(c.currentSessionId).toBeNull();
    // but solver type is preserved for the record
    expect(c.currentSolverType).toBe("MISC");
  });

  it("reopens SOLVED when a human rejects the flag", () => {
    sm.transition("ch_test", "PREPARE_START");
    sm.transition("ch_test", "PREPARE_DONE");
    sm.transition("ch_test", "QUEUE");
    sm.transition("ch_test", "SCHEDULE", { solverType: "MISC", sessionId: "s1" });
    sm.transition("ch_test", "CANDIDATE_FOUND");
    sm.transition("ch_test", "VERIFY_OK");
    sm.transition("ch_test", "SUBMIT_CORRECT");
    expect(repos.challenges.get("ch_test")!.lifecycleStatus).toBe("SOLVED");
    expect(sm.transition("ch_test", "REOPEN").to).toBe("QUEUED");
    expect(repos.challenges.get("ch_test")!.lifecycleStatus).toBe("QUEUED");
  });

  it("rejects invalid transitions and keeps state", () => {
    // SOLVED is terminal
    expect(sm.transition("ch_test", "PREPARE_START").to).toBe("PREPARING");
    expect(sm.transition("ch_test", "PREPARE_DONE").to).toBe("READY");
    expect(sm.transition("ch_test", "QUEUE").to).toBe("QUEUED");
    expect(sm.transition("ch_test", "SCHEDULE").to).toBe("ACTIVE");
    expect(sm.transition("ch_test", "SUBMIT_CORRECT").allowed).toBe(false); // can't jump to SOLVED
    expect(repos.challenges.get("ch_test")!.lifecycleStatus).toBe("ACTIVE");
  });

  it("wrong submission returns to ACTIVE", () => {
    for (const ev of ["PREPARE_START", "PREPARE_DONE", "QUEUE", "SCHEDULE", "CANDIDATE_FOUND", "VERIFY_OK"] as const) {
      sm.transition("ch_test", ev);
    }
    expect(sm.transition("ch_test", "SUBMIT_WRONG").to).toBe("ACTIVE");
  });

  it("pause/resume roundtrip preserves session", () => {
    sm.transition("ch_test", "PREPARE_START");
    sm.transition("ch_test", "PREPARE_DONE");
    sm.transition("ch_test", "QUEUE");
    sm.transition("ch_test", "SCHEDULE", { sessionId: "sess_1" });
    sm.transition("ch_test", "PAUSE", { payload: { pausedReason: "manual" } });
    expect(repos.challenges.get("ch_test")!.pausedReason).toBe("manual");
    sm.transition("ch_test", "RESUME");
    expect(repos.challenges.get("ch_test")!.lifecycleStatus).toBe("QUEUED");
    expect(repos.challenges.get("ch_test")!.pausedReason).toBeNull();
    expect(repos.challenges.get("ch_test")!.currentSessionId).toBe("sess_1");
  });

  it("marks unsupported challenges and appends domain events", () => {
    repos.challenges.update("ch_test", { category: "WEB" });
    const res = sm.transition("ch_test", "UNSUPPORTED");
    expect(res.to).toBe("UNSUPPORTED");
    const events = repos.events.recent("ch_test");
    expect(events.some((e) => e.type === "CHALLENGE_UNSUPPORTED")).toBe(true);
  });

  it("recovery events requeue without disguising as SOLVER_ERROR", () => {
    sm.transition("ch_test", "PREPARE_START");
    expect(sm.transition("ch_test", "RECOVER_PREPARING").to).toBe("DISCOVERED");
    expect(repos.events.recent("ch_test").some((e) => e.type === "CHALLENGE_RECOVERY_RESET_PREPARATION")).toBe(true);
    sm.transition("ch_test", "PREPARE_START");
    sm.transition("ch_test", "PREPARE_DONE");
    sm.transition("ch_test", "QUEUE");
    sm.transition("ch_test", "SCHEDULE", { sessionId: "s-rec" });
    expect(sm.transition("ch_test", "RECOVER_ACTIVE").to).toBe("QUEUED");
    expect(repos.challenges.get("ch_test")!.currentSessionId).toBe("s-rec");
    sm.transition("ch_test", "SCHEDULE", { sessionId: "s-rec" });
    sm.transition("ch_test", "CANDIDATE_FOUND");
    expect(sm.transition("ch_test", "RECOVER_VERIFYING").to).toBe("QUEUED");
    expect(repos.events.recent("ch_test").some((e) => e.type === "CHALLENGE_RECOVERY_VERIFY_INTERRUPTED")).toBe(true);
  });

  it("increments restart count on RESTART_SOLVER", () => {
    sm.transition("ch_test", "PREPARE_START");
    sm.transition("ch_test", "PREPARE_DONE");
    sm.transition("ch_test", "QUEUE");
    sm.transition("ch_test", "SCHEDULE");
    sm.transition("ch_test", "RESTART_SOLVER");
    const c = repos.challenges.get("ch_test")!;
    expect(c.lifecycleStatus).toBe("QUEUED");
    expect(c.solverRestartCount).toBe(1);
  });

  afterEach(() => {
    repos.db.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
