import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { TOOL_CATALOG, signatureOf } from "@rio/tool-runtime";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const OUT = join(ROOT, "docs", "tools");

function mdEscape(s: string): string {
  return s.replaceAll("|", "\\|");
}

function sectionFor(title: string, tools: ReturnType<typeof TOOL_CATALOG>): string {
  const lines = [`# ${title}`, ""];
  for (const t of tools.sort((a, b) => a.name.localeCompare(b.name))) {
    lines.push(`## \`${t.name}\``);
    lines.push("");
    lines.push(`- group: \`${t.group}\``);
    lines.push(`- exposure: \`${t.exposure}\``);
    lines.push(`- cost: \`${t.cost}\``);
    lines.push(`- signature: \`${signatureOf(t)}\``);
    lines.push("");
    lines.push(t.summary);
    lines.push("");
    lines.push("**When to use**");
    for (const w of t.whenToUse) lines.push(`- ${w}`);
    lines.push("");
    lines.push("**When not to use**");
    for (const w of t.whenNotToUse) lines.push(`- ${w}`);
    lines.push("");
    lines.push("**Parameters**");
    lines.push("");
    lines.push("| name | type | required | description |");
    lines.push("| --- | --- | --- | --- |");
    for (const p of t.parameters) {
      lines.push(`| ${p.name} | ${mdEscape(p.type)} | ${p.required ? "yes" : "no"} | ${mdEscape(p.description)} |`);
    }
    lines.push("");
    if (t.examples[0]) {
      lines.push("**Example**");
      lines.push("");
      lines.push("```json");
      lines.push(JSON.stringify(t.examples[0].args, null, 2));
      lines.push("```");
      lines.push("");
    }
    lines.push("**Output**");
    lines.push("");
    lines.push(t.output.description);
    lines.push("");
  }
  return lines.join("\n");
}

function main(): void {
  mkdirSync(OUT, { recursive: true });
  const all = TOOL_CATALOG();
  const misc = all.filter((t) => t.domains.includes("MISC") && (t.group.startsWith("MISC") || t.group === "SPECIALIST" || t.group === "WORKSPACE"));
  const crypto = all.filter((t) => t.group.startsWith("CRYPTO"));
  const visual = all.filter((t) => t.group === "MISC_IMAGE" || t.group === "MISC_AUDIO_VIDEO");
  const index = [
    "# RioMisc Tool Catalog",
    "",
    "Generated from `TOOL_CATALOG`. Do not edit by hand. Run `npm run docs:tools`.",
    "",
    `- total: ${all.length}`,
    `- CORE (Pi direct): ${all.filter((t) => t.exposure === "CORE").length}`,
    `- DISCOVERABLE: ${all.filter((t) => t.exposure === "DISCOVERABLE").length}`,
    "",
    "- [misc.md](./misc.md)",
    "- [crypto.md](./crypto.md)",
    "- [visual.md](./visual.md)",
    "",
    "## Core tools",
    "",
    ...all.filter((t) => t.exposure === "CORE").map((t) => `- \`${t.name}\` — ${t.summary}`),
    "",
  ].join("\n");
  writeFileSync(join(OUT, "README.md"), index);
  writeFileSync(join(OUT, "misc.md"), sectionFor("Misc tools", misc));
  writeFileSync(join(OUT, "crypto.md"), sectionFor("Crypto tools", crypto));
  writeFileSync(join(OUT, "visual.md"), sectionFor("Visual / media tools", visual));
  process.stdout.write(`wrote ${OUT}\n`);
}

main();
