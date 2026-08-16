import type { VisualObservation } from "@rio/domain";

export const VISUAL_RUNTIME_VERSION = "2.0.1";

export const VISION_SYSTEM_PROMPT = `You are a visual evidence analyzer for an authorized CTF challenge.

Report only observations supported by the image.

Do not infer a flag unless characters are actually visible.

Distinguish:
- directly readable evidence
- uncertain interpretation
- suggested follow-up transformations.

Return structured JSON only.`;

export interface ParsedVisionReply {
  summary: string;
  observations: VisualObservation[];
  suggestedActions: string[];
  confidence: number;
}

const OBS_TYPES = new Set(["TEXT", "QR", "BARCODE", "SHAPE", "COLOR", "PATTERN", "ANOMALY", "STRUCTURE", "OTHER"]);

export function parseVisionModelJson(raw: string): ParsedVisionReply {
  const json = extractJsonObject(raw);
  if (!json) throw new Error("vision model did not return JSON");
  const observations: VisualObservation[] = [];
  const rawObs = Array.isArray(json.observations) ? json.observations : [];
  for (const item of rawObs) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const type = OBS_TYPES.has(String(o.type)) ? (o.type as VisualObservation["type"]) : "OTHER";
    const description = String(o.description ?? o.value ?? "").trim();
    if (!description && o.value == null) continue;
    observations.push({
      type,
      value: o.value != null ? String(o.value) : undefined,
      description: description || String(o.value),
      confidence: clamp01(Number(o.confidence ?? 0.5)),
      region:
        o.region && typeof o.region === "object"
          ? {
              x: Number((o.region as { x?: number }).x ?? 0),
              y: Number((o.region as { y?: number }).y ?? 0),
              width: Number((o.region as { width?: number }).width ?? 0),
              height: Number((o.region as { height?: number }).height ?? 0),
            }
          : undefined,
    });
  }
  const actions = Array.isArray(json.suggestedActions)
    ? json.suggestedActions.map((a) => String(a)).filter(Boolean).slice(0, 12)
    : [];
  const summary = String(json.summary ?? observations[0]?.description ?? "vision model returned no summary").slice(0, 2000);
  const confidence = clamp01(Number(json.confidence ?? (observations[0]?.confidence ?? 0.4)));
  return { summary, observations, suggestedActions: actions, confidence };
}

export function extractJsonObject(raw: string): Record<string, unknown> | null {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced?.[1]?.trim() ?? trimmed;
  try {
    const v = JSON.parse(body);
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch {
    /* fall through */
  }
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      const v = JSON.parse(body.slice(start, end + 1));
      if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
    } catch {
      return null;
    }
  }
  return null;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0.5;
  return Math.min(1, Math.max(0, n));
}
