// Model Provider Registry (Phase 8, §55-59): CRUD + two-phase Test Connection.
// API keys live in the SecretStore, never in SQLite.
import type { RioLogger } from "@rio/shared";
import type { Repositories } from "@rio/database";
import type { ModelProviderConfig, ModelConfig, ProviderProtocol } from "@rio/domain";
import type { SecretStore } from "@rio/shared";
import { inferModelCapabilities, loadModelAssignments, mergeCapabilities } from "./model-assignments.js";
import { buildVisionTestPayload, extractVisionReply, selectVisionTestModel, visionTestPassed } from "./capability-test.js";

export interface TestConnectionResult {
  authentication: boolean;
  textApi: boolean;
  toolCall: boolean;
  visionApi: boolean | null;
  latencyMs: number;
  message?: string;
}

export class ModelRegistry {
  constructor(
    private repos: Repositories,
    private secrets: SecretStore,
    private logger: RioLogger,
    private fetchImpl: typeof fetch = fetch,
  ) {}

  async addProvider(input: {
    displayName: string;
    protocol: ProviderProtocol;
    baseUrl: string;
    apiKey: string;
    enabled?: boolean;
    compatProfile?: ModelProviderConfig["compatProfile"];
  }): Promise<ModelProviderConfig> {
    const apiKeyRef = `provider.apiKey.${Math.random().toString(36).slice(2, 10)}`;
    if (this.secrets.hasMasterKey()) {
      await this.secrets.set(apiKeyRef, input.apiKey);
    } else {
      this.logger.warn({ event: "no_master_key" }, "CTF_RUNTIME_MASTER_KEY not set — API key will NOT be persisted");
    }
    return this.repos.providers.create({
      displayName: input.displayName,
      protocol: input.protocol,
      baseUrl: input.baseUrl.replace(/\/+$/, ""),
      apiKeyRef,
      enabled: input.enabled ?? true,
      compatProfile: input.compatProfile ?? "AUTO",
    });
  }

  async addModel(input: {
    providerId: string;
    modelName: string;
    contextWindow: number;
    maxOutputTokens: number;
    role?: ModelConfig["role"];
    enabled?: boolean;
    capabilities?: Partial<ModelConfig["capabilities"]>;
  }): Promise<ModelConfig> {
    const provider = this.repos.providers.get(input.providerId);
    if (!provider) throw new Error("unknown provider");
    const role = input.role ?? (this.repos.models.primary() ? "GENERAL" : "PRIMARY");
    const capabilities = mergeCapabilities(inferModelCapabilities(input.modelName), input.capabilities);
    return this.repos.models.create({ ...input, role, capabilities });
  }

