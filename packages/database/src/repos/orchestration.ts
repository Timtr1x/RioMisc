import type {
  ChallengeOrchestration,
  DispatchAction,
  ManagerDecisionRecord,
  ManagerPlanRecord,
  ManagerPlanStatus,
  ReflectionMode,
  ReflectionRunRecord,
  ReflectionRunStatus,
} from "@rio/domain";
import { RioDb, buildSet } from "../db.js";

const ORCH_COLUMNS = `
  challenge_id AS challengeId,
  strategy_locked AS strategyLocked,
  manual_dispatch AS manualDispatch,
  reflection_override AS reflectionOverride,
  reflection_mode_override AS reflectionModeOverride,
  manager_action AS managerAction,
  manager_priority AS managerPriority,
  manager_reflection_enabled AS managerReflectionEnabled,
  manager_reason AS managerReason,
  manager_plan_id AS managerPlanId,
  manager_updated_at AS managerUpdatedAt,
  updated_at AS updatedAt
`;

function mapOrch(r: Record<string, unknown>): ChallengeOrchestration {
  return {
    challengeId: r.challengeId as string,
    strategyLocked: Boolean(r.strategyLocked),
    manualDispatch: (r.manualDispatch as ChallengeOrchestration["manualDispatch"]) ?? "AUTO",
    reflectionOverride: (r.reflectionOverride as ChallengeOrchestration["reflectionOverride"]) ?? "INHERIT",
    reflectionModeOverride: (r.reflectionModeOverride as ReflectionMode | null) ?? null,
    managerAction: (r.managerAction as DispatchAction | null) ?? null,
    managerPriority: (r.managerPriority as number | null) ?? null,
    managerReflectionEnabled:
      r.managerReflectionEnabled === null || r.managerReflectionEnabled === undefined
        ? null
        : Boolean(r.managerReflectionEnabled),
    managerReason: (r.managerReason as string | null) ?? null,
    managerPlanId: (r.managerPlanId as string | null) ?? null,
    managerUpdatedAt: (r.managerUpdatedAt as number | null) ?? null,
    updatedAt: r.updatedAt as number,
  };
}

const ORCH_UPDATE: Record<string, string> = {
  strategyLocked: "strategy_locked",
  manualDispatch: "manual_dispatch",
  reflectionOverride: "reflection_override",
  reflectionModeOverride: "reflection_mode_override",
  managerAction: "manager_action",
  managerPriority: "manager_priority",
  managerReflectionEnabled: "manager_reflection_enabled",
  managerReason: "manager_reason",
  managerPlanId: "manager_plan_id",
  managerUpdatedAt: "manager_updated_at",
};

export function defaultOrchestration(challengeId: string, now = Date.now()): ChallengeOrchestration {
  return {
    challengeId,
    strategyLocked: false,
    manualDispatch: "AUTO",
    reflectionOverride: "INHERIT",
    reflectionModeOverride: null,
    managerAction: null,
    managerPriority: null,
    managerReflectionEnabled: null,
    managerReason: null,
    managerPlanId: null,
    managerUpdatedAt: null,
    updatedAt: now,
  };
}

export class OrchestrationRepository {
  constructor(private db: RioDb) {}

  get(challengeId: string): ChallengeOrchestration | null {
    const r = this.db.get<Record<string, unknown>>(
      `SELECT ${ORCH_COLUMNS} FROM challenge_orchestration WHERE challenge_id = ?`,
      challengeId,
    );
    return r ? mapOrch(r) : null;
  }

  getOrCreate(challengeId: string): ChallengeOrchestration {
    const existing = this.get(challengeId);
    if (existing) return existing;
    const rec = defaultOrchestration(challengeId);
    this.db.run(
      `INSERT OR IGNORE INTO challenge_orchestration (
        challenge_id, strategy_locked, manual_dispatch, reflection_override, reflection_mode_override,
        manager_action, manager_priority, manager_reflection_enabled, manager_reason, manager_plan_id,
        manager_updated_at, updated_at
      ) VALUES (?, 0, 'AUTO', 'INHERIT', NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?)`,
      rec.challengeId,
      rec.updatedAt,
    );
    return this.get(challengeId) ?? rec;
  }

