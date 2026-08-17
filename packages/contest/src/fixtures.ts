// Programmatically generated challenge fixtures for the Mock contest.
// Pure functions — no I/O. Every fixture produces real attachment bytes.
import { deflateSync } from "node:zlib";
import { createHash, randomBytes } from "node:crypto";
import QRCode from "qrcode";

export interface FixtureAttachment {
  name: string;
  bytes: Buffer;
}

export interface FixtureChallenge {
  id: string;
  title: string;
  description: string;
  category: string;
  flag: string;
  attachments: FixtureAttachment[];
  /** Fixture bytes whose hash changes on update (challenge revision detection). */
  mutable?: boolean;
}

// ---------------------------------------------------------------------------
// Tiny binary writers
// ---------------------------------------------------------------------------

const CRC_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[i] = c >>> 0;
}

export function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function u32(v: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(v >>> 0);
  return b;
}

function be32(v: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(v >>> 0);
  return b;
}

function u16(v: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(v & 0xffff);
  return b;
}

/** Minimal ZIP writer (STORE method, no compression, no encryption). */
export function makeZip(files: { name: string; data: Buffer }[]): Buffer {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const nameBuf = Buffer.from(f.name, "utf8");
    const crc = crc32(f.data);
    const local = Buffer.concat([
      Buffer.from("PK\x03\x04", "binary"),
      u16(20), // version needed
      u16(0), // flags
      u16(0), // method: store
      u16(0), // time
      u16(0), // date
      u32(crc),
      u32(f.data.length),
      u32(f.data.length),
      u16(nameBuf.length),
      u16(0),
      nameBuf,
      f.data,
    ]);
    chunks.push(local);
    central.push(
      Buffer.concat([
        Buffer.from("PK\x01\x02", "binary"),
        u16(20),
        u16(20),
        u16(0),
        u16(0),
        u16(0),
        u16(0),
        u32(crc),
        u32(f.data.length),
        u32(f.data.length),
        u16(nameBuf.length),
        u16(0),
        u16(0),
        u16(0),
        u16(0),
        u32(0),
        u32(offset),
        nameBuf,
      ]),
    );
    offset += local.length;
  }
  const centralDir = Buffer.concat(central);
  const eocd = Buffer.concat([
    Buffer.from("PK\x05\x06", "binary"),
    u16(0),
    u16(0),
    u16(files.length),
    u16(files.length),
    u32(centralDir.length),
    u32(offset),
    u16(0),
  ]);
  return Buffer.concat([...chunks, centralDir, eocd]);
}

