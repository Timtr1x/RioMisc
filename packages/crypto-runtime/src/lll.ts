import { abs, gcd } from "./math.js";

/** Exact rational for Gram–Schmidt. */
class Q {
  n: bigint;
  d: bigint;
  constructor(n: bigint, d: bigint = 1n) {
    if (d === 0n) throw new Error("division by zero");
    if (d < 0n) {
      n = -n;
      d = -d;
    }
    const g = gcd(abs(n), d);
    this.n = n / g;
    this.d = d / g;
  }
  static from(v: bigint | Q): Q {
    return v instanceof Q ? v : new Q(v);
  }
  add(o: Q): Q {
    return new Q(this.n * o.d + o.n * this.d, this.d * o.d);
  }
  sub(o: Q): Q {
    return new Q(this.n * o.d - o.n * this.d, this.d * o.d);
  }
  mul(o: Q): Q {
    return new Q(this.n * o.n, this.d * o.d);
  }
  div(o: Q): Q {
    return new Q(this.n * o.d, this.d * o.n);
  }
  neg(): Q {
    return new Q(-this.n, this.d);
  }
  abs(): Q {
    return new Q(abs(this.n), this.d);
  }
  cmp(o: Q): number {
    const a = this.n * o.d;
    const b = o.n * this.d;
    return a < b ? -1 : a > b ? 1 : 0;
  }
  /** Nearest integer; ties away from zero to match common LLL size-reduction. */
  round(): bigint {
    const twice = this.n * 2n;
    const den = this.d;
    if (this.n >= 0n) return (twice + den) / (den * 2n);
    return -((-twice + den) / (den * 2n));
  }
}

const MAX_DIM = 48;

export function parseIntegerMatrix(raw: string): bigint[][] | null {
  const s = raw.trim();
  if (!s) return null;
  try {
    const parsed = JSON.parse(s) as unknown;
    if (Array.isArray(parsed) && parsed.every((row) => Array.isArray(row))) {
      const rows = (parsed as unknown[][]).map((row) => row.map((c) => BigInt(String(c).trim())));
      if (rows.length === 0 || rows.some((r) => r.length !== rows[0]!.length)) return null;
      return rows;
    }
  } catch {
    /* fall through to whitespace rows */
  }
  const lines = s
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
  if (lines.length === 0) return null;
  const rows: bigint[][] = [];
  for (const line of lines) {
    const cells = line
      .replace(/[[\],;]/g, " ")
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    if (cells.length === 0) continue;
    rows.push(cells.map((c) => BigInt(c)));
  }
  if (rows.length === 0 || rows.some((r) => r.length !== rows[0]!.length)) return null;
  return rows;
}

function dot(a: bigint[], b: bigint[]): Q {
  let s = 0n;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return new Q(s);
}

function gramSchmidt(B: bigint[][]): { mu: Q[][]; bstar2: Q[] } {
  const n = B.length;
  const mu: Q[][] = Array.from({ length: n }, () => Array.from({ length: n }, () => new Q(0n)));
  const bstar: Q[][] = Array.from({ length: n }, () => []);
  const bstar2: Q[] = [];
  for (let i = 0; i < n; i++) {
    const bi = B[i]!.map((x) => new Q(x));
    const star = bi.slice();
    for (let j = 0; j < i; j++) {
      let ip = new Q(0n);
      for (let k = 0; k < star.length; k++) ip = ip.add(bi[k]!.mul(bstar[j]![k]!));
      const m = bstar2[j]!.n === 0n ? new Q(0n) : ip.div(bstar2[j]!);
      mu[i]![j] = m;
      for (let k = 0; k < star.length; k++) star[k] = star[k]!.sub(m.mul(bstar[j]![k]!));
    }
    mu[i]![i] = new Q(1n);
    bstar[i] = star;
    let n2 = new Q(0n);
    for (const c of star) n2 = n2.add(c.mul(c));
    bstar2[i] = n2;
  }
  return { mu, bstar2 };
}

function addScaled(row: bigint[], other: bigint[], k: bigint): void {
  for (let i = 0; i < row.length; i++) row[i] = row[i]! + k * other[i]!;
}

/**
 * Exact integer LLL on row vectors. δ defaults to 99/100.
 * Always available on the host — no Sage/fpylll/Docker required.
 */
export function lllReduce(basis: bigint[][], deltaNum = 99n, deltaDen = 100n): bigint[][] {
  if (basis.length === 0) return [];
  const n = basis.length;
  const cols = basis[0]!.length;
  if (n > MAX_DIM || cols > 256) throw new Error(`lattice too large (${n}x${cols}; max ${MAX_DIM} rows)`);
  if (basis.some((r) => r.length !== cols)) throw new Error("ragged matrix");

  const B = basis.map((r) => r.map((x) => x));
  let k = 1;
  let { mu, bstar2 } = gramSchmidt(B);
  let guard = 0;
  const guardMax = n * n * 80 + 32;

  while (k < n) {
    if (++guard > guardMax) throw new Error("LLL did not terminate");
    for (let j = k - 1; j >= 0; j--) {
      const r = mu[k]![j]!.round();
      if (r === 0n) continue;
      addScaled(B[k]!, B[j]!, -r);
      ({ mu, bstar2 } = gramSchmidt(B));
    }
    const lovaszRhs = new Q(deltaNum, deltaDen).sub(mu[k]![k - 1]!.mul(mu[k]![k - 1]!)).mul(bstar2[k - 1]!);
    if (bstar2[k]!.cmp(lovaszRhs) >= 0) {
      k += 1;
    } else {
      const tmp = B[k]!;
      B[k] = B[k - 1]!;
      B[k - 1] = tmp;
      ({ mu, bstar2 } = gramSchmidt(B));
      k = Math.max(k - 1, 1);
    }
  }
  return B;
}

export function matrixDet(rows: bigint[][]): bigint | null {
  const n = rows.length;
  if (n === 0 || rows.some((r) => r.length !== n)) return null;
  const A = rows.map((r) => r.map((x) => new Q(x)));
  let det = new Q(1n);
  for (let i = 0; i < n; i++) {
    let pivot = i;
    while (pivot < n && A[pivot]![i]!.n === 0n) pivot += 1;
    if (pivot === n) return 0n;
    if (pivot !== i) {
      const t = A[i]!;
      A[i] = A[pivot]!;
      A[pivot] = t;
      det = det.neg();
    }
    const piv = A[i]![i]!;
    det = det.mul(piv);
    for (let r = i + 1; r < n; r++) {
      const f = A[r]![i]!.div(piv);
      for (let c = i; c < n; c++) A[r]![c] = A[r]![c]!.sub(f.mul(A[i]![c]!));
    }
  }
  if (det.d !== 1n) return null;
  return det.n;
}

export function vectorNorm2(v: bigint[]): bigint {
  let s = 0n;
  for (const x of v) s += x * x;
  return s;
}

void dot;
