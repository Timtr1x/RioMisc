import { describe, it, expect, afterEach } from "vitest";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { applyEnvConfigOverrides, resolveConfigPath, runtimeConfigSchema } from "@rio/shared";

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

describe("applyEnvConfigOverrides", () => {
  const prev = { ...process.env };
  afterEach(() => {
    for (const k of ["RIO_DATA_DIR", "RIO_HOST", "RIO_PORT", "RIO_API_TOKEN"]) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  });

  it("RIO_DATA_DIR wins over yaml paths.dataDir", () => {
    const base = runtimeConfigSchema.parse({ paths: { dataDir: "./data" } });
    process.env.RIO_DATA_DIR = "/data/rio-misc";
    const next = applyEnvConfigOverrides(base);
    expect(next.paths.dataDir).toBe(resolve("/data/rio-misc"));
    expect(base.paths.dataDir).not.toBe(next.paths.dataDir);
  });
});
