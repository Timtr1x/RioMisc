import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { downscale, encodePng } from "../decode.js";
import type { RgbaImage } from "../types.js";

function plane(image: RgbaImage, channel: 0 | 1 | 2 | 3, bit: number): RgbaImage {
  const data = new Uint8Array(image.data.length);
  const mask = 1 << bit;
  for (let i = 0; i < image.width * image.height; i++) {
    const on = ((image.data[i * 4 + channel] ?? 0) & mask) !== 0;
    const v = on ? 255 : 0;
    data[i * 4] = v;
    data[i * 4 + 1] = v;
    data[i * 4 + 2] = v;
    data[i * 4 + 3] = 255;
  }
  return { width: image.width, height: image.height, data };
}

export function renderBitplanesContactSheet(image: RgbaImage, destAbs: string): string {
  const src = downscale(image, 160);
  const tiles: RgbaImage[] = [];
  for (const ch of [0, 1, 2, 3] as const) {
    for (let bit = 0; bit < 8; bit++) tiles.push(plane(src, ch, bit));
  }
  const cols = 8;
  const cellW = src.width;
  const cellH = src.height;
  const width = cellW * cols;
  const height = cellH * 4;
  const data = new Uint8Array(width * height * 4);
  tiles.forEach((img, idx) => {
    const col = idx % cols;
    const row = Math.floor(idx / cols);
    const ox = col * cellW;
    const oy = row * cellH;
    for (let y = 0; y < img.height; y++) {
      for (let x = 0; x < img.width; x++) {
        const si = (y * img.width + x) * 4;
        const di = ((oy + y) * width + (ox + x)) * 4;
        data[di] = img.data[si]!;
        data[di + 1] = img.data[si + 1]!;
        data[di + 2] = img.data[si + 2]!;
        data[di + 3] = 255;
      }
    }
  });
  mkdirSync(dirname(destAbs), { recursive: true });
  writeFileSync(destAbs, encodePng({ width, height, data }));
  return destAbs;
}

export function extractBitplane(image: RgbaImage, channel: 0 | 1 | 2 | 3, bit: number): RgbaImage {
  return plane(image, channel, bit);
}
