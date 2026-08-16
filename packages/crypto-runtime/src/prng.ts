import { modInverse } from "./math.js";

export function lcgRecover(samples: bigint[], modulus?: bigint): { a: bigint; c: bigint; m: bigint } | null {
  if (samples.length < 3) return null;
  const m = modulus ?? 0x100000000n;
  const x0 = samples[0]!;
  const x1 = samples[1]!;
  const x2 = samples[2]!;
  const inv = modInverse(((x1 - x0) % m + m) % m, m);
  if (!inv) return null;
  const a = (((x2 - x1) % m + m) % m * inv) % m;
  const c = (((x1 - a * x0) % m) + m) % m;
  if (samples.length > 3) {
    const pred = (a * samples[2]! + c) % m;
    if (pred !== samples[3]! % m) return null;
  }
  return { a, c, m };
}

export function lcgNext(state: bigint, a: bigint, c: bigint, m: bigint): bigint {
  return (a * state + c) % m;
}

/** Recover MT19937 state from 624 raw 32-bit outputs (tempered). */
export function mt19937Untemper(y: number): number {
  y ^= y >>> 18;
  y ^= (y << 15) & 0xefc60000;
  y ^= (y << 7) & 0x9d2c5680;
  y ^= (y << 7) & 0x9d2c5680;
  y ^= (y << 7) & 0x9d2c5680;
  y ^= (y << 7) & 0x9d2c5680;
  y ^= y >>> 11;
  y ^= y >>> 11;
  return y >>> 0;
}

export function mt19937Recover(outputs: number[]): number[] | null {
  if (outputs.length < 624) return null;
  return outputs.slice(0, 624).map((y) => mt19937Untemper(y >>> 0));
}
