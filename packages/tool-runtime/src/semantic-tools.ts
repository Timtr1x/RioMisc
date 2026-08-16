import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  pathOnlySchema,
  carveSchema,
  cryptoTextSchema,
  specialistParamsSchema,
  hypothesisParamsSchema,
} from "@rio/domain";
import {
  scanTrailingData,
  scanEmbeddedSignatures,
  extractStringsSummary,
  analyzePcapOverview,
  extractHttpObjects,
  runSpecialist,
} from "@rio/misc-runtime";
import {
  parseCryptoValues,
  asBig,
  parseBig,
  gcd,
  egcd,
  modInverse,
  crt,
  integerRoot,
  factorInteger,
  analyzeRsaInstance,
  rsaBasicDecrypt,
  rsaSmallE,
  rsaFermat,
  rsaWiener,
  rsaCommonModulus,
  xorBytes,
  xorKnownPlaintext,
  frequencyAnalysis,
  caesar,
  lcgRecover,
  aesInspect,
  advancedMathUnavailable,
} from "@rio/crypto-runtime";
import type { ToolContext, ToolResult } from "./tools.js";

function fail(code: string, message: string, durationMs: number): ToolResult {
  return { ok: false, summary: message, durationMs, error: { code, message } };
}
function ok(summary: string, data: unknown, durationMs: number, extra: Partial<ToolResult> = {}): ToolResult {
  return { ok: true, summary, data, durationMs, ...extra };
}

function readTarget(ctx: ToolContext, path?: string, text?: string): { buf?: Buffer; text?: string } {
  if (text) return { text };
  if (!path) return {};
  const abs = ctx.safeResolve(path);
  const buf = readFileSync(abs);
  return { buf, text: buf.toString("utf8") };
}

export async function scanTrailingDataTool(ctx: ToolContext, params: unknown): Promise<ToolResult> {
  const t0 = Date.now();
  const p = pathOnlySchema.safeParse(params);
  if (!p.success) return fail("VALIDATION", p.error.issues[0]?.message ?? "bad", 0);
  const buf = readFileSync(ctx.safeResolve(p.data.path));
  const r = scanTrailingData(buf);
  return ok(r.hasTrailingData ? `trailing ${r.bytes}B ${r.magic} @${r.offset}` : "no trailing data", r, Date.now() - t0);
}

export async function scanEmbeddedSignaturesTool(ctx: ToolContext, params: unknown): Promise<ToolResult> {
  const t0 = Date.now();
  const p = pathOnlySchema.safeParse(params);
  if (!p.success) return fail("VALIDATION", p.error.issues[0]?.message ?? "bad", 0);
  const hits = scanEmbeddedSignatures(readFileSync(ctx.safeResolve(p.data.path)));
  return ok(`${hits.length} signatures`, { hits }, Date.now() - t0);
}

export async function extractStringsSummaryTool(ctx: ToolContext, params: unknown): Promise<ToolResult> {
  const t0 = Date.now();
  const p = pathOnlySchema.safeParse(params);
  if (!p.success) return fail("VALIDATION", p.error.issues[0]?.message ?? "bad", 0);
  const r = extractStringsSummary(readFileSync(ctx.safeResolve(p.data.path)));
  return ok(`${r.count} strings, ${r.flagLike.length} flag-like`, r, Date.now() - t0);
}

export async function analyzePcapOverviewTool(ctx: ToolContext, params: unknown): Promise<ToolResult> {
  const t0 = Date.now();
  const p = pathOnlySchema.safeParse(params);
  if (!p.success) return fail("VALIDATION", p.error.issues[0]?.message ?? "bad", 0);
  const r = analyzePcapOverview(readFileSync(ctx.safeResolve(p.data.path)));
  return ok(`pcap ${r.packetCount} pkts http=${r.httpRequests.length} dns=${r.dnsNames.length}`, r, Date.now() - t0);
}

export async function extractHttpObjectsTool(ctx: ToolContext, params: unknown): Promise<ToolResult> {
  const t0 = Date.now();
  const p = pathOnlySchema.safeParse(params);
  if (!p.success) return fail("VALIDATION", p.error.issues[0]?.message ?? "bad", 0);
  const r = extractHttpObjects(readFileSync(ctx.safeResolve(p.data.path)));
  return ok(`${r.length} HTTP requests`, { requests: r }, Date.now() - t0);
}

export async function extractDnsActivityTool(ctx: ToolContext, params: unknown): Promise<ToolResult> {
  const t0 = Date.now();
  const p = pathOnlySchema.safeParse(params);
  if (!p.success) return fail("VALIDATION", p.error.issues[0]?.message ?? "bad", 0);
  const r = analyzePcapOverview(readFileSync(ctx.safeResolve(p.data.path)));
  return ok(`${r.dnsNames.length} DNS names`, { dnsNames: r.dnsNames }, Date.now() - t0);
}

