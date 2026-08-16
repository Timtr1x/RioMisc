import { parseBig } from "./math.js";

export function parseCryptoValues(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /\b(n|e|d|p|q|c|c1|c2|e1|e2|phi|m|iv|key|seed)\s*[=:]\s*([0-9]+|0x[0-9a-fA-F]+)/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) {
    out[match[1]!.toLowerCase()] = match[2]!;
  }
  return out;
}

export function asBig(map: Record<string, string>, key: string): bigint | undefined {
  const v = map[key];
  if (!v) return undefined;
  return parseBig(v);
}
