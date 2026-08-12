/// PiAgentRuntimeAdapter — wraps the real Pi SDK (@earendil-works/pi-coding-agent).
/// This file is the ONLY place that touches the Pi SDK (§4).
///
/// The SDK is loaded LAZILY: mock-runtime workers never import the 160MB
/// package, keeping worker startup fast. `import type` is erased at compile
/// time and does not trigger a runtime load.
///
/// Provider mapping: our registry (DB + encrypted SecretStore) → models.json
/// (data/pi/models.json) + ModelRuntime.setRuntimeApiKey() runtime overrides,
/// so API keys never land in plaintext on disk (§56).
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TOOL_IMPLS, runTool, type ToolContext } from "@rio/tool-runtime";
import type { ModelRef } from "@rio/domain";
import type { AgentRuntimeAdapter, PiProviderSpec, SolverSessionConfig, SolverSessionHandle } from "./adapter.js";
import type { AgentSession, ToolDefinition } from "@earendil-works/pi-coding-agent";

const API_MAP: Record<PiProviderSpec["protocol"], string> = {
  OPENAI_CHAT_COMPLETIONS: "openai-completions",
  OPENAI_RESPONSES: "openai-responses",
  ANTHROPIC_MESSAGES: "anthropic-messages",
};

/** Lazy SDK handle — the heavy package loads on first real use. */
let sdkPromise: Promise<typeof import("@earendil-works/pi-coding-agent")> | null = null;
function getSdk(): Promise<typeof import("@earendil-works/pi-coding-agent")> {
  if (!sdkPromise) sdkPromise = import("@earendil-works/pi-coding-agent");
  return sdkPromise;
}

class PiSessionHandle implements SolverSessionHandle {
  usage_ = { inputTokens: 0, outputTokens: 0, toolCalls: 0 };
  constructor(
    readonly sessionId: string,
    readonly piSession: AgentSession,
  ) {}

  waitForIdle(): Promise<void> {
    return this.piSession.waitForIdle();
  }

  usage() {
    return this.usage_;
  }
}

function toSummary(result: Awaited<ReturnType<typeof runTool>>): string {
  if (result.ok) {
    const out = result.summary;
    return out.length > 600 ? out.slice(0, 600) + "…" : out;
  }
  return `ERROR: ${result.error?.message ?? result.summary}`;
}

export class PiAgentRuntimeAdapter implements AgentRuntimeAdapter {
  readonly kind = "pi";

  /** SDK is installed and loadable. */
  static async isAvailable(): Promise<boolean> {
    try {
      await getSdk();
      return true;
    } catch {
      return false;
    }
  }

  constructor(private piDir: string) {}

  private providers: PiProviderSpec[] = [];

  /** Worker-side: attach decrypted provider specs before creating sessions. */
  withProviders(providers: PiProviderSpec[]): this {
    this.providers = providers;
    return this;
  }

  async createSolverSession(config: SolverSessionConfig): Promise<SolverSessionHandle> {
    return this.#create(config, false);
  }

  async resumeSolverSession(config: SolverSessionConfig): Promise<SolverSessionHandle> {
    return this.#create(config, true);
  }

