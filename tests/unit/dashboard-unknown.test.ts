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
    expect(src).toContain("上下文窗口");
    expect(src).toContain("最大输出 token");
    expect(src).toContain("保存上限");
    expect(src).toContain("done()");
    expect(src).toContain("浅色模式");
    expect(src).toContain("data-theme");
    expect(src).toContain("模型 API 连续失败");
    expect(src).toContain("不会自动换备用模型");
    expect(src).toContain("信任的附件域名");
    expect(src).toContain("视觉能力");
    expect(src).toContain("视觉模型");
    expect(src).toContain("enabledProviderIds");
    expect(src).toContain("反思模型");
    expect(src).toContain("analyze_visual");
    expect(src).toContain("视觉复核");
    expect(src).toContain("request_visual_review");
    expect(src).toContain("HUMAN VISUAL OBSERVATION");
    expect(src).toContain("同时作为候选提交");
    expect(src).toContain("pickLatestReflection");
    expect(src).toContain("zhReflectTrigger");
    expect(src).toContain("评测");
    expect(src).toContain("实验账本");
    expect(src).toContain("跑全部评测");
    expect(src).toContain("Solve Rate");
    expect(src).toContain("产物图");
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
