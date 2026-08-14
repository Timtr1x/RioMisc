// Idempotent DDL migration on node:sqlite.
// Run via: npm run migrate -w packages/database -- --db <path>
import { dirname, resolve } from "node:path";
import { mkdirSync } from "node:fs";

import { MIGRATION_DDL as DDL } from "./ddl.js";
import { applySchemaMigrations } from "./schema-migrations.js";
import { RioDb } from "./db.js";

const args = process.argv.slice(2);
const dbArg = args.indexOf("--db");
const dbPath = resolve(dbArg >= 0 ? args[dbArg + 1]! : "./data/database/rio.sqlite");

mkdirSync(dirname(dbPath), { recursive: true });
const db = new RioDb(dbPath);
db.sqlite.exec(DDL);
applySchemaMigrations(db);
db.close();
console.log(`[migrate] OK ${dbPath}`);
