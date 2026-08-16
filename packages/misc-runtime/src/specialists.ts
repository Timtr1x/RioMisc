import { analyzeRsaInstance, parseCryptoValues, asBig, lcgRecover } from "@rio/crypto-runtime";
import type { SpecialistKind } from "@rio/domain";
import { analyzePcapOverview } from "./pcap.js";
import { extractStringsSummary } from "./strings.js";
import { scanEmbeddedSignatures, scanTrailingData } from "./signatures.js";

export interface SpecialistOutput {
  kind: SpecialistKind;
  conclusion: string;
  confidence: number;
  facts: string[];
  rejectedIdeas: string[];
  recommendedActions: string[];
}

export function runSpecialist(kind: SpecialistKind, input: { buf?: Buffer; text?: string; values?: Record<string, string> }): SpecialistOutput {
  if (kind === "PCAP" && input.buf) {
    const ov = analyzePcapOverview(input.buf);
    return {
      kind,
      conclusion: `${ov.packetCount} packets, ${ov.tcpStreams} TCP streams, ${ov.httpRequests.length} HTTP, ${ov.dnsNames.length} DNS names`,
      confidence: ov.packetCount > 0 ? 0.8 : 0.2,
      facts: [
        `tcp=${ov.tcp} udp=${ov.udp} icmp=${ov.icmp}`,
        ...ov.dnsNames.slice(0, 5).map((d) => `dns ${d}`),
        ...ov.httpRequests.slice(0, 5).map((h) => `${h.method} ${h.host}${h.path}`),
      ],
      rejectedIdeas: [],
      recommendedActions: ov.httpRequests.length ? ["extract_http_objects"] : ov.dnsNames.length ? ["extract_dns_activity"] : ["follow_tcp_stream"],
    };
  }
  if ((kind === "ARCHIVE" || kind === "IMAGE") && input.buf) {
    const trail = scanTrailingData(input.buf);
    const sigs = scanEmbeddedSignatures(input.buf);
    const strings = extractStringsSummary(input.buf);
    return {
      kind,
      conclusion: trail.hasTrailingData ? `trailing ${trail.bytes}B (${trail.magic}) at ${trail.offset}` : `no trailing data, ${sigs.length} inner signatures`,
      confidence: trail.hasTrailingData ? 0.9 : 0.55,
      facts: [...sigs.slice(0, 8).map((s) => `${s.type}@${s.offset}`), ...strings.flagLike],
      rejectedIdeas: [],
      recommendedActions: trail.hasTrailingData ? ["carve trailing bytes"] : kind === "IMAGE" ? ["analyze_visual"] : ["extract_strings_summary"],
    };
  }
  if (kind === "RSA") {
    const values = input.values ?? (input.text ? parseCryptoValues(input.text) : {});
    const inst = { n: asBig(values, "n"), e: asBig(values, "e"), c: asBig(values, "c") };
    const a = analyzeRsaInstance(inst);
    return {
      kind,
      conclusion: `RSA ${a.bitLength}-bit; candidates ${a.attackCandidates.map((c) => c.attack).join(",") || "none"}`,
      confidence: a.attackCandidates[0]?.confidence ?? 0.3,
      facts: Object.entries(a.checks).map(([k, v]) => `${k}=${String(v)}`),
      rejectedIdeas: ["Do not start with LLL/Coppersmith"],
      recommendedActions: a.attackCandidates.map((c) => c.attack.toLowerCase()),
    };
  }
  if (kind === "PRNG" && input.text) {
    const nums = [...input.text.matchAll(/\b\d+\b/g)].map((m) => BigInt(m[0]!));
    const rec = nums.length >= 3 ? lcgRecover(nums.slice(0, 5)) : null;
    return {
      kind,
      conclusion: rec ? `LCG a=${rec.a} c=${rec.c} m=${rec.m}` : "not enough samples for LCG",
      confidence: rec ? 0.85 : 0.2,
      facts: rec ? [`a=${rec.a}`, `c=${rec.c}`] : [],
      rejectedIdeas: [],
      recommendedActions: rec ? ["predict next"] : ["collect more samples"],
    };
  }
  return {
    kind,
    conclusion: kind === "LATTICE" ? "lattice backend unavailable" : "specialist needs more input",
    confidence: 0.1,
    facts: [],
    rejectedIdeas: kind === "LATTICE" ? ["Sage/fpylll not bundled"] : [],
    recommendedActions: kind === "AUDIO" ? ["render_spectrogram"] : [],
  };
}
