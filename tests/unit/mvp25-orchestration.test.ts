import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { createRepositories, RioDb } from "@rio/database";
import { applySchemaMigrations } from "../../packages/database/src/schema-migrations.ts";
import { dispatchPlanSchema, llmReflectionResultSchema } from "@rio/domain";
import { runtimeConfigSchema as cfgSchema, effectiveManagerMode } from "@rio/shared";
import { createLogger } from "@rio/shared";
import { seedChallenge } from "../helpers.ts";
import {
  evaluateReflectionGate,
  buildReflectionFingerprint,
  resolveReflectionEnabled,
  shouldSkipDuplicateFingerprint,
} from "../../apps/server/src/control/reflection/reflection-gate.ts";
import { ReflectionExecutor } from "../../apps/server/src/control/reflection/reflection-service.ts";
import { createCannedAdvisory, parseStructuredWithRepair, extractJsonObject } from "../../apps/server/src/control/advisory-runtime.ts";
import { buildManagerSnapshot, prefilterCandidates, snapshotContainsUnsupportedDetails } from "../../apps/server/src/control/manager/manager-snapshot.ts";
import { validateAndApply, isPlanFresh, shouldUseManagerGate, clampPriority } from "../../apps/server/src/control/manager/manager-policy.ts";
import { admitChallenge } from "../../apps/server/src/control/manager/scheduler-gate.ts";
import { ManagerService } from "../../apps/server/src/control/manager/manager-service.ts";
import { ManagerCoordinator } from "../../apps/server/src/control/manager/manager-coordinator.ts";
import { EventBus } from "../../apps/server/src/control/bus.ts";
import type { ChallengeOrchestration, DispatchPlan } from "@rio/domain";

function tmpRepos() {
  const dir = mkdtempSync(join(tmpdir(), "rio-mvp25-"));
  const repos = createRepositories(join(dir, "t.sqlite"));
  return { dir, repos };
}

function orch(partial: Partial<ChallengeOrchestration> = {}): ChallengeOrchestration {
  return {
    challengeId: partial.challengeId ?? "ch",
    strategyLocked: false,
    manualDispatch: "AUTO",
    reflectionOverride: "INHERIT",
    reflectionModeOverride: null,
    managerAction: null,
    managerPriority: null,
    managerReflectionEnabled: null,
    managerReason: null,
    managerPlanId: null,
    managerUpdatedAt: null,
    updatedAt: Date.now(),
    ...partial,
  };
}

describe("MVP-2.5 reflection gate / fingerprint / precedence", () => {
  it("triggers on wrong flag, 3×NO_SIGNAL, 120s stall, repeated experiment; clean state does not", () => {
    expect(evaluateReflectionGate({ noSignalStreak: 0, secondsSinceProgress: 0, wrongFlags: 1, repeatedTool: false })).toBe("WRONG_FLAG");
    expect(evaluateReflectionGate({ noSignalStreak: 3, secondsSinceProgress: 0, wrongFlags: 0, repeatedTool: false })).toBe("NO_SIGNAL_STREAK");
    expect(evaluateReflectionGate({ noSignalStreak: 0, secondsSinceProgress: 120, wrongFlags: 0, repeatedTool: false })).toBe("STALLED");
    expect(evaluateReflectionGate({ noSignalStreak: 0, secondsSinceProgress: 0, wrongFlags: 0, repeatedTool: true })).toBe("REPEATED_EXPERIMENT");
    expect(evaluateReflectionGate({ noSignalStreak: 0, secondsSinceProgress: 0, wrongFlags: 0, repeatedTool: false })).toBeNull();
    expect(evaluateReflectionGate({ noSignalStreak: 2, secondsSinceProgress: 10, wrongFlags: 0, repeatedTool: false })).toBeNull();
  });

  it("same fingerprint is SKIPPED_DUPLICATE; new progress allows another run", () => {
    const a = buildReflectionFingerprint({
      latestProgressId: "p1",
      latestExperimentId: "e1",
      wrongSubmissionCount: 1,
      hintCount: 0,
      hypothesisUpdatedAt: 10,
    });
    const same = buildReflectionFingerprint({
      latestProgressId: "p1",
      latestExperimentId: "e1",
      wrongSubmissionCount: 1,
      hintCount: 0,
      hypothesisUpdatedAt: 10,
    });
    const next = buildReflectionFingerprint({
      latestProgressId: "p2",
      latestExperimentId: "e1",
      wrongSubmissionCount: 1,
      hintCount: 0,
      hypothesisUpdatedAt: 10,
    });
    expect(shouldSkipDuplicateFingerprint({ current: same, previous: a })).toBe(true);
    expect(shouldSkipDuplicateFingerprint({ current: next, previous: a })).toBe(false);
  });

  it("precedence: Global ON + Manager OFF + Manual ON ⇒ ON; INHERIT ⇒ OFF", () => {
    expect(resolveReflectionEnabled({ globalEnabled: true, managerRecommendation: false, override: "ON" })).toBe(true);
    expect(resolveReflectionEnabled({ globalEnabled: true, managerRecommendation: false, override: "INHERIT" })).toBe(false);
    expect(resolveReflectionEnabled({ globalEnabled: true, managerRecommendation: null, override: "INHERIT" })).toBe(true);
    expect(resolveReflectionEnabled({ globalEnabled: true, managerRecommendation: true, override: "OFF" })).toBe(false);
  });
});

