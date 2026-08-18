/**
 * Live probe for DASCTF Agent API (game/api_doc.md).
 *
 * Prefer gitignored `.env.local`:
 *   DASCTF_ACCESS_KEY=ak_live_...
 *   DASCTF_BASE_URL=https://pro.dasctf.com
 *   npx tsx scripts/dasctf-probe.ts
 *
 * Does NOT print the AccessKey. Safe to re-run.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  DasctfAgentContestAdapter,
  normalizeDasctfBaseUrl,
} from "../packages/contest/src/dasctf.ts";

function loadDotEnvLocal(): void {
  const p = resolve(process.cwd(), ".env.local");
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!m) continue;
    const key = m[1]!;
    let val = m[2] ?? "";
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = val;
  }
}

loadDotEnvLocal();

const baseUrl = process.env.DASCTF_BASE_URL?.trim() || "https://pro.dasctf.com";
const accessKey = process.env.DASCTF_ACCESS_KEY?.trim();
if (!accessKey) {
  console.error("DASCTF_ACCESS_KEY is required (set in .env.local or the environment)");
  process.exit(2);
}

async function once(label: string): Promise<void> {
  const adapter = new DasctfAgentContestAdapter({ baseUrl, accessKey: accessKey!, miscCryptoOnly: true });
  console.log(`\n=== ${label} ===`);
  console.log("base:", normalizeDasctfBaseUrl(baseUrl));
  await adapter.authenticate();
  console.log("authenticate: OK (match-info)");
  const list = await adapter.listChallenges();
  console.log(`listChallenges: ${list.length} misc/crypto open+unsolved`);
  for (const c of list.slice(0, 12)) {
    console.log(`  - ${c.remoteId} [${c.category}] ${c.title}`);
  }
  if (list[0]) {
    const d = await adapter.getChallenge(list[0].remoteId);
    console.log(`getChallenge(${list[0].title}): attachments=${d.attachments.length} score=${d.score}`);
    console.log(`  desc preview: ${d.description.slice(0, 160).replace(/\s+/g, " ")}`);
  }
  const caps = await adapter.getCapabilities();
  console.log("caps:", JSON.stringify(caps));
}

async function main(): Promise<void> {
  await once("pass-1");
  // Platform returns code 40001 when polled too aggressively.
  await new Promise((r) => setTimeout(r, 8_000));
  await once("pass-2");
  await new Promise((r) => setTimeout(r, 8_000));
  await once("pass-3");
  console.log("\nAll three live probes succeeded.");
}

main().catch((e) => {
  console.error("PROBE FAILED:", e);
  process.exit(1);
});
