import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { resolveConfigPath } from "@rio/shared";

describe("resolveConfigPath", () => {
  it("finds the repo config/runtime.yaml from this workspace", () => {
    const path = resolveConfigPath();
    expect(existsSync(path)).toBe(true);
    expect(path.replaceAll("\\", "/")).toMatch(/config\/runtime\.yaml$/);
  });
});
