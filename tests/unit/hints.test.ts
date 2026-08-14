// Hint stall clock + fetch error + unsupported adapter. Drives shipped HintManager.
import { describe, it, expect, afterEach } from "vitest";
import { createRepositories } from "@rio/database";
import { createLogger } from "@rio/shared";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StateMachine } from "../../apps/server/src/state-machine.ts";
import { HintManager } from "../../apps/server/src/control/hints.ts";
import { EventBus } from "../../apps/server/src/control/bus.ts";
import { isStalledForHint, lastMeaningfulActivityAt, hintBackoffMs } from "../../apps/server/src/control/hint-policy.ts";
import { seedChallenge } from "../helpers.ts";

describe("hint backoff", () => {
  it("starts at 15s and caps at 5min", () => {
    expect(hintBackoffMs(1)).toBe(15_000);
    expect(hintBackoffMs(2)).toBe(30_000);
    expect(hintBackoffMs(10)).toBe(5 * 60_000);
  });
});

describe("hint safety", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
  });

  it("recent meaningful progress is not stalled; stale progress is", () => {
    const now = 1_700_000_000_000;
    const challenge = {
      progressStatus: "ACTIVE" as const,
      solverStartedAt: now - 60 * 60_000,
      startedAt: now - 60 * 60_000,
    };
    const recent = { progressLevel: "SIGNIFICANT", stalled: false, createdAt: now - 10_000 };
    expect(isStalledForHint(challenge, recent, now, 300_000)).toBe(false);
    expect(lastMeaningfulActivityAt(challenge, recent)).toBe(now - 10_000);
    const stale = { progressLevel: "MINOR", stalled: false, createdAt: now - 400_000 };
    expect(isStalledForHint(challenge, stale, now, 300_000)).toBe(true);
  });

  it("does not use now - solverStartedAt when recent progress exists", () => {
    const now = Date.now();
    const challenge = { progressStatus: "ACTIVE", solverStartedAt: now - 2 * 3600_000, startedAt: now - 2 * 3600_000 };
    const latest = { progressLevel: "MINOR", stalled: false, createdAt: now - 5_000 };
    expect(isStalledForHint(challenge, latest, now, 300_000)).toBe(false);
  });

  it("recent progress → no fetch; stale progress → fetch; throw → ELIGIBLE; no getHint → NOT_SUPPORTED", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rio-hint-"));
    dirs.push(dir);
    const repos = createRepositories(join(dir, "t.sqlite"));
    const sm = new StateMachine(repos);
    const now = Date.now();
    repos.challenges.create(
      seedChallenge({
        id: "ch_h",
        remoteId: "remote-h",
        lifecycleStatus: "ACTIVE",
        startStatus: "STARTED",
        hintStatus: "ELIGIBLE",
        startedAt: now - 20 * 60_000,
        solverStartedAt: now - 20 * 60_000,
      }),
    );
    repos.progress.append({
      challengeId: "ch_h",
      sessionId: null,
      summary: "moving",
      hypotheses: [],
      confirmedFacts: [],
      rejectedHypotheses: [],
      nextActions: [],
      confidence: 0.4,
      progressLevel: "SIGNIFICANT",
      stalled: false,
    });

    let calls = 0;
    const adapter = {
      kind: "mock",
      getHint: async () => {
        calls += 1;
        throw new Error("hint api down");
      },
    };
    const mgr = new HintManager({
      repos,
      adapter: adapter as never,
      stateMachine: sm,
      bus: new EventBus(),
      logger: createLogger("silent"),
      autoFetch: true,
      requireStalled: true,
      eligibleAfterStartMs: 0,
      stallThresholdMs: 300_000,
      inject: () => {},
    });

    await mgr.tick();
    expect(calls).toBe(0);

    repos.db.run("UPDATE solver_progress SET created_at = ?, progress_level = 'MINOR' WHERE challenge_id = ?", now - 400_000, "ch_h");

    await mgr.tick();
    expect(calls).toBe(1);
    expect(repos.challenges.get("ch_h")!.hintStatus).toBe("ELIGIBLE");

    const noHint = new HintManager({
      repos,
      adapter: { kind: "idle" } as never,
      stateMachine: sm,
      bus: new EventBus(),
      logger: createLogger("silent"),
      autoFetch: true,
      requireStalled: true,
      eligibleAfterStartMs: 0,
      stallThresholdMs: 300_000,
      inject: () => {},
    });
    repos.challenges.update("ch_h", { hintStatus: "ELIGIBLE" });
    const before = calls;
    await noHint.tick();
    await noHint.fetchHint("ch_h", { force: true });
    expect(repos.challenges.get("ch_h")!.hintStatus).toBe("NOT_SUPPORTED");
    expect(calls).toBe(before);
    repos.db.close();
  });
});
