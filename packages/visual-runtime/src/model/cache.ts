import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { VISUAL_RUNTIME_VERSION, type ParsedVisionReply } from "./parse.js";

export function visionCacheKey(input: { fileSha256: string; question: string; modelId: string }): string {
  return createHash("sha256")
    .update(`${input.fileSha256}\n${input.question}\n${input.modelId}\n${VISUAL_RUNTIME_VERSION}`)
    .digest("hex");
}

export interface VisionCache {
  get(key: string): ParsedVisionReply | null;
  set(key: string, value: ParsedVisionReply): void;
}

export class MemoryVisionCache implements VisionCache {
  private map = new Map<string, ParsedVisionReply>();
  get(key: string): ParsedVisionReply | null {
    return this.map.get(key) ?? null;
  }
  set(key: string, value: ParsedVisionReply): void {
    this.map.set(key, value);
  }
}

export class FileVisionCache implements VisionCache {
  constructor(private dir: string) {
    mkdirSync(dir, { recursive: true });
  }
  get(key: string): ParsedVisionReply | null {
    const path = join(this.dir, `${key}.json`);
    if (!existsSync(path)) return null;
    try {
      return JSON.parse(readFileSync(path, "utf8")) as ParsedVisionReply;
    } catch {
      return null;
    }
  }
  set(key: string, value: ParsedVisionReply): void {
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(join(this.dir, `${key}.json`), JSON.stringify(value), "utf8");
  }
}
