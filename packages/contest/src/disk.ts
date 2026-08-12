// DiskManager — global workspace budget + free-space reserve.
import { statfsSync, readdirSync, statSync, rmSync } from "node:fs";
import { join } from "node:path";

export interface DiskBudget {
  globalWorkspaceLimitGb: number;
  reserveDiskGb: number;
  perChallengeSoftLimitGb: number;
  maxConcurrentDownloads: number;
}

export class DiskManager {
  constructor(
    private readonly workspacesRoot: string,
    private readonly budget: DiskBudget,
  ) {}

  freeDiskGb(): number {
    try {
      const s = statfsSync(this.workspacesRoot);
      return (Number(s.bavail) * Number(s.bsize)) / 1024 ** 3;
    } catch {
      return Number.POSITIVE_INFINITY;
    }
  }

  workspaceUsedGb(): number {
    return this.dirSizeGb(this.workspacesRoot);
  }

  dirSizeGb(dir: string): number {
    let total = 0;
    try {
      for (const entry of readdirSync(dir)) {
        const p = join(dir, entry);
        const st = statSync(p);
        if (st.isDirectory()) total += this.dirSizeGb(p);
        else total += st.size;
      }
    } catch {
      // dir may not exist yet
    }
    return total / 1024 ** 3;
  }

  /** Would `additionalBytes` fit within budget & reserve? */
  canDownload(additionalBytes: number): { ok: boolean; reason?: string } {
    const free = this.freeDiskGb();
    if (free < this.budget.reserveDiskGb) {
      return { ok: false, reason: `DISK_RESOURCE: only ${free.toFixed(1)}GB free, need ${this.budget.reserveDiskGb}GB reserve` };
    }
    const used = this.workspaceUsedGb();
    if (used + additionalBytes / 1024 ** 3 > this.budget.globalWorkspaceLimitGb) {
      return { ok: false, reason: `DISK_RESOURCE: workspace would exceed ${this.budget.globalWorkspaceLimitGb}GB` };
    }
    return { ok: true };
  }

  /**
   * Free regenerable space in a challenge workspace (results/, artifacts/,
   * state/). NEVER deletes input/, work/ scripts, or sessions.
   */
  releaseRegenerable(challengeDir: string): number {
    let freed = 0;
    for (const sub of ["results", "artifacts", "state", "tmp"]) {
      try {
        const p = join(challengeDir, sub);
        if (!statSync(p).isDirectory()) continue;
        const size = this.dirSizeGb(p);
        rmSync(p, { recursive: true, force: true });
        freed += size;
      } catch {
        // ignore missing dirs
      }
    }
    return freed;
  }

  /** Sorted candidates for cleanup: SOLVED challenges, smallest first. */
  cleanupCandidates(solvedChallengeDirs: { dir: string; sizeGb: number }[]): { dir: string; sizeGb: number }[] {
    return [...solvedChallengeDirs].sort((a, b) => a.sizeGb - b.sizeGb);
  }
}
