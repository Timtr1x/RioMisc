// Provider compatibility profiles for the Pi models.json mapping.
// AUTO infers from protocol / URL / model name so OpenAI endpoints are not
// forced onto DeepSeek thinkingFormat.
import type { ProviderProtocol } from "@rio/domain";

export type CompatProfile = "AUTO" | "OPENAI" | "DEEPSEEK" | "ZAI" | "ANTHROPIC";

export interface CompatFlags {
  supportsDeveloperRole: boolean;
  supportsReasoningEffort: boolean;
  thinkingFormat?: "deepseek" | "openai" | "zai";
  requiresReasoningContentOnAssistantMessages: boolean;
}

export function selectPiProvider<T extends { modelId: string }>(providers: T[], modelId?: string | null): T {
  if (providers.length === 0) {
    throw new Error("Pi runtime: no model providers configured. Add one via Dashboard/CLI first.");
  }
  if (modelId) {
    const found = providers.find((p) => p.modelId === modelId);
    if (!found) throw new Error(`Pi runtime: model ${modelId} is not in the current provider list`);
    return found;
  }
  return providers[0]!;
}

export function inferCompatProfile(input: {
  protocol: ProviderProtocol;
  baseUrl: string;
  modelId?: string | null;
}): Exclude<CompatProfile, "AUTO"> {
  if (input.protocol === "ANTHROPIC_MESSAGES") return "ANTHROPIC";
  const hay = `${input.baseUrl} ${input.modelId ?? ""}`.toLowerCase();
  if (hay.includes("deepseek") || hay.includes("opencode.ai") || hay.includes("/zen/")) return "DEEPSEEK";
  if (hay.includes("z.ai") || hay.includes("zhipu") || hay.includes("bigmodel") || /\bglm[-_]?/i.test(hay)) return "ZAI";
  return "OPENAI";
}

export function resolveCompatProfile(
  configured: CompatProfile | null | undefined,
  input: { protocol: ProviderProtocol; baseUrl: string; modelId?: string | null },
): Exclude<CompatProfile, "AUTO"> {
  if (configured && configured !== "AUTO") return configured;
  return inferCompatProfile(input);
}

export function compatFlagsFor(profile: Exclude<CompatProfile, "AUTO">): CompatFlags {
  switch (profile) {
    case "DEEPSEEK":
      return {
        supportsDeveloperRole: false,
        supportsReasoningEffort: true,
        thinkingFormat: "deepseek",
        requiresReasoningContentOnAssistantMessages: true,
      };
    case "ZAI":
      return {
        supportsDeveloperRole: false,
        supportsReasoningEffort: true,
        thinkingFormat: "zai",
        requiresReasoningContentOnAssistantMessages: false,
      };
    case "ANTHROPIC":
      return {
        supportsDeveloperRole: true,
        supportsReasoningEffort: false,
        requiresReasoningContentOnAssistantMessages: false,
      };
    default:
      return {
        supportsDeveloperRole: false,
        supportsReasoningEffort: false,
        requiresReasoningContentOnAssistantMessages: false,
      };
  }
}
