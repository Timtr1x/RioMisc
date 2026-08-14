import { describe, it, expect } from "vitest";
import { assertApiBindSafe, isLoopbackHost } from "../../apps/server/src/api/bind-guard.ts";

describe("API bind guard", () => {
  it("allows loopback without token", () => {
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(() => assertApiBindSafe("127.0.0.1")).not.toThrow();
  });

  it("rejects 0.0.0.0 without token", () => {
    expect(() => assertApiBindSafe("0.0.0.0")).toThrow(/RIO_API_TOKEN/);
  });

  it("allows non-loopback when token is set", () => {
    expect(() => assertApiBindSafe("0.0.0.0", "supersecret")).not.toThrow();
  });
});
