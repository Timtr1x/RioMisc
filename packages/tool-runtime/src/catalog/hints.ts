import { scanTrailingData } from "@rio/misc-runtime";
import type { FileInspection } from "../inspect.js";
import type { ToolHint } from "./types.js";

const IMAGE = new Set(["PNG", "JPEG", "GIF"]);
const ARCHIVE = new Set(["ZIP", "GZIP", "RAR", "7Z"]);

function pngHasAlpha(buf: Buffer): boolean {
  if (buf.length < 26) return false;
  if (buf.readUInt32BE(0) !== 0x89504e47) return false;
  return buf[25] === 4 || buf[25] === 6;
}

export function hintsForInspection(insp: FileInspection, buf?: Buffer): ToolHint[] {
  const hints: ToolHint[] = [];
  const magic = insp.magic;
  if (IMAGE.has(magic)) {
    hints.push({ tool: "inspect_metadata", reason: "Read PNG/JPEG text chunks or comments before heavy visual work." });
    hints.push({ tool: "analyze_visual", reason: "The file is an image and visual evidence may be useful." });
    hints.push({ tool: "extract_bitplane", reason: "LSB / bitplane extraction is a cheap next check on raster images." });
    if (magic === "PNG" && buf && pngHasAlpha(buf)) {
      hints.push({ tool: "analyze_visual", reason: "This PNG uses an alpha channel; hidden data often lives there." });
    }
    const trail = buf ? scanTrailingData(buf) : null;
    if (trail?.hasTrailingData) {
      hints.push({
        tool: "scan_trailing_data",
        reason: `This ${magic} contains ${trail.bytes} bytes beyond the normal end marker.`,
      });
      hints.push({ tool: "carve_files", reason: "Carve the trailing bytes and inspect them as their own file." });
    } else if (IMAGE.has(magic) || magic === "ZIP") {
      hints.push({ tool: "scan_trailing_data", reason: `Check ${magic} containers for bytes after the official end marker.` });
    }
  }
  if (ARCHIVE.has(magic)) {
    hints.push({ tool: "extract_archive", reason: "This looks like an archive — extract it before guessing encodings." });
    if (magic === "ZIP") {
      hints.push({ tool: "scan_trailing_data", reason: "ZIP files sometimes hide a second payload after EOCD." });
    }
  }
  if (magic === "PCAP") {
    hints.push({ tool: "analyze_pcap_overview", reason: "Start with a packet/protocol/HTTP/DNS overview before carving streams." });
    hints.push({ tool: "extract_http_objects", reason: "HTTP objects in a PCAP are a common flag drop." });
    hints.push({ tool: "extract_dns_activity", reason: "DNS names may carry exfiltrated or encoded data." });
    hints.push({ tool: "follow_tcp_stream", reason: "Reassemble a TCP stream when overview shows interesting conversations." });
  }
  if (magic === "TEXT") {
    hints.push({ tool: "parse_crypto_values", reason: "Challenge text often contains n/e/c or other crypto parameters." });
    hints.push({ tool: "extract_strings_summary", reason: "Look for flag-like strings and encodings first." });
  }
  if (magic === "BINARY" || insp.entropy >= 7.2) {
    hints.push({ tool: "scan_embedded_signatures", reason: "High-entropy or unknown binaries may embed ZIP/PNG/PDF payloads." });
    hints.push({ tool: "extract_strings_summary", reason: "A strings summary is cheaper than a full dump." });
  }
  const seen = new Set<string>();
  return hints.filter((h) => {
    const k = `${h.tool}:${h.reason}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export function hintsForRsaAnalysis(candidates: { attack: string }[]): ToolHint[] {
  const map: Record<string, { tool: string; reason: string }> = {
    FACTOR: { tool: "factor_integer", reason: "n is small enough that trial / rho factorization is the first attack." },
    SMALL_E: { tool: "rsa_small_e", reason: "e is tiny; try integer root / small-e before writing an attack script." },
    FERMAT: { tool: "rsa_fermat", reason: "p and q look close — Fermat factorization is the matching cheap attack." },
    WIENER: { tool: "rsa_wiener", reason: "e is large relative to n, so d may be small enough for Wiener." },
  };
  const hints: ToolHint[] = [];
  for (const c of candidates) {
    const hit = map[c.attack];
    if (hit) hints.push(hit);
  }
  if (hints.length === 0) {
    hints.push({ tool: "analyze_rsa_instance", reason: "Re-run analysis after filling missing n/e/c." });
  }
  hints.push({ tool: "rsa_common_modulus", reason: "If you later see two (e,c) pairs on the same n, use common-modulus." });
  hints.push({ tool: "rsa_hastad", reason: "Same small e and the same plaintext under several moduli is Håstad." });
  return hints;
}
