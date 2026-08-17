import type { ModelConfig, ProviderProtocol } from "@rio/domain";
import {
  visionOkPng,
  visionTestPassed,
  VISION_OK_TEXT,
  buildVisionChatPayload,
  extractVisionHttpText,
} from "@rio/visual-runtime";

export { visionTestPassed, VISION_OK_TEXT };

export function selectVisionTestModel(models: ModelConfig[], assignedVisionModelId: string | null): ModelConfig | null {
  const enabled = models.filter((m) => m.enabled && m.capabilities.vision);
  if (enabled.length === 0) return null;
  if (assignedVisionModelId) {
    const assigned = enabled.find((m) => m.id === assignedVisionModelId);
    if (assigned) return assigned;
  }
  return enabled[0] ?? null;
}

export function buildVisionTestPayload(
  modelName: string,
  protocol: ProviderProtocol = "OPENAI_CHAT_COMPLETIONS",
): Record<string, unknown> {
  const png = visionOkPng();
  return buildVisionChatPayload({
    modelId: modelName,
    protocol,
    question: `Read the visible characters in this image. If you see the exact phrase ${VISION_OK_TEXT}, reply with that phrase and nothing else.`,
    pngBase64: png.toString("base64"),
    maxTokens: 256,
  });
}

export function extractVisionReply(json: unknown): string {
  if (typeof json === "string") return json;
  const fromHttp = extractVisionHttpText(json);
  if (fromHttp) return fromHttp;
  if (!json || typeof json !== "object") return "";
  const rec = json as Record<string, unknown>;
  const choices = rec.choices as { message?: { content?: unknown } }[] | undefined;
  const content = choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (typeof c === "object" && c && "text" in c ? String((c as { text?: string }).text ?? "") : ""))
      .join("");
  }
  if (typeof rec.output_text === "string") return rec.output_text;
  return "";
}
