import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  pathOnlySchema,
  carveSchema,
  specialistParamsSchema,
  hypothesisParamsSchema,
  updateCryptoStateSchema,
  imageTransformSchema,
  extractBitplaneSchema,
  parseCryptoValuesSchema,
  analyzeRsaInstanceSchema,
  rsaSmallESchema,
  rsaFermatSchema,
  rsaWienerSchema,
  rsaCommonModulusSchema,
  rsaHastadSchema,
  rsaBasicDecryptSchema,
  factorIntegerSchema,
  integerRootSchema,
  modInverseSchema,
  gcdSchema,
  extendedGcdSchema,
  crtSchema,
  linearCongruenceSchema,
  lcgRecoverSchema,
  mt19937RecoverSchema,
  aesInspectSchema,
  aesMisuseInspectSchema,
  followTcpStreamSchema,
  frequencyAnalysisSchema,
  xorBytesSchema,
  xorKnownPlaintextSchema,
  lllReduceSchema,
  discreteLogSchema,
  type CryptoAttackCandidate,
  type CryptoPrimitive,
  type CryptoValue,
} from "@rio/domain";
import { hintsForRsaAnalysis } from "./catalog/hints.js";
import {
  scanTrailingData,
  scanEmbeddedSignatures,
  extractStringsSummary,
  analyzePcapOverview,
  extractHttpObjects,
  followTcpStream,
  inspectMetadata,
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
  rsaHastad,
  xorBytes,
  xorKnownPlaintext,
  frequencyAnalysis,
  caesar,
  lcgRecover,
  mt19937Recover,
  aesInspect,
  aesMisuseInspect,
  parseIntegerMatrix,
  lllWithBackend,
  discreteLogSmall,
} from "@rio/crypto-runtime";
import { decodeImageFile, writeTransformedPng, extractBitplane, encodePng } from "@rio/visual-runtime";
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

export async function inspectMetadataTool(ctx: ToolContext, params: unknown): Promise<ToolResult> {
  const t0 = Date.now();
  const p = pathOnlySchema.safeParse(params);
  if (!p.success) return fail("VALIDATION", p.error.issues[0]?.message ?? "bad", 0);
  const abs = ctx.safeResolve(p.data.path);
  const r = inspectMetadata(readFileSync(abs), p.data.path);
  return ok(`${r.magic} metadata ${r.fields.length} fields`, r, Date.now() - t0);
}

export async function followTcpStreamTool(ctx: ToolContext, params: unknown): Promise<ToolResult> {
  const t0 = Date.now();
  const p = followTcpStreamSchema.safeParse(params);
  if (!p.success) return fail("VALIDATION", p.error.issues[0]?.message ?? "bad", 0);
  const r = followTcpStream(readFileSync(ctx.safeResolve(p.data.path)), {
    streamIndex: p.data.streamIndex,
    src: p.data.src,
    dst: p.data.dst,
    sport: p.data.sport,
    dport: p.data.dport,
    maxBytes: p.data.maxBytes,
  });
  return ok(`tcp stream ${r.streamKey || "(none)"} ${r.totalPayloadBytes}B`, r, Date.now() - t0);
}

function emitCryptoState(
  ctx: ToolContext,
  patch: {
    primitive?: CryptoPrimitive;
    knownVariables?: Record<string, CryptoValue>;
    unknownVariables?: string[];
    attackCandidates?: CryptoAttackCandidate[];
    replaceCandidates?: boolean;
    attempt?: { attack: string; tool?: string; outcome: "SUCCESS" | "FAILED" | "NO_SIGNAL" | "SKIPPED"; summary: string };
    assumptions?: string[];
    constraints?: string[];
    equations?: { expr: string; satisfied?: boolean }[];
  },
): void {
  ctx.emit("crypto_state", { challengeId: ctx.challengeId, sessionId: ctx.sessionId, ...patch });
}

function valuesToKnown(values: Record<string, string>, source: string): Record<string, CryptoValue> {
  const out: Record<string, CryptoValue> = {};
  for (const [k, v] of Object.entries(values)) {
    if (v) out[k] = { value: v, source, confidence: 0.8 };
  }
  return out;
}

