// Fastify REST + SSE API (§97-98).
import type { FastifyInstance } from "fastify";
import type { Repositories } from "@rio/database";
import type { RioLogger, SecretStore, RuntimeConfig } from "@rio/shared";
import { setPriorityParamsSchema, switchModelParamsSchema, manualCandidateParamsSchema, providerCreateSchema, modelCreateSchema } from "@rio/domain";
import type { ControlPlane } from "../control/control-plane.js";
import type { ModelRegistry } from "../control/registry.js";
import type { EventBus } from "../control/bus.js";

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
  const { fastify, control, repos, bus, registry } = deps;

  fastify.get("/api/status", async () => control.status());

  fastify.get("/api/health", async () => ({
    ok: true,
    db: "ok",
    workers: control.status().workers,
    diskFreeGb: control.status().diskFreeGb,
    adapter: control.status().adapter,
  }));

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
    return list.map((c) => ({
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
    }));
  });

  fastify.get("/api/challenges/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const c = repos.challenges.get(id);
    if (!c) return reply.code(404).send({ error: "unknown challenge" });
    return {
      ...c,
      attachments: repos.attachments.listByChallenge(id),
      artifacts: repos.artifacts.listByChallenge(id),
      progress: repos.progress.listForChallenge(id, 50),
      candidates: repos.candidates.listByChallenge(id),
      submissions: repos.submissions.listByChallenge(id),
      sessions: repos.sessions.listActive().filter((s) => s.challengeId === id),
      hints: repos.hints.listForChallenge(id),
      timeline: repos.events.recent(id, 60),
    };
  });

  fastify.post("/api/challenges/:id/pause", async (req) => {
    const { id } = req.params as { id: string };
    await control.pause(id);
    return { ok: true };
  });
  fastify.post("/api/challenges/:id/resume", async (req) => {
    control.resume((req.params as { id: string }).id);
    return { ok: true };
  });
  fastify.post("/api/challenges/:id/park", async (req) => {
    await control.park((req.params as { id: string }).id);
    return { ok: true };
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
    control.runReflection((req.params as { id: string }).id);
    return { ok: true };
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

  // -------------------------------------------------------------------------
  // Providers / models
  // -------------------------------------------------------------------------

  fastify.get("/api/providers", async () => ({
    providers: repos.providers.list(),
    models: repos.models.list(),
  }));

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
    return { ok: true };
  });

  fastify.post("/api/models", async (req) => {
    const body = modelCreateSchema.parse(req.body);
    const model = await registry.addModel(body);
    return { ok: true, model };
  });

  // -------------------------------------------------------------------------
  // Events (SSE)
  // -------------------------------------------------------------------------

  fastify.get("/api/events/stream", async (req, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    const send = (e: { type: string; challengeId?: string | null; payload: Record<string, unknown>; createdAt: number }) => {
      reply.raw.write(`data: ${JSON.stringify(e)}\n\n`);
    };
    const unsubscribe = bus.subscribe(send);
    req.raw.on("close", () => {
      unsubscribe();
      reply.raw.end();
    });
    return reply;
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
