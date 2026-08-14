import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("dashboard UNKNOWN reconciliation", () => {
  it("shows the warning and the four human actions", () => {
    const src = readFileSync(join(process.cwd(), "apps/dashboard/src/App.tsx"), "utf8");
    expect(src).toContain("提交结果未知");
    expect(src).toContain("Mark Correct");
    expect(src).toContain("Mark Wrong");
    expect(src).toContain("Retry Submission");
    expect(src).toContain("Resume Solving");
    expect(src).toContain("系统不会自动重复提交");
    expect(src).toContain("Native / Trusted");
    expect(src).toContain("有进展");
    expect(src).toContain("无 Hint");
    expect(src).toContain("已搁置");
    expect(src).toContain("Agent 给出了 Flag");
    expect(src).toContain("table-wrap");
    expect(src).toContain("出 Flag");
    expect(src).toContain("已添加模型");
    expect(src).toContain("先填模型名再点添加");
    expect(src).toContain("done()");
    expect(src).toContain("浅色模式");
    expect(src).toContain("data-theme");
  });
});

describe("challenge list flag summary", () => {
  it("latestPerChallenge returns the last candidate per challenge", async () => {
    const { createRepositories } = await import("@rio/database");
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(join(tmpdir(), "rio-flag-"));
    const repos = createRepositories(join(dir, "t.sqlite"));
    repos.candidates.create({
      challengeId: "ch_a",
      sessionId: null,
      value: "flag{old}",
      confidence: 0.4,
      reason: "first",
      evidenceJson: "[]",
      status: "PENDING",
    });
    repos.candidates.create({
      challengeId: "ch_a",
      sessionId: null,
      value: "flag{new}",
      confidence: 0.9,
      reason: "later",
      evidenceJson: "[]",
      status: "VERIFIED",
    });
    const latest = repos.candidates.latestPerChallenge();
    expect(latest.get("ch_a")?.value).toBe("flag{new}");
    expect(latest.get("ch_a")?.status).toBe("VERIFIED");
    repos.db.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
