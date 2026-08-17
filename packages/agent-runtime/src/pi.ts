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
import { TOOL_IMPLS, runTool, formatToolResultForModel, type ToolContext } from "@rio/tool-runtime";
import type { ModelRef } from "@rio/domain";
import type { AgentRuntimeAdapter, PiProviderSpec, SolverSessionConfig, SolverSessionHandle } from "./adapter.js";
import { compatFlagsFor, resolveCompatProfile, selectPiProvider } from "./compat.js";
import type { AgentSession, ToolDefinition } from "@earendil-works/pi-coding-agent";

const API_MAP: Record<PiProviderSpec["protocol"], string> = {
  OPENAI_CHAT_COMPLETIONS: "openai-completions",
  OPENAI_RESPONSES: "openai-responses",
  ANTHROPIC_MESSAGES: "anthropic-messages",
};

export function buildPiModelsDocument(specs: PiProviderSpec[]): {
  providers: Record<
    string,
    {
      name: string;
      baseUrl: string;
      api: string;
      compat: ReturnType<typeof compatFlagsFor>;
      models: { id: string; reasoning: boolean; contextWindow: number; maxTokens: number }[];
    }
  >;
} {
  const providers: Record<
    string,
    {
      name: string;
      baseUrl: string;
      api: string;
      compat: ReturnType<typeof compatFlagsFor>;
      models: { id: string; reasoning: boolean; contextWindow: number; maxTokens: number }[];
    }
  > = {};
  for (const spec of specs) {
    const profile = resolveCompatProfile(spec.compatProfile ?? "AUTO", spec);
    const model = {
      id: spec.modelId,
      reasoning: profile === "DEEPSEEK" || profile === "ZAI",
      contextWindow: spec.contextWindow,
      maxTokens: spec.maxOutputTokens,
    };
    const existing = providers[spec.id];
    if (!existing) {
      providers[spec.id] = {
        name: spec.displayName,
        baseUrl: spec.baseUrl,
        api: API_MAP[spec.protocol],
        compat: compatFlagsFor(profile),
        models: [model],
      };
    } else if (!existing.models.some((m) => m.id === spec.modelId)) {
      existing.models.push(model);
    }
  }
  return { providers };
}

export function resolveModelOnRuntime(
  runtime: SessionModelRuntime,
  spec: { id: string; modelId: string },
): unknown {
  const model = runtime.getModel(spec.id, spec.modelId);
  if (!model) {
    throw new Error(`Pi runtime: model ${spec.modelId} not found in current session runtime`);
  }
  return model;
}

/** Lazy SDK handle — the heavy package loads on first real use. */
let sdkPromise: Promise<typeof import("@earendil-works/pi-coding-agent")> | null = null;
function getSdk(): Promise<typeof import("@earendil-works/pi-coding-agent")> {
  if (!sdkPromise) sdkPromise = import("@earendil-works/pi-coding-agent");
  return sdkPromise;
}

/** Session-owned runtime: switchModel must reuse this, never ModelRuntime.create. */
export interface SessionModelRuntime {
  getModel(providerId: string, modelId: string): unknown;
}

class PiSessionHandle implements SolverSessionHandle {
  usage_ = { inputTokens: 0, outputTokens: 0, toolCalls: 0 };
  constructor(
    readonly sessionId: string,
    readonly piSession: AgentSession,
    readonly modelRuntime: SessionModelRuntime,
    readonly providers: PiProviderSpec[],
  ) {}

  waitForIdle(): Promise<void> {
    return this.piSession.waitForIdle();
  }

  usage() {
    return this.usage_;
  }

  persistence() {
    return {
      externalSessionId: this.piSession.sessionId ?? null,
      sessionFile: this.piSession.sessionFile ?? null,
    };
  }
}

function toSummary(result: Awaited<ReturnType<typeof runTool>>): string {
  return formatToolResultForModel(result);
}

type TBox = typeof import("typebox").Type;