  /** Two-phase test (§57): plain chat + tool calling. */
  async testConnection(providerId: string): Promise<TestConnectionResult> {
    const provider = this.repos.providers.get(providerId);
    if (!provider) throw new Error("unknown provider");
    const apiKey = await this.secrets.get(provider.apiKeyRef);
    if (!apiKey) throw new Error("no stored API key for this provider");

    // Use a real model registered for this provider, never a hardcoded name.
    const models = this.repos.models.listByProvider(providerId).filter((m) => m.enabled);
    const modelName = models.find((m) => m.role === "PRIMARY")?.modelName ?? models[0]?.modelName;
    if (!modelName) {
      return {
        authentication: false,
        textApi: false,
        toolCall: false,
        visionApi: null,
        latencyMs: 0,
        message: "该 provider 还没有注册模型 — 请先在 Dashboard 添加模型（如 deepseek-v4-flash）",
      };
    }

    const started = Date.now();
    const out: TestConnectionResult = { authentication: false, textApi: false, toolCall: false, visionApi: null, latencyMs: 0 };

    // Phase 1: plain chat — budget must cover reasoning models (deepseek etc.)
    try {
      const text = await this.#request(provider, apiKey, {
        messages: [{ role: "user", content: "Respond exactly with OK." }],
        max_tokens: 256,
      }, false, modelName);
      this.recordModelSuccess(providerId);
      out.authentication = true;
      // success = the API answered with *some* text; reasoning models may
      // reply from reasoning_content, not message.content
      out.textApi = typeof text === "string" && text.trim().length > 0;
      out.message = `text API replied: ${JSON.stringify(typeof text === "string" ? text.slice(0, 120) : text)}`;
      if (!out.textApi) out.message += " (empty reply — check the model's reasoning mode / response format)";
    } catch (e) {
      this.recordModelFailure(providerId);
      out.message = `text API failed: ${(e as Error).message}`;
      return out;
    }

    // Phase 2: tool call. OpenAI/DeepSeek probes include thinking on/off.
    // Anthropic-compatible hosts (Claude, MiniMax /anthropic) reject OpenAI
    // function tools, string tool_choice, and thinking.type=disabled.
    const probes = toolProbesFor(provider.protocol);
    out.toolCall = false;
    let probeNote = "";
    for (const probe of probes) {
      try {
        const response = (await this.#request(provider, apiKey, {
          messages: [{ role: "user", content: "Call the test_tool function with value=hello. Call it now." }],
          max_tokens: 1024,
          ...probe.extra,
          tools: [
            {
              type: "function",
              function: {
                name: "test_tool",
                description: "A test tool",
                parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
              },
            },
          ],
          tool_choice: "auto",
        }, true, modelName)) as Record<string, unknown> | null;
        const toolCalls = extractToolCalls(response);
        if (toolCalls.length > 0) {
          out.toolCall = true;
          probeNote = ` (tool+thinking 探测: ${probe.label})`;
          break;
        }
        const finish = (response?.choices as { finish_reason?: string }[] | undefined)?.[0]?.finish_reason
          ?? (typeof response?.stop_reason === "string" ? response.stop_reason : "?");
        probeNote = ` (探测 ${probe.label}: finish=${finish ?? "?"}, 无 tool call)`;
      } catch (e) {
        probeNote = ` (探测 ${probe.label} 失败: ${(e as Error).message.slice(0, 160)})`;
      }
    }
    out.message = (out.message ?? "") + ` | tool call: ${out.toolCall ? "OK" : "FAILED"}${probeNote}`;

    const assigned = loadModelAssignments(this.repos);
    const visionModel = selectVisionTestModel(models, assigned.visionModelId);
    if (visionModel) {
      try {
        const payload = buildVisionTestPayload(visionModel.modelName, provider.protocol);
        const replyRaw = await this.#request(provider, apiKey, payload, false, visionModel.modelName);
        const reply = extractVisionReply(replyRaw);
        out.visionApi = visionTestPassed(reply);
        out.message += ` | vision (${visionModel.modelName}): ${out.visionApi ? "OK" : `FAILED reply=${JSON.stringify(reply.slice(0, 80))}`}`;
      } catch (e) {
        out.visionApi = false;
        out.message += ` | vision (${visionModel.modelName}) failed: ${(e as Error).message.slice(0, 160)}`;
      }
    }

    out.latencyMs = Date.now() - started;
    if (out.authentication && out.textApi && out.toolCall) {
      this.repos.providers.recordSuccess(providerId);
    } else {
      this.repos.providers.update(providerId, { lastTestedAt: Date.now() });
    }
    return out;
  }

  async #request(
    provider: ModelProviderConfig,
    apiKey: string,
    body: Record<string, unknown>,
    wantToolCalls = false,
    modelName = "gpt-5",
  ): Promise<Record<string, unknown> | string | null> {
    const url = this.#endpoint(provider);
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (provider.protocol === "ANTHROPIC_MESSAGES") {
      headers["x-api-key"] = apiKey;
      headers["anthropic-version"] = "2023-06-01";
      headers["authorization"] = `Bearer ${apiKey}`;
      const payload = toAnthropicMessagesBody(body, modelName);
      const res = await this.fetchImpl(url, { method: "POST", headers, body: JSON.stringify(payload) });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const json = (await res.json()) as Record<string, unknown>;
      const blocks = (json.content as { type: string; text?: string; thinking?: string; id?: string }[]) ?? [];
      const text = blocks
        .map((b) => (b.type === "text" ? b.text ?? "" : b.type === "thinking" ? b.thinking ?? "" : ""))
        .filter(Boolean)
        .join("\n");
      const toolUses = blocks.filter((b) => b.type === "tool_use");
      if (wantToolCalls) {
        return {
          ...json,
          choices: [
            {
              message: { tool_calls: toolUses.map((t) => ({ id: t.id })) },
              finish_reason: toolUses.length ? "tool_calls" : json.stop_reason,
            },
          ],
        };
      }
      return text;
    }
    // OpenAI-style (completions or responses)
    headers["authorization"] = `Bearer ${apiKey}`;
    const payload = { ...body, model: modelName };
    const res = await this.fetchImpl(url, { method: "POST", headers, body: JSON.stringify(payload) });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const json = (await res.json()) as Record<string, unknown>;
    if (wantToolCalls) return json;
    const choices = (json.choices as { message?: { content?: string | null | { type: string; text: string }[]; reasoning_content?: string | null } }[]) ?? [];
    const msg = choices[0]?.message;
    if (typeof msg?.content === "string" && msg.content.length > 0) return msg.content;
    if (Array.isArray(msg?.content)) return msg.content.filter((c) => c.type === "text").map((c) => c.text).join("");
    // deepseek-style reasoning models put the visible text here when content is null
    if (typeof msg?.reasoning_content === "string" && msg.reasoning_content.length > 0) return msg.reasoning_content;
    // OpenAI Responses API shape
    const outputArr = json.output as { content?: { type?: string; text?: string }[] }[] | undefined;
    const outputText = (json.output_text ?? outputArr?.[0]?.content?.[0]?.text) as string | undefined;
    if (typeof outputText === "string") return outputText;
    return "";
  }

  /**
   * Endpoint resolution: baseUrl may or may not already include /v1
   * (e.g. https://api.openai.com vs https://opencode.ai/zen/go/v1).
   */
  #endpoint(provider: ModelProviderConfig): string {
    const base = provider.baseUrl.replace(/\/+$/, "");
    // Already a full chat/messages endpoint (or a DASCTF gateway that maps 1:1 to one).
    if (/\/messages$/i.test(base) || /\/chat\/completions$/i.test(base) || /\/responses$/i.test(base)) {
      return base;
    }
    const hasV1 = /\/v\d+$/i.test(base) || /\/v\d+\/[a-z]+$/i.test(base);
    switch (provider.protocol) {
      case "ANTHROPIC_MESSAGES":
        return hasV1 ? `${base}/messages` : `${base}/v1/messages`;
      case "OPENAI_RESPONSES":
        return hasV1 ? `${base}/responses` : `${base}/v1/responses`;
      case "OPENAI_CHAT_COMPLETIONS":
      default:
        return hasV1 ? `${base}/chat/completions` : `${base}/v1/chat/completions`;
    }
  }

  /** Failure bookkeeping (§58): 3 consecutive → DEGRADED, 5 → DOWN. */
  recordModelFailure(providerId: string): void {
    const p = this.repos.providers.get(providerId);
    if (!p) return;
    this.repos.providers.recordFailure(providerId, p.consecutiveFailures + 1);
  }

  recordModelSuccess(providerId: string): void {
    this.repos.providers.recordSuccess(providerId);
  }
}

