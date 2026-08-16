import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRepositories } from "@rio/database";
import { createLogger, FileSecretStore } from "@rio/shared";
import { ModelRegistry } from "../../apps/server/src/control/registry.ts";
import {
  inferModelCapabilities,
  loadModelAssignments,
  patchModelAssignments,
  parseModelAssignments,
} from "../../apps/server/src/control/model-assignments.ts";
import { selectVisionTestModel, visionTestPassed, buildVisionTestPayload } from "../../apps/server/src/control/capability-test.ts";
import { applySchemaMigrations } from "../../packages/database/src/schema-migrations.ts";
import { RioDb } from "@rio/database";
import { DatabaseSync } from "node:sqlite";

describe("model capabilities and assignments", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
  });

  it("infers vision from model name and keeps text/tools on by default", () => {
    expect(inferModelCapabilities("deepseek-v4-flash")).toMatchObject({ text: true, toolCalling: true, vision: false });
    expect(inferModelCapabilities("qwen2.5-vl-72b")).toMatchObject({ vision: true, text: true });
    expect(inferModelCapabilities("gpt-4o")).toMatchObject({ vision: true });
  });

  it("persists capabilities through ModelRepository", () => {
    const dir = mkdtempSync(join(tmpdir(), "rio-cap-"));
    dirs.push(dir);
    const repos = createRepositories(join(dir, "t.sqlite"));
    const p = repos.providers.create({
      displayName: "p",
      protocol: "OPENAI_CHAT_COMPLETIONS",
      baseUrl: "https://example.com",
      apiKeyRef: "k",
      enabled: true,
    });
    const m = repos.models.create({
      providerId: p.id,
      modelName: "see-v1",
      contextWindow: 8000,
      maxOutputTokens: 1024,
      capabilities: { text: true, toolCalling: true, vision: true, reasoning: false, structuredOutput: false },
    });
    const loaded = repos.models.get(m.id);
    expect(loaded?.capabilities.vision).toBe(true);
    expect(loaded?.capabilities.text).toBe(true);
    repos.models.update(m.id, {
      capabilities: { text: true, toolCalling: true, vision: false, reasoning: true, structuredOutput: false },
    });
    expect(repos.models.get(m.id)?.capabilities).toMatchObject({ vision: false, reasoning: true });
    repos.db.close();
  });

  it("stores assignments in runtime_settings without inventing a VISION role", () => {
    const dir = mkdtempSync(join(tmpdir(), "rio-asg-"));
    dirs.push(dir);
    const repos = createRepositories(join(dir, "t.sqlite"));
    expect(loadModelAssignments(repos)).toEqual({
      primarySolverModelId: null,
      reflectionModelId: null,
      visionModelId: null,
      triageModelId: null,
    });
    patchModelAssignments(repos, { visionModelId: "model_vis", primarySolverModelId: "model_txt" });
    const loaded = loadModelAssignments(repos);
    expect(loaded.visionModelId).toBe("model_vis");
    expect(loaded.primarySolverModelId).toBe("model_txt");
    expect(parseModelAssignments(repos.settings.get("models.assignments")).visionModelId).toBe("model_vis");
    repos.db.close();
  });

  it("selectVisionTestModel only returns models with capabilities.vision", () => {
    const text = {
      id: "m1",
      providerId: "p",
      modelName: "t",
      contextWindow: 1,
      maxOutputTokens: 1,
      enabled: true,
      role: "PRIMARY" as const,
      createdAt: 0,
      capabilities: { text: true, toolCalling: true, vision: false, reasoning: false, structuredOutput: false },
    };
    const vis = { ...text, id: "m2", modelName: "v", role: "GENERAL" as const, capabilities: { ...text.capabilities, vision: true } };
    expect(selectVisionTestModel([text], null)).toBeNull();
    expect(selectVisionTestModel([text, vis], null)?.id).toBe("m2");
    expect(selectVisionTestModel([text, vis], "m2")?.modelName).toBe("v");
  });

  it("visionTestPassed requires the official phrase", () => {
    expect(visionTestPassed("RIO VISION OK")).toBe(true);
    expect(visionTestPassed("the image says rio vision ok clearly")).toBe(true);
    expect(visionTestPassed("a cat sitting on a bench")).toBe(false);
  });

  it("buildVisionTestPayload embeds the official PNG as data URL", () => {
    const payload = buildVisionTestPayload("vision-x");
    const content = (payload.messages as { content: { type: string; image_url?: { url: string } }[] }[])[0]!.content;
    const img = content.find((c) => c.type === "image_url")?.image_url?.url ?? "";
    expect(img.startsWith("data:image/png;base64,")).toBe(true);
    expect(img.length).toBeGreaterThan(80);
  });

  it("testConnection runs vision only when a vision-capable model exists", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rio-vt-"));
    dirs.push(dir);
    const repos = createRepositories(join(dir, "t.sqlite"));
    const secrets = new FileSecretStore(join(dir, "secrets.enc"), "0".repeat(64));
    const p = repos.providers.create({
      displayName: "p",
      protocol: "OPENAI_CHAT_COMPLETIONS",
      baseUrl: "https://api.example.com/v1",
      apiKeyRef: "provider.apiKey.x",
      enabled: true,
    });
    await secrets.set("provider.apiKey.x", "sk-test");
    repos.models.create({
      providerId: p.id,
      modelName: "text-only",
      contextWindow: 8000,
      maxOutputTokens: 256,
      role: "PRIMARY",
      capabilities: { text: true, toolCalling: true, vision: false, reasoning: false, structuredOutput: false },
    });

    const seen: string[] = [];
    const fetchText: typeof fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { messages?: unknown; tools?: unknown };
      const asVision = JSON.stringify(body.messages ?? "").includes("image_url");
      seen.push(body.tools ? "tools" : asVision ? "vision" : "text");
      if (body.tools) {
        return new Response(JSON.stringify({ choices: [{ message: { tool_calls: [{ id: "1" }] } }] }), { status: 200 });
      }
      return new Response(
        JSON.stringify({ choices: [{ message: { content: asVision ? "RIO VISION OK" : "OK" } }] }),
        { status: 200 },
      );
    };
    const reg = new ModelRegistry(repos, secrets, createLogger("silent"), fetchText);
    const noVision = await reg.testConnection(p.id);
    expect(noVision.visionApi).toBeNull();
    expect(seen.includes("vision")).toBe(false);
    expect(noVision.textApi).toBe(true);
    expect(noVision.toolCall).toBe(true);

    repos.models.create({
      providerId: p.id,
      modelName: "see-me",
      contextWindow: 8000,
      maxOutputTokens: 256,
      capabilities: { text: true, toolCalling: true, vision: true, reasoning: false, structuredOutput: false },
    });
    seen.length = 0;
    const withVision = await reg.testConnection(p.id);
    expect(seen.includes("vision")).toBe(true);
    expect(withVision.visionApi).toBe(true);
    repos.db.close();
  });

  it("migrates capabilities_json onto an existing models table", () => {
    const dir = mkdtempSync(join(tmpdir(), "rio-mig3-"));
    dirs.push(dir);
    const path = join(dir, "t.sqlite");
    const raw = new DatabaseSync(path);
    raw.exec(`CREATE TABLE models (
      id TEXT PRIMARY KEY,
      provider_id TEXT NOT NULL,
      model_name TEXT NOT NULL,
      context_window INTEGER NOT NULL,
      max_output_tokens INTEGER NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      role TEXT NOT NULL DEFAULT 'GENERAL',
      created_at INTEGER NOT NULL
    )`);
    raw.close();
    const db = new RioDb(path);
    applySchemaMigrations(db);
    const cols = db.all<{ name: string }>("PRAGMA table_info(models)");
    expect(cols.some((c) => c.name === "capabilities_json")).toBe(true);
    const tables = db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table'");
    expect(tables.some((t) => t.name === "visual_evidence")).toBe(true);
    db.close();
  });
});
