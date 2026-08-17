import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRepositories } from "@rio/database";
import { IdleContestAdapter } from "@rio/contest";
import { createLogger } from "@rio/shared";
import { WorkspaceManager, runTool, type ToolContext } from "@rio/tool-runtime";
import { StateMachine } from "../../apps/server/src/state-machine.ts";
import { EventBus } from "../../apps/server/src/control/bus.ts";
import { SubmissionManager } from "../../apps/server/src/control/submission.ts";
import {
  parseVisionModelJson,
  visionCacheKey,
  MemoryVisionCache,
  VisionCallBudget,
  HttpVisionAdapter,
  visionMessageText,
  encodeWav,
  renderSpectrogramPng,
  composeContactSheet,
  encodePng,
  decodeImageFile,
  VISUAL_RUNTIME_VERSION,
} from "@rio/visual-runtime";
import { extractFlagsFromVisualObservation, formatHumanVisualObservation } from "../../apps/server/src/control/visual-review.ts";

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

  it("parseVisionModelJson accepts observations as a map and salvage flags from prose", () => {
    const mapped = parseVisionModelJson(`{
      "summary": "red overlay text",
      "observations": { "text_visible": "flag{He1l0_d4_ba1}", "text_color": "red" }
    }`);
    expect(mapped.observations.some((o) => o.value === "flag{He1l0_d4_ba1}")).toBe(true);
    const salvage = parseVisionModelJson("I can see flag{from_prose} in the corner but forgot JSON.");
    expect(salvage.observations.some((o) => o.value === "flag{from_prose}")).toBe(true);
  });

  it("visionMessageText includes reasoning_content so truncated JSON still yields a flag", () => {
    const text = visionMessageText({
      content: "Based on the image:\n```json\n{\"summary\":\"drawing\"",
      reasoning_content: "I located the red text string \"flag{He1l0_d4_ba1}\" clearly visible.",
    });
    const parsed = parseVisionModelJson(text);
    expect(parsed.observations.some((o) => o.value === "flag{He1l0_d4_ba1}")).toBe(true);
  });

  it("cache key changes with question and model, not with extra whitespace in version isolation", () => {
    const a = visionCacheKey({ fileSha256: "aa", question: "q1", modelId: "v" });
    const b = visionCacheKey({ fileSha256: "aa", question: "q2", modelId: "v" });
    const c = visionCacheKey({ fileSha256: "aa", question: "q1", modelId: "other" });
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
    expect(a).toHaveLength(64);
    expect(VISUAL_RUNTIME_VERSION).toMatch(/^2\.0\.2/);
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

  it("HttpVisionAdapter uses Anthropic image blocks and parses content[]", async () => {
    let body: Record<string, unknown> = {};
    const fetchImpl: typeof fetch = async (_url, init) => {
      body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          content: [
            { type: "thinking", thinking: "look at the pixels" },
            { type: "text", text: JSON.stringify({ summary: "ok", observations: [{ type: "TEXT", value: "HI", description: "letters", confidence: 0.9 }] }) },
          ],
        }),
        { status: 200 },
      );
    };
    const adapter = new HttpVisionAdapter({
      baseUrl: "https://api.minimaxi.com/anthropic",
      apiKey: "k",
      modelId: "MiniMax-M3",
      protocol: "ANTHROPIC_MESSAGES",
      fetchImpl,
    });
    const image = { width: 2, height: 2, data: new Uint8Array(16).fill(255) };
    const out = await adapter.analyzeImage({ challengeId: "c", path: "a.png", image, question: "What text?", fileSha256: "abcd" });
    const user = (body.messages as { content: { type: string }[] }[])[0]!;
    expect(user.content.some((c) => c.type === "image")).toBe(true);
    expect(user.content.some((c) => c.type === "image_url")).toBe(false);
    expect(body.system).toBeTruthy();
    expect((body.messages as { role: string }[]).some((m) => m.role === "system")).toBe(false);
    expect(out.summary).toBe("ok");
    expect(out.observations[0]?.value).toBe("HI");
  });

  it("VisionCallBudget refuses calls past the configured max", () => {
    const b = new VisionCallBudget(0, 5);
    for (let i = 0; i < 5; i++) b.take();
    expect(b.remaining()).toBe(0);
    expect(() => b.take()).toThrow(/budget exhausted/);
    const wide = new VisionCallBudget(0, 40);
    for (let i = 0; i < 6; i++) wide.take();
    expect(wide.remaining()).toBe(34);
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

  it("extracts flag-shaped tokens from a visual-review answer", () => {
    expect(extractFlagsFromVisualObservation("flag{He110_d4_ba1}")).toEqual(["flag{He110_d4_ba1}"]);
    expect(extractFlagsFromVisualObservation("  I see flag{He110_d4_ba1} on the chest  ")).toEqual(["flag{He110_d4_ba1}"]);
    expect(extractFlagsFromVisualObservation("DASCTF{abc}")).toEqual(["DASCTF{abc}"]);
    expect(extractFlagsFromVisualObservation("just a Baymax drawing")).toEqual([]);
  });

  it("flag-shaped human review is submitted as a candidate", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rio-rev-cand-"));
    dirs.push(dir);
    const repos = createRepositories(join(dir, "t.sqlite"));
    repos.challenges.create({
      id: "ch_p1",
      remoteId: "url_x",
      title: "pic",
      description: "see image",
      category: "MISC",
      subcategory: null,
      score: 100,
      solveCount: null,
      lifecycleStatus: "ACTIVE",
      startStatus: "STARTED",
      hintStatus: "LOCKED",
      progressStatus: "UNKNOWN",
      priority: 0,
      lastPriorityScore: null,
      difficultyEstimate: 2,
      currentSolverType: "MISC",
      currentSessionId: null,
      wrongSubmissionCount: 0,
      solverRestartCount: 0,
      pausedReason: null,
      parkedReason: null,
      blockedReason: null,
      contentHash: "h",
      discoveredAt: Date.now(),
      updatedAt: Date.now(),
      startedAt: Date.now(),
      solverStartedAt: Date.now(),
      wallClockSolveMs: 0,
      activeSolveMs: 0,
      remoteCreatedAt: null,
      remoteUpdatedAt: null,
    });
    const manager = new SubmissionManager({
      repos,
      adapter: new IdleContestAdapter(),
      stateMachine: new StateMachine(repos),
      bus: new EventBus(),
      logger: createLogger("silent"),
      autoSubmit: true,
      confidenceThreshold: 0.85,
      localMaxWrong: 3,
      defaultCooldownMs: 0,
      inject: () => {},
      onAutoSubmitDisabled: () => {},
      onCorrect: () => {},
    });
    const flags = extractFlagsFromVisualObservation("the chest says flag{He110_d4_ba1}");
    for (const value of flags) {
      await manager.onCandidate({
        challengeId: "ch_p1",
        sessionId: "",
        value,
        confidence: 0.95,
        reason: "human visual review of artifacts/hidden_rows_4x.png",
        evidence: [{ type: "human_visual", path: "artifacts/hidden_rows_4x.png", text: "flag{He110_d4_ba1}" }],
      });
    }
    const cands = repos.candidates.listByChallenge("ch_p1");
    expect(cands).toHaveLength(1);
    expect(cands[0]!.value).toBe("flag{He110_d4_ba1}");
    expect(cands[0]!.status).toBe("VERIFIED");
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
