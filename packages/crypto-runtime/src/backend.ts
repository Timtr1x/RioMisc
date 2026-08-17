import { spawnSync } from "node:child_process";
import { lllReduce } from "./lll.js";

export type MathBackendKind = "fpylll" | "sage" | "docker-sage" | "local";

export interface AdvancedMathBackend {
  kind: MathBackendKind;
  available(): Promise<boolean>;
  lll(matrix: bigint[][]): Promise<bigint[][]>;
  coppersmith?(opts: unknown): Promise<bigint[]>;
  polynomialRoots?(opts: unknown): Promise<bigint[]>;
}

let cached: MathBackendKind | null = null;

function run(cmd: string, args: string[], timeoutMs = 8_000): { ok: boolean; stdout: string; stderr: string } {
  try {
    const r = spawnSync(cmd, args, {
      encoding: "utf8",
      timeout: timeoutMs,
      windowsHide: true,
      shell: false,
    });
    const stdout = String(r.stdout ?? "");
    const stderr = String(r.stderr ?? "");
    return { ok: r.status === 0, stdout, stderr };
  } catch (e) {
    return { ok: false, stdout: "", stderr: String(e) };
  }
}

function pythonBin(): string {
  return process.env.RIO_PYTHON ?? (process.platform === "win32" ? "python" : "python3");
}

function probeFpylll(): boolean {
  const r = run(pythonBin(), ["-c", "import fpylll; print('ok')"], 6_000);
  return r.ok && r.stdout.includes("ok");
}

function probeSage(): boolean {
  const r = run("sage", ["-c", "print(1)"], 6_000);
  return r.ok && r.stdout.trim().startsWith("1");
}

function probeDockerSage(): boolean {
  const images = run("docker", ["images", "-q", "sagemath/sagemath"], 8_000);
  if (!images.ok || !images.stdout.trim()) return false;
  const ping = run("docker", ["info"], 6_000);
  return ping.ok;
}

/** Prefer an installed lattice backend; always fall back to the bundled local LLL. */
export function detectMathBackend(): MathBackendKind {
  if (cached) return cached;
  const forced = (process.env.RIO_MATH_BACKEND ?? "").trim().toLowerCase();
  if (forced === "local" || forced === "fpylll" || forced === "sage" || forced === "docker-sage") {
    cached = forced as MathBackendKind;
    return cached;
  }
  if (probeFpylll()) return (cached = "fpylll");
  if (probeSage()) return (cached = "sage");
  if (probeDockerSage()) return (cached = "docker-sage");
  return (cached = "local");
}

export function resetMathBackendCache(): void {
  cached = null;
}

function encodeMatrixPy(matrix: bigint[][]): string {
  return "[" + matrix.map((row) => "[" + row.map((x) => x.toString()).join(",") + "]").join(",") + "]";
}

function parseMatrixLiteral(raw: string): bigint[][] {
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) throw new Error("backend did not return a matrix");
  return parsed.map((row) => {
    if (!Array.isArray(row)) throw new Error("ragged backend matrix");
    return row.map((c) => BigInt(String(c)));
  });
}

function lllViaPythonFpylll(matrix: bigint[][]): bigint[][] {
  const src = [
    "from fpylll import IntegerMatrix, LLL",
    `M = IntegerMatrix.from_matrix(${encodeMatrixPy(matrix)})`,
    "LLL.reduction(M)",
    "print([[M[i,j] for j in range(M.ncols)] for i in range(M.nrows)])",
  ].join("; ");
  const r = run(pythonBin(), ["-c", src], 120_000);
  if (!r.ok) throw new Error(r.stderr || "fpylll LLL failed");
  return parseMatrixLiteral(r.stdout.trim().split(/\r?\n/).at(-1) ?? "");
}

function lllViaSage(matrix: bigint[][]): bigint[][] {
  const src = `print(list(Matrix(ZZ, ${encodeMatrixPy(matrix)}).LLL()))`;
  const r = run("sage", ["-c", src], 180_000);
  if (!r.ok) throw new Error(r.stderr || "sage LLL failed");
  const line = r.stdout.trim().split(/\r?\n/).at(-1) ?? "";
  return parseMatrixLiteral(line.replace(/\(/g, "[").replace(/\)/g, "]"));
}

function lllViaDockerSage(matrix: bigint[][]): bigint[][] {
  const src = `print(list(Matrix(ZZ, ${encodeMatrixPy(matrix)}).LLL()))`;
  const r = run("docker", ["run", "--rm", "sagemath/sagemath", "sage", "-c", src], 180_000);
  if (!r.ok) throw new Error(r.stderr || "docker sage LLL failed");
  const line = r.stdout.trim().split(/\r?\n/).at(-1) ?? "";
  return parseMatrixLiteral(line.replace(/\(/g, "[").replace(/\)/g, "]"));
}

export function lllWithBackend(matrix: bigint[][]): { reduced: bigint[][]; backend: MathBackendKind } {
  const kind = detectMathBackend();
  try {
    if (kind === "fpylll") return { reduced: lllViaPythonFpylll(matrix), backend: kind };
    if (kind === "sage") return { reduced: lllViaSage(matrix), backend: kind };
    if (kind === "docker-sage") return { reduced: lllViaDockerSage(matrix), backend: kind };
  } catch {
    /* fall back to the bundled implementation */
  }
  return { reduced: lllReduce(matrix), backend: "local" };
}

export const hostMathBackend: AdvancedMathBackend = {
  kind: "local",
  async available() {
    return true;
  },
  async lll(matrix) {
    return lllWithBackend(matrix).reduced;
  },
};

export const missingMathBackend: AdvancedMathBackend = {
  kind: "local",
  async available() {
    return false;
  },
  async lll() {
    throw new Error("math backend unavailable");
  },
};
