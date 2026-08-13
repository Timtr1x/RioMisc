// ControlPlane — the orchestrator (§3). Decides how the contest is played.
// Polls → syncs challenges → prepares → triages → schedules → supervises
// workers → verifies/submits → reacts to hints/feedback/recovery.
import { hashHex, type RioLogger, type RuntimeConfig } from "@rio/shared";
import type { Repositories } from "@rio/database";
import { SOLVER_CATEGORIES, type Challenge, type SolverType, type ModelRef } from "@rio/domain";
import type { ContestAdapter } from "@rio/contest";
import { Poller, ApiRateLimiter, DiskManager, CtfdContestAdapter, IdleContestAdapter, MockContestAdapter } from "@rio/contest";
import type { WorkerMessage, StartWorkerConfig } from "./worker-pool.js";
import { WorkspaceManager } from "@rio/tool-runtime";
import { systemPromptFor, buildKickoffMessage } from "@rio/solver";
import { isResumableSession, buildResumeMessage } from "./session-resume.js";
import { resolveAgentRuntime } from "./runtime-choice.js";
import { readdirSync, readFileSync, statSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { ResourceSemaphore, computePriorityScore } from "@rio/scheduler";
import { StateMachine } from "../state-machine.js";
import { EventBus } from "./bus.js";
import { WorkerPool } from "./worker-pool.js";
import { PreparationService } from "./preparation.js";
import { SubmissionManager } from "./submission.js";
import { HintManager } from "./hints.js";
import { ReflectionService } from "./reflection.js";
import { RecoveryManager } from "./recovery.js";
import { ModelRegistry } from "./registry.js";
import { acceptIntoSolved } from "./accept.js";
import { isDeletedRemoteId, rememberDeletedRemoteId } from "./deleted.js";
import { createHash } from "node:crypto";

export interface ControlPlaneDeps {
  repos: Repositories;
  adapter: ContestAdapter;
  config: RuntimeConfig;
  logger: RioLogger;
  bus: EventBus;
  workspacesRoot: string;
  sessionsRoot: string;
  piDir: string;
  secretsFile: string;
  agentRuntime: "mock" | "pi";
  stateMachine: StateMachine;
  preparation: PreparationService;
  submission: SubmissionManager;
  hints: HintManager;
  reflection: ReflectionService;
  registry: ModelRegistry;
  recovery: RecoveryManager;
  pythonExecutable: string;
}

export class ControlPlane {  private poller: Poller;
  private disk: DiskManager;
  private workspace: WorkspaceManager;
  private limiter = new ApiRateLimiter();
  private llmSlots: ResourceSemaphore;
  private llmHeld = new Map<string, () => void>();
  private workerPool: WorkerPool;
  private schedulerTimer: NodeJS.Timeout | null = null;
  private schedulerRunning = false;
  private hintTimer: NodeJS.Timeout | null = null;
  private watchdogTimer: NodeJS.Timeout | null = null;
  private preparing = new Set<string>();
  private stopped = false;
  private intentionallyStopped = new Set<string>();
  private reflectCooldown = new Map<string, number>();
  /** Challenges discovered before this process started are ignored in idle mode. */
  private readonly bootAt = Date.now();
  private contestMeta: {
    baseUrl: string | null;
    connectedAt: number | null;
    lastPollAt: number | null;
    lastError: string | null;
    lastListed: number;
    miscCryptoOnly: boolean;
  } = {
    baseUrl: null,
    connectedAt: null,
    lastPollAt: null,
    lastError: null,
    lastListed: 0,
    miscCryptoOnly: true,
  };

  constructor(private deps: ControlPlaneDeps) {
    this.disk = new DiskManager(deps.workspacesRoot, {
      globalWorkspaceLimitGb: deps.config.storage.globalWorkspaceLimitGb,
      reserveDiskGb: deps.config.storage.reserveDiskGb,
      perChallengeSoftLimitGb: deps.config.storage.perChallengeSoftLimitGb,
      maxConcurrentDownloads: deps.config.storage.maxConcurrentDownloads,
    });
    this.workspace = new WorkspaceManager(deps.workspacesRoot);
    this.llmSlots = new ResourceSemaphore({ LLM: deps.config.resources.llm });
    this.poller = new Poller({
      initialMs: deps.config.contest.poll.initialMs,
      maxMs: deps.config.contest.poll.maxMs,
      backoffFactor: deps.config.contest.poll.backoffFactor,
      cooldownAfterChangeMs: deps.config.contest.poll.cooldownAfterChangeMs,
      logger: deps.logger,
    });
    if (deps.adapter instanceof CtfdContestAdapter) {
      this.contestMeta.baseUrl = deps.adapter.baseUrl;
      this.contestMeta.connectedAt = Date.now();
      this.contestMeta.miscCryptoOnly = deps.adapter.miscCryptoOnly;
    } else if (deps.adapter.kind === "mock") {
      this.contestMeta.baseUrl = "mock://demo";
      this.contestMeta.connectedAt = Date.now();
    }
    this.workerPool = new WorkerPool(
      deps.repos,
      deps.logger,
      {
        onMessage: (challengeId, msg) => void this.onWorkerMessage(challengeId, msg),
        onWorkerLost: (challengeId) => this.onWorkerLost(challengeId),
        onWorkerExit: (challengeId, code) => this.onWorkerExit(challengeId, code),
      },
      { pingIntervalMs: deps.config.watchdog.heartbeatMs, leaseTtlMs: deps.config.watchdog.leaseTtlMs },
    );
  }

  async start(): Promise<void> {
    const { adapter, logger } = this.deps;
    await adapter.authenticate();
    const caps = await adapter.getCapabilities();
    logger.info({ event: "contest_connected", adapter: adapter.kind, caps }, "contest adapter ready");

    // single-shot adapter (local mode) → poll once
    if (!caps.polling) {
      try {
        await this.pollOnce();
      } catch (e) {
        logger.error({ err: String(e), event: "poll_once_failed" });
      }
    } else {
      this.poller.start(() => this.pollOnce());
    }

    await this.deps.recovery.start();

    this.schedulerTimer = setInterval(() => void this.schedulerTick(), 2500);
    this.schedulerTimer.unref();
    this.hintTimer = setInterval(() => void this.deps.hints.tick(), 15_000);
    this.hintTimer.unref();
    this.watchdogTimer = setInterval(() => this.watchdogTick(), 30_000);
    this.watchdogTimer.unref();

    logger.info({ event: "control_plane_started" }, "control plane started");
  }

  // -------------------------------------------------------------------------
  // Polling
  // -------------------------------------------------------------------------

  async pollOnce(): Promise<{ changed: boolean }> {
    try {
      return await this.#pollOnceInner();
    } catch (e) {
      this.contestMeta.lastError = e instanceof Error ? e.message : String(e);
      throw e;
    }
  }

  async #pollOnceInner(): Promise<{ changed: boolean }> {
    const { adapter, repos, logger, bus } = this.deps;
    await this.limiter.acquire("POLL");
    // apply mock scenario schedules
    const mockAdapter = this.deps.adapter as unknown as { applySchedule?: () => Promise<void> } | undefined;
    if (mockAdapter && typeof mockAdapter.applySchedule === "function") {
      await mockAdapter.applySchedule();
    }
    const list = await adapter.listChallenges();
    this.contestMeta.lastPollAt = Date.now();
    this.contestMeta.lastError = null;
    this.contestMeta.lastListed = list.length;
    let changed = false;
    for (const r of list) {
      if (isDeletedRemoteId(repos, r.remoteId)) continue;
      const existing = repos.challenges.getByRemoteId(r.remoteId);
      const canonical = JSON.stringify({
        title: r.title,
        description: r.description,
        category: r.category,
        score: r.score,
        solveCount: r.solveCount,
      });
      const hash = createHash("sha256").update(canonical).digest("hex");
      if (!existing) {
        const id = `ch_${r.remoteId.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
        repos.challenges.create({
          id,
          remoteId: r.remoteId,
          title: r.title,
          description: r.description,
          category: normalizeCategory(r.category),
          subcategory: null,
          score: r.score,
          solveCount: r.solveCount,
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
          contentHash: hash,
          discoveredAt: Date.now(),
          updatedAt: Date.now(),
          startedAt: null,
          solverStartedAt: null,
          wallClockSolveMs: 0,
          activeSolveMs: 0,
          remoteCreatedAt: r.createdAt,
          remoteUpdatedAt: r.updatedAt,
        });
        repos.events.append("CHALLENGE_DISCOVERED", id, { remoteId: r.remoteId, title: r.title, category: r.category });
        bus.publish({ type: "CHALLENGE_DISCOVERED", challengeId: id, payload: { remoteId: r.remoteId, title: r.title } });
        logger.info({ event: "challenge_discovered", challengeId: id, title: r.title });
        changed = true;
      } else if (existing.contentHash !== hash) {
        repos.challenges.update(existing.id, {
          title: r.title,
          description: r.description,
          category: normalizeCategory(r.category),
          score: r.score,
          solveCount: r.solveCount,
          contentHash: hash,
        });
        repos.challenges.recordRevision({
          id: `rev_${Math.random().toString(36).slice(2, 12)}`,
          challengeId: existing.id,
          contentHash: hash,
          title: r.title,
          description: r.description,
          category: r.category,
          score: r.score,
          attachmentMetasJson: "[]",
        });
        bus.publish({ type: "CHALLENGE_UPDATED", challengeId: existing.id, payload: { title: r.title } });
        this.injectUpdate(existing.id, existing.description, r.description);
        logger.info({ event: "challenge_updated", challengeId: existing.id });
        changed = true;
      }
    }
    return { changed };
  }

  private injectUpdate(challengeId: string, oldDesc: string, newDesc: string): void {
    if (this.workerPool.has(challengeId)) {
      const msg = `OFFICIAL CHALLENGE UPDATE

The challenge metadata changed.

Previous description:
<${oldDesc}>

New description:
<${newDesc}>

Re-evaluate assumptions affected by this change.`;
      this.workerPool.inject(challengeId, msg);
    }
    this.deps.preparation.refreshChallengeFile(challengeId);
  }

  // -------------------------------------------------------------------------
  // Scheduler
  // -------------------------------------------------------------------------

  private async schedulerTick(): Promise<void> {
    if (this.schedulerRunning) return; // never run two ticks concurrently
    this.schedulerRunning = true;
    const { repos } = this.deps;
    try {
      // 1. DISCOVERED → prepare (queue with triage concurrency)
      const discovered = repos.challenges.listByStatus("DISCOVERED").filter((c) => this.#schedulable(c));
      for (const c of discovered.slice(0, this.deps.config.workers.triageConcurrency)) {
        if (this.preparing.has(c.id)) continue;
        if (!SOLVER_CATEGORIES.includes(c.category)) {
          repos.challenges.update(c.id, { blockedReason: "UNSUPPORTED_CATEGORY" });
          this.deps.stateMachine.transition(c.id, "UNSUPPORTED", { payload: { category: c.category } });
          continue;
        }
        this.preparing.add(c.id);
        void this.#prepare(c.id);
      }

      // 2. READY → QUEUED
      for (const c of repos.challenges.listByStatus("READY")) {
        if (!this.#schedulable(c)) continue;
        this.deps.stateMachine.transition(c.id, "QUEUE");
      }

      // 3. scores
      const queued = repos.challenges.listByStatus("QUEUED").filter((c) => this.#schedulable(c));
      for (const c of queued) {
        const score = computePriorityScore(
          {
            challengeId: c.id,
            category: c.category,
            manualPriority: c.priority,
            score: c.score,
            solveCount: c.solveCount,
            difficulty: c.difficultyEstimate,
            attempts: c.solverRestartCount,
            progress: c.progressStatus,
            elapsedActiveMs: c.activeSolveMs,
            hintStatus: c.hintStatus,
            requiredResources: { resourceClass: "NORMAL", resourceTypes: ["LLM"] },
            discoveredAt: c.discoveredAt,
          },
          undefined,
          Date.now(),
        );
        repos.challenges.update(c.id, { lastPriorityScore: score + c.priority });
      }

      // 4. schedule workers
      const active = this.workerPool.activeCount();
      const capacity = this.deps.config.workers.solverConcurrency - active;
      if (capacity > 0) {
        const sorted = [...queued].sort((a, b) => (b.lastPriorityScore ?? 0) - (a.lastPriorityScore ?? 0));
        for (const c of sorted.slice(0, capacity)) {
          if (c.pausedReason || c.blockedReason === "MANUAL_REVIEW_REQUIRED") continue;
          const slot = this.llmSlots.tryAcquire(["LLM"]);
          if (!slot) break;
          this.llmHeld.set(c.id, slot);
          try {
            await this.#startSolver(c);
          } catch (e) {
            this.deps.logger.error({ event: "schedule_failed", challengeId: c.id, err: String(e) });
            slot();
            this.llmHeld.delete(c.id);
            this.deps.stateMachine.transition(c.id, "SOLVER_ERROR", { payload: { reason: String(e) } });
          }
        }
      }
    } catch (e) {
      this.deps.logger.error({ event: "scheduler_error", err: String(e) });
    } finally {
      this.schedulerRunning = false;
    }
  }

  async #prepare(challengeId: string): Promise<void> {
    try {
      const c = this.deps.repos.challenges.get(challengeId);
      if (!c) return;
      await this.deps.preparation.prepare(c);
    } catch (e) {
      this.deps.logger.error({ event: "prepare_failed", challengeId, err: String(e) });
      const c = this.deps.repos.challenges.get(challengeId);
      if (c && c.lifecycleStatus === "PREPARING") {
        this.deps.stateMachine.transition(challengeId, "PREPARE_FAILED", { payload: { reason: String(e) } });
      }
    } finally {
      this.preparing.delete(challengeId);
    }
  }

  async #startSolver(challenge: Challenge): Promise<void> {
    const { repos, adapter, bus } = this.deps;
    void adapter;

    // start challenge per policy
    if (this.deps.config.challenge.startPolicy === "ON_SOLVER_ASSIGNMENT" && challenge.startStatus === "NOT_STARTED") {
      repos.challenges.update(challenge.id, { startStatus: "STARTING" });
      if (adapter.startChallenge && challenge.remoteId && challenge.remoteId !== "local") {
        try {
          await adapter.startChallenge(challenge.remoteId);
          repos.challenges.update(challenge.id, { startStatus: "STARTED", startedAt: Date.now() });
          bus.publish({ type: "CHALLENGE_STARTED", challengeId: challenge.id, payload: {} });
        } catch (e) {
          repos.challenges.update(challenge.id, { startStatus: "FAILED" });
          throw new Error(`startChallenge failed: ${e}`);
        }
      } else {
        repos.challenges.update(challenge.id, { startStatus: "STARTED", startedAt: Date.now() });
      }
    }

    const latest = repos.sessions.latestForChallenge(challenge.id);
    const resume = isResumableSession(latest);
    let session = resume ? latest! : repos.sessions.activeForChallenge(challenge.id);
    if (resume && session) {
      repos.sessions.update(session.id, { status: "ACTIVE" });
    }
    if (!session) {
      session = repos.sessions.create({
        challengeId: challenge.id,
        solverType: challenge.category === "CRYPTO" ? "CRYPTO" : "MISC",
        piSessionId: null,
        piSessionFile: null,
        providerId: null,
        modelId: null,
        status: "ACTIVE",
        startedAt: Date.now(),
        lastActiveAt: Date.now(),
        endedAt: null,
        inputTokens: 0,
        outputTokens: 0,
        toolCalls: 0,
      });
    }

    const layout = this.workspace.ensure(challenge.id);
    const modelRef = this.#resolveModelRef();
    const solverType: SolverType = challenge.category === "CRYPTO" ? "CRYPTO" : "MISC";

    const res = this.deps.stateMachine.transition(challenge.id, "SCHEDULE", { solverType, sessionId: session.id });
    if (!res.allowed) throw new Error(`cannot schedule ${challenge.id} (${challenge.lifecycleStatus})`);

    const initialMessage = resume
      ? this.#resumeMessage(challenge.id)
      : this.#kickoff(layout.root);

    await this.workerPool.startWorker({
      challengeId: challenge.id,
      sessionId: session.id,
      solverType,
      workspaceRoot: layout.root,
      sessionDir: this.deps.sessionsRoot,
      systemPrompt: systemPromptFor(solverType),
      initialMessage,
      modelRef,
      runtime: resolveAgentRuntime(this.deps.repos),
      resume,
      persistedSession: resume
        ? { piSessionId: session.piSessionId, piSessionFile: session.piSessionFile }
        : undefined,
      pythonExecutable: this.deps.pythonExecutable,
      pi: this.#piWorkerConfig(),
    });
    if (resume) {
      this.deps.logger.info(
        { event: "pi_session_resumed", challengeId: challenge.id, sessionId: session.id, piSessionFile: session.piSessionFile },
        "resuming persisted Pi session",
      );
    }
    repos.sessions.update(session.id, { modelId: modelRef?.modelId ?? null, providerId: modelRef?.providerId ?? null });
    bus.publish({ type: "SOLVER_ASSIGNED", challengeId: challenge.id, payload: { sessionId: session.id, solverType, workerId: this.workerPool.get(challenge.id)?.workerId } });
    bus.publish({ type: "SOLVER_STARTED", challengeId: challenge.id, payload: { sessionId: session.id } });
    this.deps.logger.info({ event: "solver_started", challengeId: challenge.id, sessionId: session.id, solverType });
  }

  #resolveModelRef(): ModelRef | null {
    const primary = this.deps.repos.models.primary();
    if (primary) return { providerId: primary.providerId, modelId: primary.modelName };
    const first = this.deps.repos.models.listEnabled()[0];
    if (first) return { providerId: first.providerId, modelId: first.modelName };
    return null;
  }

  /** Idle mode skips leftover mock fixtures. URL / this-session tasks always run. */
  #schedulable(c: Challenge): boolean {
    if (this.deps.adapter.kind !== "idle") return true;
    const remote = c.remoteId ?? "";
    if (remote.startsWith("url_") || c.id.includes("_url_")) return true;
    return c.discoveredAt >= this.bootAt;
  }

  #kickoff(workspaceRoot: string, extraNote?: string): string {
    let challengeText = "";
    try {
      challengeText = readFileSync(join(workspaceRoot, "challenge.txt"), "utf8");
    } catch {
      challengeText = "(challenge.txt not written yet — use list_workspace and read_challenge_file)";
    }
    const inputDir = join(workspaceRoot, "input");
    const inputFiles: { name: string; sizeBytes: number | null }[] = [];
    if (existsSync(inputDir)) {
      for (const name of readdirSync(inputDir)) {
        try {
          const st = statSync(join(inputDir, name));
          inputFiles.push({ name, sizeBytes: st.isFile() ? st.size : null });
        } catch {
          inputFiles.push({ name, sizeBytes: null });
        }
      }
    }
    return buildKickoffMessage({ challengeText, inputFiles, extraNote });
  }

  #resumeMessage(challengeId: string): string {
    const hints = this.deps.repos.hints.listForChallenge(challengeId).map((h) => h.content);
    const wrongFlags = this.deps.repos.submissions
      .listByChallenge(challengeId)
      .filter((s) => s.status === "WRONG")
      .map((s) => s.flagValue);
    return buildResumeMessage({ newHints: hints, wrongFlags, revisionSummary: null });
  }

  /** Provider specs for the Pi runtime, assembled from the registry (§55). */
  #piWorkerConfig(): StartWorkerConfig["pi"] {
    const providers = this.deps.repos.providers.list().filter((p) => p.enabled);
    const models = this.deps.repos.models.listEnabled();
    const list: NonNullable<StartWorkerConfig["pi"]>["providers"] = [];
    for (const m of models) {
      const p = providers.find((x) => x.id === m.providerId);
      if (p) {
        list.push({
          id: p.id,
          displayName: p.displayName,
          protocol: p.protocol,
          baseUrl: p.baseUrl,
          apiKeyRef: p.apiKeyRef,
          modelId: m.modelName,
          contextWindow: m.contextWindow,
          maxOutputTokens: m.maxOutputTokens,
        });
      }
    }
    if (list.length === 0) return undefined;
    return { piDir: this.deps.piDir, secretsFile: this.deps.secretsFile, providers: list };
  }

  // -------------------------------------------------------------------------
  // Worker message routing
  // -------------------------------------------------------------------------

  private async onWorkerMessage(challengeId: string, msg: WorkerMessage): Promise<void> {
    const { repos, bus, logger } = this.deps;
    try {
      const challenge = repos.challenges.get(challengeId);
      if (!challenge) return;
      const sessionId = (msg.sessionId as string | undefined) ?? null;

      switch (msg.type) {
      case "session_persisted": {
        const sid = sessionId ?? String(msg.sessionId ?? "");
        if (sid) {
          repos.sessions.update(sid, {
            piSessionId: (msg.piSessionId as string | null) ?? null,
            piSessionFile: (msg.piSessionFile as string | null) ?? null,
          });
          logger.info({
            event: "session_persisted",
            challengeId,
            sessionId: sid,
            piSessionId: msg.piSessionId,
            piSessionFile: msg.piSessionFile,
          });
        }
        break;
      }
      case "progress": {
        const rec = repos.progress.append({
          challengeId,
          sessionId,
          summary: String(msg.summary ?? ""),
          hypotheses: (msg.hypotheses as string[]) ?? [],
          confirmedFacts: (msg.confirmedFacts as string[]) ?? [],
          rejectedHypotheses: (msg.rejectedHypotheses as string[]) ?? [],
          nextActions: (msg.nextActions as string[]) ?? [],
          confidence: Number(msg.confidence ?? 0),
          progressLevel: (msg.progress as "SIGNIFICANT" | "MINOR" | "NONE") ?? "NONE",
          stalled: Boolean(msg.stalled),
        });
        repos.challenges.update(challengeId, {
          progressStatus: msg.stalled ? "STALLED" : "ACTIVE",
        });
        if (sessionId) repos.sessions.heartbeat(sessionId);
        bus.publish({ type: "SOLVER_PROGRESS", challengeId, payload: { sessionId, progressId: rec.id, summary: rec.summary, stalled: rec.stalled } });
        break;
      }
      case "candidate": {
        await this.deps.submission.onCandidate({
          challengeId,
          sessionId: String(sessionId ?? ""),
          value: String(msg.value ?? ""),
          confidence: Number(msg.confidence ?? 0),
          reason: String(msg.reason ?? ""),
          evidence: (msg.evidence as { type: string; path?: string; text?: string }[]) ?? [],
        });
        break;
      }
      case "handoff": {
        const target = String(msg.target ?? "") === "CRYPTO" ? "CRYPTO" : "MISC";
        logger.info({ event: "handoff_requested", challengeId, target, summary: String(msg.summary ?? "") });
        await this.handoff(challengeId, target, String(msg.summary ?? ""));
        break;
      }
      case "reflection_request": {
        this.deps.reflection.reflect(challengeId, "solver_request");
        break;
      }
      case "artifact": {
        try {
          repos.artifacts.create({
            challengeId,
            parentArtifactId: (msg.parent as string | null) ?? null,
            path: String(msg.absPath ?? ""),
            mime: null,
            size: Number(msg.size ?? 0),
            sha256: String(msg.sha256 ?? ""),
            generatedBy: "TOOL",
            operation: String(msg.op ?? "tool"),
          });
        } catch (e) {
          logger.warn({ event: "artifact_record_failed", challengeId, err: String(e) });
        }
        break;
      }
      case "usage": {
        if (sessionId) {
          repos.sessions.recordUsage(sessionId, Number(msg.inputTokens ?? 0), Number(msg.outputTokens ?? 0), Number(msg.toolCalls ?? 0));
        }
        break;
      }
      case "idle": {
        bus.publish({ type: "SOLVER_IDLE", challengeId, payload: { sessionId, usage: msg.usage } });
        break;
      }
      case "error": {
        logger.warn({ event: "solver_error", challengeId, sessionId, message: String(msg.message ?? "") });
        bus.publish({ type: "SOLVER_ERROR", challengeId, payload: { sessionId, message: msg.message } });
        break;
      }
      case "info":
        logger.info({ event: "worker_info", challengeId, message: String(msg.message ?? "") });
        break;
      case "pong":
        break;
      default:
        logger.debug({ event: "worker_msg_unhandled", challengeId, type: msg.type });
      }
    } catch (e) {
      // A bad message must never take down the control plane (§101 recoverable).
      logger.error({ event: "worker_msg_error", challengeId, type: msg.type, err: String(e) });
    }
  }

  #markSessionInterrupted(challengeId: string): void {
    const { repos, logger } = this.deps;
    for (const s of repos.sessions.listActive().filter((x) => x.challengeId === challengeId)) {
      repos.sessions.setStatus(s.id, "INTERRUPTED");
      logger.warn({ event: "session_interrupted", challengeId, sessionId: s.id }, "session marked INTERRUPTED");
    }
  }

  private onWorkerLost(challengeId: string): void {
    const { repos, bus } = this.deps;
    const c = repos.challenges.get(challengeId);
    this.releaseLlmSlot(challengeId);
    if (c && c.lifecycleStatus === "ACTIVE") {
      this.#markSessionInterrupted(challengeId);
      this.deps.stateMachine.transition(challengeId, "RECOVER_ACTIVE", { payload: { reason: "WORKER_LOST" } });
    }
    bus.publish({ type: "WORKER_LOST", challengeId, payload: { reason: "lease expired" } });
  }

  private onWorkerExit(challengeId: string, code: number | null): void {
    const { repos } = this.deps;
    const c = repos.challenges.get(challengeId);
    this.releaseLlmSlot(challengeId);
    if (!c) return;
    if (this.intentionallyStopped.has(challengeId)) {
      this.intentionallyStopped.delete(challengeId);
      return;
    }
    if (c.lifecycleStatus === "ACTIVE") {
      this.deps.logger.warn({ event: "worker_crashed", challengeId, code }, "worker exited unexpectedly — requeueing");
      this.#markSessionInterrupted(challengeId);
      this.deps.stateMachine.transition(challengeId, "RECOVER_ACTIVE", { payload: { reason: `worker exit ${code}` } });
    } else if (c.lifecycleStatus === "VERIFYING" || c.lifecycleStatus === "SUBMITTING") {
      this.deps.logger.info({ event: "worker_exit_while_verify", challengeId, code });
    }
  }

  // -------------------------------------------------------------------------
  // Handoff (§88)
  // -------------------------------------------------------------------------

  private async handoff(challengeId: string, target: "MISC" | "CRYPTO", summary: string): Promise<void> {
    const { repos } = this.deps;
    const c = repos.challenges.get(challengeId);
    if (!c || c.lifecycleStatus !== "ACTIVE") return;
    const oldSession = repos.sessions.activeForChallenge(challengeId);
    this.intentionallyStopped.add(challengeId);
    this.workerPool.abort(challengeId);
    await new Promise((r) => setTimeout(r, 800));
    this.workerPool.kill(challengeId);
    if (oldSession) repos.sessions.setStatus(oldSession.id, "ENDED");

    const session = repos.sessions.create({
      challengeId,
      solverType: target,
      piSessionId: null,
      piSessionFile: null,
      providerId: null,
      modelId: null,
      status: "ACTIVE",
      startedAt: Date.now(),
      lastActiveAt: Date.now(),
      endedAt: null,
      inputTokens: 0,
      outputTokens: 0,
      toolCalls: 0,
    });
    const layout = this.workspace.ensure(challengeId);
    repos.challenges.update(challengeId, { currentSolverType: target, currentSessionId: session.id });
    await this.workerPool.startWorker({
      challengeId,
      sessionId: session.id,
      solverType: target,
      workspaceRoot: layout.root,
      sessionDir: this.deps.sessionsRoot,
      systemPrompt: systemPromptFor(target),
      initialMessage: this.#kickoff(layout.root, `A prior solver requested handoff to ${target}.\nPrior solver summary: ${summary}\nContinue with fresh eyes.`),
      modelRef: this.#resolveModelRef(),
      runtime: resolveAgentRuntime(this.deps.repos),
      resume: false,
      pythonExecutable: this.deps.pythonExecutable,
      pi: this.#piWorkerConfig(),
    });
    this.deps.bus.publish({ type: "SOLVER_HANDOFF", challengeId, payload: { from: c.currentSolverType, to: target, summary } });
  }

  // -------------------------------------------------------------------------
  // Watchdog (§65)
  // -------------------------------------------------------------------------

  private watchdogTick(): void {
    const { repos, logger, bus } = this.deps;
    const now = Date.now();
    for (const c of repos.challenges.listByStatus("ACTIVE")) {
      // timers
      if (c.solverStartedAt) {
        repos.challenges.update(c.id, { activeSolveMs: now - c.solverStartedAt, wallClockSolveMs: now - c.discoveredAt });
      }
      const session = repos.sessions.activeForChallenge(c.id);
      const lastActivity = Math.max(session?.lastActiveAt ?? 0, this.workerPool.get(c.id)?.lastActivityAt ?? 0);
      const idle = now - lastActivity;
      if (idle > this.deps.config.agent.stallDetectMs && c.progressStatus !== "STALLED") {
        repos.challenges.update(c.id, { progressStatus: "STALLED" });
        bus.publish({ type: "SOLVER_STALLED", challengeId: c.id, payload: { idleMs: idle } });
        logger.warn({ event: "solver_stalled", challengeId: c.id, idleMs: idle });
      }
      if (idle > this.deps.config.agent.reflectionAfterStalledMs) {
        const lastReflect = this.reflectCooldown.get(c.id) ?? 0;
        if (now - lastReflect > 5 * 60_000) {
          this.reflectCooldown.set(c.id, now);
          this.deps.reflection.reflect(c.id, "watchdog_stalled");
        }
      }
    }
    // disk alarm
    const free = this.disk.freeDiskGb();
    if (free < this.deps.config.storage.reserveDiskGb) {
      bus.publish({ type: "DISK_LOW", challengeId: null, payload: { freeGb: Math.round(free * 10) / 10 } });
    }
  }

  // -------------------------------------------------------------------------
  // Control API commands
  // -------------------------------------------------------------------------

  private releaseLlmSlot(challengeId: string): void {
    const slot = this.llmHeld.get(challengeId);
    if (slot) {
      slot();
      this.llmHeld.delete(challengeId);
    }
  }

  /** Deliver a message into a live worker (hint / feedback / update). */
  injectWorker(challengeId: string, message: string): boolean {
    return this.workerPool.inject(challengeId, message);
  }

  contestStatus(): {
    kind: string;
    connected: boolean;
    baseUrl: string | null;
    lastPollAt: number | null;
    lastError: string | null;
    lastListed: number;
    miscCryptoOnly: boolean;
    connectedAt: number | null;
  } {
    const kind = this.deps.adapter.kind;
    return {
      kind,
      connected: kind === "ctfd" || kind === "mock",
      baseUrl: this.contestMeta.baseUrl,
      lastPollAt: this.contestMeta.lastPollAt,
      lastError: this.contestMeta.lastError,
      lastListed: this.contestMeta.lastListed,
      miscCryptoOnly: this.contestMeta.miscCryptoOnly,
      connectedAt: this.contestMeta.connectedAt,
    };
  }

  async connectContest(opts: {
    kind?: "mock" | "ctfd";
    baseUrl?: string | null;
    token?: string | null;
    cookie?: string | null;
    miscCryptoOnly?: boolean;
  }): Promise<ReturnType<ControlPlane["contestStatus"]>> {
    const kind = opts.kind ?? (opts.baseUrl?.trim() ? "ctfd" : "mock");
    if (kind === "mock") {
      const adapter = new MockContestAdapter();
      adapter.loadFixtures();
      await this.#replaceAdapter(adapter, {
        baseUrl: "mock://demo",
        miscCryptoOnly: true,
        connected: true,
      });
    } else {
      const baseUrl = opts.baseUrl?.trim();
      if (!baseUrl) throw new Error("接入 CTFd 需要比赛平台地址");
      const adapter = new CtfdContestAdapter({
        baseUrl,
        token: opts.token,
        cookie: opts.cookie,
        miscCryptoOnly: opts.miscCryptoOnly,
      });
      await adapter.authenticate();
      await this.#replaceAdapter(adapter, {
        baseUrl: adapter.baseUrl,
        miscCryptoOnly: adapter.miscCryptoOnly,
        connected: true,
      });
    }
    try {
      await this.pollOnce();
    } catch (e) {
      this.deps.logger.warn({ event: "contest_first_poll_failed", err: String(e) });
    }
    const status = this.contestStatus();
    this.deps.bus.publish({
      type: "CONTEST_CONNECTED",
      challengeId: null,
      payload: { kind: status.kind, baseUrl: status.baseUrl, listed: status.lastListed },
    });
    this.deps.logger.info(
      { event: "contest_connected", kind: status.kind, baseUrl: status.baseUrl, listed: status.lastListed },
      "contest connected",
    );
    return status;
  }

  async disconnectContest(): Promise<ReturnType<ControlPlane["contestStatus"]>> {
    if (this.deps.adapter.kind === "idle") return this.contestStatus();
    const idle = new IdleContestAdapter();
    await this.#replaceAdapter(idle, { baseUrl: null, miscCryptoOnly: true, connected: false });
    this.deps.bus.publish({ type: "CONTEST_DISCONNECTED", challengeId: null, payload: {} });
    this.deps.logger.info({ event: "contest_disconnected" }, "contest disconnected — idle mode");
    return this.contestStatus();
  }

  async #replaceAdapter(
    adapter: ContestAdapter,
    meta: { baseUrl: string | null; miscCryptoOnly: boolean; connected: boolean },
  ): Promise<void> {
    const old = this.deps.adapter;
    this.deps.adapter = adapter;
    this.deps.preparation.replaceAdapter(adapter);
    this.deps.submission.replaceAdapter(adapter);
    this.deps.hints.replaceAdapter(adapter);
    this.contestMeta.baseUrl = meta.baseUrl;
    this.contestMeta.miscCryptoOnly = meta.miscCryptoOnly;
    this.contestMeta.connectedAt = meta.connected ? Date.now() : null;
    this.contestMeta.lastError = null;
    if (old !== adapter) {
      try {
        await (old as { close?: () => Promise<void> }).close?.();
      } catch {
        /* ignore */
      }
    }
    await adapter.authenticate();
    const caps = await adapter.getCapabilities();
    if (caps.polling) this.poller.start(() => this.pollOnce());
  }

  /**
   * 从 URL 开始一道新任务：抓取题面/附件 → 注入当前比赛 → 自动进入
   * 完整解题流程（Triage → Solver → 候选 Flag）。
   */
  async addUrlChallenge(url: string): Promise<{ challengeId: string; title: string; category: string; attachments: number; description: string }> {
    const { fetchChallengeFromUrl } = await import("@rio/contest");
    const fetched = await fetchChallengeFromUrl(url);
    const slug = fetched.title.replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 40) || "url-challenge";
    // poller 会加 ch_ 前缀（remoteId → challenge id），这里用 url_ 前缀保证一致
    const id = `url_${slug}_${Math.random().toString(36).slice(2, 6)}`;
    const mock = this.deps.adapter as unknown as { addExternalChallenge?: (input: unknown) => void };
    if (typeof mock.addExternalChallenge !== "function") {
      throw new Error("当前比赛适配器不支持动态注入题目（请先断开比赛，或改用 mock / 未接入状态）");
    }
    mock.addExternalChallenge({
      id,
      title: fetched.title,
      category: fetched.category,
      description: fetched.description,
      attachments: fetched.attachments,
    });
    // Discover immediately so the Dashboard can open the row (don't wait for the 5s poller).
    await this.pollOnce();
    const created = this.deps.repos.challenges.getByRemoteId(id);
    if (created) {
      this.deps.repos.challenges.update(created.id, { priority: 100 });
    }
    const challengeId = created?.id ?? `ch_${id}`;
    this.deps.bus.publish({
      type: "URL_CHALLENGE_ADDED",
      challengeId,
      payload: { url, title: fetched.title, attachments: fetched.attachments.length },
    });
    this.deps.logger.info({ event: "url_challenge_added", challengeId, url, title: fetched.title });
    return {
      challengeId,
      title: fetched.title,
      category: fetched.category,
      attachments: fetched.attachments.length,
      description: fetched.description,
    };
  }

  async reconsiderRejected(challengeId: string): Promise<{ reconsidered: number; passed: number }> {
    return this.deps.submission.reconsiderRejectedLocal(challengeId);
  }

  /**
   * Human says this candidate is wrong: mark it, tell the live solver (or
   * requeue so the next session sees it in challenge.txt), keep solving.
   */
  async rejectCandidate(challengeId: string, candidateId: string): Promise<void> {
    const { repos } = this.deps;
    const challenge = repos.challenges.get(challengeId);
    const candidate = repos.candidates.get(candidateId);
    if (!challenge || !candidate) throw new Error("unknown challenge/candidate");
    if (candidate.challengeId !== challengeId) throw new Error("candidate does not belong to this challenge");

    if (candidate.status !== "WRONG") {
      repos.candidates.update(candidateId, { status: "WRONG", submittedAt: Date.now() });
      const sub = repos.submissions.createOrGet({
        challengeId,
        candidateId,
        flagHash: hashHex(candidate.value),
        flagValue: candidate.value,
        status: "WRONG",
      });
      if (sub.status !== "WRONG") {
        repos.submissions.update(sub.id, { status: "WRONG", submittedAt: Date.now(), error: "rejected by human reviewer" });
      }
      const wrongCount = repos.submissions.countWrong(challengeId);
      repos.challenges.update(challengeId, { wrongSubmissionCount: wrongCount });
    }

    const status = repos.challenges.get(challengeId)!.lifecycleStatus;
    if (status === "SOLVED") {
      this.deps.stateMachine.transition(challengeId, "REOPEN", { payload: { reason: "human rejected flag" } });
    } else if (status === "SUBMITTING") {
      this.deps.stateMachine.transition(challengeId, "SUBMIT_WRONG", { payload: { reason: "human rejected flag" } });
    } else if (status === "VERIFYING") {
      this.deps.stateMachine.transition(challengeId, "VERIFY_FAIL", { payload: { reason: "human rejected flag" } });
    } else if (status === "PAUSED") {
      this.deps.stateMachine.transition(challengeId, "RESUME");
    }

    this.deps.preparation.refreshChallengeFile(challengeId);
    this.deps.bus.publish({
      type: "FLAG_REJECTED_BY_HUMAN",
      challengeId,
      payload: { candidateId, value: candidate.value },
    });

    const msg = `OFFICIAL SUBMISSION FEEDBACK

A human reviewer rejected the following candidate:

<${candidate.value}>

Do not submit this exact candidate again.

Re-evaluate the derivation that produced it.
Treat the rejection as negative evidence and continue solving.`;
    const injected = this.injectWorker(challengeId, msg);
    if (!injected) {
      // No live worker — put it back on the queue so a new session starts
      // with the rejection listed in challenge.txt.
      const now = repos.challenges.get(challengeId);
      if (now && now.lifecycleStatus === "ACTIVE") {
        this.deps.stateMachine.transition(challengeId, "SOLVER_STOPPED", { payload: { reason: "requeue after human reject" } });
      }
    }
    this.deps.logger.info({ event: "flag_rejected_by_human", challengeId, candidateId, injected }, "human rejected candidate — solver continues");
  }

  async acceptCandidate(challengeId: string, candidateId: string): Promise<void> {
    const { repos } = this.deps;
    const challenge = repos.challenges.get(challengeId);
    const candidate = repos.candidates.get(candidateId);
    if (!challenge || !candidate) throw new Error("unknown challenge/candidate");
    if (candidate.challengeId !== challengeId) throw new Error("candidate does not belong to this challenge");
    acceptIntoSolved(this.deps.stateMachine, repos, challengeId, candidateId);
    repos.candidates.update(candidateId, { status: "CORRECT", submittedAt: Date.now() });
    const sub = repos.submissions.createOrGet({
      challengeId,
      candidateId,
      flagHash: hashHex(candidate.value),
      flagValue: candidate.value,
      status: "CORRECT",
    });
    if (sub.status !== "CORRECT") repos.submissions.update(sub.id, { status: "CORRECT", submittedAt: Date.now() });
    await this.handleSubmissionCorrect(challengeId);
  }

  async pause(challengeId: string, reason?: string): Promise<void> {
    const c = this.deps.repos.challenges.get(challengeId);
    if (!c) throw new Error("unknown challenge");
    if (c.lifecycleStatus === "PAUSED") return;
    this.intentionallyStopped.add(challengeId);
    this.workerPool.abort(challengeId);
    this.releaseLlmSlot(challengeId);
    const res = this.deps.stateMachine.transition(challengeId, "PAUSE", {
      reason: reason ?? "manual pause",
      payload: { pausedReason: reason ?? "manual pause" },
    });
    if (!res.allowed) throw new Error(`cannot pause while ${c.lifecycleStatus}`);
    const session = this.deps.repos.sessions.activeForChallenge(challengeId);
    if (session) this.deps.repos.sessions.setStatus(session.id, "PAUSED");
    this.deps.bus.publish({ type: "CHALLENGE_PAUSED", challengeId, payload: { status: "PAUSED" } });
  }

  resume(challengeId: string): void {
    const res = this.deps.stateMachine.transition(challengeId, "RESUME");
    if (!res.allowed) throw new Error("cannot resume");
    this.deps.bus.publish({ type: "CHALLENGE_RESUMED", challengeId, payload: { status: "QUEUED" } });
  }

  async park(challengeId: string, reason?: string): Promise<void> {
    const c = this.deps.repos.challenges.get(challengeId);
    if (!c) throw new Error("unknown challenge");
    if (c.lifecycleStatus === "PARKED") return;
    this.intentionallyStopped.add(challengeId);
    this.workerPool.abort(challengeId);
    this.releaseLlmSlot(challengeId);
    const res = this.deps.stateMachine.transition(challengeId, "PARK", {
      reason: reason ?? "manual park",
      payload: { parkedReason: reason ?? "manual park" },
    });
    if (!res.allowed) throw new Error(`cannot park while ${c.lifecycleStatus}`);
    const session = this.deps.repos.sessions.activeForChallenge(challengeId);
    if (session) this.deps.repos.sessions.setStatus(session.id, "PAUSED");
    this.deps.bus.publish({ type: "CHALLENGE_PARKED", challengeId, payload: { status: "PARKED" } });
  }

  unpark(challengeId: string): void {
    this.deps.stateMachine.transition(challengeId, "UNPARK");
  }

  async deleteChallenge(challengeId: string): Promise<{ id: string; remoteId: string | null }> {
    const { repos, logger, bus } = this.deps;
    const challenge = repos.challenges.get(challengeId);
    if (!challenge) throw new Error("unknown challenge");

    this.intentionallyStopped.add(challengeId);
    this.preparing.delete(challengeId);
    this.reflectCooldown.delete(challengeId);
    this.deps.hints.clearChallenge(challengeId);
    this.deps.submission.cancelRetriesForChallenge(challengeId);
    this.workerPool.abort(challengeId);
    this.releaseLlmSlot(challengeId);
    await new Promise((r) => setTimeout(r, 200));
    this.workerPool.kill(challengeId);
    repos.leases.release(challengeId);

    const sessionFiles = repos.sessions
      .listByChallenge(challengeId)
      .map((s) => s.piSessionFile)
      .filter((p): p is string => Boolean(p));

    rememberDeletedRemoteId(repos, challenge.remoteId);
    const forget = this.deps.adapter as { forgetChallenge?: (remoteId: string) => void };
    if (challenge.remoteId && typeof forget.forgetChallenge === "function") {
      forget.forgetChallenge(challenge.remoteId);
    }

    repos.challenges.deleteCascade(challengeId);

    try {
      this.workspace.remove(challengeId);
    } catch (e) {
      logger.warn({ event: "workspace_delete_failed", challengeId, err: String(e) });
    }
    for (const file of sessionFiles) {
      try {
        if (existsSync(file)) unlinkSync(file);
      } catch {
        /* ignore leftover session files */
      }
    }

    bus.publish({ type: "CHALLENGE_DELETED", challengeId, payload: { remoteId: challenge.remoteId, title: challenge.title } });
    logger.info({ event: "challenge_deleted", challengeId, remoteId: challenge.remoteId, title: challenge.title });
    this.intentionallyStopped.delete(challengeId);
    return { id: challengeId, remoteId: challenge.remoteId };
  }

  async restartSolver(challengeId: string): Promise<void> {
    this.intentionallyStopped.add(challengeId);
    this.workerPool.abort(challengeId);
    this.releaseLlmSlot(challengeId);
    const res = this.deps.stateMachine.transition(challengeId, "RESTART_SOLVER", { payload: { reason: "manual restart" } });
    if (!res.allowed) throw new Error(`cannot restart ${challengeId} (${res.from})`);
  }

  setPriority(challengeId: string, priority: number): void {
    this.deps.repos.challenges.update(challengeId, { priority });
    this.deps.bus.publish({ type: "PRIORITY_CHANGED", challengeId, payload: { priority } });
  }

  async forceHint(challengeId: string): Promise<string | null> {
    return this.deps.hints.fetchHint(challengeId, { force: true });
  }

  async retrySubmission(challengeId: string, submissionId: string): Promise<void> {
    await this.deps.submission.retrySubmission(challengeId, submissionId);
  }

  resumeSolvingAfterUnknown(challengeId: string): void {
    this.deps.submission.resumeSolvingAfterUnknown(challengeId);
  }

  runReflection(challengeId: string): ReturnType<ReflectionService["reflect"]> {
    return this.deps.reflection.reflect(challengeId, "manual");
  }

  switchModel(challengeId: string, modelId: string): void {
    const model = this.deps.repos.models.get(modelId);
    if (!model) throw new Error("unknown model");
    const session = this.deps.repos.sessions.activeForChallenge(challengeId);
    if (session) this.deps.repos.sessions.update(session.id, { modelId: model.modelName, providerId: model.providerId });
    this.workerPool.switchModel(challengeId, { providerId: model.providerId, modelId: model.modelName });
    this.deps.bus.publish({ type: "MODEL_SWITCHED", challengeId, payload: { modelId } });
  }

  async manualCandidate(challengeId: string, input: { value: string; confidence?: number; reason?: string }): Promise<void> {
    const c = this.deps.repos.challenges.get(challengeId);
    if (!c) throw new Error("unknown challenge");
    await this.deps.submission.onCandidate({
      challengeId,
      sessionId: "",
      value: input.value,
      confidence: input.confidence ?? 0.9,
      reason: input.reason ?? "manual candidate from dashboard",
      evidence: [],
    });
  }

  async manualSubmit(challengeId: string, candidateId: string): Promise<void> {
    await this.deps.submission.manualSubmit(challengeId, candidateId);
  }

  async handleSubmissionCorrect(challengeId: string): Promise<void> {
    this.intentionallyStopped.add(challengeId);
    this.workerPool.abort(challengeId);
    this.workerPool.kill(challengeId);
    this.releaseLlmSlot(challengeId);
    const session = this.deps.repos.sessions.activeForChallenge(challengeId);
    if (session) this.deps.repos.sessions.setStatus(session.id, "ENDED");
  }

  status(): Record<string, unknown> {
    const { repos } = this.deps;
    const all = repos.challenges.list();
    const countBy = (s: string) => all.filter((c) => c.lifecycleStatus === s).length;
    return {
      total: all.length,
      solved: countBy("SOLVED"),
      active: countBy("ACTIVE"),
      queued: countBy("QUEUED"),
      preparing: countBy("PREPARING"),
      parked: countBy("PARKED"),
      paused: countBy("PAUSED"),
      unsupported: countBy("UNSUPPORTED"),
      error: countBy("ERROR"),
      miscSolved: all.filter((c) => c.category === "MISC" && c.lifecycleStatus === "SOLVED").length,
      cryptoSolved: all.filter((c) => c.category === "CRYPTO" && c.lifecycleStatus === "SOLVED").length,
      workers: this.workerPool.activeCount(),
      workerSlots: this.deps.config.workers.solverConcurrency,
      diskFreeGb: Math.round(this.disk.freeDiskGb() * 10) / 10,
      startedAt: (repos.settings.get("startedAt") ? Number(repos.settings.get("startedAt")) : null),
      adapter: this.deps.adapter.kind,
      contest: this.contestStatus(),
      agentRuntime: resolveAgentRuntime(this.deps.repos),
      executionMode: "NATIVE_TRUSTED",
      filesystemIsolation: false,
      networkIsolation: false,
      providers: repos.providers.list().map((p) => ({ id: p.id, name: p.displayName, health: p.health })),
    };
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    for (const c of this.deps.repos.challenges.listByStatus("ACTIVE")) {
      this.intentionallyStopped.add(c.id);
    }
    this.poller.stop();
    if (this.schedulerTimer) clearInterval(this.schedulerTimer);
    if (this.hintTimer) clearInterval(this.hintTimer);
    if (this.watchdogTimer) clearInterval(this.watchdogTimer);
    this.workerPool.stopAll();
    this.deps.submission.stop();
    await new Promise((r) => setTimeout(r, 2200));
    try {
      await (this.deps.adapter as { close?: () => Promise<void> }).close?.();
    } catch {
      /* ignore */
    }
  }
}

function normalizeCategory(raw: string): Challenge["category"] {
  const up = raw.toUpperCase().trim();
  if (up.includes("MISC") || raw.includes("杂项") || /forensic/i.test(raw) || /osint/i.test(raw)) return "MISC";
  if (up.includes("CRYPTO") || raw.includes("密码")) return "CRYPTO";
  if (up.includes("WEB")) return "WEB";
  if (up.includes("PWN")) return "PWN";
  if (up.includes("REV")) return "REVERSE";
  if (up === "OTHER") return "OTHER";
  return "UNKNOWN";
}
