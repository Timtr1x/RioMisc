// Model Provider Registry (Phase 8, §55-59): CRUD + two-phase Test Connection.
// API keys live in the SecretStore, never in SQLite.
import type { RioLogger } from "@rio/shared";
import type { Repositories } from "@rio/database";
import type { ModelProviderConfig, ModelConfig, ProviderProtocol } from "@rio/domain";
import type { SecretStore } from "@rio/shared";

export interface TestConnectionResult {
  authentication: boolean;
  textApi: boolean;
  toolCall: boolean;
  latencyMs: number;
  message?: string;
}

export class ModelRegistry {
  constructor(
    private repos: Repositories,
    private secrets: SecretStore,
    private logger: RioLogger,
  ) {}

  async addProvider(input: {
    displayName: string;
    protocol: ProviderProtocol;
    baseUrl: string;
    apiKey: string;
    enabled?: boolean;
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
    });
  }

  async addModel(input: {
    providerId: string;
    modelName: string;
    contextWindow: number;
    maxOutputTokens: number;
    role?: ModelConfig["role"];
    enabled?: boolean;
  }): Promise<ModelConfig> {
    const provider = this.repos.providers.get(input.providerId);
    if (!provider) throw new Error("unknown provider");
    return this.repos.models.create(input);
  }

  /** Two-phase test (§57): plain chat + tool calling. */
  async testConnection(providerId: string): Promise<TestConnectionResult> {
    const provider = this.repos.providers.get(providerId);
    if (!provider) throw new Error("unknown provider");
    const apiKey = await this.secrets.get(provider.apiKeyRef);
    if (!apiKey) throw new Error("no stored API key for this provider");
    const started = Date.now();
    const out: TestConnectionResult = { authentication: false, textApi: false, toolCall: false, latencyMs: 0 };

    // Phase 1: plain chat
    try {
      const text = await this.#request(provider, apiKey, {
        messages: [{ role: "user", content: "Respond exactly with OK." }],
        max_tokens: 16,
      });
      out.authentication = true;
      out.textApi = typeof text === "string" && text.trim().toUpperCase() === "OK";
      if (!out.textApi) out.message = `text API replied: ${JSON.stringify(text).slice(0, 100)}`;
    } catch (e) {
      out.message = `text API failed: ${(e as Error).message}`;
      return out;
    }

    // Phase 2: tool call
    try {
      const response = (await this.#request(provider, apiKey, {
        messages: [{ role: "user", content: "Call the test_tool function with value=hello. Call it now." }],
        max_tokens: 64,
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
      }, true)) as Record<string, unknown> | null;
      out.toolCall = Array.isArray(response?.tool_calls) && response.tool_calls.length > 0;
      if (!out.toolCall) out.message = (out.message ?? "") + " | no tool call returned";
    } catch (e) {
      out.message = (out.message ?? "") + ` | tool call failed: ${(e as Error).message}`;
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
  ): Promise<Record<string, unknown> | string | null> {
    const url = this.#endpoint(provider);
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (provider.protocol === "ANTHROPIC_MESSAGES") {
      headers["x-api-key"] = apiKey;
      headers["anthropic-version"] = "2023-06-01";
      const payload = { ...body, model: "claude-sonnet-4-5" };
      const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(payload) });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
      const json = (await res.json()) as Record<string, unknown>;
      const blocks = (json.content as { type: string; text?: string; id?: string }[]) ?? [];
      const text = blocks.filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
      const toolUses = blocks.filter((b) => b.type === "tool_use");
      return wantToolCalls ? { tool_calls: toolUses.length ? [{ id: toolUses[0]!.id }] : [] } : text;
    }
    // OpenAI-style (completions or responses)
    headers["authorization"] = `Bearer ${apiKey}`;
    const payload = provider.protocol === "OPENAI_RESPONSES" ? { ...body, model: "gpt-5" } : { ...body, model: "gpt-5" };
    const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(payload) });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    const json = (await res.json()) as Record<string, unknown>;
    if (wantToolCalls) return json;
    const choices = (json.choices as { message?: { content?: string | null | { type: string; text: string }[] } }[]) ?? [];
    const msg = choices[0]?.message;
    if (typeof msg?.content === "string") return msg.content;
    if (Array.isArray(msg?.content)) return msg.content.filter((c) => c.type === "text").map((c) => c.text).join("");
    return "";
  }

  #endpoint(provider: ModelProviderConfig): string {
    switch (provider.protocol) {
      case "ANTHROPIC_MESSAGES":
        return `${provider.baseUrl}/v1/messages`;
      case "OPENAI_RESPONSES":
        return `${provider.baseUrl}/v1/responses`;
      case "OPENAI_CHAT_COMPLETIONS":
      default:
        return `${provider.baseUrl}/v1/chat/completions`;
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
