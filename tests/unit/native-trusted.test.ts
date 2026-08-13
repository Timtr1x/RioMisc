// NativeTrusted: Python child env must not inherit secrets; timeout kills the tree.
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ProcessRunner, resolvePythonExecutable, killProcessTree } from "@rio/tool-runtime";

const SECRETS = [
  "CTF_RUNTIME_MASTER_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "RIO_PROVIDER_SECRET",
];

describe("NativeTrusted process runner", () => {
  it("python child environ contains none of the secret names", async () => {
    const python = resolvePythonExecutable(process.env.RIO_PYTHON ?? "python");
    const prev: Record<string, string | undefined> = {};
    for (const k of SECRETS) {
      prev[k] = process.env[k];
      process.env[k] = `secret-value-${k}`;
    }
    const dir = mkdtempSync(join(tmpdir(), "rio-pyenv-"));
    try {
      const runner = new ProcessRunner();
      const r = await runner.run(
        python.path,
        ["-c", "import os; print(os.environ)"],
        {
          cwd: dir,
          timeoutMs: 15_000,
          maxStdoutBytes: 256 * 1024,
          maxStderrBytes: 64 * 1024,
          envAllowlist: ["PATH", "SystemRoot", "TEMP", "TMP", "USERPROFILE", "HOME"],
        },
      );
      expect(r.ok).toBe(true);
      for (const k of SECRETS) {
        expect(r.stdout).not.toContain(k);
        expect(r.stdout).not.toContain(`secret-value-${k}`);
      }
    } finally {
      for (const k of SECRETS) {
        if (prev[k] === undefined) delete process.env[k];
        else process.env[k] = prev[k];
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("timeout/kill path tears down the child tree", async () => {
    const python = resolvePythonExecutable(process.env.RIO_PYTHON ?? "python");
    const dir = mkdtempSync(join(tmpdir(), "rio-pykill-"));
    const marker = join(dir, "child.pid");
    const script = join(dir, "tree.py");
    writeFileSync(
      script,
      `
import os, sys, time, subprocess
child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(120)"])
open(r"${marker.replaceAll("\\", "\\\\")}", "w").write(str(child.pid))
time.sleep(120)
`,
      "utf8",
    );
    const runner = new ProcessRunner();
    const r = await runner.run(python.path, [script], {
      cwd: dir,
      timeoutMs: 2500,
      maxStdoutBytes: 4096,
      maxStderrBytes: 4096,
      envAllowlist: ["PATH", "SystemRoot", "TEMP", "TMP", "USERPROFILE", "HOME"],
    });
    expect(r.timedOut).toBe(true);
    await new Promise((res) => setTimeout(res, 800));
    let childPid = 0;
    try {
      const { readFileSync } = await import("node:fs");
      childPid = Number(readFileSync(marker, "utf8").trim());
    } catch {
      childPid = 0;
    }
    if (childPid > 0) {
      await killProcessTree(childPid);
      let alive = false;
      try {
        process.kill(childPid, 0);
        alive = true;
      } catch {
        alive = false;
      }
      expect(alive).toBe(false);
    }
    rmSync(dir, { recursive: true, force: true });
  });
});
