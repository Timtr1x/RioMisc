import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import QRCode from "qrcode";
import { createRepositories } from "@rio/database";
import { WorkspaceManager } from "@rio/tool-runtime";
import { runTool, type ToolContext } from "@rio/tool-runtime";
import {
  computeVisualOverview,
  decodeImageBuffer,
  decodeQr,
  encodePng,
  encodeGif,
  decodeGifFrames,
  renderVisionOkImage,
  resolveVisionProvider,
  visionUnavailableAssigned,
  VISION_OK_TEXT,
  VisualRuntime,
} from "@rio/visual-runtime";

function makeCtx(root: string, challengeId: string): ToolContext {
  const wm = new WorkspaceManager(join(root, "ws"));
  const layout = wm.ensure(challengeId);
  let n = 0;
  return {
    challengeId,
    workspace: layout,
    sessionId: "s1",
    safeResolve: (p) => wm.safeResolve(layout.root, p),
    emit: () => {},
    recordArtifact: (_op, abs) => ({ path: abs, size: 1, sha256: "x" }),
    nextResultFile: () => join(layout.results, `tool-${++n}.txt`),
    pythonExecutable: "python",
  };
}

describe("visual runtime", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
  });

  it("overview reports the true pixel size of a generated PNG", () => {
    const img = { width: 12, height: 7, data: new Uint8Array(12 * 7 * 4) };
    for (let i = 0; i < 12 * 7; i++) {
      img.data[i * 4] = i % 2 ? 255 : 0;
      img.data[i * 4 + 1] = 10;
      img.data[i * 4 + 2] = 20;
      img.data[i * 4 + 3] = 255;
    }
    const ov = computeVisualOverview(img);
    expect(ov.width).toBe(12);
    expect(ov.height).toBe(7);
    expect(ov.mode).toBe("RGBA");
    expect(ov.hasAlpha).toBe(false);
    expect(ov.channelVariance[0]).toBeGreaterThan(0);
  });

  it("decodeQr reads a QR that encodePng just wrote", async () => {
    const png = await QRCode.toBuffer("flag{visual-qr-fixture}", { type: "png", margin: 2, width: 200 });
    const image = decodeImageBuffer(png);
    const hits = decodeQr(image);
    expect(hits.map((h) => h.text)).toEqual(["flag{visual-qr-fixture}"]);
  });

  it("AUTO analyze returns the QR and does not invent a flag from the vision-ok glyph", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rio-vis-"));
    dirs.push(dir);
    const qrPng = await QRCode.toBuffer("flag{from-qr}", { type: "png", margin: 2, width: 180 });
    const src = join(dir, "q.png");
    writeFileSync(src, qrPng);
    const art = join(dir, "art");
    mkdirSync(art);
    const runtime = new VisualRuntime();
    const result = await runtime.analyze({ challengeId: "ch1", path: "q.png", mode: "AUTO" }, src, art);
    expect(result.ok).toBe(true);
    expect(result.evidence.analyzer).toBe("LOCAL");
    expect(result.evidence.observations.some((o) => o.type === "QR" && o.value === "flag{from-qr}")).toBe(true);
    expect(result.derived.length).toBe(0);

    const glyph = join(dir, "ok.png");
    writeFileSync(glyph, encodePng(renderVisionOkImage()));
    const noQr = await runtime.analyze({ challengeId: "ch1", path: "ok.png", mode: "LOCAL_ONLY" }, glyph, art);
    expect(noQr.evidence.observations.some((o) => o.type === "QR")).toBe(false);
    expect(noQr.overview?.width).toBeGreaterThan(10);
    expect(existsSync(join(art, "channels-contact-sheet.png"))).toBe(true);
    expect(existsSync(join(art, "bitplanes-contact-sheet.png"))).toBe(true);
    expect(VISION_OK_TEXT).toBe("RIO VISION OK");
  });

  it("GIF encode/decode keeps two independent frames", () => {
    const w = 4;
    const h = 2;
    const a = new Uint8Array(w * h).fill(0);
    const b = new Uint8Array(w * h).fill(1);
    const gif = encodeGif(
      [
        { width: w, height: h, index: a, delayCs: 5 },
        { width: w, height: h, index: b, delayCs: 5 },
      ],
      Buffer.from([0, 0, 0, 255, 255, 255]),
    );
    expect(gif.toString("ascii", 0, 6)).toBe("GIF89a");
    const frames = decodeGifFrames(gif);
    expect(frames).toHaveLength(2);
    expect(frames[0]!.data[0]).toBe(0);
    expect(frames[1]!.data[0]).toBe(255);
  });

  it("GIF encode/decode is pixel-perfect on a 80x80 checkerboard", () => {
    const w = 80;
    const h = 80;
    const idx = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) idx[y * w + x] = (x + y) % 2;
    const gif = encodeGif([{ width: w, height: h, index: idx }], Buffer.from([0, 0, 0, 255, 255, 255]));
    const back = decodeGifFrames(gif);
    expect(back).toHaveLength(1);
    let bad = 0;
    for (let i = 0; i < w * h; i++) {
      if (back[0]!.data[i * 4] !== (idx[i] ? 255 : 0)) bad += 1;
    }
    expect(bad).toBe(0);
  });

  it("analyze_visual tool is the shipped entry and persists evidence in SQLite via the repo", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rio-av-"));
    dirs.push(dir);
    const ctx = makeCtx(dir, "ch_vis");
    const png = await QRCode.toBuffer("flag{tool-path}", { type: "png", margin: 2, width: 180 });
    writeFileSync(join(ctx.workspace.input, "task.png"), png);
    const emitted: Record<string, unknown>[] = [];
    ctx.emit = (kind, payload) => {
      emitted.push({ kind, ...payload });
    };
    const result = await runTool(ctx, "analyze_visual", { path: "input/task.png", mode: "AUTO" });
    expect(result.ok).toBe(true);
    const data = result.data as { evidence: { observations: { type: string; value?: string }[]; id: string } };
    expect(data.evidence.observations.some((o) => o.type === "QR" && o.value === "flag{tool-path}")).toBe(true);
    expect(emitted.some((e) => e.kind === "visual_evidence")).toBe(true);

    const repos = createRepositories(join(dir, "t.sqlite"));
    repos.visualEvidence.create({
      id: data.evidence.id,
      challengeId: "ch_vis",
      sourceArtifactId: null,
      sourcePath: "input/task.png",
      sourceType: "IMAGE",
      question: null,
      analyzer: "LOCAL",
      observations: data.evidence.observations as never,
      summary: "from tool",
      confidence: 0.9,
    });
    const listed = repos.visualEvidence.listByChallenge("ch_vis");
    expect(listed).toHaveLength(1);
    expect(listed[0]!.observations.some((o) => o.type === "QR" && o.value === "flag{tool-path}")).toBe(true);
    repos.db.close();
  });

  it("resolveVisionProvider refuses a non-vision assigned model without falling back", () => {
    const providers = [
      { modelId: "text-only", apiKey: "k1", vision: false },
      { modelId: "vl-capable", apiKey: "k2", vision: true },
    ];
    const refused = resolveVisionProvider(providers, "text-only");
    expect(refused.provider).toBeNull();
    expect(refused.unavailableReason).toBe(visionUnavailableAssigned("text-only"));

    const ok = resolveVisionProvider(providers, "vl-capable");
    expect(ok.provider?.modelId).toBe("vl-capable");
    expect(ok.unavailableReason).toBeNull();

    const fallback = resolveVisionProvider(providers, null);
    expect(fallback.provider?.modelId).toBe("vl-capable");
    expect(fallback.unavailableReason).toBeNull();
  });

  it("VISION_MODEL mode fails clearly when assigned model is not vision-capable", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rio-vis-nov-"));
    dirs.push(dir);
    const glyph = join(dir, "ok.png");
    writeFileSync(glyph, encodePng(renderVisionOkImage()));
    const art = join(dir, "art");
    mkdirSync(art);
    const reason = visionUnavailableAssigned("deepseek-v4-flash");
    const runtime = new VisualRuntime({ unavailableReason: reason });
    const result = await runtime.analyze(
      { challengeId: "ch1", path: "ok.png", mode: "VISION_MODEL", question: "what text is visible?" },
      glyph,
      art,
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("does not support vision");
    expect(result.evidence.summary).toContain("does not support vision");
    expect(result.evidence.observations.some((o) => o.description?.includes("does not support vision"))).toBe(true);
  });

  it("analyze_visual AUTO surfaces unavailable reason when vision slot is text-only", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rio-av-nov-"));
    dirs.push(dir);
    const ctx = makeCtx(dir, "ch_nov");
    ctx.visionUnavailableReason = visionUnavailableAssigned("text-model");
    writeFileSync(join(ctx.workspace.input, "ok.png"), encodePng(renderVisionOkImage()));
    const result = await runTool(ctx, "analyze_visual", {
      path: "input/ok.png",
      mode: "AUTO",
      question: "read any hidden text",
    });
    expect(result.ok).toBe(true);
    const data = result.data as { evidence: { observations: { description?: string }[]; summary: string } };
    expect(data.evidence.observations.some((o) => o.description?.includes("does not support vision"))).toBe(true);
  });
});
