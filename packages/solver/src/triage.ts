// Deterministic rule-based Triage (§60-61). The official category is trusted;
// this only produces subcategory/difficulty/resources/hypotheses for the scheduler.
import type { TriageResult, Attachment } from "@rio/domain";
import { inspectFile } from "@rio/tool-runtime";

const CRYPTO_KEYWORDS = [
  "rsa", "xor", "lcg", "ecc", "aes", "des", "cipher", "encrypt", "decrypt",
  "modulus", "prime", "coppersmith", "wiener", "hastad", "mt19937", "hash",
  "length extension", "signature", "nonce", "finite field", "polynomial",
];

const MISC_KEYWORDS = [
  "archive", "zip", "rar", "png", "jpeg", "gif", "image", "pcap", "stego",
  "lsb", "qr", "spectrogram", "audio", "wav", "base64", "hex", "decode",
  "nested", "trailing", "metadata", "exif", "dns", "icmp", "http",
];

export function triage(opts: {
  title: string;
  description: string;
  category: string;
  attachments: (Pick<Attachment, "name" | "sizeBytes" | "localPath"> & { localPath?: string | null })[];
}): TriageResult {
  const text = `${opts.title}\n${opts.description}`.toLowerCase();
  const subcategory: string[] = [];
  let heavyHint = false;

  for (const kw of CRYPTO_KEYWORDS) if (text.includes(kw)) subcategory.push(kw);
  for (const kw of MISC_KEYWORDS) if (text.includes(kw) && !subcategory.includes(kw)) subcategory.push(kw);

  // Cheap inspection of downloaded attachments
  const magicTypes: string[] = [];
  let bigFile = false;
  for (const a of opts.attachments) {
    if (a.sizeBytes !== null && a.sizeBytes > 100 * 1024 * 1024) bigFile = true;
    if (a.localPath) {
      try {
        const insp = inspectFile(a.localPath);
        magicTypes.push(insp.magic);
        if (insp.entropy > 7.9 && insp.magic === "BINARY") heavyHint = true;
      } catch {
        /* file may not exist yet */
      }
    }
  }

  const isCrypto = opts.category === "CRYPTO" || subcategory.some((s) => CRYPTO_KEYWORDS.includes(s));
  const isMisc = opts.category === "MISC" || magicTypes.length > 0 || subcategory.some((s) => MISC_KEYWORDS.includes(s));

  const difficulty: 1 | 2 | 3 | 4 | 5 = heavyHint || bigFile ? 4 : 2;

  const resourceProfile = heavyHint || bigFile ? "HEAVY" : "NORMAL";

  return {
    subcategory: [...new Set(subcategory)].slice(0, 8),
    difficulty,
    resourceProfile,
    initialHypotheses: [
      isCrypto ? "Data in description/attachments is encrypted or encoded; identify the primitive first." : "Attachment is a container; inventory and identify before decoding.",
      isMisc ? "Look for embedded/encoded payloads inside the container." : "Formalize variables (knowns/unknowns/equations) before attacking.",
    ],
    suggestedTools: magicTypes.includes("ZIP")
      ? ["extract_archive", "read_challenge_file", "inspect_file"]
      : magicTypes.includes("PCAP")
        ? ["inspect_file", "run_python"]
        : ["inspect_file", "read_challenge_file", "run_python", "extract_archive"],
    likelyCrossCategory: isCrypto ? "CRYPTO_TO_MISC" : isMisc ? "MISC_TO_CRYPTO" : "NONE",
    summary: `category=${opts.category} magic=${magicTypes.join(",") || "none"} sub=${subcategory.slice(0, 4).join(",") || "none"} heavy=${heavyHint || bigFile}`,
  };
}
