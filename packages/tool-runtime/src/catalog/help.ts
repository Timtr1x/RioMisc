import type { ToolDescriptor } from "./types.js";
import { signatureOf } from "./discovery.js";

export const MAX_HELP_CHARS = 6000;

export function formatToolHelp(tool: ToolDescriptor): Record<string, unknown> {
  const example = tool.examples[0];
  const help = {
    name: tool.name,
    group: tool.group,
    summary: tool.summary,
    whenToUse: tool.whenToUse,
    whenNotToUse: tool.whenNotToUse,
    prerequisites: tool.prerequisites,
    parameters: tool.parameters,
    signature: signatureOf(tool),
    example: example
      ? { title: example.title, situation: example.situation, args: example.args, expectedSummary: example.expectedSummary }
      : null,
    output: tool.output,
    failureMeaning: tool.failureModes.map((f) => `${f.code}: ${f.meaning} → ${f.recovery}`).join(" "),
    failureModes: tool.failureModes,
    suggestedNextTools: tool.suggestedNextTools,
    cost: tool.cost,
    note: "All cryptographic integers are strings (decimal or 0x hex). Do not pass JSON numbers.",
  };
  let json = JSON.stringify(help);
  if (json.length <= MAX_HELP_CHARS) return help;
  const compact = {
    name: tool.name,
    group: tool.group,
    summary: tool.summary,
    whenToUse: tool.whenToUse.slice(0, 4),
    whenNotToUse: tool.whenNotToUse.slice(0, 3),
    parameters: tool.parameters,
    signature: signatureOf(tool),
    example: example?.args ?? null,
    output: { description: tool.output.description, importantFields: tool.output.importantFields },
    failureMeaning: tool.failureModes[0] ? `${tool.failureModes[0].code}: ${tool.failureModes[0].meaning}` : "",
    suggestedNextTools: tool.suggestedNextTools,
    cost: tool.cost,
  };
  json = JSON.stringify(compact);
  if (json.length <= MAX_HELP_CHARS) return compact;
  return {
    name: tool.name,
    summary: tool.summary.slice(0, 400),
    parameters: tool.parameters,
    example: example?.args ?? null,
    suggestedNextTools: tool.suggestedNextTools,
  };
}

export function usageForInvalidArgs(tool: ToolDescriptor, issues: { path: string; message: string }[]): Record<string, unknown> {
  const missing = issues
    .filter((i) => /required|expected/i.test(i.message) || i.message.includes("undefined"))
    .map((i) => i.path)
    .filter(Boolean);
  const required = tool.parameters.filter((p) => p.required).map((p) => p.name);
  return {
    name: tool.name,
    required,
    missing: missing.length ? missing : required.filter((n) => issues.some((i) => i.path === n || i.message.includes(n))),
    parameters: tool.parameters,
    example: tool.examples[0]?.args ?? {},
    issues,
  };
}
