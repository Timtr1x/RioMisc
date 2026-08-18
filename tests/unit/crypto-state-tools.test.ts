import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRepositories } from "@rio/database";
import { encodePng } from "@rio/visual-runtime";
import { makePcapHttp } from "@rio/contest";
import { aesMisuseInspect, mt19937Recover } from "@rio/crypto-runtime";
import {
  TOOL_CATALOG,
  listDirectPiTools,
  WorkspaceManager,
  runTool,
  type ToolContext,
} from "@rio/tool-runtime";

function makeCtx(root: string, challengeId = "ch_cs"): ToolContext & { emitted: { kind: string; payload: Record<string, unknown> }[] } {
  const wm = new WorkspaceManager(join(root, "ws"));
  const layout = wm.ensure(challengeId);
  const emitted: { kind: string; payload: Record<string, unknown> }[] = [];
  const map = new Map<string, { summary: string; outcome: string }>();
  const ctx = {
    challengeId,
    workspace: layout,
    sessionId: "s",
    emitted,
    safeResolve: (p: string) => wm.safeResolve(layout.root, p),
    emit: (kind: string, payload: Record<string, unknown>) => {
      emitted.push({ kind, payload });
    },
    recordArtifact: () => ({ path: "x", size: 1, sha256: "x" }),
    nextResultFile: () => join(layout.results, "t.txt"),
    pythonExecutable: "python",
    solverDomain: "CRYPTO" as const,
    experiments: {
      lookup: (k: string) => map.get(k) ?? null,
      record: (e: { key: string; summary: string; outcome: string }) => {
        map.set(e.key, { summary: e.summary, outcome: e.outcome });
      },
    },
  };
  return ctx as ToolContext & { emitted: typeof emitted };
}