export async function carveFilesTool(ctx: ToolContext, params: unknown): Promise<ToolResult> {
  const t0 = Date.now();
  const p = carveSchema.safeParse(params);
  if (!p.success) return fail("VALIDATION", p.error.issues[0]?.message ?? "bad", 0);
  const buf = readFileSync(ctx.safeResolve(p.data.path));
  const slice = buf.subarray(p.data.offset, p.data.offset + (p.data.length ?? buf.length - p.data.offset));
  const destRel = p.data.destPath ?? `artifacts/carved/at-${p.data.offset}.bin`;
  const dest = ctx.safeResolve(destRel);
  mkdirSync(join(dest, ".."), { recursive: true });
  writeFileSync(dest, slice);
  const ref = ctx.recordArtifact("carve_files", dest);
  return ok(`carved ${slice.length}B → ${destRel}`, { path: destRel, size: slice.length }, Date.now() - t0, { artifacts: ref ? [ref] : [] });
}

export async function requestSpecialistTool(ctx: ToolContext, params: unknown): Promise<ToolResult> {
  const t0 = Date.now();
  const p = specialistParamsSchema.safeParse(params);
  if (!p.success) return fail("VALIDATION", p.error.issues[0]?.message ?? "bad", 0);
  const src = readTarget(ctx, p.data.path, p.data.text);
  const out = runSpecialist(p.data.kind, src);
  ctx.emit("specialist", { challengeId: ctx.challengeId, sessionId: ctx.sessionId, ...out });
  return ok(out.conclusion, out, Date.now() - t0);
}

export async function recordHypothesisTool(ctx: ToolContext, params: unknown): Promise<ToolResult> {
  const t0 = Date.now();
  const p = hypothesisParamsSchema.safeParse(params);
  if (!p.success) return fail("VALIDATION", p.error.issues[0]?.message ?? "bad", 0);
  ctx.emit("progress", {
    challengeId: ctx.challengeId,
    sessionId: ctx.sessionId,
    summary: `hypothesis: ${p.data.description}`,
    hypotheses: [p.data.description],
    confirmedFacts: [],
    rejectedHypotheses: [],
    nextActions: [],
    confidence: p.data.confidence ?? 0.4,
    progress: "MINOR",
    stalled: false,
    hypothesisStatus: p.data.status ?? "CANDIDATE",
  });
  return ok("hypothesis recorded", p.data, Date.now() - t0);
}

export async function parseCryptoValuesTool(ctx: ToolContext, params: unknown): Promise<ToolResult> {
  const t0 = Date.now();
  const p = cryptoTextSchema.safeParse(params);
  if (!p.success) return fail("VALIDATION", p.error.issues[0]?.message ?? "bad", 0);
  const text = p.data.text ?? (p.data.path ? readFileSync(ctx.safeResolve(p.data.path), "utf8") : "");
  const values = parseCryptoValues(text);
  return ok(`parsed ${Object.keys(values).join(",") || "nothing"}`, { values }, Date.now() - t0);
}

export async function analyzeRsaTool(ctx: ToolContext, params: unknown): Promise<ToolResult> {
  const t0 = Date.now();
  const p = cryptoTextSchema.safeParse(params);
  if (!p.success) return fail("VALIDATION", p.error.issues[0]?.message ?? "bad", 0);
  const text = p.data.text ?? (p.data.path ? readFileSync(ctx.safeResolve(p.data.path), "utf8") : "");
  const values = { ...parseCryptoValues(text), ...strip(p.data) };
  const inst = { n: asBig(values, "n"), e: asBig(values, "e"), c: asBig(values, "c") };
  const r = analyzeRsaInstance(inst);
  return ok(`RSA ${r.bitLength}b ${r.attackCandidates.map((a) => a.attack).join(",")}`, r, Date.now() - t0);
}

