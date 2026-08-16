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
