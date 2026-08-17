export * from "./math.js";
export * from "./rsa.js";
export * from "./xor.js";
export * from "./prng.js";
export * from "./aes.js";
export * from "./parse.js";
export * from "./lll.js";
export * from "./dlog.js";
export * from "./backend.js";

export function advancedMathUnavailable(name: string): { ok: false; code: "BACKEND_UNAVAILABLE"; message: string } {
  return { ok: false, code: "BACKEND_UNAVAILABLE", message: `${name} requires Sage/fpylll — not bundled in MVP-2` };
}
