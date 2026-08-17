import {
  discoverToolsParamsSchema,
  executeToolParamsSchema,
  getToolHelpParamsSchema,
} from "@rio/domain";
import type { ToolContext, ToolResult } from "../tools.js";
import type { ToolDescriptor, ToolDomain, ToolGroup } from "./types.js";
import { coreToolsWithoutMeta } from "./core.js";
import { miscTools } from "./misc.js";
import { visualTools } from "./visual.js";
import { cryptoTools } from "./crypto.js";
import { discoverTools } from "./discovery.js";
import { formatToolHelp, usageForInvalidArgs } from "./help.js";

export type { ToolDescriptor, ToolGroup, ToolDomain, ToolHint, ToolCard } from "./types.js";
export { discoverTools, scoreTool, toCard, compactCard, signatureOf } from "./discovery.js";
export { formatToolHelp, MAX_HELP_CHARS } from "./help.js";
export { hintsForInspection, hintsForRsaAnalysis } from "./hints.js";

const META_EXAMPLES = {
  discover: {
    title: "rsa common modulus",
    situation: "Need a tool for two exponents on one n",
    args: { query: "RSA same modulus two exponents", domain: "CRYPTO" },
    expectedSummary: "rsa_common_modulus",
  },
  help: {
    title: "one tool",
    situation: "Learn rsa_common_modulus",
    args: { name: "rsa_common_modulus" },
    expectedSummary: "rsa_common_modulus",
  },
  exec: {
    title: "run hidden",
    situation: "After get_tool_help",
    args: { name: "gcd", args: { a: "12", b: "18" } },
    expectedSummary: "gcd=",
  },
} as const;

function metaDiscover(): ToolDescriptor {
  return {
    name: "discover_tools",
    group: "CONTROL",
    domains: ["MISC", "CRYPTO"],
    exposure: "CORE",
    routerExecutable: false,
    summary: "Search the hidden Misc/Crypto tool catalog. Does not execute anything. Returns at most 10 short cards.",
    whenToUse: ["You know the capability you need but do not see a direct tool", "Start of a crypto/misc branch"],
    whenNotToUse: ["Do not use this to run an attack", "Do not request the full catalog"],
    prerequisites: [],
    schema: discoverToolsParamsSchema,
    parameters: [
      { name: "query", type: "string", required: false, description: "Natural-language or technique name." },
      { name: "group", type: "ToolGroup", required: false, description: "Optional group filter." },
      { name: "domain", type: "MISC|CRYPTO|ANY", required: false, description: "Domain filter." },
      { name: "limit", type: "number", required: false, description: "Default 6, max 10." },
    ],
    examples: [META_EXAMPLES.discover],
    output: { description: "Short tool cards or a group overview when called with no query.", importantFields: ["tools", "groups"], interpretation: ["Then get_tool_help on one name."] },
    failureModes: [{ code: "TOOL_DISCOVERY_EMPTY", meaning: "No match.", recovery: "Broaden the query or omit it for a group overview." }],
    suggestedNextTools: ["get_tool_help", "execute_tool"],
    cost: "CHEAP",
    tags: ["discover", "catalog", "search"],
    run: discoverToolsTool,
  };
}

function metaHelp(): ToolDescriptor {
  return {
    name: "get_tool_help",
    group: "CONTROL",
    domains: ["MISC", "CRYPTO"],
    exposure: "CORE",
    routerExecutable: false,
    summary: "Return the full calling contract for exactly one catalog tool.",
    whenToUse: ["Before execute_tool on an unfamiliar tool"],
    whenNotToUse: ["Do not request several tools at once"],
    prerequisites: ["A tool name from discover_tools or a hint"],
    schema: getToolHelpParamsSchema,
    parameters: [{ name: "name", type: "string", required: true, description: "Exact tool name." }],
    examples: [META_EXAMPLES.help],
    output: { description: "Parameters, example, failure meaning, next tools.", importantFields: ["parameters", "example"], interpretation: ["Copy the example shape. Integers are strings."] },
    failureModes: [{ code: "UNKNOWN_TOOL", meaning: "Name not in the catalog.", recovery: "discover_tools first." }],
    suggestedNextTools: ["execute_tool"],
    cost: "CHEAP",
    tags: ["help", "manual", "schema"],
    run: getToolHelpTool,
  };
}

function metaExecute(): ToolDescriptor {
  return {
    name: "execute_tool",
    group: "CONTROL",
    domains: ["MISC", "CRYPTO"],
    exposure: "CORE",
    routerExecutable: false,
    summary: "Run one DISCOVERABLE catalog tool by name. Control tools cannot be reached this way.",
    whenToUse: ["After get_tool_help, with the documented args"],
    whenNotToUse: ["Do not execute submit_flag_candidate / request_handoff / request_reflection this way", "Do not pass path traversal as a name"],
    prerequisites: ["Name must be a DISCOVERABLE catalog tool"],
    schema: executeToolParamsSchema,
    parameters: [
      { name: "name", type: "string", required: true, description: "Exact discoverable tool name." },
      { name: "args", type: "object", required: true, description: "Arguments matching that tool's schema." },
    ],
    examples: [META_EXAMPLES.exec],
    output: { description: "Whatever the inner tool returns, including hints.", importantFields: ["ok", "data"], interpretation: ["Validation errors include the correct usage and an example."] },
    failureModes: [
      { code: "TOOL_NOT_EXECUTABLE", meaning: "Core/control tool or unknown name.", recovery: "Only DISCOVERABLE tools. Call the core tool directly." },
      { code: "TOOL_ARGUMENT_INVALID", meaning: "Args failed the inner Zod schema.", recovery: "Read usage/example in the error and retry once." },
    ],
    suggestedNextTools: ["get_tool_help", "discover_tools"],
    cost: "NORMAL",
    tags: ["execute", "router"],
    run: executeToolTool,
  };
}

