export function xorBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const n = Math.max(a.length, b.length);
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = (a[i] ?? 0) ^ (b[i % b.length] ?? 0);
  return out;
}

export function xorKnownPlaintext(cipher: Uint8Array, plain: Uint8Array): Uint8Array {
  return xorBytes(cipher.subarray(0, plain.length), plain);
}

export function repeatingXorDecrypt(cipher: Uint8Array, key: Uint8Array): Uint8Array {
  const out = new Uint8Array(cipher.length);
  for (let i = 0; i < cipher.length; i++) out[i] = cipher[i]! ^ key[i % key.length]!;
  return out;
}

export function scoreEnglish(buf: Uint8Array): number {
  const freq: Record<string, number> = { e: 12, t: 9, a: 8, o: 7, i: 7, n: 6, s: 6, h: 6, r: 6, space: 13 };
  let score = 0;
  for (const b of buf) {
    if (b === 32) score += freq.space ?? 0;
    else if (b >= 65 && b <= 90) score += freq[String.fromCharCode(b + 32)] ?? 0;
    else if (b >= 97 && b <= 122) score += freq[String.fromCharCode(b)] ?? 0;
    else if (b === 10 || b === 13 || b === 9) score += 1;
    else if (b < 9 || b > 126) score -= 5;
  }
  return score / Math.max(1, buf.length);
}

export function breakSingleByteXor(cipher: Uint8Array): { key: number; plain: Uint8Array; score: number } {
  let best = { key: 0, plain: cipher, score: -1e9 };
  for (let k = 0; k < 256; k++) {
    const plain = new Uint8Array(cipher.length);
    for (let i = 0; i < cipher.length; i++) plain[i] = cipher[i]! ^ k;
    const score = scoreEnglish(plain);
    if (score > best.score) best = { key: k, plain, score };
  }
  return best;
}

export function frequencyAnalysis(buf: Uint8Array): { counts: Record<string, number>; likelyCaesar: number } {
  const counts: Record<string, number> = {};
  for (const b of buf) {
    if (b >= 65 && b <= 90) counts[String.fromCharCode(b)] = (counts[String.fromCharCode(b)] ?? 0) + 1;
    if (b >= 97 && b <= 122) counts[String.fromCharCode(b)] = (counts[String.fromCharCode(b)] ?? 0) + 1;
  }
  let bestShift = 0;
  let best = -1;
  for (let s = 0; s < 26; s++) {
    const e = (counts[String.fromCharCode(65 + ((4 + s) % 26))] ?? 0) + (counts[String.fromCharCode(97 + ((4 + s) % 26))] ?? 0);
    if (e > best) {
      best = e;
      bestShift = (26 - s) % 26;
    }
  }
  return { counts, likelyCaesar: bestShift };
}

export function caesar(buf: Uint8Array, shift: number): Uint8Array {
  const out = new Uint8Array(buf.length);
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i]!;
    if (b >= 65 && b <= 90) out[i] = 65 + ((b - 65 + shift + 26) % 26);
    else if (b >= 97 && b <= 122) out[i] = 97 + ((b - 97 + shift + 26) % 26);
    else out[i] = b;
  }
  return out;
}
