// Resolve the configured Python to an absolute path at process start.
import { existsSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { spawnSync } from "node:child_process";

export interface ResolvedPython {
  path: string;
  version: string;
}

function firstExisting(candidates: string[]): string | null {
  for (const c of candidates) {
    if (!c) continue;
    try {
      if (existsSync(c) && statSync(c).isFile()) return resolve(c);
    } catch {
      /* ignore */
    }
  }
  return null;
}

function which(cmd: string): string | null {
  const tool = process.platform === "win32" ? "where" : "which";
  const r = spawnSync(tool, [cmd], { encoding: "utf8", shell: false, windowsHide: true });
  if (r.status !== 0) return null;
  const line = (r.stdout ?? "").split(/\r?\n/).map((s) => s.trim()).find(Boolean);
  return line ? resolve(line) : null;
}

function pythonVersion(abs: string): string {
  const r = spawnSync(abs, ["-c", "import sys; print(sys.version.split()[0])"], {
    encoding: "utf8",
    shell: false,
    windowsHide: true,
    timeout: 10_000,
  });
  return (r.stdout ?? "").trim() || "unknown";
}

/** Resolve RIO_PYTHON / configured name to an absolute executable. Throws if missing. */
export function resolvePythonExecutable(configured?: string | null): ResolvedPython {
  const raw = (configured && configured.trim()) || process.env.RIO_PYTHON || "python";
  let abs: string | null = null;
  if (isAbsolute(raw)) {
    abs = firstExisting([raw, process.platform === "win32" && !raw.toLowerCase().endsWith(".exe") ? `${raw}.exe` : ""]);
  } else {
    abs = which(raw);
    if (!abs && process.platform === "win32" && !raw.toLowerCase().endsWith(".exe")) {
      abs = which(`${raw}.exe`);
    }
    if (!abs) {
      abs = firstExisting([
        process.platform === "win32" ? `C:\\Python312\\python.exe` : "",
        process.platform === "win32" ? `C:\\Python311\\python.exe` : "/usr/bin/python3",
        "/usr/bin/python",
      ]);
    }
  }
  if (!abs) {
    throw new Error(`Python executable not found (configured=${JSON.stringify(raw)}). Set RIO_PYTHON to an absolute path.`);
  }
  return { path: abs, version: pythonVersion(abs) };
}
