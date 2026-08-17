import jsQR from "jsqr";
import type { QrHit, RgbaImage } from "../types.js";

export function decodeQr(image: RgbaImage): QrHit[] {
  const attempts: RgbaImage[] = [image];
  let cur = image;
  for (let i = 0; i < 3; i++) {
    cur = rotate90Local(cur);
    attempts.push(cur);
  }
  for (const img of attempts) {
    const hit = decodeOne(img);
    if (hit.length) return hit;
  }
  return [];
}

function decodeOne(image: RgbaImage): QrHit[] {
  const clamped = new Uint8ClampedArray(image.data);
  const result = jsQR(clamped, image.width, image.height, { inversionAttempts: "attemptBoth" });
  if (!result?.data) return [];
  const loc = result.location;
  const xs = [loc.topLeftCorner.x, loc.topRightCorner.x, loc.bottomLeftCorner.x, loc.bottomRightCorner.x];
  const ys = [loc.topLeftCorner.y, loc.topRightCorner.y, loc.bottomLeftCorner.y, loc.bottomRightCorner.y];
  const x = Math.max(0, Math.min(...xs));
  const y = Math.max(0, Math.min(...ys));
  return [
    {
      text: result.data,
      confidence: 0.95,
      region: {
        x: Math.round(x),
        y: Math.round(y),
        width: Math.round(Math.max(...xs) - x),
        height: Math.round(Math.max(...ys) - y),
      },
    },
  ];
}

function rotate90Local(image: RgbaImage): RgbaImage {
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
