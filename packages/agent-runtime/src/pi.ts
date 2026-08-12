/// <reference path="./pi-sdk.d.ts" />
// PiAgentRuntimeAdapter — wraps the Pi SDK (@earendil-works/pi-coding-agent)
// behind the AgentRuntimeAdapter. This file is the ONLY place that touches the
// Pi SDK (§4). The import is lazy: if the package is not installed, sessions
// fall back to the mock runtime and this adapter reports availability=false.
//
// NOTE: at the time of writing the package on the public npm registry is an
// empty placeholder, so this adapter is built against the documented SDK
// surface (createAgentSession / SessionManager / defineTool / subscribe /
// setModel / compact / abort). When the real package becomes installable,
// nothing outside this file needs to change.
import type { AgentRuntimeAdapter, SolverSessionConfig, SolverSessionHandle } from "./adapter.js";
import { toolNames } from "@rio/tool-runtime";

/** Minimal structural typing for the Pi SDK surface we use. */
interface PiSdk {
  createAgentSession(options: Record<string, unknown>): Promise<{ session: PiSession; extensionsResult?: unknown; modelFallbackMessage?: string }>;
  SessionManager: {
    inMemory(): unknown;
    create(cwd: string): unknown;
    open(path: string): unknown;
  };
  defineTool(def: Record<string, unknown>): unknown;
}

interface PiSession {
  prompt(text: string, options?: Record<string, unknown>): Promise<unknown>;
  subscribe(listener: (event: Record<string, unknown>) => void): () => void;
  setModel(model: string): Promise<void>;
  compact(): Promise<unknown>;
  abort(): Promise<unknown>;
  dispose(): Promise<unknown>;
}

class PiSessionHandle implements SolverSessionHandle {
  private usage_: { inputTokens: number; outputTokens: number; toolCalls: number } = { inputTokens: 0, outputTokens: 0, toolCalls: 0 };
  constructor(
    readonly sessionId: string,
    private piSession: PiSession,
  ) {}

  waitForIdle(): Promise<void> {
    return Promise.resolve();
  }

  usage() {
    return this.usage_;
  }

  recordUsage(input: number, output: number, calls: number) {
    this.usage_ = { inputTokens: input, outputTokens: output, toolCalls: calls };
  }
}

let cachedSdk: PiSdk | null | undefined;

async function loadSdk(): Promise<PiSdk | null> {
  if (cachedSdk !== undefined) return cachedSdk;
  try {
    const mod = await import("@earendil-works/pi-coding-agent");
    cachedSdk = mod as unknown as PiSdk;
    return cachedSdk;
  } catch {
    cachedSdk = null;
    return null;
  }
}

export class PiAgentRuntimeAdapter implements AgentRuntimeAdapter {
  readonly kind = "pi";
  private sdk: PiSdk;

  private constructor(sdk: PiSdk) {
    this.sdk = sdk;
  }

  /** Returns null when the Pi SDK is not installed. */
  static async available(): Promise<PiAgentRuntimeAdapter | null> {
    const sdk = await loadSdk();
    return sdk ? new PiAgentRuntimeAdapter(sdk) : null;
  }

  static isAvailable(): boolean {
    return cachedSdk !== null && cachedSdk !== undefined;
  }

  async createSolverSession(config: SolverSessionConfig): Promise<SolverSessionHandle> {
    const sessionManager = this.sdk.SessionManager.create(config.sessionDir);
    const { session } = await this.sdk.createAgentSession({
      sessionManager,
      cwd: config.cwd,
      model: config.modelRef?.modelId ?? undefined,
      customTools: this.#buildTools(config),
      systemPrompt: config.systemPrompt,
    });
    const handle = new PiSessionHandle(config.sessionId, session);
    session.subscribe((event) => this.#onEvent(event, handle, config));
    // initial message
    await session.prompt(config.initialMessage);
    return handle;
  }

  async resumeSolverSession(config: SolverSessionConfig): Promise<SolverSessionHandle> {
    // Sessions are JSONL files; open the one matching our solver session id.
    const file = `${config.sessionDir}/${config.sessionId}.jsonl`;
    const sessionManager = this.sdk.SessionManager.open(file);
    const { session } = await this.sdk.createAgentSession({
      sessionManager,
      cwd: config.cwd,
      model: config.modelRef?.modelId ?? undefined,
      customTools: this.#buildTools(config),
      systemPrompt: config.systemPrompt,
    });
    const handle = new PiSessionHandle(config.sessionId, session);
    session.subscribe((event) => this.#onEvent(event, handle, config));
    return handle;
  }

  async inject(session: SolverSessionHandle, message: string): Promise<void> {
    const h = session as PiSessionHandle;
    await h["piSession"].prompt(message);
  }

  async switchModel(session: SolverSessionHandle, modelRef: { providerId: string | null; modelId: string | null }): Promise<void> {
    if (!modelRef.modelId) return;
    const h = session as PiSessionHandle;
    await h["piSession"].setModel(modelRef.modelId);
  }

  async abort(session: SolverSessionHandle): Promise<void> {
    const h = session as PiSessionHandle;
    await h["piSession"].abort();
  }

  async compact(session: SolverSessionHandle): Promise<void> {
    const h = session as PiSessionHandle;
    await h["piSession"].compact();
  }

  /** Build Pi custom tools that delegate to our Tool Runtime. */
  #buildTools(config: SolverSessionConfig): unknown[] {
    const ctx = config.toolContext;
    return toolNames().map((name) =>
      this.sdk.defineTool({
        name,
        description: `Solver tool (${name}). Operates inside the challenge workspace only.`,
        parameters: { type: "object", properties: {}, additionalProperties: true },
        async execute(_toolCallId: string, params: Record<string, unknown>) {
          const { runTool } = await import("@rio/tool-runtime");
          const result = await runTool(ctx, name, params);
          return {
            content: [{ type: "text", text: result.ok ? result.summary : `ERROR: ${result.error?.message ?? result.summary}` }],
            details: { ok: result.ok, data: result.data ?? null, fullOutputPath: result.fullOutputPath ?? null, truncated: result.truncated ?? false },
          };
        },
      }),
    );
  }

  #onEvent(event: Record<string, unknown>, handle: PiSessionHandle, config: SolverSessionConfig): void {
    switch (event.type) {
      case "tool_execution_start":
        handle.recordUsage(handle.usage().inputTokens, handle.usage().outputTokens, handle.usage().toolCalls + 1);
        break;
      case "agent_end": {
        const messages = (event as { messages?: unknown[] }).messages ?? [];
        for (const m of messages) {
          const msg = m as { type?: string; usage?: { inputTokens?: number; outputTokens?: number } };
          if (msg.usage) {
            handle.recordUsage(
              handle.usage().inputTokens + (msg.usage.inputTokens ?? 0),
              handle.usage().outputTokens + (msg.usage.outputTokens ?? 0),
              handle.usage().toolCalls,
            );
          }
        }
        break;
      }
      case "agent_error":
      case "tool_execution_error":
        config.toolContext.emit("error", { challengeId: config.challengeId, sessionId: config.sessionId, message: String(event.error ?? "agent error") });
        break;
      default:
        break;
    }
  }
}