/** Minimal valid PNG (RGB, bit depth 8). Chunk length/CRC are big-endian per spec. */
export function makePng(width: number, height: number, rgb: Buffer): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type RGB
  const scanlines = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    scanlines[y * (1 + width * 3)] = 0; // filter none
    rgb.copy(scanlines, y * (1 + width * 3) + 1, y * width * 3, (y + 1) * width * 3);
  }
  const idat = deflateSync(scanlines);
  const chunk = (type: string, data: Buffer) =>
    Buffer.concat([be32(data.length), Buffer.from(type, "binary"), data, be32(crc32(Buffer.concat([Buffer.from(type, "binary"), data])))]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Embed flag bits into the LSB of RGB channels (classic LSB stego). */
export function lsbEmbed(flag: string, width: number, height: number): Buffer {
  const rgb = randomBytes(width * height * 3);
  const bits: number[] = [];
  for (const byte of Buffer.from(flag, "utf8")) {
    for (let i = 7; i >= 0; i--) bits.push((byte >> i) & 1);
  }
  bits.push(0, 0, 0, 0, 0, 0, 0, 0); // null terminator
  for (let i = 0; i < bits.length && i < rgb.length; i++) {
    rgb[i] = (rgb[i]! & 0xfe) | bits[i]!;
  }
  return makePng(width, height, rgb);
}

/** Minimal PCAP file (Ethernet) with a single HTTP request/response exchange. */
export function makePcapHttp(flag: string): Buffer {
  const req = Buffer.from(`GET /flag HTTP/1.1\r\nHost: ctf.local\r\nUser-Agent: rio-mock\r\n\r\n`, "binary");
  const resp = Buffer.from(`HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n\r\n${flag}\r\n`, "binary");
  const eth = (payload: Buffer) =>
    Buffer.concat([
      Buffer.from("00112233445566778899aabb", "hex"),
      Buffer.from("0800", "hex"),
      payload,
    ]);
  const ipv4 = (payload: Buffer, src: number, dst: number) => {
    const hdr = Buffer.alloc(20);
    hdr[0] = 0x45;
    hdr.writeUInt16BE(20 + payload.length, 2);
    hdr[8] = 64; // ttl
    hdr[9] = 6; // tcp
    hdr.writeUInt16BE(0x0000, 10); // checksum 0 (not validated)
    hdr.writeUInt32BE(src, 12);
    hdr.writeUInt32BE(dst, 16);
    return Buffer.concat([hdr, payload]);
  };
  const tcp = (payload: Buffer, sport: number, dport: number, seq: number) => {
    const hdr = Buffer.alloc(20);
    hdr.writeUInt16BE(sport, 0);
    hdr.writeUInt16BE(dport, 2);
    hdr.writeUInt32BE(seq, 4);
    hdr.writeUInt16BE(0x5018, 12); // ACK|PSH, window 512
    return Buffer.concat([hdr, payload]);
  };
  const packet = (payload: Buffer, ts: number) => {
    const rec = Buffer.alloc(16);
    rec.writeUInt32LE(ts, 0);
    rec.writeUInt32LE(payload.length, 8);
    rec.writeUInt32LE(payload.length, 12);
    return Buffer.concat([rec, payload]);
  };
  const globalHeader = Buffer.alloc(24);
  globalHeader.writeUInt32LE(0xa1b2c3d4, 0);
  globalHeader.writeUInt16LE(2, 4);
  globalHeader.writeUInt16LE(4, 6);
  globalHeader.writeUInt32LE(65535, 16);
  globalHeader.writeUInt32LE(1, 20); // LINKTYPE_ETHERNET
  const p1 = eth(ipv4(tcp(req, 40000, 80, 1), 0x0a000001, 0x0a000002));
  const p2 = eth(ipv4(tcp(resp, 80, 40000, 1000), 0x0a000002, 0x0a000001));
  return Buffer.concat([globalHeader, packet(p1, 1700000000), packet(p2, 1700000001)]);
}

// ---------------------------------------------------------------------------
// RSA helpers (small-key fixtures; factoring is the intended path)
// ---------------------------------------------------------------------------

function modpow(base: bigint, exp: bigint, mod: bigint): bigint {
  let result = 1n;
  base %= mod;
  while (exp > 0n) {
    if (exp & 1n) result = (result * base) % mod;
    exp >>= 1n;
    base = (base * base) % mod;
  }
  return result;
}

/** Deterministic Miller-Rabin (fixed bases — fixture reproducibility). */
function millerRabin(n: bigint, rounds = 12): boolean {
  if (n < 2n) return false;
  for (const a of [2n, 3n, 5n, 7n, 11n, 13n, 17n, 19n, 23n, 29n, 31n, 37n]) {
    if (n % a === 0n) return n === a;
  }
  let d = n - 1n;
  let s = 0n;
  while (d % 2n === 0n) {
    d /= 2n;
    s++;
  }
  for (let i = 0n; i < BigInt(rounds); i++) {
    const a = 2n + ((i * 7919n + 13n) % (n - 4n));
    let x = modpow(a, d, n);
    if (x === 1n || x === n - 1n) continue;
    let composite = true;
    for (let r = 1n; r < s; r++) {
      x = (x * x) % n;
      if (x === n - 1n) {
        composite = false;
        break;
      }
    }
    if (composite) return false;
  }
  return true;
}

function nextPrime(start: bigint): bigint {
  let x = start % 2n === 0n ? start + 1n : start;
  while (!millerRabin(x)) x += 2n;
  return x;
}

export function rsaFixture(opts: { p: bigint; q: bigint; e: bigint; message: bigint }): { n: string; e: string; c: string } {
  const n = opts.p * opts.q;
  const c = modpow(opts.message, opts.e, n);
  return { n: n.toString(10), e: opts.e.toString(10), c: c.toString(10) };
}

export function flagToBigInt(flag: string): bigint {
  let v = 0n;
  for (const ch of Buffer.from(flag, "utf8")) v = (v << 8n) | BigInt(ch);
  return v;
}

export function hex(buf: Buffer): string {
  return buf.toString("hex");
}

export function sha256Hex(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

export function makeQrPng(text: string): Buffer {
  const qr = QRCode.create(text, { errorCorrectionLevel: "M" });
  const size = qr.modules.size;
  const scale = 4;
  const quiet = 4;
  const dim = (size + quiet * 2) * scale;
  const rgb = Buffer.alloc(dim * dim * 3, 255);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!qr.modules.get(y, x)) continue;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const px = (quiet + x) * scale + dx;
          const py = (quiet + y) * scale + dy;
          const o = (py * dim + px) * 3;
          rgb[o] = 0;
          rgb[o + 1] = 0;
          rgb[o + 2] = 0;
        }
      }
    }
  }
  return makePng(dim, dim, rgb);
}

