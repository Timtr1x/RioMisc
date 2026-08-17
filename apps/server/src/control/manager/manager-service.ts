import type { Repositories } from "@rio/database";
import type { DispatchPlan, ManagerTrigger } from "@rio/domain";
import { dispatchPlanSchema } from "@rio/domain";
import type { RuntimeConfig, RioLogger } from "@rio/shared";
import { effectiveManagerMode } from "@rio/shared";
import type { EventBus } from "../bus.js";
import type { AdvisoryAgentRuntime } from "../advisory-runtime.js";
import { resolveAdvisoryModel } from "../advisory-runtime.js";
import { MANAGER_SYSTEM_PROMPT } from "./manager-prompts.js";
import { buildManagerSnapshot, hashManagerSnapshot } from "./manager-snapshot.js";
import { validateAndApply } from "./manager-policy.js";
import type { AppliedDispatchPlan, ManagerSnapshot } from "./manager-types.js";

export interface ManagerReplanResult {
  skipped: boolean;
  reason: string;
  planId: string | null;
  applied: AppliedDispatchPlan | null;
  snapshot: ManagerSnapshot | null;
  fallback: boolean;
}

export class ManagerService {
  lastAppliedSnapshotHash: string | null = null;
  lastAppliedPlanId: string | null = null;
  lastApplied: AppliedDispatchPlan | null = null;
  lastSnapshot: ManagerSnapshot | null = null;
  lastReplanAt: number | null = null;
  lastTrigger: string | null = null;
  lastFallback = false;
  callCount = 0;
  fallbackCount = 0;
  successCount = 0;

  constructor(
    private deps: {
      repos: Repositories;
      bus: EventBus;
      logger: RioLogger;
      config: RuntimeConfig;
      advisory: AdvisoryAgentRuntime;
      solverSlotsUsed: () => number;
      reflectionSlotsUsed: () => number;
      contestConnected: () => boolean;
    },
  ) {}

  mode() {
    const stored = this.deps.repos.settings.get("manager.mode");
    if (stored === "OFF" || stored === "SHADOW" || stored === "ACTIVE") return stored;
    return effectiveManagerMode(this.deps.config);
  }

  enabled(): boolean {
    return this.mode() !== "OFF";
  }

  setMode(mode: "OFF" | "SHADOW" | "ACTIVE"): void {
    this.deps.repos.settings.set("manager.mode", mode);
    this.deps.repos.settings.set("manager.enabled", mode === "OFF" ? "false" : "true");
  }

  buildSnapshot(): ManagerSnapshot {
    return buildManagerSnapshot({
      repos: this.deps.repos,
      config: this.deps.config,
      contestConnected: this.deps.contestConnected(),
      solverSlotsUsed: this.deps.solverSlotsUsed(),
      reflectionSlotsUsed: this.deps.reflectionSlotsUsed(),
    });
  }

