import { modPow } from "./math.js";

const DEFAULT_BOUND = 1n << 22n;

/**
 * Baby-step giant-step discrete log: find x such that g^x ≡ h (mod m).
 * Returns null if no solution exists below `bound` (default 2^22).
 */
export function discreteLogSmall(
  g: bigint,
  h: bigint,
  modulus: bigint,
  bound: bigint = DEFAULT_BOUND,
): bigint | null {
  if (modulus <= 1n) return null;
  g = ((g % modulus) + modulus) % modulus;
  h = ((h % modulus) + modulus) % modulus;
  if (h === 1n) return 0n;
  if (g === 0n) return h === 0n ? 1n : null;

  const n = bound < modulus - 1n ? bound : modulus - 1n;
  let step = 1n;
  while (step * step < n) step <<= 1n;
  if (step < 1n) step = 1n;

  const table = new Map<string, bigint>();
  let acc = 1n;
  for (let j = 0n; j < step; j++) {
    if (!table.has(acc.toString())) table.set(acc.toString(), j);
    acc = (acc * g) % modulus;
  }

  const factor = modPow(g, modulus - 1n - (step % (modulus - 1n)), modulus);
  let gamma = h;
  const giantSteps = (n + step - 1n) / step;
  for (let i = 0n; i < giantSteps; i++) {
    const j = table.get(gamma.toString());
    if (j !== undefined) {
      const x = i * step + j;
      if (modPow(g, x, modulus) === h) return x;
    }
    gamma = (gamma * factor) % modulus;
  }
  return null;
}