export async function updateCryptoStateTool(ctx: ToolContext, params: unknown): Promise<ToolResult> {
  const t0 = Date.now();
  const p = updateCryptoStateSchema.safeParse(params);
  if (!p.success) return fail("VALIDATION", p.error.issues[0]?.message ?? "bad", 0);
  const candidates = (p.data.attackCandidates ?? []).map((c, i) => ({
    id: c.id ?? `cand_${c.attack}_${i}`,
    attack: c.attack,
    requirements: c.requirements ?? [],
    satisfiedRequirements: c.satisfiedRequirements ?? [],
    confidence: c.confidence ?? 0.4,
    estimatedCost: c.estimatedCost ?? "LOW",
    status: c.status ?? "CANDIDATE",
  }));
  emitCryptoState(ctx, {
    primitive: p.data.primitive,
    knownVariables: p.data.knownVariables,
    unknownVariables: p.data.unknownVariables,
    equations: p.data.equations,
    constraints: p.data.constraints,
    assumptions: p.data.assumptions,
    attackCandidates: candidates.length ? candidates : undefined,
    replaceCandidates: p.data.replaceCandidates,
    attempt: p.data.attempt,
  });
  return ok("crypto state updated", p.data, Date.now() - t0);
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
  const ref = ctx.recordArtifact("carve_files", dest, p.data.path);
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
  ctx.emit("hypothesis", {
    challengeId: ctx.challengeId,
    sessionId: ctx.sessionId,
    description: p.data.description,
    confidence: p.data.confidence ?? 0.4,
    status: p.data.status ?? "CANDIDATE",
    evidenceFor: p.data.evidenceFor ?? [],
    evidenceAgainst: p.data.evidenceAgainst ?? [],
    proposedTests: p.data.proposedTests ?? [],
  });
  return ok("hypothesis recorded", p.data, Date.now() - t0);
}

export async function renderTransformTool(ctx: ToolContext, params: unknown): Promise<ToolResult> {
  const t0 = Date.now();
  const p = imageTransformSchema.safeParse(params);
  if (!p.success) return fail("VALIDATION", p.error.issues[0]?.message ?? "bad", 0);
  const abs = ctx.safeResolve(p.data.path);
  const img = decodeImageFile(abs);
  const destRel = `artifacts/visual/${p.data.op}.png`;
  const dest = ctx.safeResolve(destRel);
  writeTransformedPng(img, p.data.op, dest);
  const ref = ctx.recordArtifact(`render_${p.data.op}`, dest, p.data.path);
  return ok(`wrote ${destRel}`, { path: destRel, op: p.data.op }, Date.now() - t0, { artifacts: ref ? [ref] : [] });
}

export async function extractBitplaneTool(ctx: ToolContext, params: unknown): Promise<ToolResult> {
  const t0 = Date.now();
  const p = extractBitplaneSchema.safeParse(params);
  if (!p.success) return fail("VALIDATION", p.error.issues[0]?.message ?? "bad", 0);
  const ch = typeof p.data.channel === "number" ? p.data.channel : ({ R: 0, G: 1, B: 2, A: 3 } as const)[p.data.channel];
  const img = decodeImageFile(ctx.safeResolve(p.data.path));
  const plane = extractBitplane(img, ch as 0 | 1 | 2 | 3, p.data.bit);
  const destRel = `artifacts/visual/bitplane-${"RGBA"[ch]}${p.data.bit}.png`;
  const dest = ctx.safeResolve(destRel);
  mkdirSync(join(dest, ".."), { recursive: true });
  writeFileSync(dest, encodePng(plane));
  const ref = ctx.recordArtifact("extract_bitplane", dest, p.data.path);
  return ok(`bitplane ${"RGBA"[ch]}${p.data.bit}`, { path: destRel }, Date.now() - t0, { artifacts: ref ? [ref] : [] });
}

export async function extractVisibleTextTool(ctx: ToolContext, params: unknown): Promise<ToolResult> {
  const t0 = Date.now();
  const p = pathOnlySchema.safeParse(params);
  if (!p.success) return fail("VALIDATION", p.error.issues[0]?.message ?? "bad", 0);
  try {
    ctx.safeResolve(p.data.path);
  } catch (e) {
    return fail("FS", String(e), Date.now() - t0);
  }
  return {
    ok: false,
    summary: "OCR backend unavailable",
    data: { code: "BACKEND_UNAVAILABLE", backend: "ocr" },
    durationMs: Date.now() - t0,
    error: { code: "BACKEND_UNAVAILABLE", message: "extract_visible_text requires an OCR backend (tesseract) — not bundled" },
  };
}

