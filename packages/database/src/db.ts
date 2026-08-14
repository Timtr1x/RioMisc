// SQLite access via Node's built-in node:sqlite (DatabaseSync).
// Zero native dependencies — reliable on Windows without a C++ toolchain.
//
// NOTE: the original spec suggested better-sqlite3 + Drizzle ORM; both were
// dropped because better-sqlite3 needs node-gyp (no Visual Studio toolchain
// on this host). All DB access stays behind the Repository pattern, so the
// storage library can be swapped later without touching business code.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export class RioDb {
  readonly sqlite: DatabaseSync;
  private closed = false;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.sqlite = new DatabaseSync(dbPath);
    this.sqlite.exec("PRAGMA journal_mode = WAL;");
    this.sqlite.exec("PRAGMA foreign_keys = ON;");
    this.sqlite.exec("PRAGMA busy_timeout = 5000;");
  }

  get isOpen(): boolean {
    return !this.closed;
  }

  run(sql: string, ...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint } {
    return this.sqlite.prepare(sql).run(...(params as never[]));
  }

  get<T>(sql: string, ...params: unknown[]): T | undefined {
    return this.sqlite.prepare(sql).get(...(params as never[])) as T | undefined;
  }

  all<T>(sql: string, ...params: unknown[]): T[] {
    return this.sqlite.prepare(sql).all(...(params as never[])) as T[];
  }

  tx<T>(fn: () => T): T {
    this.sqlite.exec("BEGIN");
    try {
      const result = fn();
      this.sqlite.exec("COMMIT");
      return result;
    } catch (e) {
      this.sqlite.exec("ROLLBACK");
      throw e;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.sqlite.close();
  }
}

/** Build `SET k = ?, ...` clause + values from a camelCase patch + column map. */
export function buildSet(
  patch: Record<string, unknown>,
  columnMap: Record<string, string>,
): { clause: string; values: unknown[] } {
  const parts: string[] = [];
  const values: unknown[] = [];
  for (const [key, value] of Object.entries(patch)) {
    const col = columnMap[key];
    if (!col) continue;
    parts.push(`${col} = ?`);
    values.push(value ?? null);
  }
  return { clause: parts.join(", "), values };
}

export type { RioDb as RioDatabase };
