// Three StartPolicy phases through ControlPlane poll / prepare / solver call sites.
import { describe, it, expect, afterEach } from "vitest";
import { createRepositories } from "@rio/database";
import { createLogger } from "@rio/shared";
import { EventBus } from "../../apps/server/src/control/bus.ts";
import { ChallengeStartService } from "../../apps/server/src/control/start-policy.ts";
import { syncRemoteChallenge } from "../../apps/server/src/control/challenge-sync.ts";
import { seedChallenge } from "../helpers.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { StartPolicy } from "@rio/domain";

describe("StartPolicy E2E (discovery / preparation / solver)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
  });

  function harness(policy: StartPolicy) {
    const dir = mkdtempSync(join(tmpdir(), "rio-sp-"));
    dirs.push(dir);
    const repos = createRepositories(join(dir, "t.sqlite"));
    const bus = new EventBus();
    const phases: string[] = [];
    bus.subscribe((e) => {
      if (e.type === "CHALLENGE_STARTED") phases.push(String(e.payload.phase));
    });
    const started: string[] = [];
    const adapter = {
      kind: "fake",
      startChallenge: async (id: string) => {
        started.push(id);
        return { ok: true };
      },
    };
    const svc = new ChallengeStartService({ adapter: adapter as never, repos, bus, policy, logger: createLogger("silent") });
    return { repos, bus, svc, phases, started };
  }

  it("ON_DISCOVERY starts on poll create and retries after a 500", async () => {
    const { repos, bus, svc, phases, started } = harness("ON_DISCOVERY");
    let fail = true;
    const flaky = new ChallengeStartService({
      adapter: {
        kind: "fake",
        startChallenge: async (id: string) => {
          if (fail) {
            fail = false;
            throw new Error("HTTP 500 start");
          }
          started.push(id);
          return { ok: true };
        },
      } as never,
      repos,
      bus,
      policy: "ON_DISCOVERY",
    });
    const created = syncRemoteChallenge({
      repos,
      bus,
      remote: {
        remoteId: "r-disc",
        title: "t",
        description: "d",
        category: "Misc",
        score: 1,
        solveCount: 0,
        createdAt: 0,
        updatedAt: 0,
        attachments: [],
      },
    })!;
    const ch = repos.challenges.get(created.challengeId)!;
    await expect(flaky.ensure(ch, "discovery")).rejects.toThrow(/500/);
    expect(repos.challenges.get(ch.id)!.startStatus).toBe("NOT_STARTED");
    await flaky.ensure(repos.challenges.get(ch.id)!, "discovery");
    expect(repos.challenges.get(ch.id)!.startStatus).toBe("STARTED");
    expect(phases).toEqual(["discovery"]);
    expect(started).toEqual(["r-disc"]);
    await svc.ensure(repos.challenges.get(ch.id)!, "preparation");
    await svc.ensure(repos.challenges.get(ch.id)!, "solver");
    expect(started).toEqual(["r-disc"]);
    repos.db.close();
  });

  it("ON_PREPARATION starts only at preparation", async () => {
    const { repos, svc, phases, started } = harness("ON_PREPARATION");
    repos.challenges.create(seedChallenge({ id: "ch_prep", lifecycleStatus: "DISCOVERED", startStatus: "NOT_STARTED", remoteId: "r-prep" }));
    await svc.ensure(repos.challenges.get("ch_prep")!, "discovery");
    expect(started).toEqual([]);
    await svc.ensure(repos.challenges.get("ch_prep")!, "preparation");
    expect(started).toEqual(["r-prep"]);
    expect(phases).toEqual(["preparation"]);
    await svc.ensure(repos.challenges.get("ch_prep")!, "solver");
    expect(started).toEqual(["r-prep"]);
    repos.db.close();
  });

  it("ON_SOLVER_ASSIGNMENT starts only when a solver is assigned", async () => {
    const { repos, svc, phases, started } = harness("ON_SOLVER_ASSIGNMENT");
    repos.challenges.create(seedChallenge({ id: "ch_sol", lifecycleStatus: "QUEUED", startStatus: "NOT_STARTED", remoteId: "r-sol" }));
    await svc.ensure(repos.challenges.get("ch_sol")!, "discovery");
    await svc.ensure(repos.challenges.get("ch_sol")!, "preparation");
    expect(started).toEqual([]);
    await svc.ensure(repos.challenges.get("ch_sol")!, "solver");
    expect(started).toEqual(["r-sol"]);
    expect(phases).toEqual(["solver"]);
    repos.db.close();
  });
});