export async function rsaAttackTool(name: string, ctx: ToolContext, params: unknown): Promise<ToolResult> {
  const t0 = Date.now();
  const p = cryptoTextSchema.safeParse(params);
  if (!p.success) return fail("VALIDATION", p.error.issues[0]?.message ?? "bad", 0);
  const text = p.data.text ?? (p.data.path ? readFileSync(ctx.safeResolve(p.data.path), "utf8") : "");
  const v = { ...parseCryptoValues(text), ...strip(p.data) };
  try {
    if (name === "rsa_small_e") {
      const rec = rsaSmallE(asBig(v, "c")!, asBig(v, "e") ?? 3n, asBig(v, "n"));
      return ok(rec ? `m=${rec}` : "small-e failed", { m: rec?.toString() ?? null }, Date.now() - t0);
    }
    if (name === "rsa_fermat") {
      const rec = rsaFermat(asBig(v, "n")!);
      return ok(rec ? `p=${rec.p} q=${rec.q}` : "fermat failed", rec ? { p: rec.p.toString(), q: rec.q.toString() } : {}, Date.now() - t0);
    }
    if (name === "rsa_wiener") {
      const rec = rsaWiener(asBig(v, "n")!, asBig(v, "e")!);
      return ok(rec ? `d=${rec}` : "wiener failed", { d: rec?.toString() ?? null }, Date.now() - t0);
    }
    if (name === "rsa_common_modulus") {
      const rec = rsaCommonModulus(asBig(v, "n")!, asBig(v, "e1")!, asBig(v, "c1")!, asBig(v, "e2")!, asBig(v, "c2")!);
      return ok(rec ? `m=${rec}` : "common-modulus failed", { m: rec?.toString() ?? null }, Date.now() - t0);
    }
    if (name === "rsa_basic_decrypt") {
      const rec = rsaBasicDecrypt(asBig(v, "n")!, asBig(v, "e") ?? 65537n, asBig(v, "c")!, asBig(v, "p"), asBig(v, "q"));
      return ok(rec ? `m=${rec}` : "decrypt failed", { m: rec?.toString() ?? null }, Date.now() - t0);
    }
    if (name === "factor_integer") {
      const fac = factorInteger(asBig(v, "n") ?? parseBig(v.n ?? text.trim()));
      return ok(`factors ${fac.join("*")}`, { factors: fac.map(String) }, Date.now() - t0);
    }
    if (name === "integer_root") {
      const r = integerRoot(asBig(v, "c") ?? parseBig(text.trim()), asBig(v, "e") ?? 3n);
      return ok(`root=${r.root} exact=${r.exact}`, { root: r.root.toString(), exact: r.exact }, Date.now() - t0);
    }
    if (name === "mod_inverse") {
      const inv = modInverse(parseBig(v.a ?? v.e ?? "0"), parseBig(v.m ?? v.n ?? "0"));
      return ok(inv ? `inv=${inv}` : "no inverse", { inverse: inv?.toString() ?? null }, Date.now() - t0);
    }
    if (name === "gcd") {
      const g = gcd(parseBig(v.a ?? v.n ?? "0"), parseBig(v.b ?? v.e ?? "0"));
      return ok(`gcd=${g}`, { gcd: g.toString() }, Date.now() - t0);
    }
    if (name === "extended_gcd") {
      const r = egcd(parseBig(v.a ?? "0"), parseBig(v.b ?? "0"));
      return ok(`g=${r.g}`, { g: r.g.toString(), x: r.x.toString(), y: r.y.toString() }, Date.now() - t0);
    }
    if (name === "crt") {
      const r = crt([
        { a: parseBig(v.a ?? v.c1 ?? "0"), m: parseBig(v.m ?? v.n ?? "0") },
        { a: parseBig(v.b ?? v.c2 ?? "0"), m: parseBig(v.m2 ?? "0") },
      ]);
      return ok(r ? `x=${r}` : "crt failed", { x: r?.toString() ?? null }, Date.now() - t0);
    }
    if (name === "lcg_recover") {
      const nums = (v.samples ?? text).split(/[,\s]+/).filter(Boolean).map((s) => parseBig(s));
      const rec = lcgRecover(nums);
      return ok(rec ? `a=${rec.a} c=${rec.c}` : "lcg failed", rec, Date.now() - t0);
    }
    if (name === "aes_inspect") {
      const buf = p.data.path ? readFileSync(ctx.safeResolve(p.data.path)) : Buffer.from(text, "hex");
      const r = aesInspect(buf);
      return ok(`AES ${r.likelyMode}`, r, Date.now() - t0);
    }
    if (name === "frequency_analysis") {
      const buf = Buffer.from(text, "utf8");
      const r = frequencyAnalysis(buf);
      return ok(`caesar shift ${r.likelyCaesar}`, r, Date.now() - t0);
    }
    if (name === "xor_bytes") {
      const a = Buffer.from(v.a ?? "", "hex");
      const b = Buffer.from(v.b ?? v.key ?? "", "utf8");
      const r = xorBytes(a, b);
      return ok(`xor ${r.length}B`, { hex: Buffer.from(r).toString("hex") }, Date.now() - t0);
    }
    if (name === "xor_known_plaintext") {
      const c = Buffer.from(v.c ?? "", "hex");
      const pt = Buffer.from(v.p ?? v.m ?? "flag{", "utf8");
      const r = xorKnownPlaintext(c, pt);
      return ok(`keystream ${r.length}B`, { hex: Buffer.from(r).toString("hex") }, Date.now() - t0);
    }
    if (name === "lll_reduce" || name === "discrete_log_if_small") {
      return { ...advancedMathUnavailable(name), summary: "backend unavailable", durationMs: Date.now() - t0 };
    }
  } catch (e) {
    return fail("CRYPTO", String(e), Date.now() - t0);
  }
  return fail("CRYPTO", `unknown crypto op ${name}`, Date.now() - t0);
}

function strip(data: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(data)) {
    if (typeof v === "string" && k !== "text" && k !== "path") out[k] = v;
  }
  return out;
}

void existsSync;
void statSync;
void caesar;
