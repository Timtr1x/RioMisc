// Token bucket rate limiter, one bucket per operation type.
// SUBMIT gets the highest priority — downloads must never block a flag submit.

export type OpType = "SUBMIT" | "HINT" | "POLL" | "DOWNLOAD" | "DETAIL";

interface Bucket {
  tokens: number;
  capacity: number;
  refillPerMs: number;
  lastRefill: number;
}

export class ApiRateLimiter {
  private buckets = new Map<OpType, Bucket>();

  constructor(opts: Partial<Record<OpType, { capacity?: number; perSecond?: number }>> = {}) {
    const defaults: Record<OpType, { capacity: number; perSecond: number }> = {
      SUBMIT: { capacity: 2, perSecond: 1 / 15 }, // ~1 per 15s burst of 2
      HINT: { capacity: 4, perSecond: 1 / 5 },
      DETAIL: { capacity: 10, perSecond: 2 },
      POLL: { capacity: 8, perSecond: 1 / 2.5 },
      DOWNLOAD: { capacity: 3, perSecond: 1 / 3 },
    };
    for (const op of Object.keys(defaults) as OpType[]) {
      const cfg = { ...defaults[op], ...(opts[op] ?? {}) };
      this.buckets.set(op, {
        tokens: cfg.capacity,
        capacity: cfg.capacity,
        refillPerMs: cfg.perSecond / 1000,
        lastRefill: Date.now(),
      });
    }
  }

  /**
   * Acquire a token for an op. Waits until the bucket has ≥1 token.
   * Waiting is done in small slices so tokens keep refilling — concurrent
   * waiters cannot starve each other or drive the bucket negative.
   */
  async acquire(op: OpType): Promise<number> {
    const startedAt = Date.now();
    for (;;) {
      this.#refillAll();
      const mine = this.buckets.get(op)!;
      if (mine.tokens >= 1) {
        mine.tokens -= 1;
        return Date.now() - startedAt;
      }
      // sleep in slices; refill happens on the next loop iteration
      const waitMs = Math.min((1 - mine.tokens) / mine.refillPerMs, 250);
      await sleep(Math.max(waitMs, 10) + 5);
    }
  }

  #refillAll(): void {
    const now = Date.now();
    for (const b of this.buckets.values()) {
      const elapsed = now - b.lastRefill;
      if (elapsed > 0) {
        b.tokens = Math.min(b.capacity, b.tokens + elapsed * b.refillPerMs);
        b.lastRefill = now;
      }
    }
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
