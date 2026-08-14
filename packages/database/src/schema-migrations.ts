// Versioned ALTER TABLE migrations. CREATE TABLE IF NOT EXISTS does not add
// columns to existing user databases.
import type { RioDb } from "./db.js";

export function applySchemaMigrations(db: RioDb): void {
  db.sqlite.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    )
  `);
  const applied = new Set(db.all<{ version: number }>("SELECT version FROM schema_migrations").map((r) => r.version));

  if (!applied.has(2)) {
    const cols = db.all<{ name: string }>("PRAGMA table_info(model_providers)");
    if (cols.length > 0 && !cols.some((c) => c.name === "compat_profile")) {
      db.sqlite.exec("ALTER TABLE model_providers ADD COLUMN compat_profile TEXT NOT NULL DEFAULT 'AUTO'");
    }
    db.run("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (2, ?)", Date.now());
  }
}