function toolProbesFor(protocol: ProviderProtocol): { label: string; extra: Record<string, unknown> }[] {
  if (protocol === "ANTHROPIC_MESSAGES") {
    return [
      { label: "no-param", extra: {} },
      { label: "thinking.adaptive", extra: { thinking: { type: "adaptive" } } },
      { label: "thinking.enabled", extra: { thinking: { type: "enabled", budget_tokens: 1024 } } },
    ];
  }
  return [
    { label: "thinking.enabled", extra: { thinking: { type: "enabled" }, reasoning_effort: "high" } },
    { label: "thinking.enabled-only", extra: { thinking: { type: "enabled" } } },
    { label: "no-param", extra: {} },
    { label: "thinking.disabled", extra: { thinking: { type: "disabled" } } },
  ];
}

function extractToolCalls(response: Record<string, unknown> | null): unknown[] {
  if (!response) return [];
  const choice = (response.choices as { message?: { tool_calls?: unknown[] } }[] | undefined)?.[0];
  if (Array.isArray(choice?.message?.tool_calls) && choice.message.tool_calls.length > 0) {
    return choice.message.tool_calls;
  }
  if (Array.isArray(response.tool_calls) && response.tool_calls.length > 0) return response.tool_calls;
  const blocks = response.content as { type?: string }[] | undefined;
  if (Array.isArray(blocks) && blocks.some((b) => b.type === "tool_use")) {
    return blocks.filter((b) => b.type === "tool_use");
  }
  return [];
}

function toAnthropicMessagesBody(body: Record<string, unknown>, modelName: string): Record<string, unknown> {
  const rawMessages = Array.isArray(body.messages) ? (body.messages as Record<string, unknown>[]) : [];
  let system = typeof body.system === "string" ? body.system : undefined;
  const messages: Record<string, unknown>[] = [];
  for (const msg of rawMessages) {
    if (msg.role === "system") {
      if (typeof msg.content === "string") system = msg.content;
      continue;
    }
    messages.push(msg);
  }
  const payload: Record<string, unknown> = {
    model: modelName,
    messages,
    max_tokens: body.max_tokens ?? 256,
  };
  if (system) payload.system = system;
  if (Array.isArray(body.tools)) {
    payload.tools = (body.tools as Record<string, unknown>[]).map(toAnthropicTool);
  }
  if (body.tool_choice === "auto" || body.tool_choice === "none") {
    payload.tool_choice = { type: body.tool_choice };
  } else if (body.tool_choice && typeof body.tool_choice === "object") {
    payload.tool_choice = body.tool_choice;
  }
  if (body.thinking && typeof body.thinking === "object") payload.thinking = body.thinking;
  return payload;
}

function toAnthropicTool(tool: Record<string, unknown>): Record<string, unknown> {
  const fn = tool.function as { name?: string; description?: string; parameters?: unknown } | undefined;
  if (fn?.name) {
    return {
      name: fn.name,
      description: fn.description ?? "",
      input_schema: fn.parameters ?? { type: "object", properties: {} },
    };
  }
  return tool;
}
