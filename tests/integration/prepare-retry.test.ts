import { describe, it, expect, afterEach } from "vitest";
import { createRepositories } from "@rio/database";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StateMachine } from "../../apps/server/src/state-machine.ts";
import { isRetryablePrepareError } from "../../apps/server/src/control/prepare-retry.ts";
import { seedChallenge } from "../helpers.ts";

describe("retryable prepare does not stay ERROR", () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("500 → DISCOVERED, then PREPARE_DONE → READY", () => {
    dir = mkdtempSync(join(tmpdir(), "rio-prep-int-"));
    const repos = createRepositories(join(dir, "t.sqlite"));
    const sm = new StateMachine(repos);
    repos.challenges.create(seedChallenge({ id: "ch_p", lifecycleStatus: "DISCOVERED" }));
    expect(sm.transition("ch_p", "PREPARE_START").to).toBe("PREPARING");
    const err = new Error("download failed for x.bin: HTTP 500");
    expect(isRetryablePrepareError(err)).toBe(true);
    expect(sm.transition("ch_p", "PREPARE_RETRY", { payload: { reason: err.message } }).to).toBe("DISCOVERED");
    expect(repos.challenges.get("ch_p")!.lifecycleStatus).not.toBe("ERROR");
    expect(sm.transition("ch_p", "PREPARE_START").to).toBe("PREPARING");
    expect(sm.transition("ch_p", "PREPARE_DONE").to).toBe("READY");
    repos.db.close();
  });
});
