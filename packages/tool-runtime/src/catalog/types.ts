import type { z } from "zod";
import type { ToolContext, ToolResult } from "../tools.js";

export type ToolGroup =
  | "WORKSPACE"
  | "CONTROL"
  | "MISC_FILE"
  | "MISC_ARCHIVE"
  | "MISC_IMAGE"
  | "MISC_PCAP"
  | "MISC_AUDIO_VIDEO"
  | "CRYPTO_PARSE"
  | "CRYPTO_RSA"
  | "CRYPTO_NUMBER_THEORY"
  | "CRYPTO_XOR_CLASSICAL"
  | "CRYPTO_PRNG"
  | "CRYPTO_SYMMETRIC"
  | "CRYPTO_ADVANCED_MATH"
  | "SPECIALIST";

export type ToolDomain = "MISC" | "CRYPTO";
export type ToolExposure = "CORE" | "DISCOVERABLE";
export type ToolCost = "CHEAP" | "NORMAL" | "EXPENSIVE";

export interface ToolParameterDoc {
  name: string;
  type: string;
  required: boolean;
  description: string;
  acceptedFormats?: string[];
  example?: unknown;
}

export interface ToolExample {
  title: string;
  situation: string;
  args: Record<string, unknown>;
  expectedSummary: string;
}

export interface ToolFailureMode {
  code: string;
  meaning: string;
  recovery: string;
}

export interface ToolHint {
  tool: string;
  reason: string;
}

export interface ToolDescriptor {
  name: string;
  group: ToolGroup;
  domains: ToolDomain[] | ["MISC", "CRYPTO"];
  exposure: ToolExposure;
  /** false for control/core tools — execute_tool must refuse them. */
  routerExecutable: boolean;
  summary: string;
  whenToUse: string[];
  whenNotToUse: string[];
  prerequisites: string[];
  schema: z.ZodType;
  parameters: ToolParameterDoc[];
  examples: ToolExample[];
  output: {
    description: string;
    importantFields: string[];
    interpretation: string[];
  };
  failureModes: ToolFailureMode[];
  suggestedNextTools: string[];
  cost: ToolCost;
  tags: string[];
  run(ctx: ToolContext, params: unknown, meta: { toolIndex: number; startedAt: number }): Promise<ToolResult>;
}

export interface ToolCard {
  name: string;
  group: ToolGroup;
  summary: string;
  whenToUse: string[];
  signature: string;
  cost: ToolCost;
}

export const TOOL_GROUPS_BY_DOMAIN: Record<ToolDomain | "ANY", ToolGroup[]> = {
  MISC: ["WORKSPACE", "CONTROL", "MISC_FILE", "MISC_ARCHIVE", "MISC_IMAGE", "MISC_PCAP", "MISC_AUDIO_VIDEO", "SPECIALIST"],
  CRYPTO: ["WORKSPACE", "CONTROL", "CRYPTO_PARSE", "CRYPTO_RSA", "CRYPTO_NUMBER_THEORY", "CRYPTO_XOR_CLASSICAL", "CRYPTO_PRNG", "CRYPTO_SYMMETRIC", "CRYPTO_ADVANCED_MATH", "SPECIALIST"],
  ANY: [
    "WORKSPACE",
    "CONTROL",
    "MISC_FILE",
    "MISC_ARCHIVE",
    "MISC_IMAGE",
    "MISC_PCAP",
    "MISC_AUDIO_VIDEO",
    "CRYPTO_PARSE",
    "CRYPTO_RSA",
    "CRYPTO_NUMBER_THEORY",
    "CRYPTO_XOR_CLASSICAL",
    "CRYPTO_PRNG",
    "CRYPTO_SYMMETRIC",
    "CRYPTO_ADVANCED_MATH",
    "SPECIALIST",
  ],
};

export const CRYPTO_STARTER_TOOLS = ["parse_crypto_values", "analyze_rsa_instance"] as const;
export const MISC_STARTER_TOOLS = ["inspect_file", "extract_archive", "analyze_visual", "analyze_pcap_overview"] as const;
