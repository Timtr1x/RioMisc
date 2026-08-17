// Fastify REST + SSE API (§97-98).
import type { FastifyInstance } from "fastify";
import type { Repositories } from "@rio/database";
import type { RioLogger, SecretStore, RuntimeConfig } from "@rio/shared";
import { setPriorityParamsSchema, switchModelParamsSchema, manualCandidateParamsSchema, providerCreateSchema, modelCreateSchema, modelPatchSchema, modelAssignmentsSchema, modelCapabilitiesSchema, visualReviewAnswerSchema } from "@rio/domain";
import type { ControlPlane } from "../control/control-plane.js";
import type { ModelRegistry } from "../control/registry.js";
import type { EventBus } from "../control/bus.js";
import { loadModelAssignments, patchModelAssignments, pruneUnusableAssignments, sanitizeModelAssignments } from "../control/model-assignments.js";

export interface ApiDeps {
  fastify: FastifyInstance;
  control: ControlPlane;
  repos: Repositories;
  bus: EventBus;
  registry: ModelRegistry;
  secrets: SecretStore;
  config: RuntimeConfig;
  logger: RioLogger;
}

export async function buildApi(deps: ApiDeps): Promise<FastifyInstance> {
  const { fastify, control, repos, bus, registry, secrets } = deps;

  fastify.addHook("onRequest", async (req, reply) => {
    const origin = req.headers.origin;
    if (origin === "http://127.0.0.1:5173" || origin === "http://localhost:5173") {
      reply.header("Access-Control-Allow-Origin", origin);
      reply.header("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
      reply.header("Access-Control-Allow-Headers", "content-type");
    }
    if (req.method === "OPTIONS") {
      reply.code(204);
      return reply.send();
    }
  });

  fastify.setErrorHandler((err, _req, reply) => {
    const message = err instanceof Error ? err.message : String(err);
    const status = /unknown|cannot |no stored|invalid/i.test(message) ? 400 : 500;
    reply.code(status).send({ error: message });
  });

  fastify.get("/api/status", async () => control.status());

  fastify.get("/api/health", async () => {
    const s = control.status();
    const degraded = Array.isArray(s.providers) && (s.providers as { health: string }[]).some((p) => p.health !== "HEALTHY" && p.health !== "UNKNOWN");
    return {
      ok: !degraded,
      degraded,
      db: "ok",
      workers: s.workers,
      workerSlots: s.workerSlots,
      diskFreeGb: s.diskFreeGb,
      adapter: s.adapter,
      unknownSubmissions: s.unknownSubmissions ?? 0,
      blockedChallenges: s.blocked ?? 0,
      executionMode: s.executionMode ?? "NATIVE_TRUSTED",
      filesystemIsolation: false,
      networkIsolation: false,
    };
  });

  // -------------------------------------------------------------------------
  // Challenges
  // -------------------------------------------------------------------------

  fastify.get("/api/challenges", async (req) => {
    const q = req.query as { category?: string; status?: string; solved?: string };
    let list = repos.challenges.list();
    if (q.category) list = list.filter((c) => c.category === q.category!.toUpperCase());
    if (q.status) list = list.filter((c) => c.lifecycleStatus === q.status!.toUpperCase());
    if (q.solved === "true") list = list.filter((c) => c.lifecycleStatus === "SOLVED");
    if (q.solved === "false") list = list.filter((c) => c.lifecycleStatus !== "SOLVED");
    const latestFlag = repos.candidates.latestPerChallenge();
    return list.map((c) => {
      const flag = latestFlag.get(c.id);
      return {
        id: c.id,
        title: c.title,
        category: c.category,
        score: c.score,
        status: c.lifecycleStatus,
        priority: c.priority,
        priorityScore: c.lastPriorityScore,
        elapsedMs: c.wallClockSolveMs,
        progress: c.progressStatus,
        hint: c.hintStatus,
        wrong: c.wrongSubmissionCount,
        solver: c.currentSolverType,
        difficulty: c.difficultyEstimate,
        blockedReason: c.blockedReason,
        flag: flag?.value ?? null,
        flagStatus: flag?.status ?? null,
        flagAt: flag?.createdAt ?? null,
      };
    });
  });

  fastify.get("/api/challenges/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const c = repos.challenges.get(id);
    if (!c) return reply.code(404).send({ error: "unknown challenge" });
    return {
      ...c,
      attachments: repos.attachments.listByChallenge(id),
      artifacts: repos.artifacts.listByChallenge(id),
      visualEvidence: repos.visualEvidence.listByChallenge(id),
      hypotheses: repos.hypotheses.listByChallenge(id),
      experiments: repos.experiments.listByChallenge(id),
      specialists: repos.specialists.listByChallenge(id),
      progress: repos.progress.listForChallenge(id, 50),
      candidates: repos.candidates.listByChallenge(id),
      submissions: repos.submissions.listByChallenge(id),
      sessions: repos.sessions.listByChallenge(id).map((s) => ({
        ...s,
        mode: s.piSessionFile ? "resumed" : "fresh",
      })),
      hints: repos.hints.listForChallenge(id),
      timeline: repos.events.recent(id, 60),
    };
  });

  fastify.delete("/api/challenges/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const result = await control.deleteChallenge(id);
      return { ok: true, ...result };
    } catch (e) {
      const message = (e as Error).message;
      if (/unknown challenge/i.test(message)) return reply.code(404).send({ error: message });
      return reply.code(400).send({ error: message });
    }
  });

  fastify.post("/api/challenges/:id/pause", async (req) => {
    const { id } = req.params as { id: string };
    await control.pause(id);
    const c = repos.challenges.get(id);
    return { ok: true, status: c?.lifecycleStatus ?? "PAUSED" };
  });
  fastify.post("/api/challenges/:id/resume", async (req) => {
    control.resume((req.params as { id: string }).id);
    return { ok: true };
  });
  fastify.post("/api/challenges/:id/park", async (req) => {
    await control.park((req.params as { id: string }).id);
    const c = repos.challenges.get((req.params as { id: string }).id);
    return { ok: true, status: c?.lifecycleStatus ?? "PARKED" };
  });
  fastify.post("/api/challenges/:id/unpark", async (req) => {
    control.unpark((req.params as { id: string }).id);
    return { ok: true };
  });
  fastify.post("/api/challenges/:id/restart", async (req) => {
    await control.restartSolver((req.params as { id: string }).id);
    return { ok: true };
  });
  fastify.post("/api/challenges/:id/hint", async (req) => {
    const hint = await control.forceHint((req.params as { id: string }).id);
    return { ok: true, hint };
  });
  fastify.post("/api/challenges/:id/reflection", async (req) => {
    const result = control.runReflection((req.params as { id: string }).id);
    return { ok: true, ...result };
  });
  fastify.post("/api/challenges/:id/model", async (req) => {
    const body = switchModelParamsSchema.parse(req.body);
    control.switchModel((req.params as { id: string }).id, body.modelId);
    return { ok: true };
  });
  fastify.post("/api/challenges/:id/priority", async (req) => {
    const body = setPriorityParamsSchema.parse(req.body);
    const map: Record<string, number> = { LOW: -30, NORMAL: 0, HIGH: 50, CRITICAL: 100 };
    control.setPriority((req.params as { id: string }).id, map[body.priority]!);
    return { ok: true };
  });
  fastify.post("/api/challenges/:id/candidate", async (req) => {
    const body = manualCandidateParamsSchema.parse(req.body);
    await control.manualCandidate((req.params as { id: string }).id, body);
    return { ok: true };
  });
  fastify.post("/api/challenges/:id/submit", async (req) => {
    const body = req.body as { candidateId: string };
    await control.manualSubmit((req.params as { id: string }).id, String(body.candidateId));
    return { ok: true };
  });
  fastify.post("/api/challenges/:id/reverify", async (req) => {
    const { id } = req.params as { id: string };
    const result = await control.reconsiderRejected(id);
    return { ok: true, ...result };
  });
  fastify.post("/api/challenges/:id/accept", async (req) => {
    const { id } = req.params as { id: string };
    const body = req.body as { candidateId: string };
    await control.acceptCandidate(id, String(body.candidateId));
    return { ok: true };
  });
  fastify.post("/api/challenges/:id/reject", async (req) => {
    const { id } = req.params as { id: string };
    const body = req.body as { candidateId: string };
    await control.rejectCandidate(id, String(body.candidateId));
    return { ok: true };
  });
  fastify.post("/api/challenges/:id/retry-submission", async (req) => {
    const { id } = req.params as { id: string };
    const body = req.body as { submissionId: string };
    await control.retrySubmission(id, String(body.submissionId));
    return { ok: true };
  });
  fastify.post("/api/challenges/:id/resume-solving", async (req) => {
    const { id } = req.params as { id: string };
    control.resumeSolvingAfterUnknown(id);
    return { ok: true };
  });

  // -------------------------------------------------------------------------
  // Providers / models
  // -------------------------------------------------------------------------

  fastify.get("/api/providers", async () => ({
    providers: repos.providers.list(),
    models: repos.models.list(),
    assignments: sanitizeModelAssignments(repos, loadModelAssignments(repos)),
  }));

  fastify.get("/api/models/assignments", async () => sanitizeModelAssignments(repos, loadModelAssignments(repos)));

  fastify.put("/api/models/assignments", async (req) => {
    const body = modelAssignmentsSchema.parse(req.body ?? {});
    return { ok: true, assignments: patchModelAssignments(repos, body) };
  });

  fastify.post("/api/providers", async (req) => {
    const body = providerCreateSchema.parse(req.body);
    const provider = await registry.addProvider(body);
    return { ok: true, provider };
  });

  fastify.post("/api/providers/:id/test", async (req) => {
    const result = await registry.testConnection((req.params as { id: string }).id);
    return { ok: true, result };
  });

  fastify.delete("/api/providers/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const provider = repos.providers.get(id);
    if (!provider) return reply.code(404).send({ error: "unknown provider" });
    // also drop the stored secret
    try {
      await secrets.delete(provider.apiKeyRef);
    } catch {
      /* no master key or missing secret — ignore */
    }
    repos.providers.update(id, { enabled: false });
    pruneUnusableAssignments(repos);
    return { ok: true };
  });

  fastify.post("/api/models", async (req) => {
    const body = modelCreateSchema.parse(req.body);
    const model = await registry.addModel(body);
    return { ok: true, model };
  });

  fastify.patch("/api/models/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = modelPatchSchema.parse(req.body ?? {});
    const model = repos.models.get(id);
    if (!model) return reply.code(404).send({ error: "unknown model" });
    if (!model.enabled) return reply.code(400).send({ error: "model is disabled" });
    repos.models.update(id, body);
    return { ok: true, model: repos.models.get(id) };
  });

  fastify.post("/api/models/:id/role", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as { role?: string };
    if (!["PRIMARY", "FALLBACK", "GENERAL"].includes(body.role ?? "")) {
      return reply.code(400).send({ error: "role must be PRIMARY | FALLBACK | GENERAL" });
    }
    const model = repos.models.get(id);
    if (!model) return reply.code(404).send({ error: "unknown model" });
    if (!model.enabled) return reply.code(400).send({ error: "model is disabled" });
    if (!repos.providers.get(model.providerId)?.enabled) return reply.code(400).send({ error: "provider is disabled" });
    repos.models.update(id, { role: body.role as "PRIMARY" | "FALLBACK" | "GENERAL" });
    // 同一 provider 只保留一个 PRIMARY
    if (body.role === "PRIMARY") {
      for (const other of repos.models.listByProvider(model.providerId)) {
        if (other.id !== id && other.role === "PRIMARY") repos.models.update(other.id, { role: "GENERAL" });
      }
      patchModelAssignments(repos, { primarySolverModelId: id });
    }
    return { ok: true };
  });

  fastify.post("/api/models/:id/capabilities", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = modelCapabilitiesSchema.parse(req.body ?? {});
    const model = repos.models.get(id);
    if (!model) return reply.code(404).send({ error: "unknown model" });
    repos.models.update(id, { capabilities: { ...model.capabilities, ...body } });
    return { ok: true, model: repos.models.get(id) };
  });

  fastify.get("/api/benchmarks", async () => {
    const { BENCHMARK_MANIFESTS, summarizeBenchmark } = await import("@rio/eval");
    const runs = repos.benchmarkRuns.list();
    return { manifests: BENCHMARK_MANIFESTS, runs, summary: summarizeBenchmark(runs) };
  });

  fastify.post("/api/benchmarks/run", async (req) => {
    const id = (req.body as { id?: string } | undefined)?.id;
    const { runBenchmark, summarizeBenchmark } = await import("@rio/eval");
    const results = await runBenchmark(id);
    for (const r of results) {
      repos.benchmarkRuns.create({
        manifestId: r.manifestId,
        solved: r.solved,
        flag: r.flag,
        techniques: r.techniques,
        toolCalls: r.toolCalls,
        durationMs: r.durationMs,
        error: r.error,
      });
    }
    return { ok: true, results, summary: summarizeBenchmark(results) };
  });

  fastify.get("/api/visual-reviews", async () => {
    const items = repos.visualReviews.list();
    return { items, pending: items.filter((r) => r.status === "PENDING").length };
  });

  fastify.post("/api/visual-reviews/:id/answer", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = visualReviewAnswerSchema.parse(req.body ?? {});
    try {
      const result = await control.answerVisualReview(id, body);
      return { ok: true, ...result };
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  fastify.post("/api/visual-reviews/:id/cancel", async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      control.cancelVisualReview(id);
      return { ok: true };
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  fastify.get("/api/challenges/:id/workspace", async (req, reply) => {
    const { id } = req.params as { id: string };
    const path = String((req.query as { path?: string }).path ?? "");
    if (!path) return reply.code(400).send({ error: "path required" });
    try {
      const file = control.readWorkspaceFile(id, path);
      return reply.type(file.mime).send(file.bytes);
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  fastify.delete("/api/models/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const model = repos.models.get(id);
    if (!model) return reply.code(404).send({ error: "unknown model" });
    repos.models.update(id, { enabled: false });
    pruneUnusableAssignments(repos);
    return { ok: true };
  });

  // -------------------------------------------------------------------------
  // Events (SSE)
  // -------------------------------------------------------------------------

  fastify.get("/api/events/stream", async (req, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    const send = (e: { type: string; challengeId?: string | null; payload: Record<string, unknown>; createdAt: number }) => {
      reply.raw.write(`data: ${JSON.stringify(e)}\n\n`);
    };
    reply.raw.write(`: connected\n\n`);
    const heartbeat = setInterval(() => {
      try {
        reply.raw.write(`: ping\n\n`);
      } catch {
        /* closed */
      }
    }, 15_000);
    const unsubscribe = bus.subscribe(send);
    req.raw.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
      reply.raw.end();
    });
    return reply;
  });

  // -------------------------------------------------------------------------
  // Contest — connect a full contest (mock demo or CTFd) for auto ingest/solve
  // -------------------------------------------------------------------------

  fastify.get("/api/contest", async () => control.contestStatus());

  fastify.post("/api/contest/connect", async (req, reply) => {
    const body = (req.body ?? {}) as {
      kind?: string;
      baseUrl?: string;
      token?: string;
      cookie?: string;
      miscCryptoOnly?: boolean;
      trustedCredentialOrigins?: string[] | string;
    };
    const kind = body.kind === "ctfd" ? "ctfd" : body.kind === "mock" ? "mock" : body.baseUrl ? "ctfd" : "mock";
    try {
      const status = await control.connectContest({
        kind,
        baseUrl: body.baseUrl ?? process.env.CTFD_BASE_URL,
        token: body.token ?? process.env.CTFD_TOKEN,
        cookie: body.cookie ?? process.env.CTFD_COOKIE,
        miscCryptoOnly: body.miscCryptoOnly,
        trustedCredentialOrigins: body.trustedCredentialOrigins,
      });
      return { ok: true, ...status };
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  fastify.post("/api/contest/disconnect", async () => {
    const status = await control.disconnectContest();
    return { ok: true, ...status };
  });

  // -------------------------------------------------------------------------
  // Tasks — start a new task from a URL
  // -------------------------------------------------------------------------

  fastify.post("/api/tasks/from-url", async (req, reply) => {
    const body = req.body as { url?: string };
    if (!body?.url || !/^https?:\/\//i.test(body.url)) {
      return reply.code(400).send({ error: "url must be an http(s) link" });
    }
    try {
      const result = await control.addUrlChallenge(body.url);
      return { ok: true, ...result };
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  // -------------------------------------------------------------------------
  // Shutdown
  // -------------------------------------------------------------------------

  fastify.post("/api/shutdown", async () => {
    setTimeout(() => void control.stop().then(() => process.exit(0)), 100);
    return { ok: true };
  });

  await fastify.listen({ host: deps.config.server.host, port: deps.config.server.port });
  deps.logger.info({ event: "api_ready", url: `http://${deps.config.server.host}:${deps.config.server.port}` }, "api listening");
  return fastify;
}
