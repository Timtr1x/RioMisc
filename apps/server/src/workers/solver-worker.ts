// Solver Worker entry (forked child process).
// Builds the ToolContext, wires IPC, runs the agent runtime (mock or Pi).
import { statSync } from "node:fs";
import { resolve, join } from "node:path";
import { sha256File } from "@rio/tool-runtime";
import {
  WorkspaceManager,
  toolNames,
  type ToolContext,
  type ArtifactRef,
} from "@rio/tool-runtime";
import { MockAgentRuntime, PiAgentRuntimeAdapter, type AgentRuntimeAdapter, type PiProviderSpec } from "@rio/agent-runtime";
import { FileVisionCache, HttpVisionAdapter, loadFileBudget, type VisionModelAdapter } from "@rio/visual-runtime";
import { FileSecretStore } from "@rio/shared";
import type { SolverType } from "@rio/domain";

interface StartConfig {
  challengeId: string;
  sessionId: string;
  solverType: SolverType;
  workspaceRoot: string;
  sessionDir: string;
  systemPrompt: string;
  initialMessage: string;
  modelRef: { providerId: string | null; modelId: string | null } | null;
  runtime: "mock" | "pi";
  resume?: boolean;
  persistedSession?: {
    piSessionId: string | null;
    piSessionFile: string | null;
  };
  pythonExecutable?: string;
  pi?: {
    piDir: string;
    secretsFile: string;
    providers: Omit<PiProviderSpec, "apiKey">[];
  };
  visual?: {
    maxVisionCalls: number;
    visionModelId?: string | null;
  };
}

let started = false;
let runtimeAdapter: AgentRuntimeAdapter | null = null;
let sessionHandle: Awaited<ReturnType<AgentRuntimeAdapter["createSolverSession"]>> | null = null;
let currentConfig: StartConfig | null = null;
let resultFileCounter = 0;

const parent = process as unknown as { send?: (msg: unknown) => void };

function send(msg: Record<string, unknown>): void {
  parent.send?.(msg);
}

async function selectRuntime(preferred: "mock" | "pi", config: StartConfig): Promise<AgentRuntimeAdapter> {
  const havePiSpecs = Boolean(config.pi && config.pi.providers.length > 0);
  // A configured provider+key always wins. Boot-time "mock" must not stick after the user adds a key.
  if (havePiSpecs || preferred === "pi") {
    if (!config.pi || config.pi.providers.length === 0) {
      throw new Error("Pi runtime requested but no providers configured");
    }
    const available = await PiAgentRuntimeAdapter.isAvailable();
    if (!available) {
      throw new Error("Pi runtime requested but @earendil-works/pi-coding-agent is unavailable");
    }
    const secrets = new FileSecretStore(config.pi.secretsFile, process.env.CTF_RUNTIME_MASTER_KEY);
    const providers: PiProviderSpec[] = [];
    for (const p of config.pi.providers) {
      const apiKey = await secrets.get(p.apiKeyRef);
      if (apiKey) providers.push({ ...p, apiKey });
    }
    if (providers.length === 0) {
      throw new Error("Pi runtime: no API keys resolvable from SecretStore — check the stored key / master key");
    }
    send({ type: "info", message: `using pi runtime (${providers.length} provider(s))` });
    return new PiAgentRuntimeAdapter(config.pi.piDir).withProviders(providers);
  }
  send({ type: "info", message: "using mock runtime" });
  return new MockAgentRuntime();
}

function pickVisionAdapter(config: StartConfig, providers: PiProviderSpec[]): VisionModelAdapter | null {
  const named = config.visual?.visionModelId;
  const spec =
    (named ? providers.find((p) => p.modelId === named && p.apiKey) : undefined) ??
    providers.find((p) => p.vision && p.apiKey);
  if (!spec) return null;
  const cacheDir = join(resolve(config.workspaceRoot), "state", "vision-cache");
  const budgetPath = join(resolve(config.workspaceRoot), "state", "vision-budget.json");
  return new HttpVisionAdapter({
    baseUrl: spec.baseUrl,
    apiKey: spec.apiKey,
    modelId: spec.modelId,
    protocol: spec.protocol,
    cache: new FileVisionCache(cacheDir),
    budget: loadFileBudget(budgetPath, config.visual?.maxVisionCalls ?? 5),
  });
}