  list(): ChallengeOrchestration[] {
    return this.db.all<Record<string, unknown>>(`SELECT ${ORCH_COLUMNS} FROM challenge_orchestration`).map(mapOrch);
  }

  update(challengeId: string, patch: Partial<ChallengeOrchestration>): ChallengeOrchestration {
    this.getOrCreate(challengeId);
    const data: Record<string, unknown> = { ...patch };
    if ("strategyLocked" in data) data.strategyLocked = data.strategyLocked ? 1 : 0;
    if ("managerReflectionEnabled" in data && data.managerReflectionEnabled !== null && data.managerReflectionEnabled !== undefined) {
      data.managerReflectionEnabled = data.managerReflectionEnabled ? 1 : 0;
    }
    const { clause, values } = buildSet(data, ORCH_UPDATE);
    if (clause) {
      this.db.run(`UPDATE challenge_orchestration SET ${clause}, updated_at = ? WHERE challenge_id = ?`, ...values, Date.now(), challengeId);
    }
    return this.get(challengeId)!;
  }
}

const PLAN_COLUMNS = `
  id, status, provider_id AS providerId, model_id AS modelId, trigger,
  snapshot_hash AS snapshotHash, summary, error, created_at AS createdAt,
  started_at AS startedAt, completed_at AS completedAt,
  input_tokens AS inputTokens, output_tokens AS outputTokens, duration_ms AS durationMs
`;

export class ManagerPlanRepository {
  constructor(private db: RioDb) {}

  create(input: {
    id?: string;
    status?: ManagerPlanStatus;
    providerId?: string | null;
    modelId?: string | null;
    trigger: string;
    snapshotHash?: string | null;
    summary?: string | null;
    error?: string | null;
  }): ManagerPlanRecord {
    const rec: ManagerPlanRecord = {
      id: input.id ?? `mp_${Math.random().toString(36).slice(2, 14)}`,
      status: input.status ?? "PENDING",
      providerId: input.providerId ?? null,
      modelId: input.modelId ?? null,
      trigger: input.trigger,
      snapshotHash: input.snapshotHash ?? null,
      summary: input.summary ?? null,
      error: input.error ?? null,
      createdAt: Date.now(),
      startedAt: null,
      completedAt: null,
      inputTokens: 0,
      outputTokens: 0,
      durationMs: 0,
    };
    this.db.run(
      `INSERT INTO manager_plans (id, status, provider_id, model_id, trigger, snapshot_hash, summary, error, created_at, started_at, completed_at, input_tokens, output_tokens, duration_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 0, 0, 0)`,
      rec.id, rec.status, rec.providerId, rec.modelId, rec.trigger, rec.snapshotHash, rec.summary, rec.error, rec.createdAt,
    );
    return rec;
  }

  get(id: string): ManagerPlanRecord | null {
    return this.db.get<ManagerPlanRecord>(`SELECT ${PLAN_COLUMNS} FROM manager_plans WHERE id = ?`, id) ?? null;
  }

  latest(): ManagerPlanRecord | null {
    return this.db.get<ManagerPlanRecord>(`SELECT ${PLAN_COLUMNS} FROM manager_plans ORDER BY created_at DESC LIMIT 1`) ?? null;
  }

  list(limit = 30): ManagerPlanRecord[] {
    return this.db.all<ManagerPlanRecord>(`SELECT ${PLAN_COLUMNS} FROM manager_plans ORDER BY created_at DESC LIMIT ?`, limit);
  }

  update(
    id: string,
    patch: Partial<Pick<ManagerPlanRecord, "status" | "providerId" | "modelId" | "summary" | "error" | "startedAt" | "completedAt" | "inputTokens" | "outputTokens" | "durationMs" | "snapshotHash">>,
  ): void {
    const map: Record<string, string> = {
      status: "status",
      providerId: "provider_id",
      modelId: "model_id",
      summary: "summary",
      error: "error",
      startedAt: "started_at",
      completedAt: "completed_at",
      inputTokens: "input_tokens",
      outputTokens: "output_tokens",
      durationMs: "duration_ms",
      snapshotHash: "snapshot_hash",
    };
    const { clause, values } = buildSet(patch as Record<string, unknown>, map);
    if (!clause) return;
    this.db.run(`UPDATE manager_plans SET ${clause} WHERE id = ?`, ...values, id);
  }