describe("CryptoState + tool cleanup", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  it("analyze_rsa_instance emits crypto_state that upserts candidates and known vars", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rio-cs-"));
    dirs.push(dir);
    const ctx = makeCtx(dir);
    const r = await runTool(ctx, "analyze_rsa_instance", { n: "221", e: "3", c: "80" });
    expect(r.ok).toBe(true);
    const ev = ctx.emitted.find((e) => e.kind === "crypto_state");
    expect(ev).toBeTruthy();
    expect(ev!.payload.primitive).toBe("RSA");
    expect((ev!.payload.knownVariables as Record<string, { value: string }>).n.value).toBe("221");

    const repos = createRepositories(join(dir, "t.sqlite"));
    const state = repos.cryptoStates.upsert("ch_cs", {
      primitive: ev!.payload.primitive as never,
      knownVariables: ev!.payload.knownVariables as never,
      unknownVariables: ev!.payload.unknownVariables as string[],
      attackCandidates: ev!.payload.attackCandidates as never,
      replaceCandidates: true,
      assumptions: ev!.payload.assumptions as string[],
    });
    expect(state.primitive).toBe("RSA");
    const cands = JSON.parse(state.attackCandidatesJson) as { attack: string }[];
    expect(cands.some((c) => c.attack === "FACTOR" || c.attack === "SMALL_E")).toBe(true);
    const again = repos.cryptoStates.upsert("ch_cs", {
      attempt: { attack: "SMALL_E", tool: "rsa_small_e", outcome: "SUCCESS", summary: "m=4" },
      knownVariables: { m: { value: "4", source: "rsa_small_e" } },
    });
    expect(JSON.parse(again.attemptsJson)).toHaveLength(1);
    expect(JSON.parse(again.knownVariablesJson).m.value).toBe("4");
    repos.db.close();
  });

  it("inspect_metadata reads PNG tEXt and follow_tcp_stream reassembles HTTP", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rio-meta-"));
    dirs.push(dir);
    const ctx = makeCtx(dir, "ch_misc");

    const png = encodePng({
      width: 1,
      height: 1,
      data: new Uint8Array([255, 0, 0, 255]),
    });
    // Append a tEXt chunk before IEND for a real metadata field.
    const iend = png.lastIndexOf(Buffer.from("IEND"));
    const keyword = Buffer.from("Comment");
    const text = Buffer.from("flag{meta}");
    const chunkData = Buffer.concat([keyword, Buffer.from([0]), text]);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(chunkData.length, 0);
    const type = Buffer.from("tEXt");
    const crc = Buffer.alloc(4); // parser does not validate CRC
    const withText = Buffer.concat([png.subarray(0, iend - 4), len, type, chunkData, crc, png.subarray(iend - 4)]);
    writeFileSync(join(ctx.workspace.input, "a.png"), withText);

    const meta = await runTool(ctx, "inspect_metadata", { path: "input/a.png" });
    expect(meta.ok).toBe(true);
    const fields = (meta.data as { fields: { key: string; value: string }[] }).fields;
    expect(fields.some((f) => f.key.includes("Comment") && f.value.includes("flag{meta}"))).toBe(true);

    writeFileSync(join(ctx.workspace.input, "c.pcap"), makePcapHttp("flag{tcp}"));
    const tcp = await runTool(ctx, "follow_tcp_stream", { path: "input/c.pcap", streamIndex: 0 });
    expect(tcp.ok).toBe(true);
    const data = tcp.data as { reassembledAscii: string; availableStreams: string[] };
    expect(data.availableStreams.length).toBeGreaterThan(0);
    expect(data.reassembledAscii).toMatch(/GET|HTTP|Host/i);
  });

  it("mt19937_recover and aes_misuse_inspect work on the shipped path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rio-prng-"));
    dirs.push(dir);
    const ctx = makeCtx(dir);
    const samples = Array.from({ length: 624 }, (_, i) => String((i * 2654435761) >>> 0)).join(" ");
    const mt = await runTool(ctx, "mt19937_recover", { samples });
    expect(mt.ok).toBe(true);
    expect(((mt.data as { state: number[] }).state ?? []).length).toBe(624);
    expect(mt19937Recover(samples.split(/\s+/).map(Number))!.length).toBe(624);

    const a = Buffer.alloc(32, 0x11);
    const b = Buffer.from(a);
    b[31] = 0x20; // flip last byte toward printable XOR
    const misuse = aesMisuseInspect(a, b);
    expect(misuse.primary.blockAligned).toBe(true);

    writeFileSync(join(ctx.workspace.input, "c1.bin"), a);
    writeFileSync(join(ctx.workspace.input, "c2.bin"), b);
    const tool = await runTool(ctx, "aes_misuse_inspect", { path: "input/c1.bin", path2: "input/c2.bin" });
    expect(tool.ok).toBe(true);
    expect(String((tool.data as { findings: string[] }).findings?.[0] ?? "")).toMatch(/ECB|IV|ciphertext|misuse|XOR|stream/i);
  });

  it("schema budget: CORE Pi list stays ≤15 and no mega cryptoTextSchema remains", () => {
    expect(listDirectPiTools().length).toBeLessThanOrEqual(15);
    const catalog = TOOL_CATALOG();
    expect(catalog.some((t) => t.name === "inspect_metadata")).toBe(true);
    expect(catalog.some((t) => t.name === "follow_tcp_stream")).toBe(true);
    expect(catalog.some((t) => t.name === "mt19937_recover")).toBe(true);
    expect(catalog.some((t) => t.name === "aes_misuse_inspect")).toBe(true);
    expect(catalog.some((t) => t.name === "update_crypto_state")).toBe(true);

    // Each crypto attack tool must carry its own zod schema (not a shared bag).
    const crypto = catalog.filter((t) => t.domains.includes("CRYPTO") && t.exposure === "DISCOVERABLE");
    const schemaIds = new Set(crypto.map((t) => t.schema));
    expect(schemaIds.size).toBeGreaterThan(10);

    const domainSrc = readFileSync(join(process.cwd(), "packages/domain/src/schemas.ts"), "utf8");
    expect(domainSrc).not.toMatch(/export const cryptoTextSchema/);
  });
});
