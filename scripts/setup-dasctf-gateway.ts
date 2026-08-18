/**
 * Create a DASCTF LLM-gateway Provider from the live MiniMax API key already
 * stored for an existing provider, then switch primary solver to it.
 *
 * Reads secrets from apps/server/data (tsx watch cwd) or ./data.
 * Gateway URL from .env.local DASCTF_LLM_GATEWAY_URL.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { FileSecretStore } from "../packages/shared/src/secrets.ts";
import { createRepositories } from "../packages/database/src/index.ts";

function loadDotEnvLocal(): void {
  const p = resolve(process.cwd(), ".env.local");
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!m) continue;
    if (!process.env[m[1]!]) process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
  }
}

function resolveDataDir(): string {
  for (const cand of [resolve("apps/server/data"), resolve("data")]) {
    if (existsSync(join(cand, "secrets.enc")) && existsSync(join(cand, ".master_key"))) return cand;
  }
  throw new Error("cannot find data/secrets.enc + .master_key");
}

async function main(): Promise<void> {
  loadDotEnvLocal();
  const gateway =
    process.env.DASCTF_LLM_GATEWAY_URL?.trim() ||
    "https://llm-gateway.dasctf.com/llm-gateway/proxy/e/ROOTaD_VNfr2UJwy";
  const apiBase = process.env.RIO_API_BASE?.trim() || "http://127.0.0.1:3000";
  const dataDir = resolveDataDir();
  const masterKey = readFileSync(join(dataDir, ".master_key"), "utf8").trim();
  const secrets = new FileSecretStore(join(dataDir, "secrets.enc"), masterKey);
  const repos = createRepositories(join(dataDir, "database", "rio.sqlite"));

  const source =
    repos.providers.list().find((p) => p.enabled && /minimax/i.test(p.displayName) && /anthropic/i.test(p.baseUrl)) ??
    repos.providers.list().find((p) => /minimax/i.test(p.displayName) && p.enabled) ??
    repos.providers.list().find((p) => /minimax/i.test(p.displayName));
  if (!source) throw new Error("no MiniMax provider found to copy API key from");
  const apiKey = await secrets.get(source.apiKeyRef);
  if (!apiKey) throw new Error(`no API key stored for ${source.id} (${source.apiKeyRef})`);

  const existing = repos.providers
    .list()
    .find((p) => p.enabled && p.baseUrl.replace(/\/+$/, "") === gateway.replace(/\/+$/, ""));
  let providerId = existing?.id;
  if (!providerId) {
    const created = await fetch(`${apiBase}/api/providers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        displayName: "DASCTF Gateway (MiniMax)",
        protocol: "ANTHROPIC_MESSAGES",
        baseUrl: gateway,
        apiKey,
        compatProfile: "ANTHROPIC",
      }),
    });
    const body = (await created.json()) as { ok?: boolean; provider?: { id: string }; error?: string };
    if (!created.ok || !body.provider?.id) throw new Error(`create provider failed: ${JSON.stringify(body)}`);
    providerId = body.provider.id;
    console.log("created provider", providerId);
  } else {
    console.log("reusing gateway provider", providerId);
  }

  const models = repos.models.listByProvider(providerId!).filter((m) => m.enabled);
  let modelId = models.find((m) => /minimax/i.test(m.modelName))?.id ?? models[0]?.id;
  if (!modelId) {
    const created = await fetch(`${apiBase}/api/models`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        providerId,
        modelName: "MiniMax-M3",
        contextWindow: 200000,
        maxOutputTokens: 8192,
        role: "PRIMARY",
      }),
    });
    const body = (await created.json()) as { ok?: boolean; model?: { id: string }; error?: string };
    if (!created.ok || !body.model?.id) throw new Error(`create model failed: ${JSON.stringify(body)}`);
    modelId = body.model.id;
    console.log("created model", modelId);
  } else {
    console.log("reusing model", modelId);
  }

  const assign = await fetch(`${apiBase}/api/models/assignments`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      primarySolverModelId: modelId,
      reflectionModelId: modelId,
      managerModelId: modelId,
    }),
  });
  console.log("assignments", assign.status, await assign.text());

  const test = await fetch(`${apiBase}/api/providers/${providerId}/test`, { method: "POST" });
  console.log("test", test.status, await test.text());

  const providers = await (await fetch(`${apiBase}/api/providers`)).json();
  const gw = (providers.providers as { id: string; displayName: string; baseUrl: string; enabled: boolean }[]).find(
    (p) => p.id === providerId,
  );
  console.log("gateway provider:", gw);
  console.log("primary:", providers.assignments?.primarySolverModelId);
  repos.db.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
