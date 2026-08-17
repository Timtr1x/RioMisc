export * from "./math.js";
export * from "./rsa.js";
export * from "./xor.js";
export * from "./prng.js";
export * from "./aes.js";
export * from "./parse.js";

export function advancedMathUnavailable(name: string): { ok: false; code: "BACKEND_UNAVAILABLE"; message: string } {
  return { ok: false, code: "BACKEND_UNAVAILABLE", message: `${name} requires Sage/fpylll — not bundled in MVP-2` };
}

export interface AdvancedMathBackend {
  available(): Promise<boolean>;
  lll?(matrix: bigint[][]): Promise<bigint[][]>;
  coppersmith?(opts: unknown): Promise<bigint[]>;
  polynomialRoots?(opts: unknown): Promise<bigint[]>;
}

export const missingMathBackend: AdvancedMathBackend = {
  async available() {
    return false;
  },
};
