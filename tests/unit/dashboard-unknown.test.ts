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
  });
});
