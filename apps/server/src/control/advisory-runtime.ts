// Stateless structured-output caller for Manager + Reflector.
// No workspace, no tools, no long-lived session.
import { z, type ZodType } from "zod";
import type { ModelConfig, ModelProviderConfig } from "@rio/domain";
import type { Repositories } from "@rio/database";
import { resolveChatEndpoint, type RioLogger, type SecretStore } from "@rio/shared";
import { isModelUsable, loadModelAssignments } from "./model-assignments.js";

export type AdvisoryTask = "MANAGER" | "REFLECTION";

export interface AdvisoryError {
  code: string;
  message: string;
  retryable: boolean;
}

export interface AdvisoryResult<T> {
  ok: boolean;
  value?: T;
  modelId: string;
  providerId: string;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  error?: AdvisoryError;
}

export interface AdvisoryRunInput<T> {
  model?: { providerId: string | null; modelId: string | null };
  systemPrompt: string;
  userPrompt: string;
  schema: ZodType<T>;
  timeoutMs: number;
  task: AdvisoryTask;
}

export type AdvisoryFn = <T>(input: AdvisoryRunInput<T>) => Promise<AdvisoryResult<T>>;

export interface AdvisoryAgentRuntime {
  runStructured<T>(input: AdvisoryRunInput<T>): Promise<AdvisoryResult<T>>;
}

const REPAIR_PROMPT = `Your previous response did not match the required JSON schema.

Return ONLY a corrected JSON object.
Do not add markdown or explanation.`;

export function resolveAdvisoryModel(repos: Repositories, task: AdvisoryTask): ModelConfig | null {
  const a = loadModelAssignments(repos);
  const preferred = task === "MANAGER" ? a.managerModelId : a.reflectionModelId;
  if (preferred) {
    const m = repos.models.get(preferred);
    if (isModelUsable(repos, m)) return m;
  }
  if (a.primarySolverModelId) {
    const m = repos.models.get(a.primarySolverModelId);
    if (isModelUsable(repos, m)) return m;
  }
  const primary = repos.models.primary();
  if (isModelUsable(repos, primary)) return primary;
  return repos.models.listEnabled()[0] ?? null;
}

export function extractJsonObject(raw: string): unknown {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = (fenced?.[1] ?? trimmed).trim();
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("no JSON object in model output");
  return JSON.parse(body.slice(start, end + 1));
}

export function parseStructuredWithRepair<T>(
  raw: string,
  schema: ZodType<T>,
): { value: T } | { error: string } {
  try {
    return { value: schema.parse(extractJsonObject(raw)) };
  } catch (e) {
    return { error: e instanceof z.ZodError ? e.issues.map((i) => i.message).join("; ") : (e as Error).message };
  }
}

export class HttpAdvisoryRuntime implements AdvisoryAgentRuntime {
  constructor(
    private deps: {
      repos: Repositories;
      secrets?: SecretStore | null;
      logger: RioLogger;
      fetchImpl?: typeof fetch;
      /** Test / canned override. When set, HTTP is never used. */
      run?: AdvisoryFn;
    },
  ) {}

