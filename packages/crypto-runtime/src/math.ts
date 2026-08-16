export function gcd(a: bigint, b: bigint): bigint {
  a = abs(a);
  b = abs(b);
  while (b !== 0n) {
    const t = a % b;
    a = b;
    b = t;
  }
  return a;
}

export function egcd(a: bigint, b: bigint): { g: bigint; x: bigint; y: bigint } {
  if (b === 0n) return { g: a, x: 1n, y: 0n };
  const { g, x, y } = egcd(b, a % b);
  return { g, x: y, y: x - (a / b) * y };
}

export function modInverse(a: bigint, m: bigint): bigint | null {
  const { g, x } = egcd(((a % m) + m) % m, m);
  if (g !== 1n) return null;
  return ((x % m) + m) % m;
}

export function crt(residues: { a: bigint; m: bigint }[]): bigint | null {
  let M = 1n;
  for (const r of residues) M *= r.m;
  let x = 0n;
  for (const r of residues) {
    const Mi = M / r.m;
    const inv = modInverse(Mi, r.m);
    if (inv === null) return null;
    x += r.a * Mi * inv;
  }
  return ((x % M) + M) % M;
}

export function integerRoot(n: bigint, k: bigint): { root: bigint; exact: boolean } {
  if (n < 0n) throw new Error("integer root of negative");
  if (n < 2n) return { root: n, exact: true };
  let lo = 1n;
  let hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >> 1n;
    const p = pow(mid, k);
    if (p === n) return { root: mid, exact: true };
    if (p < n) lo = mid + 1n;
    else hi = mid;
  }
  const root = lo;
  const p = pow(root, k);
  if (p === n) return { root, exact: true };
  const prev = root - 1n;
  return { root: prev, exact: pow(prev, k) === n };
}

export function pow(base: bigint, exp: bigint): bigint {
  let r = 1n;
  let b = base;
  let e = exp;
  while (e > 0n) {
    if (e & 1n) r *= b;
    b *= b;
    e >>= 1n;
  }
  return r;
}

export function modPow(base: bigint, exp: bigint, mod: bigint): bigint {
  let r = 1n;
  let b = ((base % mod) + mod) % mod;
  let e = exp;
  while (e > 0n) {
    if (e & 1n) r = (r * b) % mod;
    b = (b * b) % mod;
    e >>= 1n;
  }
  return r;
}

export function isqrt(n: bigint): bigint {
  return integerRoot(n, 2n).root;
}

export function abs(n: bigint): bigint {
  return n < 0n ? -n : n;
}

export function parseBig(raw: string): bigint {
  const s = raw.trim().replace(/[_ ,]/g, "");
  if (/^0x/i.test(s)) return BigInt(s);
  return BigInt(s);
}

export function pollardRho(n: bigint): bigint | null {
  if (n % 2n === 0n) return 2n;
  for (let seed = 2n; seed < 20n; seed++) {
    let x = seed;
    let y = seed;
    let d = 1n;
    const c = seed;
    const f = (v: bigint) => (v * v + c) % n;
    let steps = 0;
    while (d === 1n && steps < 100_000) {
      x = f(x);
      y = f(f(y));
      d = gcd(abs(x - y), n);
      steps += 1;
    }
    if (d !== 1n && d !== n) return d;
  }
  return null;
}

export function factorInteger(n: bigint): bigint[] {
  n = abs(n);
  const out: bigint[] = [];
  if (n < 2n) return out;
  while (n % 2n === 0n) {
    out.push(2n);
    n /= 2n;
  }
  for (let p = 3n; p * p <= n && p < 10_000n; p += 2n) {
    while (n % p === 0n) {
      out.push(p);
      n /= p;
    }
  }
  if (n === 1n) return out;
  if (isProbablePrime(n)) {
    out.push(n);
    return out;
  }
  const d = pollardRho(n);
  if (d) return [...out, ...factorInteger(d), ...factorInteger(n / d)];
  out.push(n);
  return out;
}

export function isProbablePrime(n: bigint): boolean {
  if (n < 2n) return false;
  const small = [2n, 3n, 5n, 7n, 11n, 13n, 17n, 19n, 23n];
  for (const p of small) {
    if (n === p) return true;
    if (n % p === 0n) return false;
  }
  return true;
}
