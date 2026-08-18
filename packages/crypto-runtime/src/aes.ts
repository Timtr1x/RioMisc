export function aesInspect(buf: Uint8Array): {
  length: number;
  blockAligned: boolean;
  uniqueBlocks: number;
  repeatedBlocks: number;
  likelyMode: "ECB" | "CBC_OR_OTHER" | "UNKNOWN";
} {
  const block = 16;
  const length = buf.length;
  const blockAligned = length % block === 0;
  const seen = new Map<string, number>();
  if (blockAligned) {
    for (let i = 0; i < buf.length; i += block) {
      const k = Buffer.from(buf.subarray(i, i + block)).toString("hex");
      seen.set(k, (seen.get(k) ?? 0) + 1);
    }
  }
  let repeated = 0;
  for (const n of seen.values()) if (n > 1) repeated += n - 1;
  return {
    length,
    blockAligned,
    uniqueBlocks: seen.size,
    repeatedBlocks: repeated,
    likelyMode: !blockAligned ? "UNKNOWN" : repeated > 0 ? "ECB" : "CBC_OR_OTHER",
  };
}

function printableRatio(buf: Uint8Array): number {
  if (buf.length === 0) return 0;
  let n = 0;
  for (const b of buf) if ((b >= 0x20 && b <= 0x7e) || b === 0x0a || b === 0x0d || b === 0x09) n += 1;
  return n / buf.length;
}

/** Heuristics for common AES misuse: ECB repeats, zero IV, CTR/OFB keystream reuse across two ciphertexts. */
export function aesMisuseInspect(primary: Uint8Array, secondary?: Uint8Array): {
  primary: ReturnType<typeof aesInspect>;
  zeroIvLikely: boolean;
  keystreamReuseLikely: boolean;
  xorPrintableRatio: number | null;
  xorHexPreview: string | null;
  findings: string[];
} {
  const primaryInfo = aesInspect(primary);
  const findings: string[] = [];
  const zeroIvLikely = primary.length >= 16 && primary.subarray(0, 16).every((b) => b === 0);
  if (primaryInfo.likelyMode === "ECB") findings.push("Repeated 16-byte blocks suggest ECB (or identical CBC plaintext blocks with fixed IV).");
  if (zeroIvLikely) findings.push("First 16 bytes are all zero — common accidental IV=0 for CBC/CTR.");
  let keystreamReuseLikely = false;
  let xorPrintableRatio: number | null = null;
  let xorHexPreview: string | null = null;
  if (secondary && secondary.length > 0) {
    const n = Math.min(primary.length, secondary.length);
    const xored = new Uint8Array(n);
    for (let i = 0; i < n; i++) xored[i] = primary[i]! ^ secondary[i]!;
    xorPrintableRatio = printableRatio(xored);
    xorHexPreview = Buffer.from(xored.subarray(0, Math.min(64, n))).toString("hex");
    if (xorPrintableRatio >= 0.7) {
      keystreamReuseLikely = true;
      findings.push("XOR of the two ciphertexts is highly printable — possible CTR/OFB/stream keystream reuse.");
    } else if (primary.length === secondary.length && primaryInfo.blockAligned) {
      findings.push("Equal-length ciphertexts: XOR them and look for crib-dragging if CTR/OFB is suspected.");
    }
  } else {
    findings.push("Pass a second ciphertext (text2/path2) to test CTR/OFB keystream reuse.");
  }
  if (findings.length === 0) findings.push("No strong misuse signal; still may be CBC with random IV.");
  return { primary: primaryInfo, zeroIvLikely, keystreamReuseLikely, xorPrintableRatio, xorHexPreview, findings };
}
