// Workspace manager + Filesystem Guard (§44, §47).
// Each challenge gets data/workspaces/<challenge-id>/{input,work,artifacts,results,state,agent}.
// Solver tools resolve paths through safeResolve() and may never escape the workspace.
import { mkdirSync, realpathSync, existsSync, rmSync } from "node:fs";
import { join, resolve, sep, normalize } from "node:path";

export interface WorkspaceLayout {
  root: string;
  input: string;
  work: string;
  artifacts: string;
  results: string;
  state: string;
  agent: string;
  tmp: string;
}

export class WorkspaceManager {
  constructor(private readonly workspacesRoot: string) {}

  /** Create the standard layout for a challenge. */
  ensure(id: string): WorkspaceLayout {
    const root = resolve(join(this.workspacesRoot, sanitizeId(id)));
    const layout = {
      root,
      input: join(root, "input"),
      work: join(root, "work"),
      artifacts: join(root, "artifacts"),
      results: join(root, "results"),
      state: join(root, "state"),
      agent: join(root, "agent"),
      tmp: join(root, "tmp"),
    };
    for (const dir of Object.values(layout)) mkdirSync(dir, { recursive: true });
    return layout;
  }

  exists(id: string): boolean {
    return existsSync(resolve(join(this.workspacesRoot, sanitizeId(id))));
  }

  /** Absolute root of a challenge workspace. */
  rootOf(id: string): string {
    return resolve(join(this.workspacesRoot, sanitizeId(id)));
  }

  /** Delete the challenge workspace. No-op if it does not exist. */
  remove(id: string): void {
    const root = this.rootOf(id);
    const base = resolve(this.workspacesRoot);
    if (root === base || !root.startsWith(base + sep)) {
      throw new Error(`refusing to delete workspace outside root: ${id}`);
    }
    rmSync(root, { recursive: true, force: true });
  }

  /** Resolve a possibly-relative tool path inside the workspace, rejecting escapes. */
  safeResolve(workspaceRoot: string, requestedPath: string): string {
    if (isUnsafeWorkspacePath(requestedPath)) {
      throw new Error(`Path escape denied: ${requestedPath}`);
    }
    const root = realpathSync(workspaceRoot);
    const unified = requestedPath.replace(/\\/g, "/");
    const candidate = posixLikeAbsolute(unified) ? normalize(requestedPath) : resolve(root, ...unified.split("/").filter((p) => p.length > 0));
    if (!candidate.startsWith(root + sep) && candidate !== root) {
      throw new Error(`Path escape denied: ${requestedPath}`);
    }
    const real = existsSync(candidate) ? realpathSync(candidate) : candidate;
    if (!real.startsWith(root + sep) && real !== root) {
      throw new Error(`Symlink/junction escape denied: ${requestedPath}`);
    }
    return real;
  }
}

/** Windows drive, UNC, or POSIX absolute — reject on every host OS. */
export function isUnsafeWorkspacePath(requestedPath: string): boolean {
  const p = String(requestedPath ?? "");
  if (/^[a-zA-Z]:[\\/]/.test(p)) return true;
  if (/^\\\\[^\\]/.test(p) || /^\/\/[^/]/.test(p)) return true;
  return false;
}

function posixLikeAbsolute(unified: string): boolean {
  return unified.startsWith("/") || /^[a-zA-Z]:\//.test(unified);
}

export function sanitizeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]/g, "_");
}