  failRunning(error: string): number {
    const rows = this.db.all<{ id: string }>(`SELECT id FROM manager_plans WHERE status IN ('PENDING','RUNNING')`);
    for (const r of rows) {
      this.update(r.id, { status: "FAILED", error, completedAt: Date.now() });
    }
    return rows.length;
  }
}

const DEC_COLUMNS = `
  id, plan_id AS planId, challenge_id AS challengeId, action, priority,
  reflection_enabled AS reflectionEnabled, reason, status,
  rejection_reason AS rejectionReason, created_at AS createdAt
`;

function mapDecision(r: Record<string, unknown>): ManagerDecisionRecord {
  return {
    id: r.id as string,
    planId: r.planId as string,
    challengeId: r.challengeId as string,
    action: r.action as ManagerDecisionRecord["action"],
    priority: r.priority as number,
    reflectionEnabled: r.reflectionEnabled === null || r.reflectionEnabled === undefined ? null : Boolean(r.reflectionEnabled),
    reason: String(r.reason ?? ""),
    status: r.status as ManagerDecisionRecord["status"],
    rejectionReason: (r.rejectionReason as string | null) ?? null,
    createdAt: r.createdAt as number,
  };
}

export class ManagerDecisionRepository {
  constructor(private db: RioDb) {}

