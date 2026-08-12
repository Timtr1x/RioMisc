// In-process event bus + SSE fan-out (§23, §97).
import { EventEmitter } from "node:events";

export type BusEvent = { type: string; challengeId?: string | null; payload: Record<string, unknown>; createdAt: number };

export class EventBus {
  private emitter = new EventEmitter();

  publish(e: Omit<BusEvent, "createdAt">): void {
    const full: BusEvent = { ...e, createdAt: Date.now() };
    this.emitter.emit("event", full);
    if (e.challengeId) this.emitter.emit(`challenge:${e.challengeId}`, full);
  }

  /** Subscribe to all events. Returns unsubscribe. */
  subscribe(listener: (e: BusEvent) => void): () => void {
    this.emitter.on("event", listener);
    return () => this.emitter.off("event", listener);
  }

  subscribeChallenge(challengeId: string, listener: (e: BusEvent) => void): () => void {
    this.emitter.on(`challenge:${challengeId}`, listener);
    return () => this.emitter.off(`challenge:${challengeId}`, listener);
  }
}
