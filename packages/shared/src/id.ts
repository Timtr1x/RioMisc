import { createHash, randomUUID } from "node:crypto";

/** Short, URL-safe id: `r_` + 12 hex chars. */
export function shortId(prefix = "r"): string {
  return `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
}

export function hashHex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export const nowMs = () => Date.now();
