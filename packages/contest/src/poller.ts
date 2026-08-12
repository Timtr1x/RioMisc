// Poller — adaptive polling with backoff.
// Default 5s; on no change grows 5→5→8→8→12→15; max 15s; resets on change.
// On 429: honor Retry-After, else exponential backoff 2/4/8/16/30s.
import type { RioLogger } from "@rio/shared";

export interface PollerOptions {
  initialMs: number;
  maxMs: number;
  backoffFactor: number;
  cooldownAfterChangeMs: number;
  logger: RioLogger;
}

const NO_CHANGE_SEQUENCE = [5000, 5000, 8000, 8000, 12000, 15000, 15000];
const BACKOFF_429 = [2000, 4000, 8000, 16000, 30000];

export class Poller {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private currentMs: number;
  private noChangeStreak = 0;
  private backoff429Idx = 0;
  private opts: PollerOptions;

  constructor(opts: PollerOptions) {
    this.opts = opts;
    this.currentMs = opts.initialMs;
  }

  /** onPoll returns true when the world changed (interval resets), false otherwise. */
  start(onPoll: () => Promise<{ changed: boolean }>): void {
    if (this.running) return;
    this.running = true;
    void this.#loop(onPoll);
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  async #loop(onPoll: () => Promise<{ changed: boolean }>) {
    while (this.running) {
      try {
        const { changed } = await onPoll();
        this.backoff429Idx = 0;
        if (changed) {
          this.noChangeStreak = 0;
          this.currentMs = this.opts.initialMs;
        } else {
          this.noChangeStreak += 1;
          const seqIdx = Math.min(this.noChangeStreak - 1, NO_CHANGE_SEQUENCE.length - 1);
          this.currentMs = Math.min(NO_CHANGE_SEQUENCE[seqIdx]!, this.opts.maxMs);
        }
      } catch (e) {
        const status = (e as { statusCode?: number }).statusCode;
        if (status === 429) {
          this.backoff429Idx = Math.min(this.backoff429Idx + 1, BACKOFF_429.length - 1);
          this.currentMs = BACKOFF_429[this.backoff429Idx]!;
          this.opts.logger.warn({ event: "poll_rate_limited" }, "poll 429, backing off");
        } else {
          this.currentMs = Math.min(this.currentMs * this.opts.backoffFactor, this.opts.maxMs);
          this.opts.logger.warn({ err: (e as Error).message, event: "poll_error" }, "poll failed, backing off");
        }
      }
      if (!this.running) return;
      await new Promise((r) => {
        this.timer = setTimeout(r, this.currentMs);
      });
    }
  }
}
