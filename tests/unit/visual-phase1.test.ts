import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRepositories } from "@rio/database";
import { WorkspaceManager, runTool, type ToolContext } from "@rio/tool-runtime";
import {
  parseVisionModelJson,
  visionCacheKey,
  MemoryVisionCache,
  VisionCallBudget,
  HttpVisionAdapter,
  encodeWav,
  renderSpectrogramPng,
  composeContactSheet,
  encodePng,
  decodeImageFile,
  VISUAL_RUNTIME_VERSION,
} from "@rio/visual-runtime";
import { formatHumanVisualObservation } from "../../apps/server/src/control/visual-review.ts";

function ctx(root: string, challengeId = "ch_p1"): ToolContext {
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
    nextResultFile: () => join(layout.results, `t-${++n}.txt`),
    pythonExecutable: "python",
  };
}

describe("vision adapter / cache / budget", () => {
  it("parseVisionModelJson accepts fenced JSON and ignores prose", () => {
    const parsed = parseVisionModelJson(`sure, here:
\`\`\`json
{"summary":"Blue bit plane 1 contains readable characters.","observations":[{"type":"TEXT","value":"TRY_ALPHA","description":"uppercase near center","confidence":0.92}],"suggestedActions":["extract alpha"]}
\`\`\``);
    expect(parsed.summary).toContain("Blue bit");
    expect(parsed.observations[0]?.value).toBe("TRY_ALPHA");
    expect(parsed.suggestedActions).toEqual(["extract alpha"]);
  });

  it("cache key changes with question and model, not with extra whitespace in version isolation", () => {
    const a = visionCacheKey({ fileSha256: "aa", question: "q1", modelId: "v" });
    const b = visionCacheKey({ fileSha256: "aa", question: "q2", modelId: "v" });
    const c = visionCacheKey({ fileSha256: "aa", question: "q1", modelId: "other" });
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
    expect(a).toHaveLength(64);
    expect(VISUAL_RUNTIME_VERSION).toMatch(/^2\./);
  });

  it("MemoryVisionCache + HttpVisionAdapter reuse the first HTTP reply", async () => {
    let hits = 0;
    const fetchImpl: typeof fetch = async () => {
      hits += 1;
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify({ summary: "letters", observations: [{ type: "TEXT", value: "OK", description: "ok", confidence: 0.8 }] }) } }],
        }),
        { status: 200 },
      );
    };
    const cache = new MemoryVisionCache();
    const adapter = new HttpVisionAdapter({
      baseUrl: "https://api.example.com/v1",
      apiKey: "k",
      modelId: "vision-x",
      fetchImpl,
      cache,
    });
    const image = { width: 2, height: 2, data: new Uint8Array(16).fill(255) };
    const first = await adapter.analyzeImage({ challengeId: "c", path: "a.png", image, question: "Any letters?", fileSha256: "deadbeef" });
    const second = await adapter.analyzeImage({ challengeId: "c", path: "a.png", image, question: "Any letters?", fileSha256: "deadbeef" });
    expect(first.summary).toBe("letters");
    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
    expect(hits).toBe(1);
    await expect(
      adapter.analyzeImage({ challengeId: "c", path: "a.png", image, question: "", fileSha256: "deadbeef" }),
    ).rejects.toThrow(/specific question/);
  });

  it("VisionCallBudget refuses the 6th call when max is 5", () => {
    const b = new VisionCallBudget(0, 5);
    for (let i = 0; i < 5; i++) b.take();
    expect(b.remaining()).toBe(0);
    expect(() => b.take()).toThrow(/budget exhausted/);
  });
});

