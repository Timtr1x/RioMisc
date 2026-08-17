import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRepositories } from "@rio/database";
import { WorkspaceManager, runTool, type ToolContext } from "@rio/tool-runtime";
import { encodePng } from "@rio/visual-runtime";
import { experimentKey } from "@rio/misc-runtime";
import { rsaSmallE, rsaFermat, lcgRecover, rsaWiener } from "@rio/crypto-runtime";
import { runBenchmark, replayLookup } from "@rio/eval";
import { scoreProposedTest, shouldReflect } from "../../apps/server/src/control/planner.ts";
import { resolveAssignedModel } from "../../apps/server/src/control/model-assignments.ts";

function makeCtx(root: string, challengeId = "ch_m2"): ToolContext {
  const wm = new WorkspaceManager(join(root, "ws"));
  const layout = wm.ensure(challengeId);
  const map = new Map<string, { summary: string; outcome: string }>();
  return {
    challengeId,
    workspace: layout,
    sessionId: "s",
    safeResolve: (p) => wm.safeResolve(layout.root, p),
    emit: () => {},
    recordArtifact: (_op, abs) => ({ path: abs, size: 1, sha256: "x" }),
    nextResultFile: () => join(layout.results, "t.txt"),
    pythonExecutable: "python",
    experiments: {
      lookup: (k) => map.get(k) ?? null,
      record: (e) => {
        map.set(e.key, { summary: e.summary, outcome: e.outcome });
      },
    },
  };
}