const CRYPTO_SCHEMAS: Record<string, { safeParse(data: unknown): { success: true; data: Record<string, unknown> } | { success: false; error: { issues: { message: string }[] } } }> = {
  parse_crypto_values: parseCryptoValuesSchema,
  analyze_rsa_instance: analyzeRsaInstanceSchema,
  rsa_small_e: rsaSmallESchema,
  rsa_fermat: rsaFermatSchema,
  rsa_wiener: rsaWienerSchema,
  rsa_common_modulus: rsaCommonModulusSchema,
  rsa_hastad: rsaHastadSchema,
  rsa_basic_decrypt: rsaBasicDecryptSchema,
  factor_integer: factorIntegerSchema,
  integer_root: integerRootSchema,
  mod_inverse: modInverseSchema,
  gcd: gcdSchema,
  extended_gcd: extendedGcdSchema,
  crt: crtSchema,
  solve_linear_congruence: linearCongruenceSchema,
  lcg_recover: lcgRecoverSchema,
  mt19937_recover: mt19937RecoverSchema,
  aes_inspect: aesInspectSchema,
  aes_misuse_inspect: aesMisuseInspectSchema,
  frequency_analysis: frequencyAnalysisSchema,
  xor_bytes: xorBytesSchema,
  xor_known_plaintext: xorKnownPlaintextSchema,
  lll_reduce: lllReduceSchema,
  discrete_log_if_small: discreteLogSchema,
};

export async function parseCryptoValuesTool(ctx: ToolContext, params: unknown): Promise<ToolResult> {
  const t0 = Date.now();
  const p = parseCryptoValuesSchema.safeParse(params);
  if (!p.success) return fail("VALIDATION", p.error.issues[0]?.message ?? "bad", 0);
  const text = p.data.text ?? (p.data.path ? readFileSync(ctx.safeResolve(p.data.path), "utf8") : "");
  const values = parseCryptoValues(text);
  const keys = Object.keys(values);
  if (keys.length) {
    emitCryptoState(ctx, {
      knownVariables: valuesToKnown(values, "parse_crypto_values"),
      unknownVariables: ["n", "e", "c", "p", "q", "d"].filter((k) => !values[k]),
    });
  }
  return ok(`parsed ${keys.join(",") || "nothing"}`, { values }, Date.now() - t0);
}

export async function analyzeRsaTool(ctx: ToolContext, params: unknown): Promise<ToolResult> {
  const t0 = Date.now();
  const p = analyzeRsaInstanceSchema.safeParse(params);
  if (!p.success) return fail("VALIDATION", p.error.issues[0]?.message ?? "bad", 0);
  const text = p.data.text ?? (p.data.path ? readFileSync(ctx.safeResolve(p.data.path), "utf8") : "");
  const values = { ...parseCryptoValues(text), ...strip(p.data) };
  const inst = { n: asBig(values, "n"), e: asBig(values, "e"), c: asBig(values, "c") };
  const r = analyzeRsaInstance(inst);
  const hints = hintsForRsaAnalysis(r.attackCandidates);
  const candidates: CryptoAttackCandidate[] = r.attackCandidates.map((a, i) => ({
    id: `rsa_${a.attack}_${i}`,
    attack: a.attack,
    requirements: [],
    satisfiedRequirements: [],
    confidence: a.confidence,
    estimatedCost: a.confidence >= 0.85 ? "TRIVIAL" : a.confidence >= 0.75 ? "LOW" : "MEDIUM",
    status: "CANDIDATE",
  }));
  emitCryptoState(ctx, {
    primitive: "RSA",
    knownVariables: valuesToKnown(
      Object.fromEntries(
        Object.entries(values).filter(([, v]) => typeof v === "string") as [string, string][],
      ),
      "analyze_rsa_instance",
    ),
    unknownVariables: ["p", "q", "d", "m"].filter((k) => !values[k]),
    attackCandidates: candidates,
    replaceCandidates: true,
    assumptions: [`RSA bitLength=${r.bitLength}`],
  });
  return {
    ...ok(`RSA ${r.bitLength}b ${r.attackCandidates.map((a) => a.attack).join(",")}`, { ...r, hints }, Date.now() - t0),
    hints,
  };
}

