import { describe, it, expect } from "vitest";
import { buildFixtures } from "@rio/contest";
import { solveRegisteredWithTools, runBenchmark } from "@rio/eval";

describe("registered cheap fixtures via runTool", () => {
  it("mock catalog includes QR, spectrogram WAV, and Håstad", () => {
    const ids = buildFixtures().map((f) => f.id);
    expect(ids).toContain("misc-006");
    expect(ids).toContain("misc-007");
    expect(ids).toContain("crypto-006");
    const qr = buildFixtures().find((f) => f.id === "misc-006")!;
    expect(qr.attachments[0]!.name).toBe("code.png");
    expect(qr.attachments[0]!.bytes.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
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

  it("full benchmark including registered fixtures is all-green", async () => {
    const results = await runBenchmark();
    const extra = results.filter((r) => ["misc-qr-001", "misc-wav-sr-001", "crypto-hastad-001"].includes(r.manifestId));
    expect(extra).toHaveLength(3);
    expect(extra.every((r) => r.solved)).toBe(true);
  });
});