describe("MVP-2 misc/crypto/planner/eval", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  it("scan_trailing_data finds bytes after a PNG IEND", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rio-m2t-"));
    dirs.push(dir);
    const ctx = makeCtx(dir);
    const png = encodePng({ width: 2, height: 2, data: new Uint8Array(16).fill(255) });
    writeFileSync(join(ctx.workspace.input, "a.png"), Buffer.concat([png, Buffer.from("PK\x03\x04hidden")]));
    const r = await runTool(ctx, "scan_trailing_data", { path: "input/a.png" });
    expect(r.ok).toBe(true);
    const data = r.data as { hasTrailingData: boolean; magic: string; bytes: number };
    expect(data.hasTrailingData).toBe(true);
    expect(data.bytes).toBeGreaterThan(4);
  });

  it("refuses the same tool+path unless force=true", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rio-m2e-"));
    dirs.push(dir);
    const ctx = makeCtx(dir);
    writeFileSync(join(ctx.workspace.input, "a.bin"), Buffer.from("hello flag{x} world"));
    const a = await runTool(ctx, "extract_strings_summary", { path: "input/a.bin" });
    const b = await runTool(ctx, "extract_strings_summary", { path: "input/a.bin" });
    expect(a.ok).toBe(true);
    expect(b.error?.code).toBe("ALREADY_TESTED");
    const c = await runTool(ctx, "extract_strings_summary", { path: "input/a.bin", force: true });
    expect(c.error?.code).not.toBe("ALREADY_TESTED");
    expect(experimentKey("path:input/a.bin", "extract_strings_summary", { path: "input/a.bin" })).toHaveLength(64);
  });

  it("rsa_small_e recovers the cube-root message via the shipped tool", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rio-m2r-"));
    dirs.push(dir);
    const ctx = makeCtx(dir);
    const m = Buffer.from("flag{cube}").reduce((a, b) => (a << 8n) + BigInt(b), 0n);
    const c = m ** 3n;
    const r = await runTool(ctx, "rsa_small_e", { c: c.toString(), e: "3" });
    expect(r.ok).toBe(true);
    expect((r.data as { m: string }).m).toBe(m.toString());
    expect(rsaSmallE(c, 3n)?.toString()).toBe(m.toString());
  });

  it("rsa_fermat and lcg_recover and wiener use real attacks", () => {
    const fac = rsaFermat(10007n * 10009n, 50);
    expect(fac?.p === 10007n || fac?.q === 10007n).toBe(true);
    const rec = lcgRecover([42n, 1664567n], 0x100000000n);
    // 2 samples not enough
    expect(rec).toBeNull();
    const a = 1664525n;
    const c = 1013904223n;
    const mod = 0x100000000n;
    let x = 7n;
    const s: bigint[] = [];
    for (let i = 0; i < 4; i++) {
      x = (a * x + c) % mod;
      s.push(x);
    }
    expect(lcgRecover(s, mod)?.a).toBe(a);
    const p = 1223n;
    const q = 1987n;
    const n = p * q;
    const phi = (p - 1n) * (q - 1n);
    const d = 17n;
    let e = 3n;
    while ((e * d) % phi !== 1n) e += 2n;
    expect(rsaWiener(n, e)).toBe(d);
  });

  it("request_specialist RSA returns attack candidates from analyze_rsa_instance", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rio-m2s-"));
    dirs.push(dir);
    const ctx = makeCtx(dir);
    const r = await runTool(ctx, "request_specialist", { kind: "RSA", text: "n=10007*10009 e=3 c=8" });
    expect(r.ok).toBe(true);
    expect(String((r.data as { conclusion: string }).conclusion)).toMatch(/RSA/);
  });

  it("benchmark runner solves the shipped fixtures", async () => {
    const results = await runBenchmark();
    expect(results.length).toBeGreaterThanOrEqual(6);
    const failed = results.filter((r) => !r.solved).map((r) => `${r.manifestId}: ${r.error}`);
    expect(failed).toEqual([]);
  });

  it("replayLookup returns the recorded tool result and not a reimplementation", () => {
    const log = [{ tool: "scan_trailing_data", canonicalArgs: "{\"path\":\"a\"}", result: { hasTrailingData: true } }];
    expect(replayLookup(log, "scan_trailing_data", "{\"path\":\"a\"}")).toEqual({ hasTrailingData: true });
    expect(replayLookup(log, "scan_trailing_data", "{\"path\":\"b\"}")).toBeUndefined();
  });

  it("planner scoring and reflection triggers follow the guide weights", () => {
    expect(scoreProposedTest({ tool: "x", args: {}, expectedInformation: "HIGH", ifPositive: "", ifNegative: "", estimatedCost: "CHEAP" }, false)).toBe(3);
    expect(scoreProposedTest({ tool: "x", args: {}, expectedInformation: "HIGH", ifPositive: "", ifNegative: "", estimatedCost: "CHEAP" }, true)).toBe(-1);
    expect(shouldReflect({ noSignalStreak: 3, secondsSinceProgress: 10, wrongFlags: 0, repeatedTool: false })).toBe("no_signal_streak");
    expect(shouldReflect({ noSignalStreak: 0, secondsSinceProgress: 10, wrongFlags: 1, repeatedTool: false })).toBe("wrong_flag");
  });

  it("resolveAssignedModel prefers the vision-capable model for vision slot", () => {
    const dir = mkdtempSync(join(tmpdir(), "rio-m2a-"));
    dirs.push(dir);
    const repos = createRepositories(join(dir, "t.sqlite"));
    const p = repos.providers.create({
      displayName: "p",
      protocol: "OPENAI_CHAT_COMPLETIONS",
      baseUrl: "https://x",
      apiKeyRef: "k",
      enabled: true,
    });
    const vis = repos.models.create({
      providerId: p.id,
      modelName: "see",
      contextWindow: 8,
      maxOutputTokens: 8,
      capabilities: { text: true, toolCalling: true, vision: true, reasoning: false, structuredOutput: false },
    });
    repos.settings.set("models.assignments", JSON.stringify({ visionModelId: vis.id, primarySolverModelId: null, reflectionModelId: null, triageModelId: null }));
    expect(resolveAssignedModel(repos, "vision")?.modelName).toBe("see");
    repos.db.close();
  });
});
