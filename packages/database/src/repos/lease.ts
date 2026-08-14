import type { WorkerLease, ModelProviderConfig, ModelConfig } from "@rio/domain";
import { RioDb, buildSet } from "../db.js";

// ---------------------------------------------------------------------------
// Worker leases
// ---------------------------------------------------------------------------

const LEASE_COLUMNS =
  "id, challenge_id AS challengeId, worker_id AS workerId, acquired_at AS acquiredAt, heartbeat_at AS heartbeatAt, expires_at AS expiresAt";

export class LeaseRepository {
  constructor(private db: RioDb) {}

  acquire(lease: Omit<WorkerLease, "id">): WorkerLease {
    this.release(lease.challengeId);
    const rec: WorkerLease = { ...lease, id: `ls_${Math.random().toString(36).slice(2, 14)}` };
    this.db.run(
      "INSERT INTO worker_leases (id, challenge_id, worker_id, acquired_at, heartbeat_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
      rec.id,
      rec.challengeId,
      rec.workerId,
      rec.acquiredAt,
      rec.heartbeatAt,
      rec.expiresAt,
    );
    return rec;
  }

  list(): WorkerLease[] {
    return this.db.all<WorkerLease>(`SELECT ${LEASE_COLUMNS} FROM worker_leases`);
  }

  getByChallenge(challengeId: string): WorkerLease | null {
    return (
      this.db.get<WorkerLease>(
        `SELECT ${LEASE_COLUMNS} FROM worker_leases WHERE challenge_id = ? LIMIT 1`,
        challengeId,
      ) ?? null
    );
  }

  heartbeat(challengeId: string, expiresAt: number): void {
    this.db.run(
      "UPDATE worker_leases SET heartbeat_at = ?, expires_at = ? WHERE challenge_id = ?",
      Date.now(),
      expiresAt,
      challengeId,
    );
  }

  release(challengeId: string): void {
    this.db.run("DELETE FROM worker_leases WHERE challenge_id = ?", challengeId);
  }

  /** All expired leases (candidates for recovery). */
  expired(before: number): WorkerLease[] {
    return this.db.all<WorkerLease>(`SELECT ${LEASE_COLUMNS} FROM worker_leases WHERE expires_at < ?`, before);
  }
}

// ---------------------------------------------------------------------------
// Model providers
// ---------------------------------------------------------------------------

const PROV_COLUMNS =
  "id, display_name AS displayName, protocol, base_url AS baseUrl, api_key_ref AS apiKeyRef, enabled, health, consecutive_failures AS consecutiveFailures, last_tested_at AS lastTestedAt, created_at AS createdAt";

function mapProvider(r: Record<string, unknown>): ModelProviderConfig {
  return {
    id: r.id as string,
    displayName: r.displayName as string,
    protocol: r.protocol as ModelProviderConfig["protocol"],
    baseUrl: r.baseUrl as string,
    apiKeyRef: r.apiKeyRef as string,
    enabled: Boolean(r.enabled),
    health: (r.health as ModelProviderConfig["health"]) ?? "UNKNOWN",
    consecutiveFailures: (r.consecutiveFailures as number) ?? 0,
    lastTestedAt: (r.lastTestedAt as number | null) ?? null,
    createdAt: r.createdAt as number,
  };
}

const PROV_UPDATE: Record<string, string> = {
  displayName: "display_name",
  protocol: "protocol",
  baseUrl: "base_url",
  apiKeyRef: "api_key_ref",
  enabled: "enabled",
  health: "health",
  consecutiveFailures: "consecutive_failures",
  lastTestedAt: "last_tested_at",
};

export class ProviderRepository {
  constructor(private db: RioDb) {}

