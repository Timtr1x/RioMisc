import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { downscale, encodePng } from "../decode.js";
import type { RgbaImage } from "../types.js";

function extractChannel(image: RgbaImage, channel: 0 | 1 | 2 | 3): RgbaImage {
  const data = new Uint8Array(image.data.length);
  for (let i = 0; i < image.width * image.height; i++) {
    const v = image.data[i * 4 + channel] ?? 0;
    data[i * 4] = v;
    data[i * 4 + 1] = v;
    data[i * 4 + 2] = v;
    data[i * 4 + 3] = 255;
  }
  return { width: image.width, height: image.height, data };
}

function tile(images: RgbaImage[], cols: number): RgbaImage {
  const cellW = Math.max(...images.map((i) => i.width));
  const cellH = Math.max(...images.map((i) => i.height));
  const rows = Math.ceil(images.length / cols);
  const width = cellW * cols;
  const height = cellH * rows;
  const data = new Uint8Array(width * height * 4);
  data.fill(16);
  images.forEach((img, idx) => {
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
        data[di + 3] = img.data[si + 3]!;
      }
    }
  });
  return { width, height, data };
}

export function renderChannelsContactSheet(image: RgbaImage, destAbs: string): { path: string; stats: ReturnType<typeof channelSummary>[] } {
  const src = downscale(image, 320);
  const tiles = [src, extractChannel(src, 0), extractChannel(src, 1), extractChannel(src, 2), extractChannel(src, 3)];
  const sheet = tile(tiles, 5);
  mkdirSync(dirname(destAbs), { recursive: true });
  writeFileSync(destAbs, encodePng(sheet));
  return {
    path: destAbs,
    stats: [
      channelSummary(image, 0, "R"),
      channelSummary(image, 1, "G"),
      channelSummary(image, 2, "B"),
      channelSummary(image, 3, "A"),
    ],
  };
}

function channelSummary(image: RgbaImage, channel: 0 | 1 | 2 | 3, name: string) {
  let min = 255;
  let max = 0;
  let sum = 0;
  const n = image.width * image.height;
  const hist = new Array<number>(256).fill(0);
  for (let i = 0; i < n; i++) {
    const v = image.data[i * 4 + channel] ?? 0;
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
    hist[v] = (hist[v] ?? 0) + 1;
  }
  const mean = n ? sum / n : 0;
  let acc = 0;
  let entropy = 0;
  for (let i = 0; i < n; i++) {
    const v = image.data[i * 4 + channel] ?? 0;
    acc += (v - mean) * (v - mean);
  }
  for (const c of hist) {
    if (!c) continue;
    const p = c / n;
    entropy -= p * Math.log2(p);
  }
  return { name, min, max, mean, variance: n ? acc / n : 0, entropy, contrast: max - min };
}
