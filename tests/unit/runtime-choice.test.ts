import { describe, it, expect, afterEach } from "vitest";
import { createRepositories } from "@rio/database";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveAgentRuntime } from "../../apps/server/src/control/runtime-choice.ts";

describe("resolveAgentRuntime", () => {
  let dir: string;
  afterEach(() => {
    delete process.env.RIO_AGENT_RUNTIME;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("does not silently mock when allowMockFallback is false", () => {
    dir = mkdtempSync(join(tmpdir(), "rio-rt-"));
    const repos = createRepositories(join(dir, "t.sqlite"));
    expect(resolveAgentRuntime(repos, { allowMockFallback: false })).toBe("unavailable");
    expect(resolveAgentRuntime(repos, { allowMockFallback: true })).toBe("mock");
    repos.db.close();
  });
});