  create(p: Omit<ModelProviderConfig, "id" | "createdAt" | "health" | "consecutiveFailures" | "lastTestedAt">): ModelProviderConfig {
    const rec: ModelProviderConfig = {
      ...p,
      id: `prov_${Math.random().toString(36).slice(2, 14)}`,
      health: "UNKNOWN",
      consecutiveFailures: 0,
      lastTestedAt: null,
      createdAt: Date.now(),
    };
    this.db.run(
      `INSERT INTO model_providers (id, display_name, protocol, base_url, api_key_ref, enabled, health, consecutive_failures, last_tested_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      rec.id,
      rec.displayName,
      rec.protocol,
      rec.baseUrl,
      rec.apiKeyRef,
      rec.enabled ? 1 : 0,
      rec.health,
      rec.consecutiveFailures,
      rec.lastTestedAt,
      rec.createdAt,
    );
    return rec;
  }

  get(id: string): ModelProviderConfig | null {
    const r = this.db.get<Record<string, unknown>>(`SELECT ${PROV_COLUMNS} FROM model_providers WHERE id = ?`, id);
    return r ? mapProvider(r) : null;
  }

  list(): ModelProviderConfig[] {
    return this.db.all<Record<string, unknown>>(`SELECT ${PROV_COLUMNS} FROM model_providers ORDER BY created_at ASC`).map(mapProvider);
  }

  update(id: string, patch: Partial<ModelProviderConfig>): void {
    const data: Record<string, unknown> = { ...patch };
    if ("enabled" in data) data.enabled = data.enabled ? 1 : 0;
    const { clause, values } = buildSet(data, PROV_UPDATE);
    if (!clause) return;
    this.db.run(`UPDATE model_providers SET ${clause} WHERE id = ?`, ...values, id);
  }

  recordFailure(id: string, consecutiveFailures: number): void {
    this.db.run(
      "UPDATE model_providers SET consecutive_failures = ?, health = CASE WHEN ? >= 5 THEN 'DOWN' WHEN ? >= 3 THEN 'DEGRADED' ELSE 'HEALTHY' END WHERE id = ?",
      consecutiveFailures,
      consecutiveFailures,
      consecutiveFailures,
      id,
    );
  }

  recordSuccess(id: string): void {
    this.db.run("UPDATE model_providers SET consecutive_failures = 0, health = 'HEALTHY' WHERE id = ?", id);
  }
}

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

const MODEL_COLUMNS =
  "id, provider_id AS providerId, model_name AS modelName, context_window AS contextWindow, max_output_tokens AS maxOutputTokens, enabled, role, created_at AS createdAt";

function mapModel(r: Record<string, unknown>): ModelConfig {
  return {
    id: r.id as string,
    providerId: r.providerId as string,
    modelName: r.modelName as string,
    contextWindow: r.contextWindow as number,
    maxOutputTokens: r.maxOutputTokens as number,
    enabled: Boolean(r.enabled),
    role: (r.role as ModelConfig["role"]) ?? "GENERAL",
    createdAt: r.createdAt as number,
  };
}

const MODEL_UPDATE: Record<string, string> = {
  providerId: "provider_id",
  modelName: "model_name",
  contextWindow: "context_window",
  maxOutputTokens: "max_output_tokens",
  enabled: "enabled",
  role: "role",
};

export class ModelRepository {
  constructor(private db: RioDb) {}

  create(m: Omit<ModelConfig, "id" | "createdAt" | "enabled" | "role"> & { enabled?: boolean; role?: ModelConfig["role"] }): ModelConfig {
    const rec: ModelConfig = {
      ...m,
      id: `model_${Math.random().toString(36).slice(2, 14)}`,
      enabled: m.enabled !== false,
      role: m.role ?? "GENERAL",
      createdAt: Date.now(),
    };
    this.db.run(
      `INSERT INTO models (id, provider_id, model_name, context_window, max_output_tokens, enabled, role, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      rec.id,
      rec.providerId,
      rec.modelName,
      rec.contextWindow,
      rec.maxOutputTokens,
      rec.enabled ? 1 : 0,
      rec.role,
      rec.createdAt,
    );
    return rec;
  }

  get(id: string): ModelConfig | null {
    const r = this.db.get<Record<string, unknown>>(`SELECT ${MODEL_COLUMNS} FROM models WHERE id = ?`, id);
    return r ? mapModel(r) : null;
  }

  list(): ModelConfig[] {
    return this.db.all<Record<string, unknown>>(`SELECT ${MODEL_COLUMNS} FROM models ORDER BY created_at ASC`).map(mapModel);
  }

  listByProvider(providerId: string): ModelConfig[] {
    return this.db
      .all<Record<string, unknown>>(`SELECT ${MODEL_COLUMNS} FROM models WHERE provider_id = ? ORDER BY created_at ASC`, providerId)
      .map(mapModel);
  }

  listEnabled(): ModelConfig[] {
    return this.db
      .all<Record<string, unknown>>(`SELECT ${MODEL_COLUMNS} FROM models WHERE enabled = 1 ORDER BY created_at ASC`)
      .map(mapModel);
  }

  primary(): ModelConfig | null {
    const r = this.db.get<Record<string, unknown>>(
      `SELECT ${MODEL_COLUMNS} FROM models WHERE enabled = 1 AND role = 'PRIMARY' LIMIT 1`,
    );
    return r ? mapModel(r) : null;
  }

  fallback(): ModelConfig | null {
    const r = this.db.get<Record<string, unknown>>(
      `SELECT ${MODEL_COLUMNS} FROM models WHERE enabled = 1 AND role = 'FALLBACK' LIMIT 1`,
    );
    return r ? mapModel(r) : null;
  }

  update(id: string, patch: Partial<ModelConfig>): void {
    const data: Record<string, unknown> = { ...patch };
    if ("enabled" in data) data.enabled = data.enabled ? 1 : 0;
    const { clause, values } = buildSet(data, MODEL_UPDATE);
    if (!clause) return;
    this.db.run(`UPDATE models SET ${clause} WHERE id = ?`, ...values, id);
  }
}

// ---------------------------------------------------------------------------
// Runtime settings (key/value)
// ---------------------------------------------------------------------------

export class SettingsRepository {
  constructor(private db: RioDb) {}

  get(key: string): string | null {
    return this.db.get<{ value: string }>("SELECT value FROM runtime_settings WHERE key = ?", key)?.value ?? null;
  }

  set(key: string, value: string): void {
    const existing = this.get(key);
    if (existing === null) {
      this.db.run("INSERT INTO runtime_settings (key, value, updated_at) VALUES (?, ?, ?)", key, value, Date.now());
    } else {
      this.db.run("UPDATE runtime_settings SET value = ?, updated_at = ? WHERE key = ?", value, Date.now(), key);
    }
  }
}
