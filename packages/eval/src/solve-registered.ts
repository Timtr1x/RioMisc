import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildFixtures } from "@rio/contest";
import { WorkspaceManager, runTool, type ToolContext } from "@rio/tool-runtime";

export const REGISTERED_SOLVE_IDS = [
  "misc-006",
  "misc-007",
  "crypto-006",
  "misc-008",
  "misc-009",
  "misc-010",
  "misc-011",
  "misc-012",
  "misc-013",
  "misc-014",
  "misc-015",
] as const;

function flagIn(value: unknown): string | null {
  return JSON.stringify(value ?? "").match(/flag\{[^}]+\}/)?.[0] ?? null;
}

function ctxFor(root: string, challengeId: string): ToolContext {
  const wm = new WorkspaceManager(join(root, "ws"));
  const layout = wm.ensure(challengeId);
  return {
    challengeId,
    workspace: layout,
    sessionId: "bench",
    safeResolve: (p) => wm.safeResolve(layout.root, p),
    emit: () => {},
    recordArtifact: (_op, abs) => ({ path: abs, size: 1, sha256: "x" }),
    nextResultFile: () => join(layout.results, "out.txt"),
    pythonExecutable: process.env.RIO_PYTHON || "python",
  };
}

export async function solveRegisteredWithTools(id: string): Promise<{ flag: string | null; techniques: string[]; toolCalls: number }> {
  const fixture = buildFixtures().find((f) => f.id === id);
  if (!fixture) return { flag: null, techniques: [], toolCalls: 0 };
  const dir = mkdtempSync(join(tmpdir(), "rio-reg-"));
  const ctx = ctxFor(dir, id);
  let toolCalls = 0;
  const call = async (name: string, params: unknown) => {
    toolCalls += 1;
    return runTool(ctx, name, params);
  };
  try {
    for (const a of fixture.attachments) {
      writeFileSync(join(ctx.workspace.input, a.name), a.bytes);
    }
    writeFileSync(join(ctx.workspace.root, "challenge.txt"), fixture.description);
    if (id === "misc-006") {
      const r = await call("analyze_visual", { path: "input/code.png", mode: "LOCAL_ONLY" });
      return { flag: flagIn(r.data), techniques: ["analyze_visual"], toolCalls };
    }
    if (id === "misc-007") {
      const r = await call("render_spectrogram", { path: "input/tone.wav", mode: "AUTO" });
      const rate = (r.data as { sampleRate?: number } | undefined)?.sampleRate;
      return { flag: rate ? `flag{sr_${rate}}` : null, techniques: ["render_spectrogram"], toolCalls };
    }
    if (id === "crypto-006") {
      const grab = (k: string) => fixture.description.match(new RegExp(`${k}\\s*=\\s*(\\d+)`))?.[1];
      const r = await call("rsa_hastad", {
        e: grab("e") ?? "3",
        n1: grab("n1"),
        c1: grab("c1"),
        n2: grab("n2"),
        c2: grab("c2"),
        n3: grab("n3"),
        c3: grab("c3"),
      });
      const raw = (r.data as { m?: string } | undefined)?.m;
      if (!raw) return { flag: null, techniques: ["rsa-hastad"], toolCalls };
      let x = BigInt(raw);
      const bytes: number[] = [];
      while (x > 0n) {
        bytes.push(Number(x & 0xffn));
        x >>= 8n;
      }
      return { flag: Buffer.from(bytes.reverse()).toString("utf8"), techniques: ["rsa-hastad"], toolCalls };
    }
    if (id === "misc-008") {
      const t = await call("render_transform", { path: "input/blank.png", op: "autocontrast" });
      const dest = (t.data as { path?: string } | undefined)?.path ?? "artifacts/visual/autocontrast.png";
      const r = await call("analyze_visual", { path: dest, mode: "LOCAL_ONLY" });
      return { flag: flagIn(r.data), techniques: ["render_transform", "analyze_visual"], toolCalls };
    }
    if (id === "misc-009") {
      const b = await call("extract_bitplane", { path: "input/rgb.png", channel: "R", bit: 7 });
      const dest = (b.data as { path?: string } | undefined)?.path ?? "artifacts/visual/bitplane-R7.png";
      const r = await call("analyze_visual", { path: dest, mode: "LOCAL_ONLY" });
      return { flag: flagIn(r.data), techniques: ["extract_bitplane", "analyze_visual"], toolCalls };
    }
    if (id === "misc-010") {
      const b = await call("extract_bitplane", { path: "input/planes.png", channel: "R", bit: 0 });
      const dest = (b.data as { path?: string } | undefined)?.path ?? "artifacts/visual/bitplane-R0.png";
      const r = await call("analyze_visual", { path: dest, mode: "LOCAL_ONLY" });
      return { flag: flagIn(r.data), techniques: ["extract_bitplane", "analyze_visual"], toolCalls };
    }
    if (id === "misc-011") {
      const b = await call("extract_bitplane", { path: "input/alpha.png", channel: "A", bit: 7 });
      const dest = (b.data as { path?: string } | undefined)?.path ?? "artifacts/visual/bitplane-A7.png";
      const r = await call("analyze_visual", { path: dest, mode: "LOCAL_ONLY" });
      return { flag: flagIn(r.data), techniques: ["extract_bitplane", "analyze_visual"], toolCalls };
    }
    if (id === "misc-012") {
      await call("extract_keyframes", { path: "input/anim.gif", maxFrames: 8 });
      const frames = await call("list_workspace", { path: "artifacts/visual/frames" });
      const names = ((frames.data as { entries: { name: string }[] })?.entries ?? []).map((e) => e.name).filter((n) => /\.png$/i.test(n));
      for (const n of names) {
        const r = await call("analyze_visual", { path: `artifacts/visual/frames/${n}`, mode: "LOCAL_ONLY" });
        const f = flagIn(r.data);
        if (f) return { flag: f, techniques: ["extract_keyframes", "analyze_visual"], toolCalls };
      }
      return { flag: null, techniques: ["extract_keyframes"], toolCalls };
    }
    if (id === "misc-013") {
      const r = await call("analyze_visual", { path: "input/tilted.png", mode: "LOCAL_ONLY" });
      return { flag: flagIn(r.data), techniques: ["analyze_visual"], toolCalls };
    }
    if (id === "misc-014") {
      const r = await call("analyze_visual", { path: "input/negative.png", mode: "LOCAL_ONLY" });
      return { flag: flagIn(r.data), techniques: ["analyze_visual"], toolCalls };
    }
    if (id === "misc-015") {
      const r = await call("extract_dns_activity", { path: "input/dns.pcap" });
      return { flag: flagIn(r.data), techniques: ["extract_dns_activity"], toolCalls };
    }
    return { flag: null, techniques: [], toolCalls };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
