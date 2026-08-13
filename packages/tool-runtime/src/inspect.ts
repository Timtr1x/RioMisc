// Deterministic file inspection (§61 Cheap Inspection): magic, entropy, image
// dims, pcap summary. No heavy operations.
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { listZipEntries, listZipEntriesFromFile } from "./zip.js";
import { sampleFileWindows, sha256File, readFileWindow } from "./stream-io.js";

export interface FileInspection {
  name: string;
  size: number;
  sha256: string;
  magic: string;
  mime: string;
  entropy: number;
  extension: string;
  hints: string[];
  inspectionSampleBytes?: number;
  partialInspection?: boolean;
}

export type MagicType =
  | "PNG"
  | "JPEG"
  | "GIF"
  | "ZIP"
  | "GZIP"
  | "RAR"
  | "7Z"
  | "PCAP"
  | "PDF"
  | "ELF"
  | "PE"
  | "TEXT"
  | "BINARY"
  | "UNKNOWN";

export function detectMagic(buf: Buffer): MagicType {
  if (buf.length >= 8 && buf.readUInt32BE(0) === 0x89504e47) return "PNG";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "JPEG";
  if (buf.length >= 6 && buf.toString("latin1", 0, 6) === "GIF89a") return "GIF";
  if (buf.length >= 4 && buf.readUInt32LE(0) === 0x04034b50) return "ZIP";
  if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) return "GZIP";
  if (buf.length >= 4 && buf.toString("latin1", 0, 4) === "Rar!") return "RAR";
  if (buf.length >= 6 && buf.toString("latin1", 0, 6) === "7z\xbc\xaf\x27\x1c") return "7Z";
  if (buf.length >= 4 && buf.readUInt32LE(0) === 0xa1b2c3d4) return "PCAP";
  if (buf.length >= 4 && buf.readUInt32BE(0) === 0xa1b2c3d4) return "PCAP";
  if (buf.length >= 5 && buf.toString("latin1", 0, 5) === "%PDF-") return "PDF";
  if (buf.length >= 4 && buf.toString("latin1", 1, 4) === "ELF") return "ELF";
  if (buf.length >= 2 && buf[0] === 0x4d && buf[1] === 0x5a) return "PE";
  if (isLikelyText(buf)) return "TEXT";
  return "BINARY";
}

export function mimeFor(magic: MagicType): string {
  switch (magic) {
    case "PNG":
      return "image/png";
    case "JPEG":
      return "image/jpeg";
    case "GIF":
      return "image/gif";
    case "ZIP":
      return "application/zip";
    case "GZIP":
      return "application/gzip";
    case "RAR":
      return "application/x-rar";
    case "7Z":
      return "application/x-7z-compressed";
    case "PCAP":
      return "application/vnd.tcpdump.pcap";
    case "PDF":
      return "application/pdf";
    case "ELF":
      return "application/x-elf";
    case "PE":
      return "application/x-dosexec";
    case "TEXT":
      return "text/plain";
    default:
      return "application/octet-stream";
  }
}

export function isLikelyText(buf: Buffer): boolean {
  if (buf.length === 0) return true;
  const sample = buf.subarray(0, Math.min(buf.length, 4096));
  let printable = 0;
  for (const b of sample) {
    if (b === 9 || b === 10 || b === 13 || (b >= 32 && b < 127) || b >= 0x80) printable++;
  }
  return printable / sample.length > 0.95;
}

/** Shannon entropy (bits/byte) over a bounded sample. */
export function entropy(buf: Buffer): number {
  const sample = buf.length <= 64 * 1024 ? buf : buf.subarray(0, 64 * 1024);
  const counts = new Array<number>(256).fill(0);
  for (const b of sample) counts[b]!++;
  let h = 0;
  const n = sample.length;
  for (const c of counts) {
    if (c === 0) continue;
    const p = c / n;
    h -= p * Math.log2(p);
  }
  return Math.round(h * 1000) / 1000;
}

export function inspectBuffer(buf: Buffer, name: string): FileInspection {
  const magic = detectMagic(buf);
  const hints: string[] = [];
  if (magic === "PNG" && buf.length > 24) {
    const dims = pngDimensions(buf);
    hints.push(`PNG ${dims.width}x${dims.height}`);
  }
  if (magic === "GIF" && buf.length > 10) {
    hints.push(`GIF ${buf.readUInt16LE(6)}x${buf.readUInt16LE(8)}`);
  }
  if (magic === "ZIP") {
    try {
      hints.push(`ZIP ${listZipEntries(buf).length} entries`);
    } catch {
      hints.push("ZIP (corrupt or partial)");
    }
  }
  if (magic === "PCAP") {
    const s = pcapSummary(buf);
    hints.push(`PCAP ${s.packetCount} packets`);
  }
  if (magic === "TEXT") {
    const sample = buf.subarray(0, Math.min(buf.length, 120)).toString("utf8").replaceAll("\n", "⏎").replaceAll("\r", "");
    hints.push(`text: ${JSON.stringify(sample)}`);
  }
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";
  return {
    name,
    size: buf.length,
    sha256: createHash("sha256").update(buf).digest("hex"),
    magic,
    mime: mimeFor(magic),
    entropy: entropy(buf),
    extension: ext,
    hints,
  };
}

