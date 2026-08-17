import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildFixtures, makeControlPng } from "@rio/contest";
import { solveRegisteredWithTools, runBenchmark, REGISTERED_SOLVE_IDS } from "@rio/eval";
import { WorkspaceManager, runTool, type ToolContext } from "@rio/tool-runtime";

function toolCtx(root: string): ToolContext {
  const wm = new WorkspaceManager(join(root, "ws"));
  const layout = wm.ensure("ctrl");
  return {
    challengeId: "ctrl",
    workspace: layout,
    sessionId: "bench",
    safeResolve: (p) => wm.safeResolve(layout.root, p),
    emit: () => {},
    recordArtifact: (_op, abs) => ({ path: abs, size: 1, sha256: "x" }),
    nextResultFile: () => join(layout.results, "out.txt"),
    pythonExecutable: process.env.RIO_PYTHON || "python",
  };
}

describe("registered cheap fixtures via runTool", () => {
  it("mock catalog includes visual pack, DNS pcap, QR, WAV, Håstad", () => {
    const ids = buildFixtures().map((f) => f.id);
    expect(ids).toContain("misc-006");
    expect(ids).toContain("misc-008");
    expect(ids).toContain("misc-015");
    expect(ids).toContain("crypto-006");
    expect(ids).toHaveLength(22);
    const gif = buildFixtures().find((f) => f.id === "misc-012")!;
    expect(gif.attachments[0]!.name).toBe("anim.gif");
    expect(gif.attachments[0]!.bytes.toString("ascii", 0, 6)).toBe("GIF89a");
  });

  it("analyze_visual reads the registered QR flag", async () => {
    const r = await solveRegisteredWithTools("misc-006");
    expect(r.techniques).toContain("analyze_visual");
    expect(r.flag).toBe("flag{visual_qr_ok}");
  });

  it("render_spectrogram recovers sample-rate flag from the registered WAV", async () => {
    const r = await solveRegisteredWithTools("misc-007");
    expect(r.techniques).toContain("render_spectrogram");
    expect(r.flag).toBe("flag{sr_8000}");
  });

  it("rsa_hastad recovers the registered broadcast flag", async () => {
    const r = await solveRegisteredWithTools("crypto-006");
    expect(r.techniques).toContain("rsa-hastad");
    expect(r.flag).toBe("flag{hastad}");
  });

  it.each([
    ["misc-008", "flag{low_contrast_ok}", "render_transform"],
    ["misc-009", "flag{red_channel_ok}", "extract_bitplane"],
    ["misc-010", "flag{bitplane_vis_ok}", "extract_bitplane"],
    ["misc-011", "flag{alpha_hidden_ok}", "extract_bitplane"],
    ["misc-012", "flag{gif_frame_ok}", "extract_keyframes"],
    ["misc-013", "flag{rotated_qr_ok}", "analyze_visual"],
    ["misc-014", "flag{inverted_qr_ok}", "analyze_visual"],
    ["misc-015", "flag{dns_exfil_ok}", "extract_dns_activity"],
  ] as const)("%s is solved via %s", async (id, flag, technique) => {
    const r = await solveRegisteredWithTools(id);
    expect(r.techniques).toContain(technique);
    expect(r.flag).toBe(flag);
  });

  it("control image produces no QR flag", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rio-ctrl-"));
    try {
      const ctx = toolCtx(dir);
      writeFileSync(join(ctx.workspace.input, "plain.png"), makeControlPng());
      const r = await runTool(ctx, "analyze_visual", { path: "input/plain.png", mode: "LOCAL_ONLY" });
      expect(JSON.stringify(r.data ?? "")).not.toMatch(/flag\{/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("full benchmark including visual pack and DNS is all-green", async () => {
    const results = await runBenchmark();
    expect(results.every((r) => r.solved)).toBe(true);
    expect(REGISTERED_SOLVE_IDS).toHaveLength(11);
  });
});
