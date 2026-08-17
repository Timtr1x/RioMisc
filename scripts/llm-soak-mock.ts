// Real-model soak against a subset of Mock contest fixtures.
// Uses the already-stored provider key. Never prints secrets.
// Env:
//   RIO_MOCK_ONLY   comma-separated fixture ids (default: new visual pack + DNS)
//   RIO_SOAK_MS     wall-clock budget (default 900000)
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRepositories } from "@rio/database";
import { FileSecretStore } from "@rio/shared";
import { startRuntime } from "../apps/server/src/index.ts";
import { resolveAgentRuntime } from "../apps/server/src/control/runtime-choice.ts";

const DEFAULT_IDS = [
  "misc-006",
  "misc-008",
  "misc-009",
  "misc-010",
  "misc-011",
  "misc-012",
  "misc-013",
  "misc-014",
  "misc-015",
];

const only = (process.env.RIO_MOCK_ONLY ?? DEFAULT_IDS.join(",")).split(",").map((s) => s.trim()).filter(Boolean);
const budgetMs = Number(process.env.RIO_SOAK_MS ?? 900_000);

async function loadStoredProvider(): Promise<{
  displayName: string;
  protocol: "OPENAI_CHAT_COMPLETIONS" | "OPENAI_RESPONSES" | "ANTHROPIC_MESSAGES";
  baseUrl: string;
  apiKey: string;
  modelName: string;
  contextWindow: number;
  maxOutputTokens: number;
  compatProfile: "AUTO" | "OPENAI" | "DEEPSEEK" | "ZAI" | "ANTHROPIC";
}> {
  const roots = [join(process.cwd(), "data"), join(process.cwd(), "apps", "server", "data")];
  for (const srcData of roots) {
    const srcDb = join(srcData, "database", "rio.sqlite");
    const masterKeyFile = join(srcData, ".master_key");
    const secretsFile = join(srcData, "secrets.enc");
    if (!existsSync(srcDb) || !existsSync(masterKeyFile) || !existsSync(secretsFile)) continue;
    const src = createRepositories(srcDb);
    try {
      const secrets = new FileSecretStore(secretsFile, readFileSync(masterKeyFile, "utf8").trim());
      for (const p of src.providers.list().filter((x) => x.enabled)) {
        const model =
          src.models.listByProvider(p.id).find((m) => m.enabled && m.role === "PRIMARY") ??
          src.models.listByProvider(p.id).find((m) => m.enabled);
        if (!model) continue;
        const apiKey = await secrets.get(p.apiKeyRef);
        if (!apiKey) continue;
        return {
          displayName: p.displayName,
          protocol: p.protocol,
          baseUrl: p.baseUrl,
          apiKey,
          modelName: model.modelName,
          contextWindow: model.contextWindow,
          maxOutputTokens: model.maxOutputTokens,
          compatProfile: p.compatProfile ?? "AUTO",
        };
      }
    } finally {
      src.db.close();
    }
  }
  throw new Error("no enabled provider with a resolvable API key in data/ or apps/server/data/");
}

const live = await loadStoredProvider();
const dataDir = mkdtempSync(join(tmpdir(), "rio-llm-soak-"));
delete process.env.RIO_AGENT_RUNTIME;
process.env.RIO_MOCK_ONLY = only.join(",");

console.log("soak start");
console.log("provider", live.displayName, live.protocol);
console.log("baseUrl", live.baseUrl);
console.log("model", live.modelName);
console.log("keyPresent", true);
console.log("fixtures", only.join(","));
console.log("budgetMs", budgetMs);
console.log("dataDir", dataDir);

const runtime = await startRuntime({
  skipApi: true,
  configOverrides: {
    contest: { adapter: "mock" as const, poll: { initialMs: 1500, maxMs: 3000 } },
    workers: { solverConcurrency: 2, triageConcurrency: 2 },
    agent: { allowMockFallback: false },
    submission: { autoSubmit: true, confidenceThreshold: 0.75, localMaxWrong: 4, defaultCooldownMs: 0 },
    watchdog: { checkMs: 10_000, heartbeatMs: 8000, leaseTtlMs: 45_000 },
    paths: { dataDir, configDir: join(process.cwd(), "config") },
  } as never,
});

try {
  const provider = await runtime.registry.addProvider({
    displayName: live.displayName,
    protocol: live.protocol,
    baseUrl: live.baseUrl,
    apiKey: live.apiKey,
    enabled: true,
    compatProfile: live.compatProfile,
  });
  await runtime.registry.addModel({
    providerId: provider.id,
    modelName: live.modelName,
    contextWindow: live.contextWindow,
    maxOutputTokens: live.maxOutputTokens,
    role: "PRIMARY",
    enabled: true,
  });

  const kind = resolveAgentRuntime(runtime.repos, { allowMockFallback: false });
  console.log("agentRuntime", kind);
  if (kind !== "pi") {
    throw new Error("refusing to soak: runtime is not pi");
  }

  const deadline = Date.now() + budgetMs;
  let lastLine = "";
  while (Date.now() < deadline) {
    const list = runtime.repos.challenges.list();
    const solved = list.filter((c) => c.lifecycleStatus === "SOLVED");
    const line = list
      .map((c) => `${c.remoteId ?? c.id}:${c.lifecycleStatus}`)
      .sort()
      .join(" ");
    if (line !== lastLine) {
      console.log("status", `solved=${solved.length}/${list.length}`, line);
      lastLine = line;
    }
    const solvable = list.filter((c) => c.category !== "WEB");
    if (solvable.length >= only.length && solvable.every((c) => c.lifecycleStatus === "SOLVED")) break;
    await new Promise((r) => setTimeout(r, 4000));
  }

  console.log("\n=== soak result ===");
  for (const c of runtime.repos.challenges.list().sort((a, b) => (a.remoteId ?? a.id).localeCompare(b.remoteId ?? b.id))) {
    const flag = runtime.repos.submissions.listByChallenge(c.id).find((s) => s.status === "CORRECT")?.flagValue;
    const cand = runtime.repos.candidates.listByChallenge(c.id);
    const sess = runtime.repos.sessions.latestForChallenge(c.id);
    console.log(
      [c.remoteId ?? c.id, c.title, c.lifecycleStatus, flag ? `flag=${flag}` : `candidates=${cand.length}`, sess ? `session=${sess.status}` : "session=none"].join(" | "),
    );
    for (const k of cand.slice(0, 4)) {
      console.log(`    candidate ${k.status} conf=${k.confidence} ${k.value}`);
    }
  }
} finally {
  await runtime.close();
  try {
    rmSync(dataDir, { recursive: true, force: true });
  } catch {
    /* windows */
  }
}
