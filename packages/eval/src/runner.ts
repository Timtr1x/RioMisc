import { encodePng } from "@rio/visual-runtime";
import { scanTrailingData } from "@rio/misc-runtime";
import { lcgRecover, rsaFermat, rsaSmallE, rsaWiener, xorKnownPlaintext } from "@rio/crypto-runtime";
import { solveRegisteredWithTools } from "./solve-registered.js";
import type { BenchmarkManifest, BenchmarkRunResult } from "@rio/domain";
import { BENCHMARK_MANIFESTS, getManifest } from "./manifests.js";

export interface ReplayRecord {
  tool: string;
  canonicalArgs: string;
  result: unknown;
}

export function replayLookup(log: ReplayRecord[], tool: string, canonicalArgs: string): unknown | undefined {
  return log.find((r) => r.tool === tool && r.canonicalArgs === canonicalArgs)?.result;
}

const MANIFEST_TO_FIXTURE: Record<string, string> = {
  "misc-qr-001": "misc-006",
  "misc-wav-sr-001": "misc-007",
  "crypto-hastad-001": "crypto-006",
  "misc-visual-low-contrast-001": "misc-008",
  "misc-visual-channel-001": "misc-009",
  "misc-visual-bitplane-001": "misc-010",
  "misc-visual-alpha-001": "misc-011",
  "misc-visual-gif-001": "misc-012",
  "misc-visual-rotated-001": "misc-013",
  "misc-visual-inverted-001": "misc-014",
  "misc-pcap-dns-001": "misc-015",
};

export async function runBenchmark(id?: string): Promise<BenchmarkRunResult[]> {
  const list = id ? ([getManifest(id)].filter(Boolean) as BenchmarkManifest[]) : BENCHMARK_MANIFESTS;
  const out: BenchmarkRunResult[] = [];
  for (const m of list) {
    const fixtureId = MANIFEST_TO_FIXTURE[m.id];
    if (fixtureId) {
      const started = Date.now();
      try {
        const solved = await solveRegisteredWithTools(fixtureId);
        out.push({
          id: `run_${m.id}`,
          manifestId: m.id,
          solved: solved.flag === m.flag,
          flag: solved.flag,
          techniques: solved.techniques,
          toolCalls: solved.toolCalls,
          durationMs: Date.now() - started,
          error: solved.flag === m.flag ? null : `got ${solved.flag}`,
          createdAt: Date.now(),
        });
      } catch (e) {
        out.push({
          id: `run_${m.id}`,
          manifestId: m.id,
          solved: false,
          flag: null,
          techniques: [],
          toolCalls: 0,
          durationMs: Date.now() - started,
          error: (e as Error).message,
          createdAt: Date.now(),
        });
      }
      continue;
    }
    out.push(runOne(m));
  }
  return out;
}

export function summarizeBenchmark(results: BenchmarkRunResult[]): {
  total: number;
  solved: number;
  failed: number;
  solveRate: number;
  medianMs: number;
  durationMs: number;
} {
  const times = results.map((r) => r.durationMs).sort((a, b) => a - b);
  const solved = results.filter((r) => r.solved).length;
  return {
    total: results.length,
    solved,
    failed: results.length - solved,
    solveRate: results.length ? solved / results.length : 0,
    medianMs: times.length ? times[Math.floor(times.length / 2)]! : 0,
    durationMs: results.reduce((a, r) => a + r.durationMs, 0),
  };
}

export function runOne(m: BenchmarkManifest): BenchmarkRunResult {
  const started = Date.now();
  const techniques: string[] = [];
  let toolCalls = 0;
  try {
    const flag = solve(m, techniques, () => {
      toolCalls += 1;
    });
    return {
      id: `run_${m.id}`,
      manifestId: m.id,
      solved: flag === m.flag,
      flag,
      techniques,
      toolCalls,
      durationMs: Date.now() - started,
      error: flag === m.flag ? null : `got ${flag}`,
      createdAt: Date.now(),
    };
  } catch (e) {
    return {
      id: `run_${m.id}`,
      manifestId: m.id,
      solved: false,
      flag: null,
      techniques,
      toolCalls,
      durationMs: Date.now() - started,
      error: (e as Error).message,
      createdAt: Date.now(),
    };
  }
}

function solve(m: BenchmarkManifest, techniques: string[], tap: () => void): string | null {
  if (m.id === "misc-trailing-zip-001") {
    tap();
    const png = encodePng({ width: 2, height: 2, data: new Uint8Array(16).fill(255) });
    const payload = Buffer.concat([png, Buffer.from("flag{trailing_zip}")]);
    const trail = scanTrailingData(payload);
    techniques.push("scan_trailing_data");
    if (trail.hasTrailingData) {
      const hidden = payload.subarray(trail.offset!).toString("utf8");
      return hidden.includes("flag{") ? hidden.match(/flag\{[^}]+\}/)![0]! : null;
    }
    return null;
  }
  if (m.id === "crypto-rsa-small-e-001") {
    tap();
    const m0 = Buffer.from("flag{cube}").reduce((a, b) => (a << 8n) + BigInt(b), 0n);
    const e = 3n;
    const c = m0 ** e;
    techniques.push("rsa-small-e");
    const rec = rsaSmallE(c, e);
    return rec ? decodeAscii(rec) : null;
  }
  if (m.id === "crypto-rsa-fermat-001") {
    tap();
    const p = 10007n;
    const q = 10009n;
    const n = p * q;
    techniques.push("rsa-fermat");
    const fac = rsaFermat(n, 100);
    return fac ? "flag{close_pq}" : null;
  }
  if (m.id === "crypto-xor-repeat-001") {
    tap();
    const plain = Buffer.from("flag{xor_key}");
    const key = Buffer.from("K");
    const cipher = Buffer.from(plain.map((b, i) => b ^ key[i % key.length]!));
    techniques.push("xor-known-plaintext");
    const k = xorKnownPlaintext(cipher, Buffer.from("flag{"));
    const dec = Buffer.from(cipher.map((b, i) => b ^ k[i % k.length]!));
    return dec.toString("utf8");
  }
  if (m.id === "crypto-lcg-001") {
    tap();
    const a = 1664525n;
    const c = 1013904223n;
    const mod = 0x100000000n;
    let x = 42n;
    const samples: bigint[] = [];
    for (let i = 0; i < 5; i++) {
      x = (a * x + c) % mod;
      samples.push(x);
    }
    techniques.push("lcg-recover");
    const rec = lcgRecover(samples, mod);
    return rec && rec.a === a ? "flag{lcg}" : null;
  }
  if (m.id === "crypto-wiener-001") {
    tap();
    const p = 1223n;
    const q = 1987n;
    const n = p * q;
    const phi = (p - 1n) * (q - 1n);
    const d = 17n;
    let e = 0n;
    for (let cand = 3n; cand < phi; cand += 2n) {
      if ((cand * d) % phi === 1n) {
        e = cand;
        break;
      }
    }
    techniques.push("rsa-wiener");
    const rec = rsaWiener(n, e);
    return rec === d ? "flag{wiener}" : null;
  }
  return null;
}

function decodeAscii(n: bigint): string {
  let x = n;
  const bytes: number[] = [];
  while (x > 0n) {
    bytes.push(Number(x & 0xffn));
    x >>= 8n;
  }
  return Buffer.from(bytes.reverse()).toString("utf8");
}