export function inspectFile(path: string): FileInspection {
  const st = statSync(path);
  // Small files stay exact; anything unbounded uses head/middle/tail + streaming hash.
  if (st.size <= 256 * 1024) {
    const buf = readFileSync(path);
    return inspectBuffer(buf, path.split(/[\\/]/).pop() ?? path);
  }
  return inspectFilePath(path);
}

const PCAP_BOUND = 16 * 1024 * 1024;

/** Bounded inspection: never readFileSync the whole unbounded file. */
export function inspectFilePath(path: string): FileInspection {
  const name = path.split(/[\\/]/).pop() ?? path;
  const samples = sampleFileWindows(path);
  const magic = detectMagic(samples.head);
  const hints: string[] = [];
  if (magic === "PNG" && samples.head.length > 24) {
    const dims = pngDimensions(samples.head);
    hints.push(`PNG ${dims.width}x${dims.height}`);
  }
  if (magic === "GIF" && samples.head.length > 10) {
    hints.push(`GIF ${samples.head.readUInt16LE(6)}x${samples.head.readUInt16LE(8)}`);
  }
  if (magic === "ZIP") {
    try {
      hints.push(`ZIP ${listZipEntriesFromFile(path).length} entries`);
    } catch {
      hints.push("ZIP (corrupt or partial)");
    }
  }
  if (magic === "PCAP") {
    const window = readFileWindow(path, 0, Math.min(samples.size, PCAP_BOUND));
    const s = pcapSummary(window);
    hints.push(`PCAP ${s.packetCount} packets${samples.size > PCAP_BOUND ? " (partial, first 16MB)" : ""}`);
    if (s.hasHttp) hints.push("HTTP present");
  }
  if (magic === "TEXT") {
    const sample = samples.head.subarray(0, Math.min(samples.head.length, 120)).toString("utf8").replaceAll("\n", "⏎").replaceAll("\r", "");
    hints.push(`text: ${JSON.stringify(sample)}`);
  }
  const entropySample = samples.middle
    ? Buffer.concat([samples.head, samples.middle, samples.tail])
    : samples.head;
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";
  return {
    name,
    size: samples.size,
    sha256: sha256File(path),
    magic,
    mime: mimeFor(magic),
    entropy: entropy(entropySample),
    extension: ext,
    hints: [...hints, samples.partialInspection ? "entropy/magic from samples, not the whole file" : ""].filter(Boolean),
    inspectionSampleBytes: samples.inspectionSampleBytes,
    partialInspection: samples.partialInspection,
  };
}

export function pngDimensions(buf: Buffer): { width: number; height: number } {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error("not a png");
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

export interface PcapSummary {
  packetCount: number;
  tcp: number;
  udp: number;
  icmp: number;
  other: number;
  hasHttp: boolean;
  sampleText: string;
}

export function pcapSummary(buf: Buffer): PcapSummary {
  let packetCount = 0;
  let tcp = 0;
  let udp = 0;
  let icmp = 0;
  let other = 0;
  let hasHttp = false;
  const texts: string[] = [];
  if (buf.length < 24) return { packetCount: 0, tcp: 0, udp: 0, icmp: 0, other: 0, hasHttp: false, sampleText: "" };
  const linkType = buf.readUInt32LE(20);
  let p = 24;
  while (p + 16 <= buf.length) {
    const inclLen = buf.readUInt32LE(p + 8);
    const dataStart = p + 16;
    const dataEnd = Math.min(dataStart + inclLen, buf.length);
    packetCount++;
    let ipStart = dataStart;
    if (linkType === 1 && dataEnd - dataStart >= 14) ipStart = dataStart + 14; // ethernet
    if (dataEnd - ipStart >= 20) {
      const proto = buf[ipStart + 9];
      const isTcp = proto === 6;
      const isUdp = proto === 17;
      const isIcmp = proto === 1;
      if (isTcp) tcp++;
      else if (isUdp) udp++;
      else if (isIcmp) icmp++;
      else other++;
      // payload after ip(20) + tcp(20) or udp(8)
      const payloadStart = ipStart + (isTcp ? 40 : isUdp ? 28 : 20);
      if (payloadStart < dataEnd) {
        const text = buf.subarray(payloadStart, Math.min(dataEnd, payloadStart + 200)).toString("latin1");
        if (/HTTP\/1\.[01]|GET |POST |Host:/i.test(text)) hasHttp = true;
        if (isTcp && texts.length < 3) texts.push(text.slice(0, 120).replaceAll("\r", "␍").replaceAll("\n", "⏎"));
      }
    }
    p = dataStart + inclLen;
  }
  return { packetCount, tcp, udp, icmp, other, hasHttp, sampleText: texts.join("\n") };
}

/** Deterministic pseudo-random bytes for tests (seeded). */
export function seededBytes(seed: number, length: number): Buffer {
  let s = seed >>> 0;
  const out = Buffer.alloc(length);
  for (let i = 0; i < length; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    out[i] = s & 0xff;
  }
  return out;
}
