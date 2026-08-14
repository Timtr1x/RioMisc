import { describe, it, expect } from "vitest";
import { isRetryablePrepareError, prepareBackoffMs } from "../../apps/server/src/control/prepare-retry.ts";

describe("prepare retry", () => {
  it("treats 500/timeout as retryable and 404/disk as fatal", () => {
    expect(isRetryablePrepareError(new Error("download failed for a.bin: HTTP 500"))).toBe(true);
    expect(isRetryablePrepareError(new Error("ETIMEDOUT"))).toBe(true);
    expect(isRetryablePrepareError(new Error("HTTP 404 fetching"))).toBe(false);
    expect(isRetryablePrepareError(new Error("disk budget exceeded"))).toBe(false);
  });

  it("backs off", () => {
    expect(prepareBackoffMs(1)).toBe(5_000);
    expect(prepareBackoffMs(8)).toBe(5 * 60_000);
  });
});
