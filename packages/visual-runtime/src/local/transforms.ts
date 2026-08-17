import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { encodePng } from "../decode.js";
import type { RgbaImage } from "../types.js";

export type ImageTransformOp =
  | "grayscale"
  | "invert"
  | "autocontrast"
  | "threshold"
  | "rotate90"
  | "rotate180"
  | "rotate270";

export function applyImageTransform(image: RgbaImage, op: ImageTransformOp): RgbaImage {
  switch (op) {
    case "grayscale":
      return mapPixels(image, (r, g, b, a) => {
        const y = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
        return [y, y, y, a];
      });
    case "invert":
      return mapPixels(image, (r, g, b, a) => [255 - r, 255 - g, 255 - b, a]);
    case "autocontrast":
      return autocontrast(image);
    case "threshold":
      return mapPixels(image, (r, g, b, a) => {
        const y = 0.299 * r + 0.587 * g + 0.114 * b;
        const v = y >= 128 ? 255 : 0;
        return [v, v, v, a];
      });
    case "rotate90":
      return rotate90(image);
    case "rotate180":
      return rotate90(rotate90(image));
    case "rotate270":
      return rotate90(rotate90(rotate90(image)));
  }
}

export function writeTransformedPng(image: RgbaImage, op: ImageTransformOp, destAbs: string): RgbaImage {
  const out = applyImageTransform(image, op);
  mkdirSync(dirname(destAbs), { recursive: true });
  writeFileSync(destAbs, encodePng(out));
  return out;
}

export function rotateRgba(image: RgbaImage, turns: 1 | 2 | 3): RgbaImage {
  let out = image;
  for (let i = 0; i < turns; i++) out = rotate90(out);
  return out;
}

function mapPixels(image: RgbaImage, fn: (r: number, g: number, b: number, a: number) => [number, number, number, number]): RgbaImage {
  const data = new Uint8Array(image.data.length);
  for (let i = 0; i < image.width * image.height; i++) {
    const o = i * 4;
    const [r, g, b, a] = fn(image.data[o] ?? 0, image.data[o + 1] ?? 0, image.data[o + 2] ?? 0, image.data[o + 3] ?? 255);
    data[o] = r;
    data[o + 1] = g;
    data[o + 2] = b;
    data[o + 3] = a;
  }
  return { width: image.width, height: image.height, data };
}

function autocontrast(image: RgbaImage): RgbaImage {
  let min = 255;
  let max = 0;
  for (let i = 0; i < image.width * image.height; i++) {
    const y = 0.299 * (image.data[i * 4] ?? 0) + 0.587 * (image.data[i * 4 + 1] ?? 0) + 0.114 * (image.data[i * 4 + 2] ?? 0);
    if (y < min) min = y;
    if (y > max) max = y;
  }
  const span = Math.max(1, max - min);
  return mapPixels(image, (r, g, b, a) => [
    clamp(((r - min) * 255) / span),
    clamp(((g - min) * 255) / span),
    clamp(((b - min) * 255) / span),
    a,
  ]);
}

function rotate90(image: RgbaImage): RgbaImage {
  const width = image.height;
  const height = image.width;
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      const si = (y * image.width + x) * 4;
      const nx = image.height - 1 - y;
      const ny = x;
      const di = (ny * width + nx) * 4;
      data[di] = image.data[si]!;
      data[di + 1] = image.data[si + 1]!;
      data[di + 2] = image.data[si + 2]!;
      data[di + 3] = image.data[si + 3]!;
    }
  }
  return { width, height, data };
}

function clamp(n: number): number {
  return Math.max(0, Math.min(255, Math.round(n)));
}