  async #create(config: SolverSessionConfig, resume: boolean): Promise<PiSessionHandle> {
    const { createAgentSession, DefaultResourceLoader, SessionManager } = await getSdk();
    const spec = this.#pickProvider(config);
    const { modelRuntime, model } = await this.#buildModelRuntime(spec);
    const sessionManager = resume
      ? SessionManager.open(this.#sessionFile(config.sessionId, config.sessionDir))
      : SessionManager.create(config.sessionDir);

    const loader = new DefaultResourceLoader({
      cwd: config.cwd,
      agentDir: this.piDir,
      systemPromptOverride: () => config.systemPrompt,
      appendSystemPromptOverride: () => [],
    });
    await loader.reload();

    const tools = await this.#buildTools(config.toolContext);
    const { session } = await createAgentSession({
      cwd: config.cwd,
      agentDir: this.piDir,
      modelRuntime,
      model,
      thinkingLevel: "medium",
      sessionManager,
      resourceLoader: loader,
      customTools: tools,
      noTools: "builtin", // disable read/bash/edit/write — our tools only (§45)
    });

    const handle = new PiSessionHandle(config.sessionId, session);
    session.subscribe((event) => this.#onEvent(event, handle, config));
    await session.prompt(config.initialMessage);
    return handle;
  }

  async inject(session: SolverSessionHandle, message: string): Promise<void> {
    const h = session as PiSessionHandle;
    await h.piSession.prompt(message);
  }

  async switchModel(session: SolverSessionHandle, modelRef: ModelRef): Promise<void> {
    const h = session as PiSessionHandle;
    if (!modelRef.modelId) return;
    const { ModelRuntime } = await getSdk();
    const runtime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false });
    const model = runtime.getModel("*", modelRef.modelId);
    if (model) await h.piSession.setModel(model);
  }

  async abort(session: SolverSessionHandle): Promise<void> {
    const h = session as PiSessionHandle;
    await h.piSession.abort();
  }

  async compact(session: SolverSessionHandle): Promise<void> {
    const h = session as PiSessionHandle;
    await h.piSession.compact();
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  #pickProvider(config: SolverSessionConfig): PiProviderSpec {
    const providers = this.providers.length > 0 ? this.providers : (config.piProviders ?? []);
    if (providers.length === 0) {
      throw new Error("Pi runtime: no model providers configured. Add one via Dashboard/CLI first.");
    }
    const preferred = config.modelRef?.modelId;
    return (preferred ? providers.find((p) => p.modelId === preferred) : undefined) ?? providers[0]!;
  }

  #sessionFile(sessionId: string, sessionDir: string): string {
    return join(sessionDir, `${sessionId}.jsonl`);
  }

  async #buildModelRuntime(spec: PiProviderSpec) {
    const { ModelRuntime } = await getSdk();
    mkdirSync(this.piDir, { recursive: true });
    const modelsPath = join(this.piDir, "models.json");
    writeFileSync(
      modelsPath,
      JSON.stringify(
        {
          providers: {
            [spec.id]: {
              name: spec.displayName,
              baseUrl: spec.baseUrl,
              api: API_MAP[spec.protocol],
              compat: { supportsDeveloperRole: false },
              models: [
                {
                  id: spec.modelId,
                  contextWindow: spec.contextWindow,
                  maxTokens: spec.maxOutputTokens,
                },
              ],
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const modelRuntime = await ModelRuntime.create({
      modelsPath,
      authPath: join(this.piDir, "auth.json"),
      refreshOnCreate: false,
    });
    await modelRuntime.setRuntimeApiKey(spec.id, spec.apiKey);
    const model = modelRuntime.getModel(spec.id, spec.modelId);
    if (!model) {
      throw new Error(`Pi runtime: model ${spec.modelId} not found in provider ${spec.id}`);
    }
    return { modelRuntime, model };
  }

  async #buildTools(ctx: ToolContext): Promise<ToolDefinition[]> {
    const { defineTool, Type } = await this.#sdkWithTypebox();
    return TOOL_IMPLS.map((impl) =>
      defineTool({
        name: impl.name,
        label: impl.name,
        description: `${impl.description} Operates inside the challenge workspace only.`,
        parameters: Type.Record(Type.String(), Type.Any()),
        promptSnippet: impl.name,
        async execute(_toolCallId: string, params: Record<string, unknown>) {
          const result = await runTool(ctx, impl.name, params);
          const text = toSummary(result);
          return {
            content: [{ type: "text", text }],
            details: {
              ok: result.ok,
              data: result.data ?? null,
              fullOutputPath: result.fullOutputPath ?? null,
              truncated: result.truncated ?? false,
              artifacts: result.artifacts ?? [],
              error: result.error ?? null,
            },
          };
        },
      }),
    );
  }

  async #sdkWithTypebox(): Promise<{ defineTool: (typeof import("@earendil-works/pi-coding-agent"))["defineTool"]; Type: typeof import("typebox").Type }> {
    const sdk = await getSdk();
    const { Type } = await import("typebox");
    return { defineTool: sdk.defineTool, Type };
  }

  #onEvent(event: unknown, handle: PiSessionHandle, config: SolverSessionConfig): void {
    const e = event as { type: string; usage?: { inputTokens?: number; outputTokens?: number }; error?: unknown };
    switch (e.type) {
      case "tool_execution_start":
        handle.usage_.toolCalls += 1;
        break;
      case "message_end":
        if (e.usage) {
          handle.usage_.inputTokens += e.usage.inputTokens ?? 0;
          handle.usage_.outputTokens += e.usage.outputTokens ?? 0;
        }
        break;
      case "agent_error":
      case "tool_execution_error":
        config.toolContext.emit("error", {
          challengeId: config.challengeId,
          sessionId: config.sessionId,
          message: String(e.error ?? "pi agent error"),
        });
        break;
      default:
        break;
    }
  }
}