function buildToolContext(config: StartConfig, vision?: VisionModelAdapter | null): ToolContext {
  const wm = new WorkspaceManager(resolve(config.workspaceRoot, ".."));
  const root = resolve(config.workspaceRoot);
  return {
    challengeId: config.challengeId,
    workspace: {
      root,
      input: resolve(root, "input"),
      work: resolve(root, "work"),
      artifacts: resolve(root, "artifacts"),
      results: resolve(root, "results"),
      state: resolve(root, "state"),
      agent: resolve(root, "agent"),
      tmp: resolve(root, "tmp"),
    },
    sessionId: config.sessionId,
    safeResolve: (p: string) => wm.safeResolve(root, p),
    emit: (kind, payload) => send({ type: kind, ...payload }),
    recordArtifact: (op: string, absPath: string, parent?: string | null): ArtifactRef | null => {
      try {
        const st = statSync(absPath);
        const sha = sha256File(absPath);
        send({
          type: "artifact",
          challengeId: config.challengeId,
          sessionId: config.sessionId,
          op,
          absPath,
          parent,
          size: st.size,
          sha256: sha,
        });
        return { path: absPath.replaceAll("\\", "/"), size: st.size, sha256: sha };
      } catch {
        return null;
      }
    },
    nextResultFile: () => {
      resultFileCounter += 1;
      return join(root, "results", `tool-${String(resultFileCounter).padStart(4, "0")}.txt`);
    },
    pythonExecutable: config.pythonExecutable || process.env.RIO_PYTHON || "python",
    networkIsolation: "NONE",
    vision: vision ?? null,
    maxVisionCalls: config.visual?.maxVisionCalls ?? 5,
    experiments: (() => {
      const map = new Map<string, { summary: string; outcome: string }>();
      return {
        lookup: (key: string) => map.get(key) ?? null,
        record: (e: { key: string; summary: string; outcome: string }) => {
          map.set(e.key, { summary: e.summary, outcome: e.outcome });
        },
      };
    })(),
  };
}

process.on("uncaughtException", (e) => {
  console.error("[worker-uncaught]", e);
});
process.on("unhandledRejection", (e) => {
  console.error("[worker-unhandled]", e);
});
process.on("message", async (msg: { type: string; [k: string]: unknown }) => {
  if (started && msg.type !== "start") {
    // runtime commands
    if (msg.type === "inject" && sessionHandle && currentConfig) {
      await runtimeAdapter?.inject(sessionHandle, String(msg.message ?? ""));
    } else if (msg.type === "switch_model" && sessionHandle) {
      try {
        await runtimeAdapter?.switchModel(sessionHandle, (msg.modelRef ?? null) as never);
      } catch (e) {
        send({ type: "error", message: e instanceof Error ? e.message : String(e) });
      }
    } else if (msg.type === "abort") {
      if (sessionHandle && runtimeAdapter) {
        try {
          await runtimeAdapter.abort(sessionHandle);
        } catch {
          /* shutting down */
        }
      }
      process.exit(0);
    } else if (msg.type === "ping") {
      send({ type: "pong", t: Date.now() });
    }
    return;
  }
  if (msg.type === "ping") {
    send({ type: "pong", t: Date.now() });
    return;
  }
  if (msg.type === "start") {
    currentConfig = msg.config as StartConfig;
    started = true;
    // ready 立即发送（进程就绪）；创建 session + 首次模型调用很慢（Pi 加载 SDK、
    // 模型思考），必须在后台执行，否则控制平面以为启动超时。
    send({ type: "ready", sessionId: currentConfig.sessionId });
    void (async () => {
      try {
        runtimeAdapter = await selectRuntime(currentConfig.runtime, currentConfig);
        let vision: VisionModelAdapter | null = null;
        if (currentConfig.pi && currentConfig.pi.providers.length > 0) {
          const secrets = new FileSecretStore(currentConfig.pi.secretsFile, process.env.CTF_RUNTIME_MASTER_KEY);
          const decrypted: PiProviderSpec[] = [];
          for (const p of currentConfig.pi.providers) {
            const apiKey = await secrets.get(p.apiKeyRef);
            if (apiKey) decrypted.push({ ...p, apiKey });
          }
          vision = pickVisionAdapter(currentConfig, decrypted);
        }
        const ctx = buildToolContext(currentConfig, vision);
        const tools = toolNames().map((name) => ({ name, description: `Solver tool ${name}` }));
        const sessionConfig = {
          sessionId: currentConfig.sessionId,
          challengeId: currentConfig.challengeId,
          solverType: currentConfig.solverType,
          cwd: ctx.workspace.work,
          workspaceRoot: ctx.workspace.root,
          sessionDir: currentConfig.sessionDir,
          systemPrompt: currentConfig.systemPrompt,
          initialMessage: currentConfig.initialMessage,
          modelRef: currentConfig.modelRef,
          tools,
          toolContext: ctx,
          persistedSession: currentConfig.persistedSession,
        };
        sessionHandle = currentConfig.resume
          ? await runtimeAdapter.resumeSolverSession(sessionConfig)
          : await runtimeAdapter.createSolverSession(sessionConfig);
        const persisted = sessionHandle.persistence();
        send({
          type: "session_persisted",
          challengeId: currentConfig.challengeId,
          sessionId: currentConfig.sessionId,
          piSessionId: persisted.externalSessionId,
          piSessionFile: persisted.sessionFile,
        });
        await sessionHandle.waitForIdle();
        const usage = sessionHandle.usage();
        send({ type: "idle", challengeId: currentConfig.challengeId, sessionId: currentConfig.sessionId, usage });
      } catch (e) {
        send({ type: "error", challengeId: currentConfig.challengeId, sessionId: currentConfig.sessionId, message: String(e) });
        process.exit(1);
      }
    })();
  }
});
