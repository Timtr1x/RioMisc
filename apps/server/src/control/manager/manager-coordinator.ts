import type { ManagerTrigger } from "@rio/domain";
import type { RioLogger } from "@rio/shared";
import type { EventBus } from "../bus.js";
import type { Repositories } from "@rio/database";
import { isPlanFresh } from "./manager-policy.js";
import { ManagerService, type ManagerReplanResult } from "./manager-service.js";
import type { AppliedDispatchPlan } from "./manager-types.js";

export class ManagerCoordinator {
  private dirty = false;
  private running = false;
  private runPromise: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private periodic: ReturnType<typeof setInterval> | null = null;
  private pending = new Set<ManagerTrigger>();
  inFlight = 0;
  lastResult: ManagerReplanResult | null = null;

  constructor(
    private deps: {
      service: ManagerService;
      repos: Repositories;
      bus: EventBus;
      logger: RioLogger;
      debounceMs: number;
      replanIntervalMs: number;
      planTtlMs: number;
    },
  ) {}

  get service(): ManagerService {
    return this.deps.service;
  }

  livePlanFresh(now = Date.now()): boolean {
    const id = this.deps.service.lastAppliedPlanId;
    if (!id) return false;
    const plan = this.deps.repos.managerPlans.get(id);
    return isPlanFresh(plan, now, this.deps.planTtlMs);
  }

  applied(): AppliedDispatchPlan | null {
    return this.livePlanFresh() ? this.deps.service.lastApplied : null;
  }

  requestReplan(trigger: ManagerTrigger): void {
    this.pending.add(trigger);
    this.dirty = true;
    this.deps.repos.events.append("MANAGER_REPLAN_REQUESTED", null, { trigger });
    this.deps.bus.publish({ type: "MANAGER_REPLAN_REQUESTED", challengeId: null, payload: { trigger } });
    if (!this.deps.service.enabled() && trigger !== "MANUAL") return;
    if (trigger === "MANUAL" || trigger === "STARTUP") {
      if (this.timer) {
        clearTimeout(this.timer);
        this.timer = null;
      }
      void this.runIfNeeded();
      return;
    }
    if (this.timer || this.running) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.runIfNeeded();
    }, this.deps.debounceMs);
  }

  async runIfNeeded(): Promise<void> {
    if (this.runPromise) {
      this.dirty = true;
      await this.runPromise;
      if (this.dirty) return this.runIfNeeded();
      return;
    }
    if (!this.dirty) return;
    if (!this.deps.service.enabled() && !this.pending.has("MANUAL")) {
      this.dirty = false;
      this.pending.clear();
      return;
    }
    this.running = true;
    this.inFlight = 1;
    this.dirty = false;
    const triggers = [...this.pending] as ManagerTrigger[];
    this.pending.clear();
    this.runPromise = (async () => {
      try {
        this.lastResult = await this.deps.service.replan(triggers.length ? triggers : ["PERIODIC"]);
      } catch (e) {
        this.deps.logger.error({ event: "manager_replan_error", err: String(e) });
        this.deps.service.emit("MANAGER_FALLBACK_ACTIVATED", null, { error: String(e) });
        this.deps.service.lastFallback = true;
        this.deps.service.lastAppliedPlanId = null;
        this.deps.service.fallbackCount += 1;
      } finally {
        this.running = false;
        this.inFlight = 0;
        this.runPromise = null;
      }
    })();
    await this.runPromise;
    if (this.dirty) return this.runIfNeeded();
  }

  startPeriodic(): void {
    if (this.periodic) return;
    this.periodic = setInterval(() => this.requestReplan("PERIODIC"), this.deps.replanIntervalMs);
    this.periodic.unref?.();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    if (this.periodic) clearInterval(this.periodic);
    this.timer = null;
    this.periodic = null;
  }
}
