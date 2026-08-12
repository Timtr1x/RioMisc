// Counting semaphore per resource type (§38). Acquiring a job takes one unit
// of each required resource type; release returns them.
import type { ResourceType } from "@rio/domain";

export type Release = () => void;

export class ResourceSemaphore {
  private available: Map<ResourceType, number>;
  private queue: { types: ResourceType[]; resolve: (release: Release) => void }[] = [];

  constructor(limits: Partial<Record<ResourceType, number>> = {}) {
    this.available = new Map();
    for (const t of ["LLM", "CPU_LIGHT", "CPU_HEAVY", "MEM_HEAVY", "DISK_HEAVY", "NETWORK", "SAGE"] as ResourceType[]) {
      this.available.set(t, limits[t] ?? 1);
    }
  }

  current(t: ResourceType): number {
    return this.available.get(t) ?? 0;
  }

  canAcquire(types: ResourceType[]): boolean {
    return types.every((t) => (this.available.get(t) ?? 0) >= 1);
  }

  /** Non-blocking try. Returns release or null. */
  tryAcquire(types: ResourceType[]): Release | null {
    if (!this.canAcquire(types)) return null;
    for (const t of types) this.available.set(t, this.available.get(t)! - 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      for (const t of types) this.available.set(t, this.available.get(t)! + 1);
      // wake waiters
      this.#pump();
    };
  }

  async acquire(types: ResourceType[]): Promise<Release> {
    const immediate = this.tryAcquire(types);
    if (immediate) return immediate;
    return new Promise((resolve) => {
      this.queue.push({ types, resolve });
      // prevent starvation of already-waiting jobs by head-of-line fairness:
      this.#pump();
    });
  }

  /** True if there are waiters that can now proceed. */
  #pump(): void {
    for (let i = 0; i < this.queue.length; i++) {
      const job = this.queue[i]!;
      const release = this.tryAcquire(job.types);
      if (release) {
        this.queue.splice(i, 1);
        i--;
        job.resolve(release);
      }
    }
  }

  get waiterCount(): number {
    return this.queue.length;
  }
}
