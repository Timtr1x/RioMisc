import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRepositories } from "@rio/database";
import { WorkspaceManager, runTool, type ToolContext } from "@rio/tool-runtime";
import { encodePng, applyImageTransform } from "@rio/visual-runtime";
import { summarizeBenchmark, runBenchmark } from "@rio/eval";
import { formatHumanVisualObservation } from "../../apps/server/src/control/visual-review.ts";

function ctx(root: string, challengeId = "ch_close"): ToolContext {
  const wm = new WorkspaceManager(join(root, "ws"));
  const layout = wm.ensure(challengeId);
  const map = new Map<string, { summary: string; outcome: string }>();
  return {
    challengeId,
    workspace: layout,
    sessionId: "s",
    safeResolve: (p) => wm.safeResolve(layout.root, p),
    emit: () => {},
    recordArtifact: (_op, abs, parent) => ({ path: abs, size: 1, sha256: "x", parent: parent ?? null } as never),
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

describe("MVP-2 feature-complete closeout", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  it("record_hypothesis emits a payload the repo can persist with evidence", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rio-hyp-"));
    dirs.push(dir);
    const c = ctx(dir);
    const emitted: Record<string, unknown>[] = [];
    c.emit = (kind, payload) => {
      emitted.push({ kind, ...payload });
    };
    const r = await runTool(c, "record_hypothesis", {
      description: "trailing zip after IEND",
      confidence: 0.8,
      status: "TESTING",
      evidenceFor: ["scan_trailing_data hit ZIP"],
      evidenceAgainst: [],
    });
    expect(r.ok).toBe(true);
    expect(emitted[0]?.kind).toBe("hypothesis");
    expect(emitted[0]?.description).toBe("trailing zip after IEND");
    const repos = createRepositories(join(dir, "t.sqlite"));
    repos.hypotheses.create({
      challengeId: "ch_close",
      description: String(emitted[0]!.description),
      confidence: Number(emitted[0]!.confidence),
      status: "TESTING",
      evidenceForJson: JSON.stringify(emitted[0]!.evidenceFor),
      evidenceAgainstJson: JSON.stringify(emitted[0]!.evidenceAgainst),
      proposedTestsJson: "[]",
    });
    const listed = repos.hypotheses.listByChallenge("ch_close");
    expect(listed).toHaveLength(1);
    expect(listed[0]!.confidence).toBe(0.8);
    expect(JSON.parse(listed[0]!.evidenceForJson)).toEqual(["scan_trailing_data hit ZIP"]);
    repos.db.close();
  });

  it("carve_files records the source path as parent for DAG", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rio-dag-"));
    dirs.push(dir);
    const c = ctx(dir);
    writeFileSync(join(c.workspace.input, "a.bin"), Buffer.from("AAAAHIDDEN"));
    const parents: string[] = [];
    c.recordArtifact = (op, abs, parent) => {
      if (parent) parents.push(parent);
      return { path: abs, size: 1, sha256: "x" };
    };
    const r = await runTool(c, "carve_files", { path: "input/a.bin", offset: 4, length: 6 });
    expect(r.ok).toBe(true);
    expect(parents).toContain("input/a.bin");
    const repos = createRepositories(join(dir, "t.sqlite"));
    repos.artifacts.create({
      challengeId: "ch_close",
      parentArtifactId: null,
      path: "input/a.bin",
      mime: "application/octet-stream",
      size: 10,
      sha256: "aa",
      generatedBy: "DOWNLOAD",
      operation: "download",
    });
    const parent = repos.artifacts.findByPath("ch_close", "input/a.bin");
    repos.artifacts.create({
      challengeId: "ch_close",
      parentArtifactId: parent!.id,
      path: "artifacts/carved/at-4.bin",
      mime: null,
      size: 6,
      sha256: "bb",
      generatedBy: "TOOL",
      operation: "carve_files",
    });
    const kids = repos.artifacts.listByChallenge("ch_close").filter((a) => a.parentArtifactId === parent!.id);
    expect(kids).toHaveLength(1);
    repos.db.close();
  });

  it("render_transform invert changes pixels and extract_visible_text is BACKEND_UNAVAILABLE", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rio-xf-"));
    dirs.push(dir);
    const c = ctx(dir);
    const img = { width: 2, height: 2, data: new Uint8Array([0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255]) };
    writeFileSync(join(c.workspace.input, "b.png"), encodePng(img));
    const r = await runTool(c, "render_transform", { path: "input/b.png", op: "invert" });
    expect(r.ok).toBe(true);
    const inverted = applyImageTransform(img, "invert");
    expect(inverted.data[0]).toBe(255);
    const ocr = await runTool(c, "extract_visible_text", { path: "input/b.png" });
    expect(ocr.error?.code).toBe("BACKEND_UNAVAILABLE");
    const plane = await runTool(c, "extract_bitplane", { path: "input/b.png", channel: "R", bit: 0 });
    expect(plane.ok).toBe(true);
  });

  it("HUMAN observation formatter plus VisualEvidence analyzer=HUMAN persist", () => {
    const dir = mkdtempSync(join(tmpdir(), "rio-hum-"));
    dirs.push(dir);
    const repos = createRepositories(join(dir, "t.sqlite"));
    const ev = repos.visualEvidence.create({
      challengeId: "ch_close",
      sourceArtifactId: null,
      sourcePath: "input/pic.png",
      sourceType: "IMAGE",
      question: "any text?",
      analyzer: "HUMAN",
      observations: [{ type: "TEXT", description: "TRY_ALPHA", confidence: 0.9 }],
      summary: "TRY_ALPHA",
      confidence: 0.9,
    });
    expect(ev.analyzer).toBe("HUMAN");
    expect(formatHumanVisualObservation({ sourcePath: "input/pic.png", question: "any text?", observation: "TRY_ALPHA", useful: true })).toContain("HUMAN VISUAL OBSERVATION");
    repos.db.close();
  });

  it("summarizeBenchmark reports solve rate and median", async () => {
    const results = await runBenchmark();
    const s = summarizeBenchmark(results);
    expect(s.total).toBe(results.length);
    expect(s.solved).toBe(results.length);
    expect(s.failed).toBe(0);
    expect(s.solveRate).toBe(1);
    expect(s.medianMs).toBeGreaterThanOrEqual(0);
  });
});
