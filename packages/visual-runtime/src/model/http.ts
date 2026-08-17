import { createHash } from "node:crypto";
import type { VisualAnalyzer, VisualObservation } from "@rio/domain";
import { encodePng } from "../decode.js";
import type { RgbaImage, VisionModelAdapter } from "../types.js";
import type { VisionCache } from "./cache.js";
import { visionCacheKey } from "./cache.js";
import type { VisionCallBudget } from "./budget.js";
import { parseVisionModelJson, VISION_SYSTEM_PROMPT } from "./parse.js";

export interface HttpVisionAdapterOpts {
  baseUrl: string;
  apiKey: string;
  modelId: string;
  protocol?: "OPENAI_CHAT_COMPLETIONS" | "OPENAI_RESPONSES" | "ANTHROPIC_MESSAGES";
  fetchImpl?: typeof fetch;
  cache?: VisionCache;
  budget?: VisionCallBudget;
  force?: boolean;
}

export class HttpVisionAdapter implements VisionModelAdapter {
  constructor(private opts: HttpVisionAdapterOpts) {}

  async analyzeImage(input: {
    challengeId: string;
    path: string;
    image: RgbaImage;
    question: string;
    fileSha256?: string;
    force?: boolean;
  }): Promise<{ observations: VisualObservation[]; summary: string; confidence: number; analyzer: VisualAnalyzer; cached?: boolean; suggestedActions?: string[] }> {
    const question = input.question.trim();
    if (!question) throw new Error("vision adapter requires a specific question");
    const sha = input.fileSha256 ?? createHash("sha256").update(Buffer.from(input.image.data)).digest("hex");
    const key = visionCacheKey({ fileSha256: sha, question, modelId: this.opts.modelId });
    const force = input.force === true || this.opts.force === true;
    if (!force) {
      const hit = this.opts.cache?.get(key);
      if (hit) {
        return { ...hit, analyzer: "VISION_MODEL", cached: true };
      }
    }
    this.opts.budget?.take();
    const png = encodePng(input.image);
    const b64 = png.toString("base64");
    const protocol = this.opts.protocol ?? "OPENAI_CHAT_COMPLETIONS";
    const fetchImpl = this.opts.fetchImpl ?? fetch;
    const url = chatEndpoint(this.opts.baseUrl, protocol);
    const payload = buildVisionChatPayload({
      modelId: this.opts.modelId,
      protocol,
      question,
      pngBase64: b64,
      maxTokens: 4096,
      system: VISION_SYSTEM_PROMPT,
    });
    const res = await fetchImpl(url, {
      method: "POST",
      headers: visionRequestHeaders(protocol, this.opts.apiKey),
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`vision HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const json = (await res.json()) as Record<string, unknown>;
    const text = extractVisionHttpText(json);
    const parsed = parseVisionModelJson(text);
    this.opts.cache?.set(key, parsed);
    return { ...parsed, analyzer: "VISION_MODEL", cached: false };
  }
}

export function visionRequestHeaders(protocol: string, apiKey: string): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    authorization: `Bearer ${apiKey}`,
  };
  if (protocol === "ANTHROPIC_MESSAGES") {
    headers["x-api-key"] = apiKey;
    headers["anthropic-version"] = "2023-06-01";
  }
  return headers;
}

export function visionImagePart(protocol: string, pngBase64: string): Record<string, unknown> {
  if (protocol === "ANTHROPIC_MESSAGES") {
    return {
      type: "image",
      source: { type: "base64", media_type: "image/png", data: pngBase64 },
    };
  }
  return { type: "image_url", image_url: { url: `data:image/png;base64,${pngBase64}` } };
}

export function buildVisionChatPayload(input: {
  modelId: string;
  protocol: string;
  question: string;
  pngBase64: string;
  maxTokens: number;
  system?: string;
}): Record<string, unknown> {
  const userContent = [{ type: "text", text: input.question }, visionImagePart(input.protocol, input.pngBase64)];
  if (input.protocol === "ANTHROPIC_MESSAGES") {
    const payload: Record<string, unknown> = {
      model: input.modelId,
      max_tokens: input.maxTokens,
      messages: [{ role: "user", content: userContent }],
    };
    if (input.system) payload.system = input.system;
    return payload;
  }
  const messages: Record<string, unknown>[] = [];
  if (input.system) messages.push({ role: "system", content: input.system });
  messages.push({ role: "user", content: userContent });
  return { model: input.modelId, max_tokens: input.maxTokens, messages };
}

export function extractAnthropicMessageText(json: unknown): string {
  if (!json || typeof json !== "object") return "";
  const blocks = (json as { content?: unknown }).content;
  if (!Array.isArray(blocks)) return "";
  const chunks: string[] = [];
  for (const block of blocks) {
    if (!block || typeof block !== "object") continue;
    const rec = block as { type?: string; text?: unknown; thinking?: unknown };
    if (typeof rec.text === "string" && rec.text.trim()) chunks.push(rec.text);
    else if (typeof rec.thinking === "string" && rec.thinking.trim()) chunks.push(rec.thinking);
  }
  return chunks.join("\n");
}

export function extractVisionHttpText(json: unknown): string {
  const anthropic = extractAnthropicMessageText(json);
  if (anthropic) return anthropic;
  if (!json || typeof json !== "object") return "";
  const rec = json as {
    choices?: { message?: { content?: unknown; reasoning_content?: unknown } }[];
    output_text?: unknown;
  };
  const fromChoices = visionMessageText(rec.choices?.[0]?.message);
  if (fromChoices) return fromChoices;
  if (typeof rec.output_text === "string") return rec.output_text;
  return "";
}

export function visionMessageText(message: { content?: unknown; reasoning_content?: unknown } | undefined): string {
  if (!message) return "";
  const chunks: string[] = [];
  const push = (v: unknown) => {
    if (typeof v === "string" && v.trim()) chunks.push(v);
    else if (Array.isArray(v)) {
      for (const part of v) {
        if (typeof part === "string") chunks.push(part);
        else if (part && typeof part === "object" && "text" in part) chunks.push(String((part as { text?: string }).text ?? ""));
      }
    }
  };
  push(message.content);
  push(message.reasoning_content);
  return chunks.join("\n");
}

export function chatEndpoint(baseUrl: string, protocol: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  const hasV1 = /\/v\d+$/i.test(base) || /\/v\d+\/[a-z]+$/i.test(base);
  if (protocol === "ANTHROPIC_MESSAGES") return hasV1 ? `${base}/messages` : `${base}/v1/messages`;
  return hasV1 ? `${base}/chat/completions` : `${base}/v1/chat/completions`;
}
