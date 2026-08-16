import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export class VisionCallBudget {
  constructor(
    private used: number,
    private readonly max: number,
    private persist?: (used: number) => void,
  ) {}

  remaining(): number {
    return Math.max(0, this.max - this.used);
  }

  take(): void {
    if (this.used >= this.max) {
      throw new Error(`vision budget exhausted (${this.max} calls per challenge)`);
    }
    this.used += 1;
    this.persist?.(this.used);
  }
}

export function loadFileBudget(path: string, max: number): VisionCallBudget {
  let used = 0;
  if (existsSync(path)) {
    try {
      used = Number((JSON.parse(readFileSync(path, "utf8")) as { used?: number }).used ?? 0);
    } catch {
      used = 0;
    }
  }
  return new VisionCallBudget(used, max, (next) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ used: next }), "utf8");
  });
}
