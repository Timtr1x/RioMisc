import type { Repositories } from "@rio/database";
import type { ReflectionMode, ReflectionTrigger, StructuredReflectionResult } from "@rio/domain";
import { llmReflectionResultSchema } from "@rio/domain";
import type { RuntimeConfig } from "@rio/shared";
import type { RioLogger } from "@rio/shared";
import type { EventBus } from "../bus.js";
import type { AdvisoryAgentRuntime } from "../advisory-runtime.js";
import { buildReflection, reflectionMessage, type ReflectionOutcome } from "../reflection.js";
import {
  buildReflectionFingerprint,
  normalizeReflectionTrigger,
  resolveReflectionEnabled,
  resolveReflectionMode,
  shouldBypassReflectionCooldown,
  shouldSkipDuplicateFingerprint,
} from "./reflection-gate.js";
import { REFLECTION_SYSTEM_PROMPT } from "./reflection-prompts.js";
import { buildReflectionSnapshot, snapshotFingerprintParts } from "./reflection-snapshot.js";
import { reflectionHasMaterial } from "../planner.js";

export class ReflectionSemaphore {
  used = 0;
  constructor(readonly max: number) {}
  tryAcquire(): boolean {
    if (this.used >= this.max) return false;
    this.used += 1;
    return true;
  }
  release(): void {
    if (this.used > 0) this.used -= 1;
  }
}

function heuristicToStructured(o: ReflectionOutcome): StructuredReflectionResult {
  return {
    diagnosis: o.diagnosis.slice(0, 1500),
    likelyMistakes: o.likelyMistakes.slice(0, 8),
    missedEvidence: o.missedEvidence.slice(0, 8),
    recommendedNextSteps: o.recommendedNextSteps.slice(0, 6).map((action) => ({
      action,
      reason: "heuristic",
      expectedSignal: "new evidence or a contradiction",
    })),
    shouldContinueCurrentDirection: o.shouldContinueCurrentDirection,
    recommendHandoff: null,
    confidence: 0.45,
  };
}

export function formatIndependentReview(result: StructuredReflectionResult): string {
  const lines = [
    "INDEPENDENT REFLECTION REVIEW",
    "",
    "Diagnosis:",
    result.diagnosis,
    "",
  ];
  if (result.likelyMistakes.length) {
    lines.push("Potential mistakes:", ...result.likelyMistakes.map((m) => `- ${m}`), "");
  }
  if (result.missedEvidence.length) {
    lines.push("Missed evidence:", ...result.missedEvidence.map((m) => `- ${m}`), "");
  }
  if (result.recommendedNextSteps.length) {
    lines.push("Recommended next tests:");
    result.recommendedNextSteps.forEach((s, i) => {
      lines.push(`${i + 1}. ${s.action}`, `   Reason: ${s.reason}`, `   Expected signal: ${s.expectedSignal}`);
    });
    lines.push("");
  }
  lines.push(`Continue current direction:`, result.shouldContinueCurrentDirection ? "YES" : "NO", "");
  lines.push("Suggested handoff:", result.recommendHandoff ?? "NONE", "");
  lines.push("This review is advisory.", "Re-evaluate it against the actual evidence before acting.");
  return lines.join("\n");
}

export interface ReflectionRunRequest {
  trigger: string;
  source: "auto" | "manual";
  modeOverride?: ReflectionMode;
}

export interface ReflectionRunView {
  id: string;
  diagnosis: string;
  likelyMistakes: string[];
  missedEvidence: string[];
  recommendedNextSteps: string[];
  shouldContinueCurrentDirection: boolean;
  injected: boolean;
  status: string;
  mode: ReflectionMode;
  trigger: ReflectionTrigger;
  skipped?: boolean;
}

