import type { BenchmarkManifest } from "@rio/domain";

export const BENCHMARK_MANIFESTS: BenchmarkManifest[] = [
  {
    id: "misc-trailing-zip-001",
    category: "MISC",
    subcategory: ["trailing-data", "zip"],
    difficulty: 1,
    flag: "flag{trailing_zip}",
    expectedTechniques: ["scan_trailing_data"],
    maxSolveSeconds: 30,
  },
  {
    id: "crypto-rsa-small-e-001",
    category: "CRYPTO",
    subcategory: ["RSA", "small-e"],
    difficulty: 2,
    flag: "flag{cube}",
    expectedTechniques: ["integer-root", "rsa-small-e"],
    maxSolveSeconds: 30,
  },
  {
    id: "crypto-rsa-fermat-001",
    category: "CRYPTO",
    subcategory: ["RSA", "fermat"],
    difficulty: 2,
    flag: "flag{close_pq}",
    expectedTechniques: ["rsa-fermat"],
    maxSolveSeconds: 30,
  },
  {
    id: "crypto-xor-repeat-001",
    category: "CRYPTO",
    subcategory: ["XOR"],
    difficulty: 1,
    flag: "flag{xor_key}",
    expectedTechniques: ["xor-known-plaintext"],
    maxSolveSeconds: 30,
  },
  {
    id: "crypto-lcg-001",
    category: "CRYPTO",
    subcategory: ["PRNG", "LCG"],
    difficulty: 2,
    flag: "flag{lcg}",
    expectedTechniques: ["lcg-recover"],
    maxSolveSeconds: 30,
  },
  {
    id: "crypto-wiener-001",
    category: "CRYPTO",
    subcategory: ["RSA", "wiener"],
    difficulty: 3,
    flag: "flag{wiener}",
    expectedTechniques: ["rsa-wiener"],
    maxSolveSeconds: 30,
  },
];

export function getManifest(id: string): BenchmarkManifest | undefined {
  return BENCHMARK_MANIFESTS.find((m) => m.id === id);
}
