import type { VisualObservation } from "@rio/domain";

export const VISUAL_RUNTIME_VERSION = "2.0.2";

export const VISION_SYSTEM_PROMPT = `You are a visual evidence analyzer for an authorized CTF challenge.

Report only observations supported by the image.
Do not invent a flag unless those characters are actually visible.
Do not ask for another vision pass on the same pixels.

Return ONE JSON object and nothing else (no markdown fences if you can avoid them). Schema:
{
  "summary": "one sentence",
  "confidence": 0.0,
  "observations": [
    { "type": "TEXT"|"QR"|"BARCODE"|"SHAPE"|"COLOR"|"PATTERN"|"ANOMALY"|"STRUCTURE"|"OTHER", "value": "exact visible text if any", "description": "what you see", "confidence": 0.0 }
  ],
  "suggestedActions": ["optional next transform"]
}
observations MUST be an array of objects, never a map.`;

export interface ParsedVisionReply {
  summary: string;
  observations: VisualObservation[];
  suggestedActions: string[];
  confidence: number;
}

const OBS_TYPES = new Set(["TEXT", "QR", "BARCODE", "SHAPE", "COLOR", "PATTERN", "ANOMALY", "STRUCTURE", "OTHER"]);

export function parseVisionModelJson(raw: string): ParsedVisionReply {
  const json = extractJsonObject(raw);
  const observations: VisualObservation[] = [];
  if (json) {
    for (const item of normalizeObservationList(json.observations ?? json.observation)) {
      const obs = observationFromUnknown(item);
      if (obs) observations.push(obs);
    }
    if (json.text != null || json.flag != null || json.visibleText != null) {
      const value = String(json.flag ?? json.visibleText ?? json.text);
      if (value.trim()) {
        observations.push({
          type: looksLikeFlag(value) ? "TEXT" : "OTHER",
          value,
          description: value,
          confidence: 0.7,
        });
      }
    }
  }
  for (const flag of extractFlags(raw)) {
    if (!observations.some((o) => o.value === flag)) {
      observations.push({ type: "TEXT", value: flag, description: `visible flag-shaped text: ${flag}`, confidence: 0.85 });
    }
  }
  if (!json && observations.length === 0) {
    const prose = raw.trim().slice(0, 2000);
    if (!prose) throw new Error("vision model did not return JSON");
    return {
      summary: prose.slice(0, 400),
      observations: [{ type: "OTHER", description: prose, confidence: 0.35 }],
      suggestedActions: [],
      confidence: 0.35,
    };
  }
  const actions = Array.isArray(json?.suggestedActions)
    ? (json!.suggestedActions as unknown[]).map((a) => String(a)).filter(Boolean).slice(0, 12)
    : [];
  const summary = String(json?.summary ?? observations[0]?.description ?? raw.trim().slice(0, 400) ?? "vision model returned no summary").slice(0, 2000);
  const confidence = clamp01(Number(json?.confidence ?? (observations[0]?.confidence ?? 0.4)));
  return { summary, observations, suggestedActions: actions, confidence };
}

function normalizeObservationList(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === "object") {
    return Object.entries(raw as Record<string, unknown>).map(([key, value]) => {
      if (value && typeof value === "object" && !Array.isArray(value)) return { ...(value as object), type: (value as { type?: string }).type ?? guessType(key, value) };
      return { type: guessType(key, value), value, description: `${key}: ${stringifySmall(value)}` };
    });
  }
  return [];
}

function observationFromUnknown(item: unknown): VisualObservation | null {
  if (item == null) return null;
  if (typeof item === "string") {
    const t = item.trim();
    if (!t) return null;
    return { type: looksLikeFlag(t) ? "TEXT" : "OTHER", value: t, description: t, confidence: 0.6 };
  }
  if (typeof item !== "object") return null;
  const o = item as Record<string, unknown>;
  const type = OBS_TYPES.has(String(o.type)) ? (o.type as VisualObservation["type"]) : guessType(String(o.type ?? ""), o.value ?? o.description);
  const description = String(o.description ?? o.value ?? o.text ?? "").trim();
  const value = o.value != null ? String(o.value) : o.text != null ? String(o.text) : undefined;
  if (!description && value == null) return null;
  return {
    type,
    value,
    description: description || String(value),
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
  };
}

function guessType(key: string, value: unknown): VisualObservation["type"] {
  const blob = `${key} ${stringifySmall(value)}`.toLowerCase();
  if (blob.includes("qr")) return "QR";
  if (/(flag|text|string|label|caption|visible)/.test(blob) || looksLikeFlag(String(value ?? ""))) return "TEXT";
  if (OBS_TYPES.has(key.toUpperCase())) return key.toUpperCase() as VisualObservation["type"];
  return "OTHER";
}

function looksLikeFlag(s: string): boolean {
  return /[A-Za-z0-9_-]{2,32}\{[^}]{2,200}\}/.test(s);
}

function extractFlags(raw: string): string[] {
  return [...raw.matchAll(/[A-Za-z0-9_-]{2,32}\{[^\s}]{2,200}\}/g)].map((m) => m[0]!);
}

function stringifySmall(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    return JSON.stringify(v).slice(0, 400);
  } catch {
    return String(v);
  }
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