export async function rsaAttackTool(name: string, ctx: ToolContext, params: unknown): Promise<ToolResult> {
  const t0 = Date.now();
  const schema = CRYPTO_SCHEMAS[name];
  const p = schema ? schema.safeParse(params) : { success: false as const, error: { issues: [{ message: `no schema for ${name}` }] } };
  if (!p.success) return fail("VALIDATION", p.error.issues[0]?.message ?? "bad", 0);
  const data = p.data as Record<string, unknown>;
  const text =
    (typeof data.text === "string" ? data.text : undefined) ??
    (typeof data.path === "string" ? readFileSync(ctx.safeResolve(data.path), "utf8") : undefined) ??
    (typeof data.samples === "string" ? data.samples : undefined) ??
    (typeof data.matrix === "string" ? data.matrix : "") ??
    "";
  const v = { ...parseCryptoValues(text), ...strip(data) };
  try {
    if (name === "rsa_small_e") {
      const rec = rsaSmallE(asBig(v, "c")!, asBig(v, "e") ?? 3n, asBig(v, "n"));
      emitCryptoState(ctx, {
        primitive: "RSA",
        attempt: { attack: "SMALL_E", tool: name, outcome: rec ? "SUCCESS" : "FAILED", summary: rec ? `m=${rec}` : "small-e failed" },
        knownVariables: rec ? { m: { value: rec.toString(), source: name, confidence: 0.95 } } : undefined,
      });
      return ok(rec ? `m=${rec}` : "small-e failed", { m: rec?.toString() ?? null }, Date.now() - t0);
    }
    if (name === "rsa_fermat") {
      const rec = rsaFermat(asBig(v, "n")!);
      emitCryptoState(ctx, {
        primitive: "RSA",
        attempt: { attack: "FERMAT", tool: name, outcome: rec ? "SUCCESS" : "FAILED", summary: rec ? `p=${rec.p} q=${rec.q}` : "fermat failed" },
        knownVariables: rec
          ? { p: { value: rec.p.toString(), source: name }, q: { value: rec.q.toString(), source: name } }
          : undefined,
      });
      return ok(rec ? `p=${rec.p} q=${rec.q}` : "fermat failed", rec ? { p: rec.p.toString(), q: rec.q.toString() } : {}, Date.now() - t0);
    }
    if (name === "rsa_wiener") {
      const rec = rsaWiener(asBig(v, "n")!, asBig(v, "e")!);
      emitCryptoState(ctx, {
        primitive: "RSA",
        attempt: { attack: "WIENER", tool: name, outcome: rec ? "SUCCESS" : "FAILED", summary: rec ? `d=${rec}` : "wiener failed" },
        knownVariables: rec ? { d: { value: rec.toString(), source: name } } : undefined,
      });
      return ok(rec ? `d=${rec}` : "wiener failed", { d: rec?.toString() ?? null }, Date.now() - t0);
    }
    if (name === "rsa_hastad") {
      const pairs: { c: bigint; n: bigint }[] = [];
      if (v.c1 && v.n1) pairs.push({ c: parseBig(v.c1), n: parseBig(v.n1) });
      if (v.c2 && v.n2) pairs.push({ c: parseBig(v.c2), n: parseBig(v.n2) });
      if (v.c3 && v.n3) pairs.push({ c: parseBig(v.c3), n: parseBig(v.n3) });
      const rec = rsaHastad(asBig(v, "e") ?? 3n, pairs);
      emitCryptoState(ctx, {
        primitive: "RSA",
        attempt: { attack: "HASTAD", tool: name, outcome: rec ? "SUCCESS" : "FAILED", summary: rec ? `m=${rec}` : "hastad failed" },
        knownVariables: rec ? { m: { value: rec.toString(), source: name } } : undefined,
      });
      return ok(rec ? `m=${rec}` : "hastad failed", { m: rec?.toString() ?? null }, Date.now() - t0);
    }
    if (name === "solve_linear_congruence") {
      const a = parseBig(v.a ?? "0");
      const b = parseBig(v.b ?? "0");
      const m = parseBig(v.m ?? "0");
      const g = gcd(a, m);
      if (b % g !== 0n) return ok("no solution", { solutions: [] }, Date.now() - t0);
      const inv = modInverse(a / g, m / g);
      const x0 = (((inv! * (b / g)) % (m / g)) + (m / g)) % (m / g);
      return ok(`x=${x0} (mod ${m / g})`, { x: x0.toString(), modulus: (m / g).toString() }, Date.now() - t0);
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
      emitCryptoState(ctx, {
        primitive: "PRNG",
        attempt: {
          attack: "LCG_RECOVER",
          tool: name,
          outcome: rec ? "SUCCESS" : "FAILED",
          summary: rec ? `a=${rec.a} c=${rec.c} m=${rec.m}` : "lcg failed",
        },
        knownVariables: rec
          ? {
              a: { value: rec.a.toString(), source: name },
              c: { value: rec.c.toString(), source: name },
              m: { value: rec.m.toString(), source: name },
            }
          : undefined,
      });
      return ok(rec ? `a=${rec.a} c=${rec.c}` : "lcg failed", rec, Date.now() - t0);
    }
    if (name === "mt19937_recover") {
      const nums = (v.samples ?? text).split(/[,\s]+/).filter(Boolean).map((s) => Number(BigInt(s.trim()) & 0xffffffffn));
      const state = mt19937Recover(nums);
      emitCryptoState(ctx, {
        primitive: "PRNG",
        attempt: {
          attack: "MT19937_RECOVER",
          tool: name,
          outcome: state ? "SUCCESS" : "FAILED",
          summary: state ? `recovered ${state.length} MT state words` : "need ≥624 tempered outputs",
        },
      });
      return ok(state ? `mt state ${state.length}` : "mt19937 need ≥624 outputs", { state }, Date.now() - t0);
    }
    if (name === "aes_inspect") {
      const buf = typeof data.path === "string" ? readFileSync(ctx.safeResolve(data.path)) : Buffer.from(text, "hex");
      const r = aesInspect(buf);
      emitCryptoState(ctx, {
        primitive: "AES",
        attempt: { attack: "AES_INSPECT", tool: name, outcome: "NO_SIGNAL", summary: `mode=${r.likelyMode}` },
        assumptions: [`AES likelyMode=${r.likelyMode}`],
      });
      return ok(`AES ${r.likelyMode}`, r, Date.now() - t0);
    }
    if (name === "aes_misuse_inspect") {
      const primary =
        typeof data.path === "string"
          ? readFileSync(ctx.safeResolve(data.path))
          : Buffer.from(String(data.text ?? text), "hex");
      const secondary =
        typeof data.path2 === "string"
          ? readFileSync(ctx.safeResolve(data.path2))
          : typeof data.text2 === "string"
            ? Buffer.from(data.text2, "hex")
            : undefined;
      const r = aesMisuseInspect(primary, secondary);
      emitCryptoState(ctx, {
        primitive: "AES",
        attempt: {
          attack: "AES_MISUSE",
          tool: name,
          outcome: r.keystreamReuseLikely || r.primary.likelyMode === "ECB" || r.zeroIvLikely ? "SUCCESS" : "NO_SIGNAL",
          summary: r.findings[0] ?? "aes misuse inspect",
        },
        assumptions: r.findings.slice(0, 4),
      });
      return ok(r.findings[0] ?? "aes misuse", r, Date.now() - t0);
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
    if (name === "lll_reduce") {
      const matrix = parseIntegerMatrix(v.matrix ?? text);
      if (!matrix) return fail("VALIDATION", "lll_reduce needs a matrix (JSON [[..],[..]] or whitespace rows)", Date.now() - t0);
      const { reduced, backend } = lllWithBackend(matrix);
      return ok(`lll ${reduced.length}x${reduced[0]?.length ?? 0} via ${backend}`, {
        backend,
        matrix: reduced.map((row) => row.map(String)),
      }, Date.now() - t0);
    }
    if (name === "discrete_log_if_small") {
      const g = parseBig(v.g ?? v.a ?? "0");
      const h = parseBig(v.h ?? v.b ?? "0");
      const mod = parseBig(v.m ?? v.n ?? "0");
      const x = discreteLogSmall(g, h, mod);
      return ok(x !== null ? `x=${x}` : "no small discrete log", { x: x?.toString() ?? null }, Date.now() - t0);
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
