import jsQR from "jsqr";
import type { QrHit, RgbaImage } from "../types.js";

export function decodeQr(image: RgbaImage): QrHit[] {
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
