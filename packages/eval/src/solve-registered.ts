import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildFixtures } from "@rio/contest";
import { WorkspaceManager, runTool, type ToolContext } from "@rio/tool-runtime";

export const REGISTERED_SOLVE_IDS = ["misc-006", "misc-007", "crypto-006"] as const;

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
      const blob = JSON.stringify(r.data ?? "");
      const m = blob.match(/flag\{[^}]+\}/);
      return { flag: m?.[0] ?? null, techniques: ["analyze_visual"], toolCalls };
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
    return { flag: null, techniques: [], toolCalls };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