  async runStructured<T>(input: AdvisoryRunInput<T>): Promise<AdvisoryResult<T>> {
    if (this.deps.run) return this.deps.run(input);
    const started = Date.now();
    const model = resolveAdvisoryModel(this.deps.repos, input.task);
    if (!model) {
      return {
        ok: false,
        modelId: "",
        providerId: "",
        durationMs: Date.now() - started,
        inputTokens: 0,
        outputTokens: 0,
        error: { code: "MODEL_UNAVAILABLE", message: "no usable advisory model", retryable: false },
      };
    }
    const provider = this.deps.repos.providers.get(model.providerId);
    if (!provider) {
      return {
        ok: false,
        modelId: model.modelName,
        providerId: model.providerId,
        durationMs: Date.now() - started,
        inputTokens: 0,
        outputTokens: 0,
        error: { code: "MODEL_UNAVAILABLE", message: "provider missing", retryable: false },
      };
    }
    const apiKey = this.deps.secrets ? await this.deps.secrets.get(provider.apiKeyRef) : null;
    if (!apiKey) {
      return {
        ok: false,
        modelId: model.modelName,
        providerId: provider.id,
        durationMs: Date.now() - started,
        inputTokens: 0,
        outputTokens: 0,
        error: { code: "MODEL_UNAVAILABLE", message: "no stored API key", retryable: false },
      };
    }

    const call = async (messages: { role: string; content: string }[]) =>
      this.#chat(provider, apiKey, model, messages, input.timeoutMs);

    try {
      const first = await call([
        { role: "system", content: input.systemPrompt },
        { role: "user", content: input.userPrompt },
      ]);
      const parsed = parseStructuredWithRepair(first.text, input.schema);
      if ("value" in parsed) {
        return {
          ok: true,
          value: parsed.value,
          modelId: model.modelName,
          providerId: provider.id,
          durationMs: Date.now() - started,
          inputTokens: first.inputTokens,
          outputTokens: first.outputTokens,
        };
      }
      const repaired = await call([
        { role: "system", content: input.systemPrompt },
        { role: "user", content: input.userPrompt },
        { role: "assistant", content: first.text.slice(0, 4000) },
        { role: "user", content: `${REPAIR_PROMPT}\n\nParse error: ${parsed.error}` },
      ]);
      const second = parseStructuredWithRepair(repaired.text, input.schema);
      if ("value" in second) {
        return {
          ok: true,
          value: second.value,
          modelId: model.modelName,
          providerId: provider.id,
          durationMs: Date.now() - started,
          inputTokens: first.inputTokens + repaired.inputTokens,
          outputTokens: first.outputTokens + repaired.outputTokens,
        };
      }
      return {
        ok: false,
        modelId: model.modelName,
        providerId: provider.id,
        durationMs: Date.now() - started,
        inputTokens: first.inputTokens + repaired.inputTokens,
        outputTokens: first.outputTokens + repaired.outputTokens,
        error: { code: "ADVISORY_OUTPUT_INVALID", message: second.error, retryable: false },
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const timeout = /abort|timeout/i.test(msg);
      const http = /HTTP (5\d\d|429)/.test(msg);
      return {
        ok: false,
        modelId: model.modelName,
        providerId: provider.id,
        durationMs: Date.now() - started,
        inputTokens: 0,
        outputTokens: 0,
        error: {
          code: timeout ? "ADVISORY_TIMEOUT" : http ? "ADVISORY_PROVIDER_ERROR" : "ADVISORY_CALL_FAILED",
          message: msg.slice(0, 400),
          retryable: timeout || http,
        },
      };
    }
  }

  async #chat(
    provider: ModelProviderConfig,
    apiKey: string,
    model: ModelConfig,
    messages: { role: string; content: string }[],
    timeoutMs: number,
  ): Promise<{ text: string; inputTokens: number; outputTokens: number }> {
    const fetchImpl = this.deps.fetchImpl ?? fetch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const url = chatEndpoint(provider);
      const headers: Record<string, string> = { "content-type": "application/json" };
      const structured = model.capabilities.structuredOutput;
      if (provider.protocol === "ANTHROPIC_MESSAGES") {
        headers["x-api-key"] = apiKey;
        headers["anthropic-version"] = "2023-06-01";
        headers["authorization"] = `Bearer ${apiKey}`;
        const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
        const rest = messages.filter((m) => m.role !== "system");
        const body: Record<string, unknown> = {
          model: model.modelName,
          max_tokens: Math.min(model.maxOutputTokens, 2048),
          system,
          messages: rest,
        };
        const res = await fetchImpl(url, { method: "POST", headers, body: JSON.stringify(body), signal: controller.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
        const json = (await res.json()) as {
          content?: { type: string; text?: string }[];
          usage?: { input_tokens?: number; output_tokens?: number };
        };
        const text = (json.content ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n");
        return {
          text,
          inputTokens: json.usage?.input_tokens ?? 0,
          outputTokens: json.usage?.output_tokens ?? 0,
        };
      }
      headers.authorization = `Bearer ${apiKey}`;
      const body: Record<string, unknown> = {
        model: model.modelName,
        messages,
        max_tokens: Math.min(model.maxOutputTokens, 2048),
      };
      if (structured) body.response_format = { type: "json_object" };
      const res = await fetchImpl(url, { method: "POST", headers, body: JSON.stringify(body), signal: controller.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const json = (await res.json()) as {
        choices?: { message?: { content?: string | { type: string; text: string }[]; reasoning_content?: string } }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number };
        output_text?: string;
      };
      const msg = json.choices?.[0]?.message;
      let text = "";
      if (typeof msg?.content === "string") text = msg.content;
      else if (Array.isArray(msg?.content)) text = msg.content.filter((c) => c.type === "text").map((c) => c.text).join("");
      else if (typeof msg?.reasoning_content === "string") text = msg.reasoning_content;
      else if (typeof json.output_text === "string") text = json.output_text;
      return {
        text,
        inputTokens: json.usage?.prompt_tokens ?? 0,
        outputTokens: json.usage?.completion_tokens ?? 0,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

function chatEndpoint(provider: ModelProviderConfig): string {
  return resolveChatEndpoint(provider.baseUrl, provider.protocol);
}

export function createCannedAdvisory(opts: {
  manager?: unknown | ((input: AdvisoryRunInput<unknown>) => unknown | Promise<unknown>);
  reflection?: unknown | ((input: AdvisoryRunInput<unknown>) => unknown | Promise<unknown>);
  fail?: { task?: AdvisoryTask; error?: AdvisoryError };
}): HttpAdvisoryRuntime {
  const run: AdvisoryFn = async (input) => {
    const started = Date.now();
    if (opts.fail && (!opts.fail.task || opts.fail.task === input.task)) {
      return {
        ok: false,
        modelId: "canned",
        providerId: "canned",
        durationMs: Date.now() - started,
        inputTokens: 0,
        outputTokens: 0,
        error: opts.fail.error ?? { code: "ADVISORY_PROVIDER_ERROR", message: "canned 500", retryable: true },
      };
    }
    const src = input.task === "MANAGER" ? opts.manager : opts.reflection;
    const raw = typeof src === "function" ? await (src as (i: AdvisoryRunInput<unknown>) => unknown)(input) : src;
    if (raw === undefined) {
      return {
        ok: false,
        modelId: "canned",
        providerId: "canned",
        durationMs: Date.now() - started,
        inputTokens: 0,
        outputTokens: 0,
        error: { code: "ADVISORY_OUTPUT_INVALID", message: "no canned payload", retryable: false },
      };
    }
    const parsed = input.schema.safeParse(raw);
    if (!parsed.success) {
      return {
        ok: false,
        modelId: "canned",
        providerId: "canned",
        durationMs: Date.now() - started,
        inputTokens: 1,
        outputTokens: 1,
        error: { code: "ADVISORY_OUTPUT_INVALID", message: parsed.error.message, retryable: false },
      };
    }
    return {
      ok: true,
      value: parsed.data,
      modelId: "canned",
      providerId: "canned",
      durationMs: Date.now() - started,
      inputTokens: 8,
      outputTokens: 16,
    };
  };
  return new HttpAdvisoryRuntime({
    repos: null as never,
    logger: { info() {}, warn() {}, error() {}, debug() {} } as never,
    run,
  });
}
