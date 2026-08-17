import type { RgbaImage } from "../types.js";

/** Decode GIF87a/89a frames as independent RGBA images (no disposal compositing). */
export function decodeGifFrames(buf: Buffer): RgbaImage[] {
  if (buf.length < 13 || buf.toString("ascii", 0, 3) !== "GIF") {
    throw new Error("not a GIF");
  }
  const width = buf.readUInt16LE(6);
  const height = buf.readUInt16LE(8);
  const packed = buf[10]!;
  const gctFlag = (packed & 0x80) !== 0;
  const gctSize = 2 << (packed & 7);
  let p = 13;
  let gct: Buffer | null = null;
  if (gctFlag) {
    gct = buf.subarray(p, p + gctSize * 3);
    p += gctSize * 3;
  }
  const frames: RgbaImage[] = [];
  let transIndex: number | null = null;
  while (p < buf.length) {
    const b = buf[p]!;
    if (b === 0x3b) break;
    if (b === 0x21) {
      const label = buf[p + 1];
      p += 2;
      if (label === 0xf9 && p + 6 <= buf.length) {
        const gcePacked = buf[p + 1]!;
        transIndex = gcePacked & 1 ? buf[p + 4]! : null;
        p += 6;
        continue;
      }
      while (p < buf.length && buf[p] !== 0) {
        p += 1 + buf[p]!;
      }
      p += 1;
      continue;
    }
    if (b !== 0x2c || p + 10 > buf.length) break;
    const fw = buf.readUInt16LE(p + 5);
    const fh = buf.readUInt16LE(p + 7);
    const ipacked = buf[p + 9]!;
    p += 10;
    let lct: Buffer | null = null;
    if (ipacked & 0x80) {
      const n = 2 << (ipacked & 7);
      lct = buf.subarray(p, p + n * 3);
      p += n * 3;
    }
    const minCode = buf[p]!;
    p += 1;
    const compressed: number[] = [];
    while (p < buf.length && buf[p] !== 0) {
      const n = buf[p]!;
      for (let i = 0; i < n; i++) compressed.push(buf[p + 1 + i]!);
      p += 1 + n;
    }
    p += 1;
    const ct = lct ?? gct;
    if (!ct) continue;
    const index = lzwDecode(compressed, minCode, fw * fh);
    const data = new Uint8Array(fw * fh * 4);
    for (let i = 0; i < fw * fh; i++) {
      const idx = index[i] ?? 0;
      const o = idx * 3;
      const di = i * 4;
      data[di] = ct[o] ?? 0;
      data[di + 1] = ct[o + 1] ?? 0;
      data[di + 2] = ct[o + 2] ?? 0;
      data[di + 3] = transIndex !== null && idx === transIndex ? 0 : 255;
    }
    frames.push({ width: fw || width, height: fh || height, data });
    transIndex = null;
  }
  return frames;
}

export function isGif(buf: Buffer): boolean {
  return buf.length >= 6 && buf.toString("ascii", 0, 3) === "GIF" && (buf[4] === 0x37 || buf[4] === 0x39);
}

/** Encode independent indexed frames as a GIF89a. Palette is RGB triplets (2..256 colors). */
export function encodeGif(
  frames: { width: number; height: number; index: Uint8Array; delayCs?: number }[],
  palette: Buffer,
): Buffer {
  if (!frames.length) throw new Error("GIF needs a frame");
  const colors = Math.max(2, Math.min(256, Math.floor(palette.length / 3)));
  const gctBits = Math.max(0, Math.ceil(Math.log2(colors)) - 1);
  const gctCount = 2 << gctBits;
  const gct = Buffer.alloc(gctCount * 3, 0);
  palette.subarray(0, Math.min(palette.length, gct.length)).copy(gct);
  const w = frames[0]!.width;
  const h = frames[0]!.height;
  const header = Buffer.alloc(13);
  header.write("GIF89a", 0);
  header.writeUInt16LE(w, 6);
  header.writeUInt16LE(h, 8);
  header[10] = 0x80 | (gctBits << 4) | gctBits;
  header[11] = 0;
  header[12] = 0;
  const chunks: Buffer[] = [header, gct];
  const minCode = Math.max(2, gctBits + 1);
  for (const fr of frames) {
    const gce = Buffer.from([0x21, 0xf9, 0x04, 0x04, 0, 0, 0, 0x00]);
    gce.writeUInt16LE(fr.delayCs ?? 10, 4);
    const desc = Buffer.alloc(10);
    desc[0] = 0x2c;
    desc.writeUInt16LE(fr.width, 5);
    desc.writeUInt16LE(fr.height, 7);
    const lzw = lzwEncode(fr.index, minCode);
    chunks.push(gce, desc, Buffer.from([minCode]), gifBlocks(lzw));
  }
  chunks.push(Buffer.from([0x3b]));
  return Buffer.concat(chunks);
}

