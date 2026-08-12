// Solver Worker entry (forked child process).
// Builds the ToolContext, wires IPC, runs the agent runtime (mock or Pi).
import { readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, join } from "node:path";
import {
  WorkspaceManager,
  toolNames,
  type ToolContext,
  type ArtifactRef,
} from "@rio/tool-runtime";
import { MockAgentRuntime, PiAgentRuntimeAdapter, type AgentRuntimeAdapter, type PiProviderSpec } from "@rio/agent-runtime";
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
  pi?: {
    piDir: string;
    secretsFile: string;
    providers: Omit<PiProviderSpec, "apiKey">[];
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
  if (preferred === "pi") {
    const available = await PiAgentRuntimeAdapter.isAvailable();
    if (available && config.pi && config.pi.providers.length > 0) {
      // decrypt API keys from the encrypted secrets file (never over IPC)
      const secrets = new FileSecretStore(config.pi.secretsFile, process.env.CTF_RUNTIME_MASTER_KEY);
      const providers: PiProviderSpec[] = [];
      for (const p of config.pi.providers) {
        const apiKey = await secrets.get(p.apiKeyRef);
        if (apiKey) providers.push({ ...p, apiKey });
      }
      if (providers.length > 0) {
        send({ type: "info", message: `using pi runtime (${providers.length} provider(s))` });
        return new PiAgentRuntimeAdapter(config.pi.piDir).withProviders(providers);
      }
      send({ type: "info", message: "pi runtime: no API keys resolvable — falling back to mock" });
    } else {
      send({ type: "info", message: "pi runtime requested but SDK/providers unavailable — falling back to mock" });
    }
  }
  send({ type: "info", message: "using mock runtime" });
  return new MockAgentRuntime();
}

function buildToolContext(config: StartConfig): ToolContext {
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
        const sha = createHash("sha256").update(readFileSync(absPath)).digest("hex");
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
    pythonExecutable: process.env.RIO_PYTHON ?? "python",
    allowNetwork: false,
  };
}

process.on("message", async (msg: { type: string; [k: string]: unknown }) => {
  if (started && msg.type !== "start") {
    // runtime commands
    if (msg.type === "inject" && sessionHandle && currentConfig) {
      await runtimeAdapter?.inject(sessionHandle, String(msg.message ?? ""));
    } else if (msg.type === "switch_model" && sessionHandle) {
      await runtimeAdapter?.switchModel(sessionHandle, (msg.modelRef ?? null) as never);
    } else if (msg.type === "abort") {
      await runtimeAdapter?.abort(sessionHandle!);
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
    try {
      runtimeAdapter = await selectRuntime(currentConfig.runtime, currentConfig);
      const ctx = buildToolContext(currentConfig);
      const tools = toolNames().map((name) => ({ name, description: `Solver tool ${name}` }));
      sessionHandle = await runtimeAdapter.createSolverSession({
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
      });
      send({ type: "ready", sessionId: currentConfig.sessionId });
      await sessionHandle.waitForIdle();
      const usage = sessionHandle.usage();
      send({ type: "idle", challengeId: currentConfig.challengeId, sessionId: currentConfig.sessionId, usage });
    } catch (e) {
      send({ type: "error", challengeId: currentConfig.challengeId, sessionId: currentConfig.sessionId, message: String(e) });
      process.exit(1);
    }
  }
});
