import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  shouldStartOn,
  ChallengeStartService,
  ContestOperationError,
  isRetryableContestError,
} from "../../apps/server/src/control/start-policy.ts";
import { createRepositories } from "@rio/database";
import { EventBus } from "../../apps/server/src/control/bus.ts";
import { seedChallenge } from "../helpers.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("start policy predicates", () => {
  it("ON_DISCOVERY only fires at discovery", () => {
    expect(shouldStartOn("ON_DISCOVERY", "discovery")).toBe(true);
    expect(shouldStartOn("ON_DISCOVERY", "preparation")).toBe(false);
    expect(shouldStartOn("ON_DISCOVERY", "solver")).toBe(false);
  });

  it("ON_PREPARATION only fires at preparation", () => {
    expect(shouldStartOn("ON_PREPARATION", "discovery")).toBe(false);
    expect(shouldStartOn("ON_PREPARATION", "preparation")).toBe(true);
    expect(shouldStartOn("ON_PREPARATION", "solver")).toBe(false);
  });

  it("ON_SOLVER_ASSIGNMENT only fires at solver", () => {
    expect(shouldStartOn("ON_SOLVER_ASSIGNMENT", "discovery")).toBe(false);
    expect(shouldStartOn("ON_SOLVER_ASSIGNMENT", "preparation")).toBe(false);
    expect(shouldStartOn("ON_SOLVER_ASSIGNMENT", "solver")).toBe(true);
  });
});

describe("ChallengeStartService", () => {
  let dir: string;
  let repos: ReturnType<typeof createRepositories>;
  let bus: EventBus;
  const started: string[] = [];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rio-start-"));
    repos = createRepositories(join(dir, "t.sqlite"));
    bus = new EventBus();
    started.length = 0;
  });

  afterEach(() => {
    repos.db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function adapter(impl?: { startChallenge?: (id: string) => Promise<{ ok: boolean; message?: string }> }) {
    return {
      kind: "fake",
      startChallenge: impl?.startChallenge ?? (async (id: string) => {
        started.push(id);
        return { ok: true };
      }),
    };
  }

  it("three policies call startChallenge only on their own phase", async () => {
    repos.challenges.create(seedChallenge({ id: "ch_a", lifecycleStatus: "DISCOVERED", startStatus: "NOT_STARTED", remoteId: "r1" }));
    for (const [policy, phase, expectCall] of [
      ["ON_DISCOVERY", "discovery", true],
      ["ON_DISCOVERY", "preparation", false],
      ["ON_PREPARATION", "preparation", true],
      ["ON_PREPARATION", "solver", false],
      ["ON_SOLVER_ASSIGNMENT", "solver", true],
      ["ON_SOLVER_ASSIGNMENT", "discovery", false],
    ] as const) {
      started.length = 0;
      repos.challenges.update("ch_a", { startStatus: "NOT_STARTED" });
      const svc = new ChallengeStartService({ adapter: adapter() as never, repos, bus, policy });
      await svc.ensure(repos.challenges.get("ch_a")!, phase);
      expect(started.length > 0).toBe(expectCall);
      if (expectCall) expect(repos.challenges.get("ch_a")!.startStatus).toBe("STARTED");
      else expect(repos.challenges.get("ch_a")!.startStatus).toBe("NOT_STARTED");
    }
  });

  it("is idempotent once STARTED", async () => {
    repos.challenges.create(seedChallenge({ id: "ch_b", lifecycleStatus: "DISCOVERED", startStatus: "NOT_STARTED", remoteId: "r1" }));
    const svc = new ChallengeStartService({ adapter: adapter() as never, repos, bus, policy: "ON_DISCOVERY" });
    await svc.ensure(repos.challenges.get("ch_b")!, "discovery");
    await svc.ensure(repos.challenges.get("ch_b")!, "discovery");
    expect(started).toEqual(["r1"]);
  });

  it("retryable 500 leaves NOT_STARTED", async () => {
    repos.challenges.create(seedChallenge({ id: "ch_c", lifecycleStatus: "DISCOVERED", startStatus: "NOT_STARTED", remoteId: "r1" }));
    const svc = new ChallengeStartService({
      adapter: adapter({ startChallenge: async () => { throw new Error("HTTP 500 start"); } }) as never,
      repos,
      bus,
      policy: "ON_DISCOVERY",
    });
    await expect(svc.ensure(repos.challenges.get("ch_c")!, "discovery")).rejects.toBeInstanceOf(ContestOperationError);
    expect(repos.challenges.get("ch_c")!.startStatus).toBe("NOT_STARTED");
    expect(isRetryableContestError(new ContestOperationError("HTTP 500 start", { retryable: true }))).toBe(true);
  });

  it("fatal 403 becomes FAILED and is not retryable", async () => {
    repos.challenges.create(seedChallenge({ id: "ch_d", lifecycleStatus: "DISCOVERED", startStatus: "NOT_STARTED", remoteId: "r1" }));
    const svc = new ChallengeStartService({
      adapter: adapter({ startChallenge: async () => { throw new Error("HTTP 403 forbidden"); } }) as never,
      repos,
      bus,
      policy: "ON_SOLVER_ASSIGNMENT",
    });
    await expect(svc.ensure(repos.challenges.get("ch_d")!, "solver")).rejects.toMatchObject({ retryable: false });
    expect(repos.challenges.get("ch_d")!.startStatus).toBe("FAILED");
    await expect(svc.ensure(repos.challenges.get("ch_d")!, "solver")).rejects.toMatchObject({ retryable: false });
    expect(started).toEqual([]);
  });

  it("adapter without startChallenge marks STARTED locally", async () => {
    repos.challenges.create(seedChallenge({ id: "ch_e", lifecycleStatus: "DISCOVERED", startStatus: "NOT_STARTED", remoteId: "r1" }));
    const svc = new ChallengeStartService({
      adapter: { kind: "local" } as never,
      repos,
      bus,
      policy: "ON_PREPARATION",
    });
    await svc.ensure(repos.challenges.get("ch_e")!, "preparation");
    expect(repos.challenges.get("ch_e")!.startStatus).toBe("STARTED");
  });
});
