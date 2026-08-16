export interface StringsSummary {
  count: number;
  interesting: string[];
  urls: string[];
  paths: string[];
  base64Candidates: string[];
  flagLike: string[];
}

export function extractStringsSummary(buf: Buffer, minLen = 4): StringsSummary {
  const found: string[] = [];
  let cur: number[] = [];
  const push = () => {
    if (cur.length >= minLen) found.push(Buffer.from(cur).toString("latin1"));
    cur = [];
  };
  for (const b of buf) {
    if ((b >= 32 && b < 127) || b === 9) cur.push(b);
    else push();
  }
  push();
  const urls: string[] = [];
  const paths: string[] = [];
  const base64Candidates: string[] = [];
  const flagLike: string[] = [];
  const interesting: string[] = [];
  for (const s of found) {
    if (/flag\{|ctf\{|FLAG\{/i.test(s)) flagLike.push(s.slice(0, 200));
    if (/https?:\/\/[^\s]+/i.test(s)) urls.push(s.match(/https?:\/\/[^\s]+/i)![0]!);
    if (/^[A-Za-z]:\\|^\/[\w./-]+$/.test(s) && s.length < 180) paths.push(s);
    if (s.length >= 16 && s.length % 4 === 0 && /^[A-Za-z0-9+/=]+$/.test(s)) base64Candidates.push(s.slice(0, 80));
    if (/flag\{|PK\\x03|SQLite format 3|BEGIN RSA|ssh-rsa|password|secret|http/i.test(s)) {
      interesting.push(s.slice(0, 160));
    }
  }
  return {
    count: found.length,
    interesting: unique(interesting).slice(0, 40),
    urls: unique(urls).slice(0, 20),
    paths: unique(paths).slice(0, 20),
    base64Candidates: unique(base64Candidates).slice(0, 10),
    flagLike: unique(flagLike).slice(0, 10),
  };
}

function unique(xs: string[]): string[] {
  return [...new Set(xs)];
}
