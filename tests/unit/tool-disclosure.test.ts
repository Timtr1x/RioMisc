import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  TOOL_CATALOG,
  listDirectPiTools,
  listDiscoverableTools,
  runTool,
  formatToolResultForModel,
  WorkspaceManager,
  type ToolContext,
  MAX_HELP_CHARS,
} from "@rio/tool-runtime";
import { encodePng } from "@rio/visual-runtime";
import { makePcapHttp, makeZip } from "@rio/contest";
import { rsaCommonModulus, modPow } from "@rio/crypto-runtime";

function makeCtx(root: string, challengeId = "ch_disc"): ToolContext {
  const wm = new WorkspaceManager(join(root, "ws"));
  const layout = wm.ensure(challengeId);
  const map = new Map<string, { summary: string; outcome: string }>();
  const telemetry: { code: string; name?: string }[] = [];
  const ctx: ToolContext = {
    challengeId,
    workspace: layout,
    sessionId: "s",
    solverDomain: "CRYPTO",
    safeResolve: (p) => wm.safeResolve(layout.root, p),
    emit: (kind, payload) => {
      if (kind === "tool_telemetry") telemetry.push({ code: String(payload.code), name: payload.name as string | undefined });
    },
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
  (ctx as ToolContext & { telemetry: typeof telemetry }).telemetry = telemetry;
  return ctx;
}

describe("progressive tool disclosure", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  it("exposes at most 15 CORE tools to Pi and hides discoverable ones", () => {
    const direct = listDirectPiTools();
    expect(direct.length).toBeLessThanOrEqual(15);
    expect(direct.every((t) => t.exposure === "CORE")).toBe(true);
    const names = new Set(direct.map((t) => t.name));
    expect(names.has("discover_tools")).toBe(true);
    expect(names.has("get_tool_help")).toBe(true);
    expect(names.has("execute_tool")).toBe(true);
    expect(names.has("submit_flag_candidate")).toBe(true);
    expect(names.has("rsa_common_modulus")).toBe(false);
    expect(names.has("analyze_visual")).toBe(false);
    expect(names.has("extract_archive")).toBe(false);
    const hidden = listDiscoverableTools();
    expect(hidden.length).toBeGreaterThan(20);
    expect(hidden.every((t) => t.exposure === "DISCOVERABLE")).toBe(true);
    const src = readFileSync(join(process.cwd(), "packages/agent-runtime/src/pi.ts"), "utf8");
    expect(src).toContain("listDirectPiTools()");
    expect(src).not.toMatch(/TOOL_IMPLS\.map/);
  });

  it("keeps CORE schema payload small and bans the old mega cryptoTextSchema", () => {
    const direct = listDirectPiTools();
    let paramChars = 0;
    for (const tool of direct) {
      paramChars += JSON.stringify(tool.parameters ?? []).length;
      paramChars += tool.summary.length;
    }
    expect(paramChars).toBeLessThan(12_000);
    expect(TOOL_CATALOG().every((t) => t.name !== "cryptoTextSchema")).toBe(true);
    const domainSrc = readFileSync(join(process.cwd(), "packages/domain/src/schemas.ts"), "utf8");
    expect(domainSrc).not.toContain("export const cryptoTextSchema");
    const cryptoTools = TOOL_CATALOG().filter((t) => t.domains.includes("CRYPTO") && t.routerExecutable);
    const uniqueSchemas = new Set(cryptoTools.map((t) => t.schema));
    expect(uniqueSchemas.size).toBeGreaterThanOrEqual(Math.min(12, cryptoTools.length));
  });

  it("documents every catalog tool and every example passes the real schema", () => {
    for (const tool of TOOL_CATALOG()) {
      expect(tool.summary.length, tool.name).toBeGreaterThan(10);
      expect(tool.whenToUse.length, tool.name).toBeGreaterThan(0);
      expect(tool.whenNotToUse.length, tool.name).toBeGreaterThan(0);
      expect(tool.parameters, tool.name).toBeDefined();
      expect(tool.examples.length, tool.name).toBeGreaterThan(0);
      expect(tool.output.description.length, tool.name).toBeGreaterThan(5);
      expect(tool.failureModes.length, tool.name).toBeGreaterThan(0);
      for (const example of tool.examples) {
        const parsed = tool.schema.safeParse(example.args);
        expect(parsed.success, `${tool.name} example ${example.title}: ${parsed.success ? "" : JSON.stringify(parsed.error.issues)}`).toBe(true);
      }
    }
  });

  it("discovers common-modulus / Fermat / linear congruence / discrete log and help teaches the contract", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rio-disc-"));
    dirs.push(dir);
    const ctx = makeCtx(dir);

    const found = await runTool(ctx, "discover_tools", { query: "same modulus", domain: "CRYPTO" });
    expect(found.ok).toBe(true);
    const names = ((found.data as { tools: { name: string }[] }).tools ?? []).map((t) => t.name);
    expect(names).toContain("rsa_common_modulus");
    expect(names.length).toBeLessThanOrEqual(10);

    const fermat = await runTool(ctx, "discover_tools", { query: "Fermat close primes", domain: "CRYPTO" });
    expect(((fermat.data as { tools: { name: string }[] }).tools ?? []).map((t) => t.name)).toContain("rsa_fermat");

    const lin = await runTool(ctx, "discover_tools", { query: "linear congruence", domain: "CRYPTO" });
    expect(((lin.data as { tools: { name: string }[] }).tools ?? []).map((t) => t.name)).toContain("solve_linear_congruence");

    const dlog = await runTool(ctx, "discover_tools", { query: "small discrete log", domain: "CRYPTO" });
    expect(((dlog.data as { tools: { name: string }[] }).tools ?? []).map((t) => t.name)).toContain("discrete_log_if_small");

    const help = await runTool(ctx, "get_tool_help", { name: "rsa_common_modulus" });
    expect(help.ok).toBe(true);
    const blob = JSON.stringify(help.data);
    expect(blob.length).toBeLessThanOrEqual(MAX_HELP_CHARS);
    expect(blob).toContain("n");
    expect(blob).toContain("e1");
    expect(blob).toContain("c1");
    expect(blob).toContain("e2");
    expect(blob).toContain("c2");
    expect(blob).toMatch(/string/);
  });

  it("execute_tool runs a real common-modulus instance through the shipped attack", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rio-ex-"));
    dirs.push(dir);
    const ctx = makeCtx(dir);
    const n = 11n * 13n; // 143, phi=120
    const e1 = 7n;
    const e2 = 11n;
    const m = 42n;
    const c1 = modPow(m, e1, n);
    const c2 = modPow(m, e2, n);
    expect(rsaCommonModulus(n, e1, c1, e2, c2)).toBe(m);
    const r = await runTool(ctx, "execute_tool", {
      name: "rsa_common_modulus",
      args: { n: n.toString(), e1: e1.toString(), c1: c1.toString(), e2: e2.toString(), c2: c2.toString() },
    });
    expect(r.ok).toBe(true);
    expect((r.data as { m: string }).m).toBe(m.toString());
  });

  it("invalid execute_tool args return usage and an example, not just bad params", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rio-inv-"));
    dirs.push(dir);
    const ctx = makeCtx(dir);
    const r = await runTool(ctx, "execute_tool", { name: "rsa_common_modulus", args: { n: "123" } });
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("TOOL_ARGUMENT_INVALID");
    expect(r.summary).toMatch(/e1/);
    const usage = (r.data as { usage: { missing: string[] }; example: Record<string, unknown> }).usage;
    expect(usage.missing.join(" ")).toMatch(/e1|c1|e2|c2/);
    expect((r.data as { example: Record<string, string> }).example.e1).toBeDefined();
    expect(formatToolResultForModel(r)).toContain("TOOL_ARGUMENT_INVALID");
  });

  it("execute_tool cannot run control tools or path-like names", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rio-ctl-"));
    dirs.push(dir);
    const ctx = makeCtx(dir);
    const blocked = await runTool(ctx, "execute_tool", { name: "submit_flag_candidate", args: { value: "flag{x}", confidence: 0.9, reason: "no" } });
    expect(blocked.error?.code).toBe("TOOL_NOT_EXECUTABLE");
    const traversal = await runTool(ctx, "execute_tool", { name: "../../secrets", args: {} });
    expect(traversal.error?.code).toBe("TOOL_NOT_EXECUTABLE");
  });

  it("inspect_file hints visual/pcap/archive tools from real files", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rio-hint-"));
    dirs.push(dir);
    const ctx = makeCtx(dir);
    const png = encodePng({ width: 2, height: 2, data: new Uint8Array(16).fill(255) });
    writeFileSync(join(ctx.workspace.input, "a.png"), Buffer.concat([png, Buffer.from("PK\x03\x04hidden")]));
    writeFileSync(join(ctx.workspace.input, "c.pcap"), makePcapHttp("flag{pcap}"));
    writeFileSync(join(ctx.workspace.input, "d.zip"), makeZip([{ name: "x.txt", data: Buffer.from("hi") }]));

    const img = await runTool(ctx, "inspect_file", { path: "input/a.png" });
    expect(img.ok).toBe(true);
    const imgHints = (img.hints ?? []).map((h) => h.tool);
    expect(imgHints).toContain("scan_trailing_data");
    expect(imgHints).toContain("analyze_visual");
    expect(formatToolResultForModel(img)).toContain("scan_trailing_data");

    const pcap = await runTool(ctx, "inspect_file", { path: "input/c.pcap" });
    expect((pcap.hints ?? []).map((h) => h.tool)).toContain("analyze_pcap_overview");

    const zip = await runTool(ctx, "inspect_file", { path: "input/d.zip" });
    expect((zip.hints ?? []).map((h) => h.tool)).toContain("extract_archive");
  });

  it("analyze_rsa_instance hints matching attack tools", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rio-rsa-"));
    dirs.push(dir);
    const ctx = makeCtx(dir);
    const r = await runTool(ctx, "analyze_rsa_instance", { n: (10007n * 10009n).toString(), e: "3", c: "8" });
    expect(r.ok).toBe(true);
    const tools = (r.hints ?? []).map((h) => h.tool);
    expect(tools).toContain("rsa_small_e");
    expect(tools).toContain("rsa_fermat");
  });

  it("experiment ledger records the real hidden tool name via execute_tool", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rio-led-"));
    dirs.push(dir);
    const ctx = makeCtx(dir);
    writeFileSync(join(ctx.workspace.input, "a.bin"), Buffer.from("hello flag{x} world"));
    const a = await runTool(ctx, "execute_tool", { name: "extract_strings_summary", args: { path: "input/a.bin" } });
    expect(a.ok).toBe(true);
    const b = await runTool(ctx, "execute_tool", { name: "extract_strings_summary", args: { path: "input/a.bin" } });
    expect(b.error?.code).toBe("ALREADY_TESTED");
    const again = await runTool(ctx, "extract_strings_summary", { path: "input/a.bin" });
    expect(again.error?.code).toBe("ALREADY_TESTED");
  });

  it("empty discover_tools returns crypto group overview for a crypto solver", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rio-ov-"));
    dirs.push(dir);
    const ctx = makeCtx(dir);
    const r = await runTool(ctx, "discover_tools", {});
    expect(r.ok).toBe(true);
    const groups = (r.data as { groups: string[] }).groups ?? [];
    expect(groups).toContain("CRYPTO_RSA");
    expect(((r.data as { tools: { name: string }[] }).tools ?? []).map((t) => t.name)).toContain("parse_crypto_values");
  });

  it("prompts teach discover then help then execute", () => {
    const common = readFileSync(join(process.cwd(), "packages/solver/prompts/common.md"), "utf8");
    const crypto = readFileSync(join(process.cwd(), "packages/solver/prompts/crypto.md"), "utf8");
    expect(common).toContain("discover_tools");
    expect(common).toContain("get_tool_help");
    expect(common).toContain("execute_tool");
    expect(crypto).toContain("progressively disclosed");
    expect(crypto).toContain("execute_tool");
  });

  it("human docs are generated from the same catalog", () => {
    const readme = readFileSync(join(process.cwd(), "docs/tools/README.md"), "utf8");
    const crypto = readFileSync(join(process.cwd(), "docs/tools/crypto.md"), "utf8");
    expect(readme).toContain("discover_tools");
    expect(readme).toContain("CORE");
    expect(crypto).toContain("rsa_common_modulus");
    expect(crypto).toContain("bigint-string");
  });
});
