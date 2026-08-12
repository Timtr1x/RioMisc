// Idempotent DDL migration on node:sqlite.
// Run via: npm run migrate -w packages/database -- --db <path>
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { MIGRATION_DDL as DDL } from "./ddl.js";


const args = process.argv.slice(2);
const dbArg = args.indexOf("--db");
const dbPath = resolve(dbArg >= 0 ? args[dbArg + 1]! : "./data/database/rio.sqlite");

mkdirSync(dirname(dbPath), { recursive: true });
const db = new DatabaseSync(dbPath);
db.exec(DDL);
db.close();
console.log(`[migrate] OK ${dbPath}`);
