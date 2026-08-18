import type {
  CryptoAttackAttempt,
  CryptoAttackCandidate,
  CryptoPrimitive,
  CryptoStateRecord,
  CryptoValue,
} from "@rio/domain";
import { RioDb } from "../db.js";

export interface CryptoStatePatch {
  primitive?: CryptoPrimitive;
  knownVariables?: Record<string, CryptoValue>;
  unknownVariables?: string[];
  equations?: { expr: string; satisfied?: boolean }[];
  constraints?: string[];
  assumptions?: string[];
  attackCandidates?: CryptoAttackCandidate[];
  replaceCandidates?: boolean;
  attempt?: Omit<CryptoAttackAttempt, "id" | "at"> & { id?: string; at?: number };
}

function empty(challengeId: string, now = Date.now()): CryptoStateRecord {
  return {
    challengeId,
    primitive: "UNKNOWN",
    knownVariablesJson: "{}",
    unknownVariablesJson: "[]",
    equationsJson: "[]",
    constraintsJson: "[]",
    assumptionsJson: "[]",
    attackCandidatesJson: "[]",
    attemptsJson: "[]",
    createdAt: now,
    updatedAt: now,
  };
}

function parseJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export class CryptoStateRepository {
  constructor(private db: RioDb) {}

  get(challengeId: string): CryptoStateRecord | null {
    return this.db.get<CryptoStateRecord>(
      `SELECT challenge_id AS challengeId, primitive,
              known_variables_json AS knownVariablesJson,
              unknown_variables_json AS unknownVariablesJson,
              equations_json AS equationsJson,
              constraints_json AS constraintsJson,
              assumptions_json AS assumptionsJson,
              attack_candidates_json AS attackCandidatesJson,
              attempts_json AS attemptsJson,
              created_at AS createdAt, updated_at AS updatedAt
         FROM crypto_states WHERE challenge_id = ?`,
      challengeId,
    ) ?? null;
  }

  ensure(challengeId: string): CryptoStateRecord {
    const existing = this.get(challengeId);
    if (existing) return existing;
    const rec = empty(challengeId);
    this.db.run(
      `INSERT INTO crypto_states (
         challenge_id, primitive, known_variables_json, unknown_variables_json,
         equations_json, constraints_json, assumptions_json, attack_candidates_json,
         attempts_json, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      rec.challengeId, rec.primitive, rec.knownVariablesJson, rec.unknownVariablesJson,
      rec.equationsJson, rec.constraintsJson, rec.assumptionsJson, rec.attackCandidatesJson,
      rec.attemptsJson, rec.createdAt, rec.updatedAt,
    );
    return rec;
  }

  upsert(challengeId: string, patch: CryptoStatePatch): CryptoStateRecord {
    const cur = this.ensure(challengeId);
    const now = Date.now();
    const known = {
      ...parseJson<Record<string, CryptoValue>>(cur.knownVariablesJson, {}),
      ...(patch.knownVariables ?? {}),
    };
    const unknown = patch.unknownVariables
      ? [...new Set(patch.unknownVariables)]
      : parseJson<string[]>(cur.unknownVariablesJson, []);
    const equations = patch.equations ?? parseJson(cur.equationsJson, []);
    const constraints = patch.constraints
      ? [...new Set([...parseJson<string[]>(cur.constraintsJson, []), ...patch.constraints])]
      : parseJson(cur.constraintsJson, []);
    const assumptions = patch.assumptions
      ? [...new Set([...parseJson<string[]>(cur.assumptionsJson, []), ...patch.assumptions])]
      : parseJson(cur.assumptionsJson, []);

    let candidates = parseJson<CryptoAttackCandidate[]>(cur.attackCandidatesJson, []);
    if (patch.replaceCandidates && patch.attackCandidates) {
      candidates = patch.attackCandidates;
    } else if (patch.attackCandidates?.length) {
      const byId = new Map(candidates.map((c) => [c.id, c]));
      for (const c of patch.attackCandidates) {
        byId.set(c.id, { ...byId.get(c.id), ...c });
      }
      candidates = [...byId.values()];
    }

    const attempts = parseJson<CryptoAttackAttempt[]>(cur.attemptsJson, []);
    if (patch.attempt) {
      attempts.push({
        id: patch.attempt.id ?? `att_${Math.random().toString(36).slice(2, 10)}`,
        attack: patch.attempt.attack,
        tool: patch.attempt.tool,
        outcome: patch.attempt.outcome,
        summary: patch.attempt.summary,
        at: patch.attempt.at ?? now,
      });
      if (attempts.length > 64) attempts.splice(0, attempts.length - 64);
    }

    const next: CryptoStateRecord = {
      challengeId,
      primitive: patch.primitive ?? cur.primitive,
      knownVariablesJson: JSON.stringify(known),
      unknownVariablesJson: JSON.stringify(unknown),
      equationsJson: JSON.stringify(equations),
      constraintsJson: JSON.stringify(constraints),
      assumptionsJson: JSON.stringify(assumptions),
      attackCandidatesJson: JSON.stringify(candidates),
      attemptsJson: JSON.stringify(attempts),
      createdAt: cur.createdAt,
      updatedAt: now,
    };
    this.db.run(
      `UPDATE crypto_states SET
         primitive = ?, known_variables_json = ?, unknown_variables_json = ?,
         equations_json = ?, constraints_json = ?, assumptions_json = ?,
         attack_candidates_json = ?, attempts_json = ?, updated_at = ?
       WHERE challenge_id = ?`,
      next.primitive, next.knownVariablesJson, next.unknownVariablesJson,
      next.equationsJson, next.constraintsJson, next.assumptionsJson,
      next.attackCandidatesJson, next.attemptsJson, next.updatedAt, challengeId,
    );
    return next;
  }
}
