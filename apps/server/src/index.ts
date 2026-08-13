// Server bootstrap: config → DB → repos → services → control plane → API.
import { resolve, join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { createLogger, loadConfig, FileSecretStore, type RuntimeConfig } from "@rio/shared";
import { createRepositories } from "@rio/database";
import { MockContestAdapter, IdleContestAdapter, LocalContestAdapter, DiskManager, type ContestAdapter } from "@rio/contest";
import { WorkspaceManager } from "@rio/tool-runtime";
import { StateMachine } from "./state-machine.js";
import { EventBus } from "./control/bus.js";
import { PreparationService } from "./control/preparation.js";
import { SubmissionManager } from "./control/submission.js";
import { HintManager } from "./control/hints.js";
import { ReflectionService } from "./control/reflection.js";
import { RecoveryManager } from "./control/recovery.js";
import { ModelRegistry } from "./control/registry.js";
import { ControlPlane } from "./control/control-plane.js";
import { buildApi } from "./api/routes.js";
import Fastify from "fastify";

function compileFlagPattern(raw: string | null | undefined): RegExp | null {
  if (!raw) return null;
  try {
    return new RegExp(raw);
  } catch (e) {
    throw new Error(`invalid submission.flagPattern: ${(e as Error).message}`);
  }
}

function resolveAgentRuntime(repos: ReturnType<typeof createRepositories>): "mock" | "pi" {
  const env = process.env.RIO_AGENT_RUNTIME;
  if (env === "mock" || env === "pi") return env;
  const hasProvider = repos.providers.list().some((p) => p.enabled);
  const hasModel = repos.models.listEnabled().length > 0;
  return hasProvider && hasModel ? "pi" : "mock";
}

export interface Runtime {
  config: RuntimeConfig;
  control: ControlPlane;
  repos: ReturnType<typeof createRepositories>;
  bus: EventBus;
  registry: ModelRegistry;
  close(): Promise<void>;
}

export async function startRuntime(opts: { configPath?: string; configOverrides?: Partial<RuntimeConfig>; skipApi?: boolean } = {}): Promise<Runtime> {
  const config = opts.configOverrides
    ? ({ ...loadConfig(opts.configPath), ...opts.configOverrides } as RuntimeConfig)
    : loadConfig(opts.configPath);
  const logger = createLogger(config.logLevel);
  logger.info({ event: "bootstrap", dataDir: config.paths.dataDir }, "starting rio-misc-agent");

  const dataDir = resolve(config.paths.dataDir);
  for (const sub of ["database", "workspaces", "sessions", "tool-results", "logs"]) {
    mkdirSync(join(dataDir, sub), { recursive: true });
  }

  const repos = createRepositories(join(dataDir, "database", "rio.sqlite"));
  const bus = new EventBus();

  // Master key for the encrypted secrets file (§56). Priority:
  // env CTF_RUNTIME_MASTER_KEY > data/.master_key (auto-generated, persisted)
  let masterKey = process.env.CTF_RUNTIME_MASTER_KEY ?? "";
  const masterKeyFile = join(dataDir, ".master_key");
  if (!masterKey) {
    try {
      masterKey = readFileSync(masterKeyFile, "utf8").trim();
    } catch {
      masterKey = randomBytes(32).toString("hex");
      try {
        writeFileSync(masterKeyFile, masterKey, { mode: 0o600 });
        logger.info({ event: "master_key_generated" }, "generated persistent master key at data/.master_key");
      } catch {
        logger.warn({ event: "master_key_write_failed" }, "could not persist master key — secrets will not survive restarts");
      }
    }
  }
  const secrets = new FileSecretStore(join(dataDir, "secrets.enc"), masterKey);
  // worker 子进程通过 env 继承 master key 以解密 API key
  process.env.CTF_RUNTIME_MASTER_KEY = masterKey;
  const workspacesRoot = join(dataDir, "workspaces");
  const sessionsRoot = join(dataDir, "sessions");
  const workspace = new WorkspaceManager(workspacesRoot);
  const disk = new DiskManager(workspacesRoot, {
    globalWorkspaceLimitGb: config.storage.globalWorkspaceLimitGb,
    reserveDiskGb: config.storage.reserveDiskGb,
    perChallengeSoftLimitGb: config.storage.perChallengeSoftLimitGb,
    maxConcurrentDownloads: config.storage.maxConcurrentDownloads,
  });

  // adapter
  let adapter: ContestAdapter;
  if (config.contest.adapter === "local" && config.contest.localChallengeDir) {
    adapter = new LocalContestAdapter(config.contest.localChallengeDir);
  } else if (config.contest.adapter === "mock") {
    const mock = new MockContestAdapter();
    mock.loadFixtures();
    adapter = mock;
  } else if (config.contest.adapter === "none") {
    adapter = new IdleContestAdapter();
  } else {
    throw new Error(`unsupported contest adapter: ${config.contest.adapter}`);
  }

  const stateMachine = new StateMachine(repos);
  const registry = new ModelRegistry(repos, secrets, logger);

  let control: ControlPlane | null = null;
  const inject = (challengeId: string, message: string) => {
    const ok = control?.injectWorker(challengeId, message) ?? false;
    if (!ok) logger.debug({ event: "inject_skipped", challengeId }, "no live worker — message not delivered");
  };

  const preparation = new PreparationService({
    repos,
    adapter,
    workspace,
    disk,
    stateMachine,
    bus,
    logger,
    dataDir,
    maxConcurrentDownloads: config.storage.maxConcurrentDownloads,
    pythonExecutable: "python",
  });

  const submission = new SubmissionManager({
    repos,
    adapter,
    stateMachine,
    bus,
    logger,
    autoSubmit: config.submission.autoSubmit,
    confidenceThreshold: config.submission.confidenceThreshold,
    localMaxWrong: config.submission.localMaxWrong,
    defaultCooldownMs: config.submission.defaultCooldownMs,
    flagPattern: compileFlagPattern(config.submission.flagPattern),
    inject,
    onAutoSubmitDisabled: (challengeId) => {
      bus.publish({ type: "AUTO_SUBMIT_DISABLED", challengeId, payload: { reason: "max wrong reached" } });
    },
    onCorrect: (challengeId) => {
      void control?.handleSubmissionCorrect(challengeId);
    },
  });

  const hints = new HintManager({
    repos,
    adapter,
    stateMachine,
    bus,
    logger,
    autoFetch: config.hint.autoFetch,
    requireStalled: config.hint.requireStalled,
    eligibleAfterStartMs: config.hint.eligibleAfterStartMs,
    stallThresholdMs: config.hint.stallThresholdMs,
    inject,
  });

  const reflection = new ReflectionService({ repos, bus, logger, inject });

  const recovery = new RecoveryManager({
    repos,
    stateMachine,
    bus,
    logger,
    submissionManager: submission,
    preparation,
  });

  control = new ControlPlane({
    repos,
    adapter,
    config,
    logger,
    bus,
    workspacesRoot,
    sessionsRoot,
    piDir: join(dataDir, "pi"),
    secretsFile: join(dataDir, "secrets.enc"),
    agentRuntime: resolveAgentRuntime(repos),
    stateMachine,
    preparation,
    submission,
    hints,
    reflection,
    registry,
    recovery,
  });

  await control.start();

  if (!repos.settings.get("startedAt")) repos.settings.set("startedAt", String(Date.now()));

  let api: Awaited<ReturnType<typeof buildApi>> | null = null;
  if (!opts.skipApi) {
    const fastify = Fastify({ logger: false });
    api = await buildApi({ fastify, control, repos, bus, registry, secrets, config, logger });
  }

  const shutdown = async (signal: string, exit = false) => {
    logger.info({ event: "shutdown", signal }, "graceful shutdown");
    await control!.stop();
    await api?.close();
    repos.db.close();
    logger.info({ event: "shutdown_complete" });
    if (exit) process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT", true));
  process.on("SIGTERM", () => void shutdown("SIGTERM", true));

  return {
    config,
    control,
    repos,
    bus,
    registry,
    close: () => shutdown("api"),
  };
}

// entrypoint when run directly (path may use backslashes on Windows)
const isDirectEntry =
  process.argv[1] !== undefined &&
  (process.argv[1].replaceAll("\\", "/").endsWith("apps/server/src/index.ts") ||
    process.argv[1].replaceAll("\\", "/").endsWith("apps/server/src/index.js"));

if (isDirectEntry) {
  startRuntime().catch((e) => {
    console.error("fatal:", e);
    process.exit(1);
  });
}