/** Real JSON-schema parameters so the model knows field names (not Type.Record Any). */
function toolParameterSchema(Type: TBox, name: string) {
  const evidence = Type.Optional(
    Type.Array(
      Type.Object({
        type: Type.Union([
          Type.Literal("artifact"),
          Type.Literal("script"),
          Type.Literal("tool_output"),
          Type.Literal("reason"),
        ]),
        path: Type.Optional(Type.String()),
        text: Type.Optional(Type.String()),
      }),
    ),
  );
  switch (name) {
    case "read_challenge_file":
      return Type.Object({
        path: Type.String({ description: "Workspace-relative path, e.g. challenge.txt or input/task.zip" }),
        maxChars: Type.Optional(Type.Number()),
      });
    case "list_workspace":
      return Type.Object({
        path: Type.Optional(Type.String({ description: "Directory relative to workspace root. Omit or '.' for root." })),
      });
    case "write_work_file":
      return Type.Object({
        path: Type.String({ description: "File to write. Bare names go under work/ (solve.py → work/solve.py)." }),
        content: Type.String(),
      });
    case "inspect_file":
      return Type.Object({ path: Type.String({ description: "e.g. input/task.zip" }) });
    case "extract_archive":
      return Type.Object({
        path: Type.String({ description: "Archive path, e.g. input/task.zip" }),
        destPath: Type.Optional(Type.String({ description: "Default artifacts/extracted" })),
        maxDepth: Type.Optional(Type.Number()),
      });
    case "run_python":
      return Type.Object({
        code: Type.Optional(Type.String({ description: "Inline snippet. cwd is workspace root." })),
        scriptPath: Type.Optional(Type.String({ description: "Prefer work/solve.py" })),
        args: Type.Optional(Type.Array(Type.String())),
        timeoutMs: Type.Optional(Type.Number()),
      });
    case "search_tool_output":
      return Type.Object({
        path: Type.String(),
        query: Type.String(),
        maxMatches: Type.Optional(Type.Number()),
      });
    case "read_tool_output_chunk":
      return Type.Object({
        path: Type.String(),
        offset: Type.Optional(Type.Number()),
        maxChars: Type.Optional(Type.Number()),
      });
    case "report_progress":
      return Type.Object({
        summary: Type.String(),
        confidence: Type.Number({ description: "0..1" }),
        hypotheses: Type.Optional(Type.Array(Type.String())),
        confirmedFacts: Type.Optional(Type.Array(Type.String())),
        rejectedHypotheses: Type.Optional(Type.Array(Type.String())),
        nextActions: Type.Optional(Type.Array(Type.String())),
        progress: Type.Optional(Type.Union([Type.Literal("SIGNIFICANT"), Type.Literal("MINOR"), Type.Literal("NONE")])),
        stalled: Type.Optional(Type.Boolean()),
      });
    case "submit_flag_candidate":
      return Type.Object({
        value: Type.String({ description: "The flag, usually flag{...}" }),
        confidence: Type.Number({ description: "0..1, auto-submit at >= 0.85" }),
        reason: Type.String({ description: "How you derived it" }),
        evidence,
      });
    case "request_handoff":
      return Type.Object({
        target: Type.Union([Type.Literal("MISC"), Type.Literal("CRYPTO")]),
        summary: Type.String(),
      });
    case "request_reflection":
      return Type.Object({ reason: Type.String() });
    case "analyze_visual":
      return Type.Object({
        path: Type.String({ description: "Workspace-relative image, e.g. input/challenge.png" }),
        question: Type.Optional(Type.String({ description: "What to look for. Do not ask to 'describe the image'." })),
        mode: Type.Optional(Type.Union([Type.Literal("AUTO"), Type.Literal("LOCAL_ONLY"), Type.Literal("VISION_MODEL")])),
        force: Type.Optional(Type.Boolean()),
      });
    case "request_visual_review":
      return Type.Object({
        path: Type.String(),
        question: Type.String({ description: "Specific question for the human" }),
        reason: Type.String({ description: "Why local/vision tools are not enough" }),
      });
    case "render_spectrogram":
      return Type.Object({
        path: Type.String({ description: "WAV path, e.g. input/secret.wav" }),
        mode: Type.Optional(Type.Union([Type.Literal("AUTO"), Type.Literal("WIDE"), Type.Literal("DETAIL")])),
        maxDurationSeconds: Type.Optional(Type.Number()),
      });
    case "extract_keyframes":
      return Type.Object({
        path: Type.String(),
        strategy: Type.Optional(Type.Union([Type.Literal("UNIFORM"), Type.Literal("SCENE_CHANGE"), Type.Literal("ALL_IF_SMALL")])),
        maxFrames: Type.Optional(Type.Number()),
      });
    case "render_transform":
      return Type.Object({
        path: Type.String(),
        op: Type.Union([
          Type.Literal("grayscale"),
          Type.Literal("invert"),
          Type.Literal("autocontrast"),
          Type.Literal("threshold"),
          Type.Literal("rotate90"),
          Type.Literal("rotate180"),
          Type.Literal("rotate270"),
        ]),
      });
    case "extract_bitplane":
      return Type.Object({
        path: Type.String(),
        channel: Type.Union([Type.Number(), Type.String()]),
        bit: Type.Number(),
      });
    case "extract_visible_text":
      return Type.Object({ path: Type.String() });
    case "record_hypothesis":
      return Type.Object({
        description: Type.String(),
        confidence: Type.Optional(Type.Number()),
        status: Type.Optional(Type.String()),
      });
    default:
      return Type.Object({});
  }
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
    const specs = this.providers.length > 0 ? this.providers : (config.piProviders ?? []);
    const spec = this.#pickProvider(config);
    const modelRuntime = await this.#buildModelRuntime(specs);
    const model = resolveModelOnRuntime(modelRuntime, spec) as Parameters<AgentSession["setModel"]>[0];
    const persistedFile = config.persistedSession?.piSessionFile;
    const sessionManager = resume && persistedFile
      ? SessionManager.open(persistedFile, config.sessionDir, config.cwd)
      : SessionManager.create(config.cwd, config.sessionDir);

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
      thinkingLevel: "high",
      sessionManager,
      resourceLoader: loader,
      customTools: tools,
      noTools: "builtin", // disable read/bash/edit/write — our tools only (§45)
    });

    const handle = new PiSessionHandle(config.sessionId, session, modelRuntime, specs);
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
    if (!modelRef?.modelId) throw new Error("switchModel requires modelId");
    if (!h.modelRuntime) throw new Error("switchModel: session has no ModelRuntime");
    const specs = h.providers?.length ? h.providers : this.providers;
    const spec = this.#pickProvider({ modelRef, piProviders: specs } as SolverSessionConfig);
    const model = resolveModelOnRuntime(h.modelRuntime, spec);
    await h.piSession.setModel(model as Parameters<AgentSession["setModel"]>[0]);
  }

  async abort(session: SolverSessionHandle): Promise<void> {
    const h = session as PiSessionHandle;
    if (!h?.piSession) return;
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
    return selectPiProvider(providers, config.modelRef?.modelId);
  }

  async #buildModelRuntime(specs: PiProviderSpec[]) {
    if (specs.length === 0) {
      throw new Error("Pi runtime: no model providers configured. Add one via Dashboard/CLI first.");
    }
    const { ModelRuntime } = await getSdk();
    mkdirSync(this.piDir, { recursive: true });
    const modelsPath = join(this.piDir, "models.json");
    writeFileSync(modelsPath, JSON.stringify(buildPiModelsDocument(specs), null, 2), "utf8");

    const modelRuntime = await ModelRuntime.create({
      modelsPath,
      authPath: join(this.piDir, "auth.json"),
      refreshOnCreate: false,
    });
    const seen = new Set<string>();
    for (const spec of specs) {
      if (seen.has(spec.id)) continue;
      seen.add(spec.id);
      await modelRuntime.setRuntimeApiKey(spec.id, spec.apiKey);
    }
    return modelRuntime;
  }

  async #buildTools(ctx: ToolContext): Promise<ToolDefinition[]> {
    const { defineTool, Type } = await this.#sdkWithTypebox();
    return TOOL_IMPLS.map((impl) =>
      defineTool({
        name: impl.name,
        label: impl.name,
        description: `${impl.description} Operates inside the challenge workspace only.`,
        parameters: toolParameterSchema(Type, impl.name),
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
