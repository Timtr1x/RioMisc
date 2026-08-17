import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startRuntime, type Runtime } from "../../apps/server/src/index.ts";
import { runtimeConfigSchema as cfgSchema } from "@rio/shared";
import { seedChallenge } from "../helpers.ts";
import { createCannedAdvisory } from "../../apps/server/src/control/advisory-runtime.ts";
import type { AdvisoryRunInput } from "../../apps/server/src/control/advisory-runtime.ts";

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

async function waitFor(fn: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timeout waiting for ${label}`);
}

describe("MVP-2.5 control-plane + WorkerPool gating", () => {
  const runtimes: Runtime[] = [];
  const dirs: string[] = [];

  afterEach(async () => {
    for (const r of runtimes.splice(0)) {
      try {
        await r.close();
      } catch {
        /* ignore */
      }
    }
    for (const d of dirs) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });

  function managerCfg(mode: "ACTIVE" | "SHADOW" | "OFF") {
    return cfgSchema.parse({
      manager: { enabled: mode !== "OFF", mode, debounceMs: 5, planTtlMs: 90_000, maxCandidates: 40, callTimeoutMs: 2000 },
      reflection: { enabledByDefault: true, mode: "HYBRID", cooldownMs: 0, maxConcurrent: 2, callTimeoutMs: 3000 },
    });
  }

  async function boot(opts: {
    advisory?: ReturnType<typeof createCannedAdvisory>;
    solverConcurrency?: number;
    reflectionMode?: "OFF" | "HEURISTIC" | "LLM" | "HYBRID";
  } = {}): Promise<Runtime> {
    const dataDir = mkdtempSync(join(tmpdir(), "rio-mvp25-int-"));
    dirs.push(dataDir);
    const parsed = managerCfg("ACTIVE");
    const runtime = await startRuntime({
      skipApi: true,
      advisory: opts.advisory,
      configOverrides: {
        contest: { adapter: "none", poll: { initialMs: 60_000, maxMs: 60_000 } },
        workers: { solverConcurrency: opts.solverConcurrency ?? 4, triageConcurrency: 4 },
        manager: parsed.manager,
        reflection: { ...parsed.reflection, mode: opts.reflectionMode ?? "HYBRID" },
        agent: { allowMockFallback: true, progressIntervalMs: 120_000, reflectionAfterStalledMs: 300_000, stallDetectMs: 180_000, contextCompactThreshold: 0.8, compactTriggerThreshold: 0.7 },
        paths: { dataDir, configDir: join(process.cwd(), "config") },
      } as never,
    });
    runtimes.push(runtime);
    return runtime;
  }

  function seedQueued(runtime: Runtime, n = 40): void {
    const now = Date.now();
    for (let i = 1; i <= n; i++) {
      runtime.repos.challenges.create(
        seedChallenge({
          id: `ch_${pad(i)}`,
          title: `Challenge ${pad(i)}`,
          lifecycleStatus: "QUEUED",
          startStatus: "NOT_REQUIRED",
          discoveredAt: now,
          lastPriorityScore: 100 - i,
          category: i % 2 === 0 ? "CRYPTO" : "MISC",
        }),
      );
    }
  }

  function cannedPicks(ids: string[]) {
    return createCannedAdvisory({
      manager: {
        summary: `start ${ids.join(",")}`,
        decisions: ids.map((challengeId, i) => ({
          challengeId,
          action: "START",
          priority: 95 - i,
          reflectionEnabled: true,
          reason: "canned pick",
        })),
      },
      reflection: {
        diagnosis: "Current solver is overcommitted to LSB.",
        likelyMistakes: ["overcommit"],
        missedEvidence: ["tail"],
        recommendedNextSteps: [{ action: "inspect tail", reason: "cheap", expectedSignal: "magic" }],
        shouldContinueCurrentDirection: false,
        recommendHandoff: null,
        confidence: 0.8,
      },
    });
  }

  it("40 queued / 4 slots / fake plan starts only #03,#07,#12,#19", async () => {
    const started: string[] = [];
    const advisory = cannedPicks(["ch_03", "ch_07", "ch_12", "ch_19"]);
    const runtime = await boot({ advisory });
    runtime.bus.subscribe((e) => {
      if (e.type === "SOLVER_STARTED" && e.challengeId) started.push(e.challengeId);
    });
    seedQueued(runtime, 40);
    runtime.control.requestManagerReplan("MANUAL");
    await runtime.control.flushManager();
    await runtime.control.runSchedulerTick();
    const active = runtime.repos.challenges.listByStatus("ACTIVE").map((c) => c.id).sort();
    expect(active).toEqual(["ch_03", "ch_07", "ch_12", "ch_19"]);
    expect(runtime.control.workerActiveCount()).toBe(4);
    expect(started.sort()).toEqual(["ch_03", "ch_07", "ch_12", "ch_19"]);
    const queued = runtime.repos.challenges.listByStatus("QUEUED");
    expect(queued).toHaveLength(36);
  });

  it("after #03 SOLVED a replan can admit another queued id", async () => {
    const picks = ["ch_03", "ch_07", "ch_12", "ch_19"];
    const advisory = createCannedAdvisory({
      manager: (input: AdvisoryRunInput<unknown>) => {
        const snap = JSON.parse(input.userPrompt) as { candidates: { challengeId: string }[] };
        const avail = new Set(snap.candidates.map((c) => c.challengeId));
        const chosen = (avail.has("ch_03") ? picks : ["ch_07", "ch_12", "ch_19", "ch_22"]).filter((id) => avail.has(id));
        return {
          summary: "next",
          decisions: chosen.map((challengeId, i) => ({
            challengeId,
            action: "START",
            priority: 90 - i,
            reflectionEnabled: null,
            reason: "slot-free",
          })),
        };
      },
    });
    const runtime = await boot({ advisory });
    seedQueued(runtime, 40);
    runtime.control.requestManagerReplan("MANUAL");
    await runtime.control.flushManager();
    await runtime.control.runSchedulerTick();
    expect(runtime.repos.challenges.get("ch_03")?.lifecycleStatus).toBe("ACTIVE");
    await runtime.control.handleSubmissionCorrect("ch_03");
    runtime.repos.challenges.update("ch_03", { lifecycleStatus: "SOLVED" });
    await waitFor(() => runtime.control.workerActiveCount() < 4, 10_000, "slot free after #03");
    runtime.control.requestManagerReplan("MANUAL");
    await runtime.control.flushManager();
    await runtime.control.runSchedulerTick();
    await runtime.control.runSchedulerTick();
    expect(runtime.repos.challenges.get("ch_22")?.lifecycleStatus).toBe("ACTIVE");
  });

  it("Manager 500/timeout emits fallback and still starts Solvers", async () => {
    const events: string[] = [];
    const runtime = await boot({
      advisory: createCannedAdvisory({
        fail: { task: "MANAGER", error: { code: "ADVISORY_TIMEOUT", message: "timeout", retryable: true } },
      }),
    });
    runtime.bus.subscribe((e) => events.push(e.type));
    seedQueued(runtime, 10);
    runtime.control.requestManagerReplan("MANUAL");
    await runtime.control.flushManager();
    expect(events).toContain("MANAGER_FALLBACK_ACTIVATED");
    await runtime.control.runSchedulerTick();
    expect(runtime.repos.challenges.listByStatus("ACTIVE").length).toBeGreaterThan(0);
    expect(runtime.control.workerActiveCount()).toBeGreaterThan(0);
    expect(runtime.control.workerActiveCount()).toBeLessThanOrEqual(4);
  });

  it("3×NO_SIGNAL ⇒ one Reflector call, persisted, injected to the same worker", async () => {
    let reflectionCalls = 0;
    const advisory = createCannedAdvisory({
      manager: { summary: "s", decisions: [{ challengeId: "ch_01", action: "START", priority: 90, reflectionEnabled: true, reason: "x" }] },
      reflection: async () => {
        reflectionCalls += 1;
        return {
          diagnosis: "Current solver is overcommitted to LSB.",
          likelyMistakes: ["lsb"],
          missedEvidence: [],
          recommendedNextSteps: [{ action: "switch", reason: "no signal", expectedSignal: "new family" }],
          shouldContinueCurrentDirection: false,
          recommendHandoff: null,
          confidence: 0.6,
        };
      },
    });
    const runtime = await boot({ advisory, reflectionMode: "LLM" });
    seedQueued(runtime, 4);
    runtime.control.requestManagerReplan("MANUAL");
    await runtime.control.flushManager();
    await runtime.control.runSchedulerTick();
    await waitFor(() => runtime.control.workerActiveCount() >= 1, 15_000, "worker up");
    const id = "ch_01";
    for (let i = 0; i < 3; i++) {
      runtime.repos.experiments.create({
        challengeId: id,
        key: `k${i}`,
        artifactSha256: "x",
        tool: "analyze_lsb",
        canonicalArgs: `{}:${i}`,
        resultSummary: "nothing",
        outcome: "NO_SIGNAL",
      });
    }
    const beforeWorkers = runtime.control.workerActiveCount();
    const result = await runtime.control.runReflection(id, "LLM");
    expect(reflectionCalls).toBe(1);
    expect(result.status).toBe("COMPLETED");
    expect(result.injected).toBe(true);
    expect(runtime.repos.reflectionRuns.listByChallenge(id).some((r) => r.status === "COMPLETED")).toBe(true);
    expect(runtime.control.workerActiveCount()).toBe(beforeWorkers);
    expect(runtime.repos.sessions.listByChallenge(id).length).toBe(1);
  });

  it("per-challenge Reflection OFF ⇒ zero Reflector calls despite wrong flag + stall", async () => {
    let reflectionCalls = 0;
    const advisory = createCannedAdvisory({
      manager: { summary: "s", decisions: [] },
      reflection: async () => {
        reflectionCalls += 1;
        return {
          diagnosis: "should not run",
          likelyMistakes: [],
          missedEvidence: [],
          recommendedNextSteps: [],
          shouldContinueCurrentDirection: true,
          recommendHandoff: null,
          confidence: 0.1,
        };
      },
    });
    const runtime = await boot({ advisory, reflectionMode: "LLM" });
    runtime.repos.challenges.create(seedChallenge({ id: "ch_off", lifecycleStatus: "ACTIVE", wrongSubmissionCount: 2, progressStatus: "STALLED", discoveredAt: Date.now() }));
    runtime.repos.orchestration.update("ch_off", { reflectionOverride: "OFF" });
    runtime.repos.progress.append({
      challengeId: "ch_off",
      sessionId: null,
      summary: "stuck",
      hypotheses: ["a"],
      confirmedFacts: [],
      rejectedHypotheses: [],
      nextActions: [],
      confidence: 0.1,
      progressLevel: "NONE",
      stalled: true,
    });
    const skipped = await runtime.control.runAutomaticReflection("ch_off", "WRONG_FLAG");
    expect(skipped.skipped).toBe(true);
    expect(reflectionCalls).toBe(0);
  });

  it("4 busy Solvers + 2 Reflections ⇒ solver active count stays 4", async () => {
    let inFlight = 0;
    let maxRefl = 0;
    const advisory = createCannedAdvisory({
      manager: {
        summary: "four",
        decisions: ["ch_01", "ch_02", "ch_03", "ch_04"].map((challengeId, i) => ({
          challengeId,
          action: "START",
          priority: 90 - i,
          reflectionEnabled: true,
          reason: "x",
        })),
      },
      reflection: async () => {
        inFlight += 1;
        maxRefl = Math.max(maxRefl, inFlight);
        await new Promise((r) => setTimeout(r, 200));
        inFlight -= 1;
        return {
          diagnosis: "review",
          likelyMistakes: [],
          missedEvidence: [],
          recommendedNextSteps: [{ action: "a", reason: "r", expectedSignal: "s" }],
          shouldContinueCurrentDirection: true,
          recommendHandoff: null,
          confidence: 0.5,
        };
      },
    });
    const runtime = await boot({ advisory });
    seedQueued(runtime, 8);
    runtime.control.requestManagerReplan("MANUAL");
    await runtime.control.flushManager();
    await runtime.control.runSchedulerTick();
    await waitFor(() => runtime.control.workerActiveCount() === 4, 20_000, "4 workers");
    const a = runtime.control.runReflection("ch_01", "LLM");
    const b = runtime.control.runReflection("ch_02", "LLM");
    await waitFor(() => runtime.control.reflectionInFlight() === 2, 5_000, "2 reflections");
    expect(runtime.control.workerActiveCount()).toBe(4);
    await Promise.all([a, b]);
    expect(maxRefl).toBe(2);
    expect(runtime.control.workerActiveCount()).toBe(4);
  });

  it("Force Start + Lock survives a later Manager HOLD", async () => {
    const advisory = createCannedAdvisory({
      manager: {
        summary: "hold 10",
        decisions: [{ challengeId: "ch_10", action: "HOLD", priority: 1, reflectionEnabled: false, reason: "hold" }],
      },
    });
    const runtime = await boot({ advisory });
    seedQueued(runtime, 12);
    runtime.repos.orchestration.update("ch_10", { strategyLocked: true, manualDispatch: "FORCE_START" });
    runtime.control.requestManagerReplan("MANUAL");
    await runtime.control.flushManager();
    const plans = runtime.repos.managerPlans.list(10);
    const locked = plans.flatMap((p) => runtime.repos.managerDecisions.listByPlan(p.id)).filter((d) => d.challengeId === "ch_10");
    expect(locked.some((d) => d.rejectionReason === "STRATEGY_LOCKED")).toBe(true);
    await runtime.control.runSchedulerTick();
    expect(runtime.repos.challenges.get("ch_10")?.lifecycleStatus).toBe("ACTIVE");
    expect(runtime.repos.orchestration.get("ch_10")?.manualDispatch).toBe("FORCE_START");
    expect(runtime.repos.orchestration.get("ch_10")?.strategyLocked).toBe(true);
  });

  it("synthetic burst: workers ≤ concurrency, manager in-flight ≤ 1, reflection ≤ max", async () => {
    const runtime = await boot({ advisory: cannedPicks(["ch_01", "ch_02", "ch_03", "ch_04"]), solverConcurrency: 4 });
    seedQueued(runtime, 20);
    for (let i = 0; i < 8; i++) runtime.control.requestManagerReplan("CHALLENGE_BATCH");
    expect(runtime.control.managerInFlight()).toBeLessThanOrEqual(1);
    await runtime.control.flushManager();
    await runtime.control.runSchedulerTick();
    expect(runtime.control.workerActiveCount()).toBeLessThanOrEqual(4);
    expect(runtime.control.reflectionInFlight()).toBeLessThanOrEqual(2);
  });
});
