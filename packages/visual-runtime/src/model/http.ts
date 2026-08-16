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
    const fetchImpl = this.opts.fetchImpl ?? fetch;
    const url = chatEndpoint(this.opts.baseUrl, this.opts.protocol ?? "OPENAI_CHAT_COMPLETIONS");
    const payload = {
      model: this.opts.modelId,
      max_tokens: 800,
      messages: [
        { role: "system", content: VISION_SYSTEM_PROMPT },
        {
          role: "user",
          content: [
            { type: "text", text: question },
            { type: "image_url", image_url: { url: `data:image/png;base64,${b64}` } },
          ],
        },
      ],
    };
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.opts.apiKey}` },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`vision HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const json = (await res.json()) as { choices?: { message?: { content?: unknown } }[] };
    const content = json.choices?.[0]?.message?.content;
    const text = typeof content === "string" ? content : Array.isArray(content) ? content.map((c) => (c as { text?: string }).text ?? "").join("") : "";
    const parsed = parseVisionModelJson(text);
    this.opts.cache?.set(key, parsed);
    return { ...parsed, analyzer: "VISION_MODEL", cached: false };
  }
}

export function chatEndpoint(baseUrl: string, protocol: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  const hasV1 = /\/v\d+$/i.test(base) || /\/v\d+\/[a-z]+$/i.test(base);
  if (protocol === "ANTHROPIC_MESSAGES") return hasV1 ? `${base}/messages` : `${base}/v1/messages`;
  return hasV1 ? `${base}/chat/completions` : `${base}/v1/chat/completions`;
}
