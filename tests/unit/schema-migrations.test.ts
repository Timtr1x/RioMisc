import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { RioDb } from "@rio/database";
import { applySchemaMigrations } from "../../packages/database/src/schema-migrations.ts";

describe("schema migrations", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  it("adds compat_profile to an existing model_providers table", () => {
    const dir = mkdtempSync(join(tmpdir(), "rio-mig-"));
    dirs.push(dir);
    const path = join(dir, "t.sqlite");
    const raw = new DatabaseSync(path);
    raw.exec(`CREATE TABLE model_providers (
      id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      protocol TEXT NOT NULL,
      base_url TEXT NOT NULL,
      api_key_ref TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      health TEXT NOT NULL DEFAULT 'UNKNOWN',
      consecutive_failures INTEGER NOT NULL DEFAULT 0,
      last_tested_at INTEGER,
      created_at INTEGER NOT NULL
    )`);
    raw.close();
    const db = new RioDb(path);
    applySchemaMigrations(db);
    const cols = db.all<{ name: string }>("PRAGMA table_info(model_providers)");
    expect(cols.some((c) => c.name === "compat_profile")).toBe(true);
    db.close();
  });

  it("close is idempotent — second close does not throw", () => {
    const dir = mkdtempSync(join(tmpdir(), "rio-dbclose-"));
    dirs.push(dir);
    const db = new RioDb(join(dir, "t.sqlite"));
    expect(db.isOpen).toBe(true);
    db.close();
    expect(db.isOpen).toBe(false);
    expect(() => db.close()).not.toThrow();
    expect(db.isOpen).toBe(false);
  });
});