  create(d: Omit<ManagerDecisionRecord, "id" | "createdAt"> & { id?: string }): ManagerDecisionRecord {
    const rec: ManagerDecisionRecord = {
      ...d,
      id: d.id ?? `md_${Math.random().toString(36).slice(2, 14)}`,
      createdAt: Date.now(),
    };
    this.db.run(
      `INSERT INTO manager_decisions (id, plan_id, challenge_id, action, priority, reflection_enabled, reason, status, rejection_reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      rec.id,
      rec.planId,
      rec.challengeId,
      rec.action,
      rec.priority,
      rec.reflectionEnabled === null ? null : rec.reflectionEnabled ? 1 : 0,
      rec.reason,
      rec.status,
      rec.rejectionReason,
      rec.createdAt,
    );
    return rec;
  }

  listByPlan(planId: string): ManagerDecisionRecord[] {
    return this.db.all<Record<string, unknown>>(`SELECT ${DEC_COLUMNS} FROM manager_decisions WHERE plan_id = ? ORDER BY priority DESC`, planId).map(mapDecision);
  }
}

const RUN_COLUMNS = `
  id, challenge_id AS challengeId, trigger, mode, provider_id AS providerId, model_id AS modelId,
  fingerprint, status, snapshot_json AS snapshotJson, result_json AS resultJson, error,
  created_at AS createdAt, started_at AS startedAt, completed_at AS completedAt, delivered_at AS deliveredAt,
  input_tokens AS inputTokens, output_tokens AS outputTokens, duration_ms AS durationMs
`;

export class ReflectionRunRepository {
  constructor(private db: RioDb) {}

  create(input: Omit<ReflectionRunRecord, "id" | "createdAt" | "startedAt" | "completedAt" | "deliveredAt" | "inputTokens" | "outputTokens" | "durationMs" | "resultJson" | "error" | "providerId" | "modelId"> & {
    id?: string;
    providerId?: string | null;
    modelId?: string | null;
    resultJson?: string | null;
    error?: string | null;
  }): ReflectionRunRecord {
    const rec: ReflectionRunRecord = {
      id: input.id ?? `rr_${Math.random().toString(36).slice(2, 14)}`,
      challengeId: input.challengeId,
      trigger: input.trigger,
      mode: input.mode,
      providerId: input.providerId ?? null,
      modelId: input.modelId ?? null,
      fingerprint: input.fingerprint,
      status: input.status,
      snapshotJson: input.snapshotJson,
      resultJson: input.resultJson ?? null,
      error: input.error ?? null,
      createdAt: Date.now(),
      startedAt: null,
      completedAt: null,
      deliveredAt: null,
      inputTokens: 0,
      outputTokens: 0,
      durationMs: 0,
    };
    this.db.run(
      `INSERT INTO reflection_runs (id, challenge_id, trigger, mode, provider_id, model_id, fingerprint, status, snapshot_json, result_json, error, created_at, started_at, completed_at, delivered_at, input_tokens, output_tokens, duration_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, 0, 0, 0)`,
      rec.id, rec.challengeId, rec.trigger, rec.mode, rec.providerId, rec.modelId, rec.fingerprint, rec.status, rec.snapshotJson, rec.resultJson, rec.error, rec.createdAt,
    );
    return rec;
  }

  get(id: string): ReflectionRunRecord | null {
    return this.db.get<ReflectionRunRecord>(`SELECT ${RUN_COLUMNS} FROM reflection_runs WHERE id = ?`, id) ?? null;
  }

  listByChallenge(challengeId: string, limit = 40): ReflectionRunRecord[] {
    return this.db.all<ReflectionRunRecord>(
      `SELECT ${RUN_COLUMNS} FROM reflection_runs WHERE challenge_id = ? ORDER BY created_at DESC LIMIT ?`,
      challengeId,
      limit,
    );
  }

  latestForChallenge(challengeId: string): ReflectionRunRecord | null {
    return (
      this.db.get<ReflectionRunRecord>(
        `SELECT ${RUN_COLUMNS} FROM reflection_runs WHERE challenge_id = ? ORDER BY created_at DESC LIMIT 1`,
        challengeId,
      ) ?? null
    );
  }

  latestCompletedUndelivered(challengeId: string): ReflectionRunRecord | null {
    return (
      this.db.get<ReflectionRunRecord>(
        `SELECT ${RUN_COLUMNS} FROM reflection_runs
          WHERE challenge_id = ? AND delivered_at IS NULL AND status IN ('COMPLETED','FALLBACK')
          ORDER BY created_at DESC LIMIT 1`,
        challengeId,
      ) ?? null
    );
  }

  findByFingerprint(challengeId: string, fingerprint: string): ReflectionRunRecord | null {
    return (
      this.db.get<ReflectionRunRecord>(
        `SELECT ${RUN_COLUMNS} FROM reflection_runs
          WHERE challenge_id = ? AND fingerprint = ? AND status IN ('COMPLETED','FALLBACK','RUNNING','PENDING')
          ORDER BY created_at DESC LIMIT 1`,
        challengeId,
        fingerprint,
      ) ?? null
    );
  }

  update(
    id: string,
    patch: Partial<Pick<ReflectionRunRecord, "status" | "providerId" | "modelId" | "resultJson" | "error" | "startedAt" | "completedAt" | "deliveredAt" | "inputTokens" | "outputTokens" | "durationMs">>,
  ): void {
    const map: Record<string, string> = {
      status: "status",
      providerId: "provider_id",
      modelId: "model_id",
      resultJson: "result_json",
      error: "error",
      startedAt: "started_at",
      completedAt: "completed_at",
      deliveredAt: "delivered_at",
      inputTokens: "input_tokens",
      outputTokens: "output_tokens",
      durationMs: "duration_ms",
    };
    const { clause, values } = buildSet(patch as Record<string, unknown>, map);
    if (!clause) return;
    this.db.run(`UPDATE reflection_runs SET ${clause} WHERE id = ?`, ...values, id);
  }

  failRunning(error: string): number {
    const rows = this.db.all<{ id: string }>(`SELECT id FROM reflection_runs WHERE status IN ('PENDING','RUNNING')`);
    for (const r of rows) {
      this.update(r.id, { status: "FAILED", error, completedAt: Date.now() });
    }
    return rows.length;
  }

  countByStatus(status: ReflectionRunStatus): number {
    return this.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM reflection_runs WHERE status = ?`, status)?.n ?? 0;
  }
}
