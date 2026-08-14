// PREPARING crash: partial .part is cleared, challenge returns to DISCOVERED, second prepare → READY.
import { describe, it, expect, afterEach } from "vitest";
import { createRepositories } from "@rio/database";
import { createLogger } from "@rio/shared";
import { DiskManager } from "@rio/contest";
import { WorkspaceManager } from "@rio/tool-runtime";
import { existsSync, mkdtempSync, rmSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StateMachine } from "../../apps/server/src/state-machine.ts";
import { PreparationService } from "../../apps/server/src/control/preparation.ts";
import { RecoveryManager } from "../../apps/server/src/control/recovery.ts";
import { EventBus } from "../../apps/server/src/control/bus.ts";
import { seedChallenge } from "../helpers.ts";
import type { RemoteChallengeDetail } from "@rio/domain";

describe("PREPARING crash E2E", () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("kills a mid-download, removes .part, and re-prepares to READY", async () => {
    dir = mkdtempSync(join(tmpdir(), "rio-prep-e2e-"));
    const repos = createRepositories(join(dir, "t.sqlite"));
    const sm = new StateMachine(repos);
    const bus = new EventBus();
    const logger = createLogger("silent");
    const ws = new WorkspaceManager(join(dir, "ws"));
    const disk = new DiskManager(join(dir, "ws"), {
      globalWorkspaceLimitGb: 80,
      reserveDiskGb: 1,
      perChallengeSoftLimitGb: 8,
      maxConcurrentDownloads: 2,
    });

    let release: (() => void) | null = null;
    const hang = new Promise<void>((r) => {
      release = r;
    });
    const payload = Buffer.alloc(1000, 7);
    const adapter = {
      kind: "mock",
      async getChallenge(): Promise<RemoteChallengeDetail> {
        return {
          remoteId: "slow",
          title: "slow",
          description: "d",
          category: "MISC",
          score: 100,
          solveCount: null,
          createdAt: 0,
          updatedAt: 0,
          attachments: [{ remoteId: "a", name: "big.bin", url: "http://x/big.bin", sizeBytes: payload.length }],
        };
      },
      async downloadAttachment(_c: unknown, _a: unknown, sink?: { write: (b: Buffer) => void; end: () => void }) {
        sink?.write(payload.subarray(0, 200));
        await hang;
        sink?.write(payload.subarray(200));
        sink?.end();
        return { ok: true, bytes: payload.length, sha256: "ab", retryable: false };
      },
    };

    const preparation = new PreparationService({
      repos,
      adapter: adapter as never,
      workspace: ws,
      disk,
      stateMachine: sm,
      bus,
      logger,
      dataDir: dir,
      maxConcurrentDownloads: 2,
      pythonExecutable: process.env.RIO_PYTHON ?? "python",
    });
    repos.challenges.create(seedChallenge({ id: "ch_slow", remoteId: "slow", lifecycleStatus: "DISCOVERED", startStatus: "NOT_REQUIRED" }));

    const first = preparation.prepare(repos.challenges.get("ch_slow")!);
    const input = join(dir, "ws", "ch_slow", "input");
    const deadline = Date.now() + 10_000;
    let part = "";
    while (Date.now() < deadline) {
      if (existsSync(input)) {
        const hit = readdirSync(input).find((f) => f.endsWith(".part"));
        if (hit && statSync(join(input, hit)).size >= 200) {
          part = join(input, hit);
          break;
        }
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(part, "expected a .part after ~20% download").toBeTruthy();
    expect(existsSync(part)).toBe(true);
    expect(repos.challenges.get("ch_slow")!.lifecycleStatus).toBe("PREPARING");

    const recovery = new RecoveryManager({
      repos,
      stateMachine: sm,
      bus,
      logger,
      submissionManager: { recoverSubmitting: async () => {} } as never,
      preparation: { refreshChallengeFile: () => {} } as never,
      workspacesRoot: join(dir, "ws"),
    });
    await recovery.start();
    expect(repos.challenges.get("ch_slow")!.lifecycleStatus).toBe("DISCOVERED");
    expect(existsSync(part)).toBe(false);

    release?.();
    await first.catch(() => undefined);

    await preparation.prepare(repos.challenges.get("ch_slow")!);
    expect(repos.challenges.get("ch_slow")!.lifecycleStatus).toBe("READY");
    repos.db.close();
  }, 20_000);
});
