import { describe, it, expect } from "vitest";
import { shouldStartOn } from "../../apps/server/src/control/start-policy.ts";

describe("start policy", () => {
  it("ON_DISCOVERY only fires at discovery", () => {
    expect(shouldStartOn("ON_DISCOVERY", "discovery")).toBe(true);
    expect(shouldStartOn("ON_DISCOVERY", "preparation")).toBe(false);
    expect(shouldStartOn("ON_DISCOVERY", "solver")).toBe(false);
  });

  it("ON_PREPARATION only fires at preparation", () => {
    expect(shouldStartOn("ON_PREPARATION", "discovery")).toBe(false);
    expect(shouldStartOn("ON_PREPARATION", "preparation")).toBe(true);
    expect(shouldStartOn("ON_PREPARATION", "solver")).toBe(false);
  });

  it("ON_SOLVER_ASSIGNMENT only fires at solver", () => {
    expect(shouldStartOn("ON_SOLVER_ASSIGNMENT", "discovery")).toBe(false);
    expect(shouldStartOn("ON_SOLVER_ASSIGNMENT", "preparation")).toBe(false);
    expect(shouldStartOn("ON_SOLVER_ASSIGNMENT", "solver")).toBe(true);
  });
});
