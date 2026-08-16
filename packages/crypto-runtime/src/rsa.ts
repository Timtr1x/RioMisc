import { crt, factorInteger, gcd, integerRoot, isqrt, modInverse, modPow } from "./math.js";

export interface RsaInstance {
  n?: bigint;
  e?: bigint;
  c?: bigint;
  p?: bigint;
  q?: bigint;
  d?: bigint;
}

export function analyzeRsaInstance(inst: RsaInstance): {
  bitLength: number;
  checks: Record<string, boolean | string>;
  attackCandidates: { attack: string; confidence: number }[];
} {
  const n = inst.n;
  const e = inst.e ?? 65537n;
  const bitLength = n ? n.toString(2).length : 0;
  const checks = {
    smallE: e <= 7n,
    perfectPowerCandidate: n ? integerRoot(n, 2n).exact : false,
    fermatDistance: n ? String(fermatDistance(n)) : "n/a",
    wienerApplicable: n ? e * e * e > n : false,
    sharedModulus: false,
  };
  const attackCandidates: { attack: string; confidence: number }[] = [];
  if (n && n < 2n ** 80n) attackCandidates.push({ attack: "FACTOR", confidence: 0.9 });
  if (e <= 7n && inst.c !== undefined) attackCandidates.push({ attack: "SMALL_E", confidence: 0.85 });
  if (n && fermatDistance(n) < 1_000_000n) attackCandidates.push({ attack: "FERMAT", confidence: 0.8 });
  if (n && e * e * e > n) attackCandidates.push({ attack: "WIENER", confidence: 0.75 });
  return { bitLength, checks, attackCandidates };
}

export function rsaBasicDecrypt(n: bigint, e: bigint, c: bigint, p?: bigint, q?: bigint): bigint | null {
  let pp = p;
  let qq = q;
  if (!pp || !qq) {
    const fac = factorInteger(n);
    if (fac.length < 2) return null;
    pp = fac[0]!;
    qq = n / pp;
  }
  const phi = (pp - 1n) * (qq - 1n);
  const d = modInverse(e, phi);
  if (!d) return null;
  return modPow(c, d, n);
}

export function rsaSmallE(c: bigint, e: bigint, n?: bigint): bigint | null {
  if (!n) {
    const r = integerRoot(c, e);
    return r.exact ? r.root : null;
  }
  for (let k = 0n; k < 4096n; k++) {
    const r = integerRoot(k * n + c, e);
    if (r.exact && r.root > 0n) return r.root;
  }
  return null;
}

export function rsaFermat(n: bigint, maxSteps = 2_000_000): { p: bigint; q: bigint } | null {
  let a = isqrt(n);
  if (a * a < n) a += 1n;
  for (let i = 0; i < maxSteps; i++) {
    const b2 = a * a - n;
    const b = isqrt(b2);
    if (b * b === b2) return { p: a - b, q: a + b };
    a += 1n;
  }
  return null;
}

export function rsaWiener(n: bigint, e: bigint): bigint | null {
  const conv = convergents(e, n);
  for (const { k, d } of conv) {
    if (k === 0n) continue;
    if ((e * d - 1n) % k !== 0n) continue;
    const phi = (e * d - 1n) / k;
    const s = n - phi + 1n;
    const disc = s * s - 4n * n;
    if (disc < 0n) continue;
    const t = isqrt(disc);
    if (t * t !== disc) continue;
    if ((s - t) % 2n !== 0n) continue;
    return d;
  }
  return null;
}

export function rsaCommonModulus(n: bigint, e1: bigint, c1: bigint, e2: bigint, c2: bigint): bigint | null {
  if (gcd(e1, e2) !== 1n) return null;
  const { x, y } = extCombo(e1, e2);
  const a = x < 0n ? modInverse(c1, n) : c1;
  const b = y < 0n ? modInverse(c2, n) : c2;
  if (!a || !b) return null;
  return (modPow(a, abs(x), n) * modPow(b, abs(y), n)) % n;
}

export function rsaHastad(e: bigint, pairs: { c: bigint; n: bigint }[]): bigint | null {
  if (pairs.length < Number(e)) return null;
  const take = pairs.slice(0, Number(e));
  const c = crt(take.map((p) => ({ a: p.c, m: p.n })));
  if (c === null) return null;
  const r = integerRoot(c, e);
  return r.exact ? r.root : null;
}

function fermatDistance(n: bigint): bigint {
  const a = isqrt(n);
  return a * a >= n ? a * a - n : (a + 1n) * (a + 1n) - n;
}

function convergents(e: bigint, n: bigint): { k: bigint; d: bigint }[] {
  const cf: bigint[] = [];
  let a = e;
  let b = n;
  while (b !== 0n && cf.length < 200) {
    cf.push(a / b);
    const t = a % b;
    a = b;
    b = t;
  }
  const out: { k: bigint; d: bigint }[] = [];
  let n0 = 0n, n1 = 1n, d0 = 1n, d1 = 0n;
  for (const q of cf) {
    const nn = q * n1 + n0;
    const dd = q * d1 + d0;
    n0 = n1;
    d0 = d1;
    n1 = nn;
    d1 = dd;
    out.push({ k: nn, d: dd });
  }
  return out;
}

function extCombo(a: bigint, b: bigint): { x: bigint; y: bigint } {
  const { x, y } = (function rec(aa: bigint, bb: bigint): { x: bigint; y: bigint } {
    if (bb === 0n) return { x: 1n, y: 0n };
    const q = aa / bb;
    const r = rec(bb, aa % bb);
    return { x: r.y, y: r.x - q * r.y };
  })(a, b);
  return { x, y };
}

function abs(n: bigint): bigint {
  return n < 0n ? -n : n;
}