describe("MVP-2.5 reflection modes", () => {
  const dirs: string[] = [];
  const dbs: { close(): void }[] = [];
  afterEach(() => {
    for (const db of dbs.splice(0)) {
      try {
        db.close();
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
    dirs.length = 0;
  });

  function harness(mode: "OFF" | "HEURISTIC" | "LLM" | "HYBRID", advisory = createCannedAdvisory({
    reflection: {
      diagnosis: "LLM says overcommitted to LSB.",
      likelyMistakes: ["stuck on LSB"],
      missedEvidence: ["file tail"],
      recommendedNextSteps: [{ action: "inspect tail", reason: "cheap", expectedSignal: "magic" }],
      shouldContinueCurrentDirection: false,
      recommendHandoff: null,
      confidence: 0.7,
    },
  })) {
    const { dir, repos } = tmpRepos();
    dirs.push(dir);
    dbs.push(repos.db);
    const cfg = cfgSchema.parse({ reflection: { mode, enabledByDefault: true, cooldownMs: 0 } });
    let modelCalls = 0;
    const wrapped = createCannedAdvisory({
      reflection: async (input) => {
        modelCalls += 1;
        return advisory.runStructured(input);
      },
    });
    // recount via wrapper using fail-less canned
    const exec = new ReflectionExecutor({
      repos,
      bus: new EventBus(),
      logger: createLogger("silent"),
      config: cfg,
      advisory: {
        async runStructured(input) {
          modelCalls += 1;
          return advisory.runStructured(input);
        },
      },
      inject: () => true,
    });
    repos.challenges.create(seedChallenge({ id: "ch_r", lifecycleStatus: "ACTIVE" }));
    repos.progress.append({
      challengeId: "ch_r",
      sessionId: null,
      summary: "trying lsb",
      hypotheses: ["lsb"],
      confirmedFacts: [],
      rejectedHypotheses: [],
      nextActions: ["more lsb"],
      confidence: 0.3,
      progressLevel: "MINOR",
      stalled: false,
    });
    void wrapped;
    return { repos, exec, getCalls: () => modelCalls };
  }

  it("OFF makes no automatic run", async () => {
    const { exec, getCalls } = harness("OFF");
    const r = await exec.run("ch_r", { trigger: "WRONG_FLAG", source: "auto" });
    expect(r.skipped).toBe(true);
    expect(getCalls()).toBe(0);
  });

  it("HEURISTIC does not call the model", async () => {
    const { exec, getCalls } = harness("HEURISTIC");
    const r = await exec.run("ch_r", { trigger: "WRONG_FLAG", source: "auto" });
    expect(r.status).toBe("COMPLETED");
    expect(r.diagnosis.length).toBeGreaterThan(0);
    expect(getCalls()).toBe(0);
  });

  it("LLM calls the model", async () => {
    const { exec, getCalls } = harness("LLM");
    const r = await exec.run("ch_r", { trigger: "WRONG_FLAG", source: "auto" });
    expect(r.status).toBe("COMPLETED");
    expect(r.diagnosis).toMatch(/LSB/i);
    expect(getCalls()).toBe(1);
  });

  it("HYBRID success uses LLM result", async () => {
    const { exec, getCalls } = harness("HYBRID");
    const r = await exec.run("ch_r", { trigger: "WRONG_FLAG", source: "auto" });
    expect(r.status).toBe("COMPLETED");
    expect(r.diagnosis).toMatch(/LSB/i);
    expect(getCalls()).toBe(1);
  });

  it("HYBRID failure status FALLBACK + heuristic inject", async () => {
    const { dir, repos } = tmpRepos();
    dirs.push(dir);
    dbs.push(repos.db);
    const cfg = cfgSchema.parse({ reflection: { mode: "HYBRID", enabledByDefault: true, cooldownMs: 0 } });
    const exec = new ReflectionExecutor({
      repos,
      bus: new EventBus(),
      logger: createLogger("silent"),
      config: cfg,
      advisory: createCannedAdvisory({ fail: { task: "REFLECTION", error: { code: "ADVISORY_PROVIDER_ERROR", message: "500", retryable: true } } }),
      inject: () => true,
    });
    repos.challenges.create(seedChallenge({ id: "ch_r", lifecycleStatus: "ACTIVE", title: "x" }));
    repos.progress.append({
      challengeId: "ch_r",
      sessionId: null,
      summary: "s",
      hypotheses: [],
      confirmedFacts: [],
      rejectedHypotheses: [],
      nextActions: [],
      confidence: 0.1,
      progressLevel: "NONE",
      stalled: true,
    });
    const r = await exec.run("ch_r", { trigger: "WRONG_FLAG", source: "auto" });
    expect(r.status).toBe("FALLBACK");
    expect(r.injected).toBe(true);
    expect(r.diagnosis.length).toBeGreaterThan(0);
    expect(repos.reflectionRuns.latestForChallenge("ch_r")?.status).toBe("FALLBACK");
  });

  it("same fingerprint second run is SKIPPED_DUPLICATE; new progress allows", async () => {
    const { exec, repos } = harness("HEURISTIC");
    const first = await exec.run("ch_r", { trigger: "WRONG_FLAG", source: "auto" });
    expect(first.status).toBe("COMPLETED");
    const second = await exec.run("ch_r", { trigger: "WRONG_FLAG", source: "auto" });
    expect(second.status).toBe("SKIPPED");
    repos.progress.append({
      challengeId: "ch_r",
      sessionId: null,
      summary: "new progress",
      hypotheses: ["other"],
      confirmedFacts: ["fact"],
      rejectedHypotheses: [],
      nextActions: [],
      confidence: 0.5,
      progressLevel: "SIGNIFICANT",
      stalled: false,
    });
    const third = await exec.run("ch_r", { trigger: "WRONG_FLAG", source: "auto" });
    expect(third.status).toBe("COMPLETED");
  });
});

describe("MVP-2.5 manager snapshot + policy + TTL + debounce", () => {
  const dirs: string[] = [];
  const dbs: { close(): void }[] = [];
  afterEach(() => {
    for (const db of dbs.splice(0)) {
      try {
        db.close();
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
    dirs.length = 0;
  });

  it("snapshot omits unsupported details and full attachment bytes; includes all ACTIVE; candidates ≤ maxCandidates", () => {
    const { dir, repos } = tmpRepos();
    dirs.push(dir);
    dbs.push(repos.db);
    for (let i = 0; i < 5; i++) {
      repos.challenges.create(seedChallenge({ id: `act_${i}`, lifecycleStatus: "ACTIVE", title: `A${i}` }));
    }
    for (let i = 0; i < 60; i++) {
      repos.challenges.create(
        seedChallenge({
          id: `q_${String(i).padStart(2, "0")}`,
          lifecycleStatus: "QUEUED",
          title: `Q${i}`,
          category: i % 2 === 0 ? "MISC" : "CRYPTO",
          lastPriorityScore: 100 - i,
        }),
      );
    }
    repos.challenges.create(seedChallenge({ id: "web_01", lifecycleStatus: "UNSUPPORTED", category: "WEB", title: "web" }));
    repos.attachments.create({
      challengeId: "act_0",
      remoteId: null,
      name: "dump.pcap",
      remoteUrl: null,
      localPath: "/tmp/dump.pcap",
      sizeBytes: 1_800_000_000,
      sha256: "aa",
      mime: "application/vnd.tcpdump.pcap",
      downloadStatus: "DOWNLOADED",
      downloadedAt: Date.now(),
    });
    const cfg = cfgSchema.parse({ manager: { maxCandidates: 40 } });
    const snap = buildManagerSnapshot({
      repos,
      config: cfg,
      contestConnected: true,
      solverSlotsUsed: 5,
      reflectionSlotsUsed: 0,
    });
    expect(snap.activeChallenges).toHaveLength(5);
    expect(snap.candidates.length).toBeLessThanOrEqual(40);
    expect(snap.contest.unsupported).toBe(1);
    expect(snapshotContainsUnsupportedDetails(snap)).toBe(false);
    expect(JSON.stringify(snap)).not.toContain("web_01");
    expect(JSON.stringify(snap)).not.toMatch(/"data":|"content":/);
    expect(snap.candidates.every((c) => c.attachmentSummary)).toBe(true);
    const blob = JSON.stringify(snap);
    expect(blob).not.toContain("/tmp/dump.pcap");
  });

  it("prefilter is stable and capped", () => {
    const queued = Array.from({ length: 80 }, (_, i) => ({
      challengeId: `q_${i}`,
      title: `q${i}`,
      category: (i % 2 === 0 ? "MISC" : "CRYPTO") as "MISC" | "CRYPTO",
      score: i,
      solveCount: 0,
      lifecycleStatus: "QUEUED",
      progressStatus: "UNKNOWN",
      difficulty: 2,
      subcategories: [],
      triageSummary: null,
      basePriorityScore: 80 - i,
      activeSolveMs: 0,
      latestProgress: null,
      hint: { status: "LOCKED", fetched: false },
      wrongSubmissionCount: 0,
      attachmentSummary: { count: 0, totalBytes: null, types: [] },
      reflection: { enabled: true, mode: "HYBRID" as const, lastRunAt: null },
      lastReflection: null,
      manuallyLocked: false,
    }));
    const a = prefilterCandidates(queued, 40);
    const b = prefilterCandidates(queued, 40);
    expect(a.map((c) => c.challengeId)).toEqual(b.map((c) => c.challengeId));
    expect(a.length).toBeLessThanOrEqual(40);
  });

  it("policy rejects START SOLVED / WEB / unknown; clamps START 10 to 4 slots; locked ignores Manager; priority 200 clamped", () => {
    const snapshot = {
      generatedAt: 1,
      contest: { connected: true, totalChallenges: 3, solved: 1, active: 0, queued: 2, preparing: 0, parked: 0, unsupported: 1 },
      resources: { solverSlotsTotal: 4, solverSlotsUsed: 0, solverSlotsAvailable: 4, reflectionSlotsTotal: 2, reflectionSlotsUsed: 0 },
      activeChallenges: [],
      candidates: [],
      omittedCandidateCount: 0,
    };
    const challenges = new Map([
      ["ch_solved", seedChallenge({ id: "ch_solved", lifecycleStatus: "SOLVED" })],
      ["web_01", seedChallenge({ id: "web_01", lifecycleStatus: "QUEUED", category: "WEB" })],
      ["ch_lock", seedChallenge({ id: "ch_lock", lifecycleStatus: "QUEUED" })],
      ...Array.from({ length: 10 }, (_, i) => [`ch_${i}`, seedChallenge({ id: `ch_${i}`, lifecycleStatus: "QUEUED" })] as const),
    ]);
    const orchestrations = new Map([["ch_lock", orch({ challengeId: "ch_lock", strategyLocked: true })]]);
    const plan: DispatchPlan = {
      summary: "test",
      decisions: [
        { challengeId: "ch_solved", action: "START", priority: 90, reflectionEnabled: null, reason: "no" },
        { challengeId: "web_01", action: "START", priority: 90, reflectionEnabled: null, reason: "no" },
        { challengeId: "ghost", action: "START", priority: 90, reflectionEnabled: null, reason: "no" },
        { challengeId: "ch_lock", action: "HOLD", priority: 10, reflectionEnabled: false, reason: "mgr" },
        { challengeId: "ch_0", action: "START", priority: 200, reflectionEnabled: null, reason: "hi" },
        ...Array.from({ length: 9 }, (_, i) => ({
          challengeId: `ch_${i + 1}`,
          action: "START" as const,
          priority: 90 - i,
          reflectionEnabled: null,
          reason: "slot",
        })),
      ],
    };
    const applied = validateAndApply(snapshot, plan, challenges, orchestrations);
    expect(applied.decisions.find((d) => d.challengeId === "ch_solved")?.rejectionReason).toBe("ALREADY_SOLVED");
    expect(applied.decisions.find((d) => d.challengeId === "web_01")?.rejectionReason).toBe("UNSUPPORTED_CATEGORY");
    expect(applied.decisions.find((d) => d.challengeId === "ghost")?.rejectionReason).toBe("UNKNOWN_CHALLENGE");
    expect(applied.decisions.find((d) => d.challengeId === "ch_lock")?.rejectionReason).toBe("STRATEGY_LOCKED");
    expect(applied.decisions.find((d) => d.challengeId === "ch_0")?.priority).toBe(100);
    expect(applied.decisions.find((d) => d.challengeId === "ch_0")?.status).toBe("CLAMPED");
    expect(applied.startIds).toHaveLength(4);
    expect(clampPriority(200)).toBe(100);
  });

  it("fresh plan gates; stale plan falls back", () => {
    const now = 1_000_000;
    expect(isPlanFresh({ completedAt: now - 10_000, status: "APPLIED" }, now, 90_000)).toBe(true);
    expect(isPlanFresh({ completedAt: now - 120_000, status: "APPLIED" }, now, 90_000)).toBe(false);
    expect(shouldUseManagerGate("ACTIVE", true)).toBe(true);
    expect(shouldUseManagerGate("ACTIVE", false)).toBe(false);
    expect(shouldUseManagerGate("SHADOW", true)).toBe(false);
    expect(shouldUseManagerGate("OFF", true)).toBe(false);
    expect(admitChallenge({
      challenge: { id: "c", lifecycleStatus: "QUEUED", lastPriorityScore: 10, discoveredAt: 1 },
      orchestration: orch({ managerAction: "HOLD" }),
      mode: "ACTIVE",
      livePlanFresh: true,
      applied: { summary: "", decisions: [{ challengeId: "c", action: "HOLD", priority: 1, reflectionEnabled: null, reason: "h", status: "APPLIED", rejectionReason: null }], startIds: [], holdIds: ["c"], continueIds: [], rejectedCount: 0, clampedCount: 0 },
    }).admitted).toBe(false);
    expect(admitChallenge({
      challenge: { id: "c", lifecycleStatus: "QUEUED", lastPriorityScore: 10, discoveredAt: 1 },
      orchestration: orch({ managerAction: "HOLD" }),
      mode: "ACTIVE",
      livePlanFresh: false,
      applied: null,
    }).admitted).toBe(true);
  });

  it("50 batched replan requests produce exactly one Manager call after debounce", async () => {
    const { dir, repos } = tmpRepos();
    dirs.push(dir);
    dbs.push(repos.db);
    repos.settings.set("manager.mode", "SHADOW");
    repos.challenges.create(seedChallenge({ id: "ch_batch", lifecycleStatus: "QUEUED", lastPriorityScore: 10 }));
    const cfg = cfgSchema.parse({ manager: { enabled: true, mode: "SHADOW", debounceMs: 40 } });
    let calls = 0;
    let resolveFirst: () => void = () => {};
    const firstCall = new Promise<void>((r) => {
      resolveFirst = r;
    });
    const advisory = createCannedAdvisory({
      manager: async () => {
        calls += 1;
        resolveFirst();
        return { summary: "ok", decisions: [] };
      },
    });
    const bus = new EventBus();
    const service = new ManagerService({
      repos,
      bus,
      logger: createLogger("silent"),
      config: cfg,
      advisory,
      solverSlotsUsed: () => 0,
      reflectionSlotsUsed: () => 0,
      contestConnected: () => false,
    });
    const coord = new ManagerCoordinator({
      service,
      repos,
      bus,
      logger: createLogger("silent"),
      debounceMs: 40,
      replanIntervalMs: 30_000,
      planTtlMs: 90_000,
    });
    for (let i = 0; i < 50; i++) coord.requestReplan("CHALLENGE_BATCH");
    expect(calls).toBe(0);
    await Promise.race([firstCall, new Promise((_, rej) => setTimeout(() => rej(new Error("debounce did not fire")), 2000))]);
    await new Promise((r) => setTimeout(r, 30));
    expect(calls).toBe(1);
    coord.stop();
  });

  it("illegal manager/reflection config refuses to parse", () => {
    expect(() => cfgSchema.parse({ manager: { maxCandidates: 0 } })).toThrow();
    expect(() => cfgSchema.parse({ manager: { planTtlMs: 100 } })).toThrow();
    expect(() => cfgSchema.parse({ reflection: { maxConcurrent: 0 } })).toThrow();
    expect(() => cfgSchema.parse({ reflection: { mode: "MAGIC" } })).toThrow();
    expect(effectiveManagerMode(cfgSchema.parse({}))).toBe("OFF");
    expect(effectiveManagerMode(cfgSchema.parse({ manager: { enabled: true, mode: "ACTIVE" } }))).toBe("ACTIVE");
  });
});

describe("schema migration 6", () => {
  it("upgrades an old database with orchestration tables", () => {
    const dir = mkdtempSync(join(tmpdir(), "rio-mig6-"));
    const path = join(dir, "t.sqlite");
    const raw = new DatabaseSync(path);
    raw.exec(`CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)`);
    raw.exec(`INSERT INTO schema_migrations (version, applied_at) VALUES (5, 1)`);
    raw.close();
    const db = new RioDb(path);
    applySchemaMigrations(db);
    const tables = db.all<{ name: string }>(`SELECT name FROM sqlite_master WHERE type='table'`).map((t) => t.name);
    expect(tables).toContain("challenge_orchestration");
    expect(tables).toContain("manager_plans");
    expect(tables).toContain("manager_decisions");
    expect(tables).toContain("reflection_runs");
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("structured parse helper", () => {
  it("extracts JSON and validates the shipped schemas", () => {
    const obj = extractJsonObject("```json\n{\"summary\":\"x\",\"decisions\":[]}\n```");
    expect(dispatchPlanSchema.parse(obj).summary).toBe("x");
    const parsed = parseStructuredWithRepair(
      JSON.stringify({
        diagnosis: "d",
        likelyMistakes: [],
        missedEvidence: [],
        recommendedNextSteps: [],
        shouldContinueCurrentDirection: true,
        recommendHandoff: null,
        confidence: 0.2,
      }),
      llmReflectionResultSchema,
    );
    expect("value" in parsed).toBe(true);
  });
});
