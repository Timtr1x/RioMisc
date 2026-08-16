import type { ModelConfig } from "@rio/domain";
import { visionOkPng, visionTestPassed, VISION_OK_TEXT } from "@rio/visual-runtime";

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

export function buildVisionTestPayload(modelName: string): Record<string, unknown> {
  const png = visionOkPng();
  const b64 = png.toString("base64");
  return {
    model: modelName,
    max_tokens: 256,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `Read the visible characters in this image. If you see the exact phrase ${VISION_OK_TEXT}, reply with that phrase and nothing else.`,
          },
          {
            type: "image_url",
            image_url: { url: `data:image/png;base64,${b64}` },
          },
        ],
      },
    ],
  };
}

export function extractVisionReply(json: unknown): string {
  if (typeof json === "string") return json;
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