export function makeToneWav(sampleRate: number, hz: number, seconds: number): Buffer {
  const frames = Math.floor(sampleRate * seconds);
  const data = Buffer.alloc(frames * 2);
  for (let i = 0; i < frames; i++) {
    const s = Math.sin((2 * Math.PI * hz * i) / sampleRate);
    data.writeInt16LE(Math.round(s * 16000), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

export function bigintToAscii(n: bigint): string {
  let x = n;
  const bytes: number[] = [];
  while (x > 0n) {
    bytes.push(Number(x & 0xffn));
    x >>= 8n;
  }
  return Buffer.from(bytes.reverse()).toString("utf8");
}

// ---------------------------------------------------------------------------
// The fixture set (misc-001..007, crypto-001..006, unsupported-web)
// ---------------------------------------------------------------------------

export function buildFixtures(): FixtureChallenge[] {
  const fixtures: FixtureChallenge[] = [];

  // misc-001: base64-encoded flag in a text file
  {
    const flag = "flag{base64_is_not_encryption}";
    fixtures.push({
      id: "misc-001",
      title: "Base64 Decode",
      description: "The flag was base64 encoded and saved to a file. Decode it.",
      category: "MISC",
      flag,
      attachments: [{ name: "message.txt", bytes: Buffer.from(Buffer.from(flag, "utf8").toString("base64") + "\n") }],
    });
  }

  // misc-002: nested zip (flag.txt inside inner.zip inside outer.zip)
  {
    const flag = "flag{nested_zips_never_end}";
    const inner = makeZip([{ name: "flag.txt", data: Buffer.from(flag + "\n") }]);
    fixtures.push({
      id: "misc-002",
      title: "Nested Archive",
      description: "Unpack the archives until you find the flag.",
      category: "MISC",
      flag,
      attachments: [{ name: "outer.zip", bytes: makeZip([{ name: "inner.zip", data: inner }]) }],
    });
  }

  // misc-003: PNG with a zip appended at the end
  {
    const flag = "flag{trailing_data_always_suspicious}";
    const png = makePng(64, 64, randomBytes(64 * 64 * 3));
    const zip = makeZip([{ name: "secret.txt", data: Buffer.from(flag + "\n") }]);
    fixtures.push({
      id: "misc-003",
      title: "PNG Trailing Zip",
      description: "An innocent PNG. Look at the whole file.",
      category: "MISC",
      flag,
      attachments: [{ name: "picture.png", bytes: Buffer.concat([png, zip]) }],
    });
  }

  // misc-004: LSB stego in PNG
  {
    const flag = "flag{lsb_hides_in_plain_sight}";
    fixtures.push({
      id: "misc-004",
      title: "Least Significant",
      description: "The image looks normal. Check the channel anomalies.",
      category: "MISC",
      flag,
      attachments: [{ name: "stego.png", bytes: lsbEmbed(flag, 96, 96) }],
    });
  }

  // misc-005: pcap with HTTP response containing the flag
  {
    const flag = "flag{http_capture_contains_secrets}";
    fixtures.push({
      id: "misc-005",
      title: "Packet Sniff",
      description: "Somebody fetched the flag over HTTP. Follow the stream.",
      category: "MISC",
      flag,
      attachments: [{ name: "capture.pcap", bytes: makePcapHttp(flag) }],
    });
  }

  // crypto-001: XOR with known key
  {
    const flag = "flag{xor_is_reversible}";
    const key = "p@ssw0rd";
    const plain = Buffer.from(flag, "utf8");
    const cipher = Buffer.from(plain.map((b, i) => b ^ key.charCodeAt(i % key.length)));
    fixtures.push({
      id: "crypto-001",
      title: "XOR Cipher",
      description: `cipher = ${cipher.toString("hex")}\nkey = ${key}\nRecover the flag.`,
      category: "CRYPTO",
      flag,
      attachments: [{ name: "cipher.txt", bytes: Buffer.from(cipher.toString("hex") + "\n") }],
    });
  }

  // crypto-002: RSA with close primes (Fermat factorization)
  {
    const flag = "flag{rsa_needs_big_primes}";
    const p = nextPrime(2n ** 105n + 0x1337n);
    const q = nextPrime(p + 2n);
    const { n, e, c } = rsaFixture({
      p,
      q,
      e: 65537n,
      message: flagToBigInt(flag),
    });
    fixtures.push({
      id: "crypto-002",
      title: "Baby RSA",
      description: `n = ${n}\ne = ${e}\nc = ${c}\nThe primes p and q are very close. Decrypt.`,
      category: "CRYPTO",
      flag,
      attachments: [],
    });
  }

  // crypto-003: RSA small e (m^e < n → integer root)
  {
    const flag = "flag{small_e_leaks_plaintext}";
    const e = 3n;
    let m = flagToBigInt(flag);
    let c = m ** e;
    // ensure c < n by choosing n = c + something
    const n = c + 99999999999999999999n;
    const primeCheck = (x: bigint) => {
      if (x < 2n) return false;
      for (let i = 2n; i * i <= x && i < 10000n; i++) if (x % i === 0n) return false;
      return true;
    };
    if (!primeCheck(n)) {
      // n doesn't need to be prime for the challenge; any n > c works.
    }
    fixtures.push({
      id: "crypto-003",
      title: "RSA Small e",
      description: `n = ${n}\ne = ${e}\nc = ${c}\nDecrypt.`,
      category: "CRYPTO",
      flag,
      attachments: [],
    });
  }

  // crypto-004: RSA common modulus (same n, coprime e1,e2)
  {
    const flag = "flag{common_modulus_attack}";
    const p = nextPrime(2n ** 110n + 0xbeefn);
    const q = nextPrime(2n ** 110n + 0xc0den);
    const n = p * q;
    const e1 = 65537n;
    const e2 = 65521n;
    const m = flagToBigInt(flag);
    const c1 = modpow(m, e1, n);
    const c2 = modpow(m, e2, n);
    fixtures.push({
      id: "crypto-004",
      title: "RSA Common Modulus",
      description: `n = ${n}\ne1 = ${e1}\nc1 = ${c1}\ne2 = ${e2}\nc2 = ${c2}\nThe same message was encrypted with both exponents.`,
      category: "CRYPTO",
      flag,
      attachments: [],
    });
  }

  // crypto-005: LCG — predict next output
  {
    const flag = "flag{lcg_is_predictable}";
    const a = 1103515245n;
    const c = 12345n;
    const m = 1n << 31n;
    let s = 42n;
    const out: string[] = [];
    for (let i = 0; i < 5; i++) {
      s = (a * s + c) % m;
      out.push(s.toString());
    }
    // out[0..3] given, flag = next value
    fixtures.push({
      id: "crypto-005",
      title: "LCG Predict",
      description: `a = ${a}\nc = ${c}\nm = ${m}\noutputs = [${out.slice(0, 4).join(", ")}]\nWhat is the next output? (flag{next})`,
      category: "CRYPTO",
      flag: `flag{${out[4]}}`,
      attachments: [],
    });
  }

  // misc-006: QR image — Solver must call analyze_visual, not guess pixels
  {
    const flag = "flag{visual_qr_ok}";
    fixtures.push({
      id: "misc-006",
      title: "Scan This",
      description: "A QR code holds the flag. Use analyze_visual; do not guess pixels.",
      category: "MISC",
      flag,
      attachments: [{ name: "code.png", bytes: makeQrPng(flag) }],
    });
  }

  // misc-007: single-tone WAV — sample rate is the flag payload
  {
    const sampleRate = 8000;
    const flag = `flag{sr_${sampleRate}}`;
    fixtures.push({
      id: "misc-007",
      title: "One Tone",
      description: "A single-tone WAV. Render the spectrogram and put the sample rate in flag{sr_<rate>}.",
      category: "MISC",
      flag,
      attachments: [{ name: "tone.wav", bytes: makeToneWav(sampleRate, 440, 1) }],
    });
  }

  // crypto-006: Håstad broadcast (e=3, three moduli)
  {
    const flag = "flag{hastad}";
    const m = flagToBigInt(flag);
    const e = 3n;
    const n1 = nextPrime(2n ** 96n + 101n);
    const n2 = nextPrime(2n ** 96n + 333n);
    const n3 = nextPrime(2n ** 96n + 777n);
    const c1 = (m ** e) % n1;
    const c2 = (m ** e) % n2;
    const c3 = (m ** e) % n3;
    fixtures.push({
      id: "crypto-006",
      title: "Broadcast RSA",
      description: `Håstad broadcast with e = ${e}.\nn1 = ${n1}\nc1 = ${c1}\nn2 = ${n2}\nc2 = ${c2}\nn3 = ${n3}\nc3 = ${c3}\nRecover the message.`,
      category: "CRYPTO",
      flag,
      attachments: [],
    });
  }

  // unsupported-web — must never be scheduled
  {
    fixtures.push({
      id: "unsupported-web",
      title: "Login Portal",
      description: "Exploit the web app to get admin.",
      category: "WEB",
      flag: "flag{web_is_out_of_scope}",
      attachments: [],
    });
  }

  return fixtures;
}
