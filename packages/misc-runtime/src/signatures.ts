export interface SignatureHit {
  offset: number;
  type: string;
  confidence: number;
}

const SIGS: { type: string; bytes: number[] }[] = [
  { type: "PNG", bytes: [0x89, 0x50, 0x4e, 0x47] },
  { type: "JPEG", bytes: [0xff, 0xd8, 0xff] },
  { type: "ZIP", bytes: [0x50, 0x4b, 0x03, 0x04] },
  { type: "GZIP", bytes: [0x1f, 0x8b] },
  { type: "PDF", bytes: [0x25, 0x50, 0x44, 0x46] },
  { type: "7Z", bytes: [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c] },
  { type: "RAR", bytes: [0x52, 0x61, 0x72, 0x21] },
  { type: "ELF", bytes: [0x7f, 0x45, 0x4c, 0x46] },
  { type: "PE", bytes: [0x4d, 0x5a] },
  { type: "SQLITE", bytes: [0x53, 0x51, 0x4c, 0x69, 0x74, 0x65] },
];

export function scanEmbeddedSignatures(buf: Buffer, opts: { skipZero?: boolean } = {}): SignatureHit[] {
  const hits: SignatureHit[] = [];
  const skipZero = opts.skipZero !== false;
  for (const sig of SIGS) {
    let from = 0;
    while (from < buf.length) {
      const idx = indexOfBytes(buf, sig.bytes, from);
      if (idx < 0) break;
      if (!(skipZero && idx === 0)) {
        hits.push({ offset: idx, type: sig.type, confidence: 0.98 });
      }
      from = idx + 1;
    }
  }
  hits.sort((a, b) => a.offset - b.offset);
  return hits;
}

export function scanTrailingData(buf: Buffer): { hasTrailingData: boolean; offset: number | null; bytes: number; magic: string | null } {
  const end = containerEnd(buf);
  if (end === null || end >= buf.length) {
    return { hasTrailingData: false, offset: null, bytes: 0, magic: null };
  }
  const trail = buf.subarray(end);
  const hits = scanEmbeddedSignatures(trail, { skipZero: false });
  return {
    hasTrailingData: true,
    offset: end,
    bytes: trail.length,
    magic: hits[0]?.type ?? (trail[0] === 0 ? "zeros" : "unknown"),
  };
}

export function containerEnd(buf: Buffer): number | null {
  if (buf.length >= 8 && buf.readUInt32BE(0) === 0x89504e47) {
    const iend = indexOfBytes(buf, [0x49, 0x45, 0x4e, 0x44]);
    if (iend >= 0) return Math.min(buf.length, iend + 8);
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8) {
    for (let i = buf.length - 2; i >= 2; i--) {
      if (buf[i] === 0xff && buf[i + 1] === 0xd9) return i + 2;
    }
  }
  if (buf.length >= 6 && buf.toString("latin1", 0, 3) === "GIF") {
    const term = buf.lastIndexOf(0x3b);
    if (term >= 0) return term + 1;
  }
  if (buf.length >= 4 && buf.readUInt32LE(0) === 0x04034b50) {
    const eocd = lastIndexOfBytes(buf, [0x50, 0x4b, 0x05, 0x06]);
    if (eocd >= 0) return Math.min(buf.length, eocd + 22);
  }
  return null;
}

function indexOfBytes(buf: Buffer, needle: number[], from = 0): number {
  outer: for (let i = from; i <= buf.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (buf[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

function lastIndexOfBytes(buf: Buffer, needle: number[]): number {
  outer: for (let i = buf.length - needle.length; i >= 0; i--) {
    for (let j = 0; j < needle.length; j++) {
      if (buf[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}