describe("human visual review", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  it("request_visual_review emits and repo+answer produce the inject text", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rio-rev-"));
    dirs.push(dir);
    const c = ctx(dir);
    writeFileSync(join(c.workspace.input, "pic.png"), encodePng({ width: 2, height: 2, data: new Uint8Array(16).fill(200) }));
    const emitted: Record<string, unknown>[] = [];
    c.emit = (kind, payload) => {
      emitted.push({ kind, ...payload });
    };
    const result = await runTool(c, "request_visual_review", {
      path: "input/pic.png",
      question: "Which plane has text?",
      reason: "local tools found no QR",
    });
    expect(result.ok).toBe(true);
    expect(emitted[0]?.kind).toBe("visual_review");
    expect(emitted[0]?.question).toBe("Which plane has text?");

    const repos = createRepositories(join(dir, "t.sqlite"));
    const rec = repos.visualReviews.create({
      challengeId: "ch_p1",
      sourcePath: "input/pic.png",
      question: "Which plane has text?",
      reason: "local tools found no QR",
    });
    expect(repos.visualReviews.listPending()).toHaveLength(1);
    const text = formatHumanVisualObservation({
      sourcePath: rec.sourcePath,
      question: rec.question ?? "",
      observation: "Blue bit 1 says TRY_ALPHA",
      useful: true,
    });
    expect(text).toContain("HUMAN VISUAL OBSERVATION");
    expect(text).toContain("TRY_ALPHA");
    expect(text).toContain("input/pic.png");
    repos.visualReviews.answer(rec.id, JSON.stringify({ observation: "Blue bit 1 says TRY_ALPHA", useful: true }));
    expect(repos.visualReviews.get(rec.id)?.status).toBe("ANSWERED");
    repos.db.close();
  });
});

describe("spectrogram and keyframes", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  it("render_spectrogram from a generated 440Hz WAV writes a real PNG", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rio-spec-"));
    dirs.push(dir);
    const rate = 8000;
    const samples = new Float32Array(rate);
    for (let i = 0; i < samples.length; i++) samples[i] = Math.sin((2 * Math.PI * 440 * i) / rate);
    const c = ctx(dir, "ch_wav");
    writeFileSync(join(c.workspace.input, "tone.wav"), encodeWav(samples, rate));
    const result = await runTool(c, "render_spectrogram", { path: "input/tone.wav", mode: "AUTO" });
    expect(result.ok).toBe(true);
    const dest = join(c.workspace.artifacts, "visual", "spectrogram.png");
    expect(existsSync(dest)).toBe(true);
    const img = decodeImageFile(dest);
    expect(img.width).toBeGreaterThan(50);
    expect(img.height).toBeGreaterThan(50);
    const data = result.data as { sampleRate: number; durationSec: number };
    expect(data.sampleRate).toBe(8000);
    expect(data.durationSec).toBeCloseTo(1, 1);
  });

  it("composeContactSheet and extract_keyframes on a PNG use the shipped path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rio-kf-"));
    dirs.push(dir);
    const a = { width: 8, height: 8, data: new Uint8Array(8 * 8 * 4).fill(80) };
    const b = { width: 8, height: 8, data: new Uint8Array(8 * 8 * 4).fill(200) };
    const sheetPath = join(dir, "sheet.png");
    const sheet = composeContactSheet([a, b], sheetPath, 2);
    expect(sheet.width).toBeGreaterThan(8);
    expect(existsSync(sheetPath)).toBe(true);

    const c = ctx(dir, "ch_kf");
    writeFileSync(join(c.workspace.input, "still.png"), encodePng(a));
    const result = await runTool(c, "extract_keyframes", { path: "input/still.png", maxFrames: 4 });
    expect(result.ok).toBe(true);
    expect(existsSync(join(c.workspace.artifacts, "visual", "keyframes-contact-sheet.png"))).toBe(true);
  });

  it("renderSpectrogramPng reports audio stats from the WAV it just encoded", () => {
    const dir = mkdtempSync(join(tmpdir(), "rio-spec2-"));
    dirs.push(dir);
    const samples = new Float32Array(4000);
    samples[10] = 1;
    const wav = encodeWav(samples, 4000);
    const dest = join(dir, "s.png");
    const spec = renderSpectrogramPng(wav, dest, { mode: "DETAIL", maxDurationSeconds: 2 });
    expect(spec.audio.peak).toBeGreaterThan(0.9);
    expect(existsSync(dest)).toBe(true);
  });
});