let CATALOG: ToolDescriptor[] | null = null;

export function TOOL_CATALOG(): ToolDescriptor[] {
  if (!CATALOG) {
    CATALOG = [...coreToolsWithoutMeta(), ...miscTools(), ...visualTools(), ...cryptoTools(), metaDiscover(), metaHelp(), metaExecute()];
  }
  return CATALOG;
}

export function getCatalogTool(name: string): ToolDescriptor | undefined {
  return TOOL_CATALOG().find((t) => t.name === name);
}

export function listDirectPiTools(): ToolDescriptor[] {
  return TOOL_CATALOG().filter((t) => t.exposure === "CORE");
}

export function listDiscoverableTools(): ToolDescriptor[] {
  return TOOL_CATALOG().filter((t) => t.exposure === "DISCOVERABLE");
}

function emitTelemetry(ctx: ToolContext, code: string, extra: Record<string, unknown> = {}): void {
  ctx.emit("tool_telemetry", { challengeId: ctx.challengeId, sessionId: ctx.sessionId, code, ...extra });
}

function ok(summary: string, data: unknown, started: number): ToolResult {
  return { ok: true, summary, data, durationMs: Date.now() - started };
}

function fail(code: string, message: string, started: number, extra: Partial<ToolResult> = {}): ToolResult {
  return { ok: false, summary: message, durationMs: Date.now() - started, error: { code, message }, ...extra };
}

export async function discoverToolsTool(ctx: ToolContext, params: unknown): Promise<ToolResult> {
  const started = Date.now();
  const p = discoverToolsParamsSchema.safeParse(params ?? {});
  if (!p.success) return fail("VALIDATION", p.error.issues[0]?.message ?? "bad params", started);
  const currentDomain = (ctx.solverDomain ?? "ANY") as ToolDomain | "ANY";
  const found = discoverTools(TOOL_CATALOG(), {
    query: p.data.query,
    group: p.data.group as ToolGroup | undefined,
    domain: p.data.domain,
    limit: p.data.limit,
    currentDomain,
  });
  emitTelemetry(ctx, found.empty ? "TOOL_DISCOVERY_EMPTY" : "TOOL_DISCOVERY", {
    query: p.data.query ?? "",
    domain: p.data.domain ?? currentDomain,
    count: found.tools.length,
  });
  const summary = found.empty
    ? "no matching tools — broaden the query or omit it for a group overview"
    : `found ${found.tools.length} tool(s)` + (found.groups ? `; groups: ${found.groups.join(", ")}` : "");
  return ok(summary, found, started);
}

export async function getToolHelpTool(ctx: ToolContext, params: unknown): Promise<ToolResult> {
  const started = Date.now();
  const p = getToolHelpParamsSchema.safeParse(params);
  if (!p.success) return fail("VALIDATION", p.error.issues[0]?.message ?? "bad params", started);
  const tool = getCatalogTool(p.data.name);
  if (!tool) {
    emitTelemetry(ctx, "TOOL_DISCOVERY_EMPTY", { name: p.data.name });
    return fail("UNKNOWN_TOOL", `no catalog entry named ${p.data.name}`, started);
  }
  emitTelemetry(ctx, "TOOL_HELP_VIEWED", { name: tool.name });
  return ok(`help for ${tool.name}`, formatToolHelp(tool), started);
}

export async function executeToolTool(ctx: ToolContext, params: unknown): Promise<ToolResult> {
  const started = Date.now();
  const p = executeToolParamsSchema.safeParse(params);
  if (!p.success) return fail("VALIDATION", p.error.issues[0]?.message ?? "bad params", started);
  const name = p.data.name;
  if (name.includes("/") || name.includes("\\") || name.includes("..")) {
    return fail("TOOL_NOT_EXECUTABLE", "execute_tool only accepts catalog names", started);
  }
  const tool = getCatalogTool(name);
  if (!tool) return fail("TOOL_NOT_EXECUTABLE", `${name} is not in the tool catalog whitelist`, started);
  if (tool.exposure !== "DISCOVERABLE" || tool.routerExecutable === false) {
    return fail("TOOL_NOT_EXECUTABLE", `${name} is a core/control tool — call it directly, not via execute_tool`, started);
  }
  const parsed = tool.schema.safeParse(p.data.args ?? {});
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
    const usage = usageForInvalidArgs(tool, issues);
    emitTelemetry(ctx, "TOOL_ARGUMENT_INVALID", { name, issues });
    return {
      ok: false,
      summary: `${name} requires ${tool.parameters.filter((x) => x.required).map((x) => x.name).join(", ") || "valid arguments"}.`,
      data: { usage, example: tool.examples[0]?.args ?? {}, help: formatToolHelp(tool) },
      durationMs: Date.now() - started,
      error: { code: "TOOL_ARGUMENT_INVALID", message: issues.map((i) => i.message).join("; ") },
    };
  }
  emitTelemetry(ctx, "TOOL_EXECUTED_VIA_ROUTER", { name });
  const { runTool } = await import("../tools.js");
  return runTool(ctx, name, parsed.data);
}