function parseResultJson(raw: string | null): StructuredReflectionResult | null {
  if (!raw) return null;
  try {
    return llmReflectionResultSchema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

export class ReflectionExecutor {
  readonly slots: ReflectionSemaphore;
  private metrics = {
    runs: 0,
    llm: 0,
    heuristic: 0,
    fallback: 0,
    failed: 0,
    duplicateSkipped: 0,
  };

  constructor(
    private deps: {
      repos: Repositories;
      bus: EventBus;
      logger: RioLogger;
      config: RuntimeConfig;
      advisory: AdvisoryAgentRuntime;
      inject: (challengeId: string, message: string) => boolean;
    },
  ) {
    this.slots = new ReflectionSemaphore(deps.config.reflection.maxConcurrent);
  }

  metricsSnapshot(): typeof this.metrics & { inFlight: number } {
    return { ...this.metrics, inFlight: this.slots.used };
  }

  isEnabledFor(challengeId: string): boolean {
    const orch = this.deps.repos.orchestration.getOrCreate(challengeId);
    return resolveReflectionEnabled({
      globalEnabled: this.deps.config.reflection.enabledByDefault,
      managerRecommendation: orch.managerReflectionEnabled,
      override: orch.reflectionOverride,
    });
  }

  modeFor(challengeId: string, override?: ReflectionMode): ReflectionMode {
    if (override) return override;
    const orch = this.deps.repos.orchestration.getOrCreate(challengeId);
    return resolveReflectionMode({
      globalMode: this.deps.config.reflection.mode,
      override: orch.reflectionModeOverride,
    });
  }

  pendingMessage(challengeId: string): string | null {
    const pending = this.deps.repos.reflectionRuns.latestCompletedUndelivered(challengeId);
    if (!pending) return null;
    const result = parseResultJson(pending.resultJson);
    if (!result) return null;
    return `RESUME CONTEXT\n\nPending reflection review:\n${formatIndependentReview(result)}`;
  }

  markDelivered(challengeId: string): void {
    const pending = this.deps.repos.reflectionRuns.latestCompletedUndelivered(challengeId);
    if (!pending) return;
    this.deps.repos.reflectionRuns.update(pending.id, { deliveredAt: Date.now() });
    this.emit("REFLECTION_DELIVERED", challengeId, { id: pending.id });
  }

  async run(challengeId: string, req: ReflectionRunRequest): Promise<ReflectionRunView> {
    const { repos, config } = this.deps;
    const challenge = repos.challenges.get(challengeId);
    if (!challenge) throw new Error("unknown challenge");
    const trigger = normalizeReflectionTrigger(req.trigger);
    const automatic = req.source === "auto";
    const mode = this.modeFor(challengeId, req.modeOverride);

    if (automatic && !this.isEnabledFor(challengeId)) {
      return this.#skip(challengeId, trigger, mode, "REFLECTION_DISABLED");
    }
    if (automatic && mode === "OFF") {
      return this.#skip(challengeId, trigger, mode, "MODE_OFF");
    }
    if (
      automatic &&
      !reflectionHasMaterial({
        trigger: req.trigger,
        hasProgress: Boolean(repos.progress.latestForChallenge(challengeId)),
        wrongFlags: challenge.wrongSubmissionCount,
        experimentCount: repos.experiments.listByChallenge(challengeId).length,
      })
    ) {
      return this.#skip(challengeId, trigger, mode, "NO_MATERIAL");
    }

    const fp = buildReflectionFingerprint(snapshotFingerprintParts(repos, challengeId));
    const prior = repos.reflectionRuns.findByFingerprint(challengeId, fp);
    if (shouldSkipDuplicateFingerprint({ current: fp, previous: prior?.fingerprint ?? null }) && prior) {
      this.metrics.duplicateSkipped += 1;
      const skipped = repos.reflectionRuns.create({
        challengeId,
        trigger,
        mode,
        fingerprint: fp,
        status: "SKIPPED",
        snapshotJson: "{}",
        error: "SKIPPED_DUPLICATE",
      });
      repos.reflectionRuns.update(skipped.id, { completedAt: Date.now() });
      this.emit("REFLECTION_SKIPPED_DUPLICATE", challengeId, { id: skipped.id, fingerprint: fp });
      return {
        id: skipped.id,
        diagnosis: "",
        likelyMistakes: [],
        missedEvidence: [],
        recommendedNextSteps: [],
        shouldContinueCurrentDirection: true,
        injected: false,
        status: "SKIPPED",
        mode,
        trigger,
        skipped: true,
      };
    }

    const last = repos.reflectionRuns.latestForChallenge(challengeId);
    const now = Date.now();
    if (
      automatic &&
      last?.completedAt &&
      now - last.completedAt < config.reflection.cooldownMs &&
      !shouldBypassReflectionCooldown(trigger)
    ) {
      return this.#skip(challengeId, trigger, mode, "COOLDOWN");
    }

    this.emit("REFLECTION_TRIGGERED", challengeId, { trigger, mode });
    this.metrics.runs += 1;

    if (mode === "OFF" && req.source === "manual") {
      // Force-run still executes (button bypasses automatic switch).
    }

    const snapshot = buildReflectionSnapshot(repos, challengeId, trigger);
    const run = repos.reflectionRuns.create({
      challengeId,
      trigger,
      mode: mode === "OFF" ? "HEURISTIC" : mode,
      fingerprint: fp,
      status: "PENDING",
      snapshotJson: JSON.stringify(snapshot ?? {}),
    });

    const heuristic = (): StructuredReflectionResult => {
      this.metrics.heuristic += 1;
      const latest = repos.progress.latestForChallenge(challengeId);
      const outcome = buildReflection(
        challenge,
        latest
          ? {
              summary: latest.summary,
              hypotheses: safeJsonArray(latest.hypothesesJson),
              confirmedFacts: safeJsonArray(latest.confirmedFactsJson),
              rejectedHypotheses: safeJsonArray(latest.rejectedHypothesesJson),
              nextActions: safeJsonArray(latest.nextActionsJson),
              confidence: latest.confidence,
            }
          : null,
        snapshot?.wrongFlags ?? [],
        snapshot?.hints ?? [],
        (snapshot?.recentExperiments ?? []).map((e) => `${e.tool}:${e.outcome}`),
      );
      return heuristicToStructured(outcome);
    };

    const effectiveMode = mode === "OFF" ? "HEURISTIC" : mode;
    if (effectiveMode === "HEURISTIC") {
      const result = heuristic();
      return this.#complete(run.id, challengeId, result, "COMPLETED", "heuristic");
    }

    let held = this.slots.tryAcquire();
    if (!held && req.source === "manual") {
      const deadline = Date.now() + 5_000;
      while (!held && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25));
        held = this.slots.tryAcquire();
      }
    }
    if (!held) {
      repos.reflectionRuns.update(run.id, { status: "SKIPPED", error: "REFLECTION_BUSY", completedAt: Date.now() });
      return this.#skip(challengeId, trigger, mode, "REFLECTION_BUSY");
    }

    repos.reflectionRuns.update(run.id, { status: "RUNNING", startedAt: Date.now() });
    this.emit("REFLECTION_STARTED", challengeId, { id: run.id, mode: effectiveMode });
    this.metrics.llm += 1;
    try {
      const advisory = await this.deps.advisory.runStructured({
        task: "REFLECTION",
        systemPrompt: REFLECTION_SYSTEM_PROMPT,
        userPrompt: JSON.stringify(snapshot),
        schema: llmReflectionResultSchema,
        timeoutMs: config.reflection.callTimeoutMs,
      });
      if (advisory.ok && advisory.value) {
        repos.reflectionRuns.update(run.id, {
          providerId: advisory.providerId || null,
          modelId: advisory.modelId || null,
          inputTokens: advisory.inputTokens,
          outputTokens: advisory.outputTokens,
          durationMs: advisory.durationMs,
        });
        return this.#complete(run.id, challengeId, advisory.value, "COMPLETED", "llm");
      }
      if (effectiveMode === "HYBRID") {
        this.metrics.fallback += 1;
        this.emit("REFLECTION_FALLBACK", challengeId, { id: run.id, error: advisory.error });
        const result = heuristic();
        repos.reflectionRuns.update(run.id, {
          providerId: advisory.providerId || null,
          modelId: advisory.modelId || null,
          error: advisory.error?.message ?? "advisory failed",
          durationMs: advisory.durationMs,
        });
        return this.#complete(run.id, challengeId, result, "FALLBACK", "hybrid");
      }
      this.metrics.failed += 1;
      repos.reflectionRuns.update(run.id, {
        status: "FAILED",
        error: advisory.error?.code ?? "FAILED",
        providerId: advisory.providerId || null,
        modelId: advisory.modelId || null,
        completedAt: Date.now(),
        durationMs: advisory.durationMs,
      });
      this.emit("REFLECTION_FAILED", challengeId, { id: run.id, error: advisory.error });
      return {
        id: run.id,
        diagnosis: "",
        likelyMistakes: [],
        missedEvidence: [],
        recommendedNextSteps: [],
        shouldContinueCurrentDirection: true,
        injected: false,
        status: "FAILED",
        mode: effectiveMode,
        trigger,
      };
    } finally {
      this.slots.release();
    }
  }

  #complete(
    id: string,
    challengeId: string,
    result: StructuredReflectionResult,
    status: "COMPLETED" | "FALLBACK",
    via: string,
  ): ReflectionRunView {
    const message = formatIndependentReview(result);
    const injected = this.deps.inject(challengeId, message);
    this.deps.repos.reflectionRuns.update(id, {
      status,
      resultJson: JSON.stringify(result),
      completedAt: Date.now(),
      deliveredAt: injected ? Date.now() : null,
    });
    this.emit(status === "FALLBACK" ? "REFLECTION_FALLBACK" : "REFLECTION_COMPLETED", challengeId, {
      id,
      via,
      injected,
      diagnosis: result.diagnosis,
    });
    this.deps.repos.events.append(status === "FALLBACK" ? "REFLECTION_FALLBACK" : "REFLECTION_RUN", challengeId, {
      trigger: this.deps.repos.reflectionRuns.get(id)?.trigger,
      ...result,
      recommendedNextSteps: result.recommendedNextSteps.map((s) => s.action),
      injected,
    });
    this.deps.bus.publish({
      type: "REFLECTION_RUN",
      challengeId,
      payload: { id, status, injected, diagnosis: result.diagnosis },
    });
    if (injected) this.emit("REFLECTION_DELIVERED", challengeId, { id });
    return {
      id,
      diagnosis: result.diagnosis,
      likelyMistakes: result.likelyMistakes,
      missedEvidence: result.missedEvidence,
      recommendedNextSteps: result.recommendedNextSteps.map((s) => s.action),
      shouldContinueCurrentDirection: result.shouldContinueCurrentDirection,
      injected,
      status,
      mode: (this.deps.repos.reflectionRuns.get(id)?.mode as ReflectionMode) ?? "HYBRID",
      trigger: (this.deps.repos.reflectionRuns.get(id)?.trigger as ReflectionTrigger) ?? "MANUAL",
    };
  }

  #skip(challengeId: string, trigger: ReflectionTrigger, mode: ReflectionMode, reason: string): ReflectionRunView {
    this.deps.logger.debug({ event: "reflection_skipped", challengeId, trigger, reason });
    return {
      id: "",
      diagnosis: "",
      likelyMistakes: [],
      missedEvidence: [],
      recommendedNextSteps: [],
      shouldContinueCurrentDirection: true,
      injected: false,
      status: "SKIPPED",
      mode,
      trigger,
      skipped: true,
    };
  }

  emit(type: string, challengeId: string, payload: unknown): void {
    this.deps.repos.events.append(type, challengeId, payload);
    this.deps.bus.publish({ type, challengeId, payload: payload as Record<string, unknown> });
  }
}

function safeJsonArray(raw: string): string[] {
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}
