import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createRepositories } from "@rio/database";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StateMachine } from "../../apps/server/src/state-machine.ts";
import { acceptIntoSolved } from "../../apps/server/src/control/accept.ts";
import { seedChallenge } from "../helpers.ts";

describe("acceptIntoSolved", () => {
  let dir: string;
  let repos: ReturnType<typeof createRepositories>;
  let sm: StateMachine;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rio-acc-"));
    repos = createRepositories(join(dir, "t.sqlite"));
    sm = new StateMachine(repos);
    repos.challenges.create(seedChallenge({ id: "ch_a", lifecycleStatus: "DISCOVERED" }));
    sm.transition("ch_a", "PREPARE_START");
    sm.transition("ch_a", "PREPARE_DONE");
    sm.transition("ch_a", "QUEUE");
    sm.transition("ch_a", "SCHEDULE", { sessionId: "s1" });
    sm.transition("ch_a", "PAUSE", { payload: { pausedReason: "manual" } });
  });

  afterEach(() => {
    repos.db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("marks PAUSED challenges SOLVED (human accept after pause)", () => {
    expect(repos.challenges.get("ch_a")!.lifecycleStatus).toBe("PAUSED");
    acceptIntoSolved(sm, repos, "ch_a", "cand_1");
    expect(repos.challenges.get("ch_a")!.lifecycleStatus).toBe("SOLVED");
  });

  it("marks PARKED challenges SOLVED", () => {
    sm.transition("ch_a", "RESUME");
    sm.transition("ch_a", "PARK", { payload: { parkedReason: "later" } });
    expect(repos.challenges.get("ch_a")!.lifecycleStatus).toBe("PARKED");
    acceptIntoSolved(sm, repos, "ch_a", "cand_1");
    expect(repos.challenges.get("ch_a")!.lifecycleStatus).toBe("SOLVED");
  });

  it("is a no-op when already SOLVED", () => {
    acceptIntoSolved(sm, repos, "ch_a", "cand_1");
    acceptIntoSolved(sm, repos, "ch_a", "cand_1");
    expect(repos.challenges.get("ch_a")!.lifecycleStatus).toBe("SOLVED");
  });
});
