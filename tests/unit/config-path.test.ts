import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { resolveConfigPath, runtimeConfigSchema } from "@rio/shared";

describe("resolveConfigPath", () => {
  it("finds the repo config/runtime.yaml from this workspace", () => {
    const path = resolveConfigPath();
    expect(existsSync(path)).toBe(true);
    expect(path.replaceAll("\\", "/")).toMatch(/config\/runtime\.yaml$/);
  });

  it("accepts contest.trustedCredentialOrigins in yaml", () => {
    const cfg = runtimeConfigSchema.parse({
      contest: { trustedCredentialOrigins: ["https://files.ctf.example.com"] },
    });
    expect(cfg.contest.trustedCredentialOrigins).toEqual(["https://files.ctf.example.com"]);
  });
});
