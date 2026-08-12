import type { DomainEvent } from "@rio/domain";
import { RioDb } from "../db.js";

const COLUMNS = "id, type, challenge_id AS challengeId, payload_json AS payloadJson, created_at AS createdAt, processed_at AS processedAt";

export class EventLog {
  constructor(private db: RioDb) {}

  append(type: string, challengeId: string | null, payload: unknown): DomainEvent {
    const ev: DomainEvent = {
      id: `evt_${Math.random().toString(36).slice(2, 14)}`,
      type,
      challengeId,
      payloadJson: JSON.stringify(payload ?? {}),
      createdAt: Date.now(),
      processedAt: null,
    };
    this.db.run(
      "INSERT INTO domain_events (id, type, challenge_id, payload_json, created_at) VALUES (?, ?, ?, ?, ?)",
      ev.id,
      ev.type,
      ev.challengeId,
      ev.payloadJson,
      ev.createdAt,
    );
    return ev;
  }

  appendMany(events: { type: string; challengeId: string | null; payload: unknown }[]): DomainEvent[] {
    const now = Date.now();
    const out: DomainEvent[] = [];
    const stmt = this.db.sqlite.prepare(
      "INSERT INTO domain_events (id, type, challenge_id, payload_json, created_at) VALUES (?, ?, ?, ?, ?)",
    );
    this.db.tx(() => {
      for (const e of events) {
        const ev: DomainEvent = {
          id: `evt_${Math.random().toString(36).slice(2, 14)}`,
          type: e.type,
          challengeId: e.challengeId,
          payloadJson: JSON.stringify(e.payload ?? {}),
          createdAt: now,
          processedAt: null,
        };
        stmt.run(ev.id, ev.type, ev.challengeId, ev.payloadJson, ev.createdAt);
        out.push(ev);
      }
    });
    return out;
  }

  nextUnprocessed(limit = 100): DomainEvent[] {
    return this.db.all<DomainEvent>(
      `SELECT ${COLUMNS} FROM domain_events WHERE processed_at IS NULL ORDER BY created_at ASC LIMIT ?`,
      limit,
    );
  }

  markProcessed(id: string): void {
    this.db.run("UPDATE domain_events SET processed_at = ? WHERE id = ?", Date.now(), id);
  }

  recent(challengeId: string | null, limit = 50): DomainEvent[] {
    if (challengeId) {
      return this.db.all<DomainEvent>(
        `SELECT ${COLUMNS} FROM domain_events WHERE challenge_id = ? ORDER BY created_at DESC LIMIT ?`,
        challengeId,
        limit,
      );
    }
    return this.db.all<DomainEvent>(`SELECT ${COLUMNS} FROM domain_events ORDER BY created_at DESC LIMIT ?`, limit);
  }
}
