import type { ToolCard, ToolDescriptor, ToolDomain, ToolGroup } from "./types.js";
import { CRYPTO_STARTER_TOOLS, MISC_STARTER_TOOLS, TOOL_GROUPS_BY_DOMAIN } from "./types.js";

const TOKEN = /[a-z0-9_]+/g;

function tokens(s: string): string[] {
  return (s.toLowerCase().match(TOKEN) ?? []).filter((t) => t.length > 1);
}

function overlap(queryTokens: string[], text: string): number {
  const hay = new Set(tokens(text));
  let n = 0;
  for (const t of queryTokens) if (hay.has(t)) n += 1;
  return n;
}

export function signatureOf(tool: ToolDescriptor): string {
  const req = tool.parameters.filter((p) => p.required).map((p) => p.name);
  const opt = tool.parameters.filter((p) => !p.required).map((p) => `${p.name}?`);
  return `{ ${[...req, ...opt].join(", ")} }`;
}

export function toCard(tool: ToolDescriptor): ToolCard {
  const when = tool.whenToUse.slice(0, 3);
  const card: ToolCard = {
    name: tool.name,
    group: tool.group,
    summary: tool.summary,
    whenToUse: when,
    signature: signatureOf(tool),
    cost: tool.cost,
  };
  return card;
}

/** Keep a discovery card under ~500 chars as specified. */
export function compactCard(card: ToolCard): ToolCard {
  const summary = card.summary.length > 180 ? `${card.summary.slice(0, 177)}...` : card.summary;
  const whenToUse = card.whenToUse.map((w) => (w.length > 80 ? `${w.slice(0, 77)}...` : w)).slice(0, 3);
  return { ...card, summary, whenToUse };
}

export function scoreTool(tool: ToolDescriptor, query: string, domain?: ToolDomain | "ANY", group?: ToolGroup): number {
  const q = query.trim().toLowerCase();
  const qTokens = tokens(q);
  let score = 0;
  if (q && tool.name === q) score += 100;
  else if (q && tool.name.includes(q.replace(/\s+/g, "_"))) score += 80;
  else if (q && q.replace(/\s+/g, "_").includes(tool.name)) score += 40;
  if (group && tool.group === group) score += 20;
  if (domain && domain !== "ANY" && tool.domains.includes(domain)) score += 10;
  if (qTokens.length) {
    for (const tag of tool.tags) {
      if (qTokens.includes(tag.toLowerCase()) || tag.toLowerCase().includes(q)) score += 30;
    }
    score += overlap(qTokens, tool.summary) * 10;
    score += overlap(qTokens, tool.whenToUse.join(" ")) * 5;
    score += overlap(qTokens, tool.name.replaceAll("_", " ")) * 15;
    score += overlap(qTokens, tool.group.toLowerCase().replaceAll("_", " ")) * 8;
  }
  return score;
}

export function discoverTools(
  catalog: ToolDescriptor[],
  opts: { query?: string; group?: ToolGroup; domain?: ToolDomain | "ANY"; limit?: number; currentDomain?: ToolDomain | "ANY" },
): { tools: ToolCard[]; groups?: ToolGroup[]; starters?: ToolCard[]; empty: boolean } {
  const limit = Math.min(Math.max(opts.limit ?? 6, 1), 10);
  const domain = opts.domain ?? "ANY";
  const query = opts.query?.trim() ?? "";
  const discoverable = catalog.filter((t) => t.exposure === "DISCOVERABLE");

  if (!query && !opts.group) {
    const d = (opts.domain ?? opts.currentDomain ?? "ANY") as ToolDomain | "ANY";
    const groups = TOOL_GROUPS_BY_DOMAIN[d].filter((g) => g !== "WORKSPACE" && g !== "CONTROL");
    const starterNames = d === "CRYPTO" ? CRYPTO_STARTER_TOOLS : d === "MISC" ? MISC_STARTER_TOOLS : [...MISC_STARTER_TOOLS, ...CRYPTO_STARTER_TOOLS];
    const starters = starterNames
      .map((n) => catalog.find((t) => t.name === n))
      .filter((t): t is ToolDescriptor => Boolean(t))
      .map((t) => compactCard(toCard(t)));
    return { tools: starters.slice(0, limit), groups, starters, empty: starters.length === 0 };
  }

  const pool = discoverable.filter((t) => {
    if (opts.group && t.group !== opts.group) return false;
    if (domain !== "ANY" && !t.domains.includes(domain as ToolDomain)) return false;
    return true;
  });

  const ranked = pool
    .map((t) => ({ t, s: scoreTool(t, query, domain, opts.group) }))
    .filter((x) => x.s > 0 || opts.group)
    .sort((a, b) => b.s - a.s || a.t.name.localeCompare(b.t.name));

  const tools = ranked.slice(0, limit).map((x) => compactCard(toCard(x.t)));
  return { tools, empty: tools.length === 0 };
}