function gifBlocks(data: Buffer): Buffer {
  const out: Buffer[] = [];
  for (let i = 0; i < data.length; i += 255) {
    const sl = data.subarray(i, Math.min(i + 255, data.length));
    out.push(Buffer.from([sl.length]), sl);
  }
  out.push(Buffer.from([0]));
  return Buffer.concat(out);
}

function lzwEncode(index: Uint8Array, minCodeSize: number): Buffer {
  // Uncompressed-but-legal LZW: emit each index, keep code-size in lockstep
  // with the decoder, and clear before the 12-bit table fills.
  const clear = 1 << minCodeSize;
  const eoi = clear + 1;
  const bytes: number[] = [];
  let acc = 0;
  let nbits = 0;
  const write = (code: number, size: number) => {
    acc |= code << nbits;
    nbits += size;
    while (nbits >= 8) {
      bytes.push(acc & 0xff);
      acc >>= 8;
      nbits -= 8;
    }
  };
  let codeSize = minCodeSize + 1;
  let codeMask = (1 << codeSize) - 1;
  let available = eoi + 1;
  let first = true;
  write(clear, codeSize);
  for (const px of index) {
    write(px & (clear - 1), codeSize);
    if (!first) {
      if (available < 4096) {
        available += 1;
        if ((available & codeMask) === 0 && available < 4096) {
          codeSize += 1;
          codeMask = (1 << codeSize) - 1;
        }
      }
      if (available >= 4096) {
        write(clear, codeSize);
        codeSize = minCodeSize + 1;
        codeMask = (1 << codeSize) - 1;
        available = eoi + 1;
        first = true;
        continue;
      }
    }
    first = false;
  }
  write(eoi, codeSize);
  if (nbits > 0) bytes.push(acc & 0xff);
  return Buffer.from(bytes);
}

function lzwDecode(bytes: number[], minCodeSize: number, expected: number): Uint8Array {
  const clear = 1 << minCodeSize;
  const eoi = clear + 1;
  const out = new Uint8Array(expected);
  const prefix = new Int32Array(4096);
  const suffix = new Uint8Array(4096);
  const stack = new Uint8Array(4096);
  let oi = 0;
  let dataSize = minCodeSize;
  let codeSize = dataSize + 1;
  let codeMask = (1 << codeSize) - 1;
  let available = eoi + 1;
  let oldCode = -1;
  let first = 0;
  let datum = 0;
  let bits = 0;
  let bi = 0;
  for (let i = 0; i < clear; i++) suffix[i] = i;
  while (oi < expected) {
    if (bits < codeSize) {
      if (bi >= bytes.length) break;
      datum += bytes[bi]! << bits;
      bits += 8;
      bi += 1;
      continue;
    }
    let code = datum & codeMask;
    datum >>= codeSize;
    bits -= codeSize;
    if (code === clear) {
      codeSize = dataSize + 1;
      codeMask = (1 << codeSize) - 1;
      available = eoi + 1;
      oldCode = -1;
      continue;
    }
    if (code === eoi) break;
    if (oldCode === -1) {
      out[oi++] = suffix[code]!;
      oldCode = code;
      first = code;
      continue;
    }
    const inCode = code;
    let top = 0;
    if (code >= available) {
      stack[top++] = first;
      code = oldCode;
    }
    while (code >= clear) {
      stack[top++] = suffix[code]!;
      code = prefix[code]!;
    }
    first = suffix[code]!;
    stack[top++] = first;
    while (top > 0) {
      if (oi < expected) out[oi++] = stack[--top]!;
    }
    if (available < 4096) {
      prefix[available] = oldCode;
      suffix[available] = first;
      available += 1;
      if ((available & codeMask) === 0 && available < 4096) {
        codeSize += 1;
        codeMask = (1 << codeSize) - 1;
      }
    }
    oldCode = inCode;
  }
  return out;
}