  async replan(triggers: ManagerTrigger[]): Promise<ManagerReplanResult> {
    const mode = this.mode();
    const trigger = (triggers.includes("MANUAL") ? "MANUAL" : triggers[0]) ?? "PERIODIC";
    this.lastTrigger = trigger;
    this.emit("MANAGER_RUN_STARTED", null, { trigger, triggers, mode });

    if (mode === "OFF") {
      return { skipped: true, reason: "MODE_OFF", planId: null, applied: null, snapshot: null, fallback: false };
    }

    const snapshot = this.buildSnapshot();
    this.lastSnapshot = snapshot;
    if (snapshot.activeChallenges.length === 0 && snapshot.candidates.length === 0) {
      this.lastReplanAt = Date.now();
      return { skipped: true, reason: "EMPTY_SNAPSHOT", planId: null, applied: null, snapshot, fallback: false };
    }
    const hash = hashManagerSnapshot(snapshot);
    if (trigger !== "MANUAL" && this.lastAppliedSnapshotHash === hash) {
      this.lastReplanAt = Date.now();
      return { skipped: true, reason: "SKIP_UNCHANGED", planId: this.lastAppliedPlanId, applied: this.lastApplied, snapshot, fallback: false };
    }

    const rec = this.deps.repos.managerPlans.create({
      trigger: triggers.join(","),
      snapshotHash: hash,
      status: "RUNNING",
    });
    this.deps.repos.managerPlans.update(rec.id, { startedAt: Date.now() });
    this.callCount += 1;

    const model = resolveAdvisoryModel(this.deps.repos, "MANAGER");
    const advisory = await this.deps.advisory.runStructured({
      task: "MANAGER",
      systemPrompt: MANAGER_SYSTEM_PROMPT,
      userPrompt: JSON.stringify(snapshot),
      schema: dispatchPlanSchema,
      timeoutMs: this.deps.config.manager.callTimeoutMs,
    });

    if (!advisory.ok || !advisory.value) {
      this.fallbackCount += 1;
      this.lastFallback = true;
      this.lastAppliedPlanId = null;
      this.lastApplied = null;
      this.deps.repos.managerPlans.update(rec.id, {
        status: "FALLBACK",
        error: advisory.error?.message ?? advisory.error?.code ?? "MANAGER_FAILED",
        providerId: advisory.providerId || model?.providerId || null,
        modelId: advisory.modelId || model?.modelName || null,
        completedAt: Date.now(),
        durationMs: advisory.durationMs,
      });
      this.emit("MANAGER_PLAN_FAILED", null, { id: rec.id, error: advisory.error });
      this.emit("MANAGER_FALLBACK_ACTIVATED", null, { id: rec.id, trigger });
      this.lastReplanAt = Date.now();
      return { skipped: false, reason: advisory.error?.code ?? "FAILED", planId: rec.id, applied: null, snapshot, fallback: true };
    }

    const challenges = new Map(this.deps.repos.challenges.list().map((c) => [c.id, c]));
    const orchestrations = new Map(
      this.deps.repos.challenges.list().map((c) => [c.id, this.deps.repos.orchestration.getOrCreate(c.id)]),
    );
    const applied = validateAndApply(snapshot, advisory.value as DispatchPlan, challenges, orchestrations);
    this.#persistApplied(rec.id, applied);

    const status = applied.rejectedCount > 0 || applied.clampedCount > 0 ? "PARTIAL" : "APPLIED";
    this.deps.repos.managerPlans.update(rec.id, {
      status,
      summary: applied.summary,
      providerId: advisory.providerId || null,
      modelId: advisory.modelId || null,
      completedAt: Date.now(),
      durationMs: advisory.durationMs,
      inputTokens: advisory.inputTokens,
      outputTokens: advisory.outputTokens,
    });
    this.lastApplied = applied;
    this.lastAppliedPlanId = rec.id;
    this.lastAppliedSnapshotHash = hash;
    this.lastFallback = false;
    this.successCount += 1;
    this.lastReplanAt = Date.now();
    this.emit("MANAGER_PLAN_CREATED", null, {
      id: rec.id,
      trigger,
      started: applied.startIds.length,
      held: applied.holdIds.length,
      rejected: applied.rejectedCount,
    });
    return { skipped: false, reason: status, planId: rec.id, applied, snapshot, fallback: false };
  }

  #persistApplied(planId: string, applied: AppliedDispatchPlan): void {
    const now = Date.now();
    for (const d of applied.decisions) {
      this.deps.repos.managerDecisions.create({
        planId,
        challengeId: d.challengeId,
        action: d.action,
        priority: d.priority,
        reflectionEnabled: d.reflectionEnabled,
        reason: d.reason,
        status: d.status,
        rejectionReason: d.rejectionReason,
      });
      if (d.status === "REJECTED") {
        this.emit("MANAGER_DECISION_REJECTED", d.challengeId, { planId, reason: d.rejectionReason });
        continue;
      }
      const orch = this.deps.repos.orchestration.get(d.challengeId);
      if (orch?.strategyLocked) continue;
      this.deps.repos.orchestration.update(d.challengeId, {
        managerAction: d.action,
        managerPriority: d.priority,
        managerReflectionEnabled: d.reflectionEnabled,
        managerReason: d.reason,
        managerPlanId: planId,
        managerUpdatedAt: now,
      });
      this.emit("MANAGER_DECISION_APPLIED", d.challengeId, { planId, action: d.action, priority: d.priority });
    }
  }

  emit(type: string, challengeId: string | null, payload: unknown): void {
    this.deps.repos.events.append(type, challengeId, payload);
    this.deps.bus.publish({ type, challengeId, payload: payload as Record<string, unknown> });
  }
}
