/**
 * Migration runner — dual dialect.
 *  - Postgres (DATABASE_URL set): applies drizzle/pg/*.sql in order via
 *    postgres.js, tracked in the drizzle_migrations ledger table.
 *  - SQLite (no DATABASE_URL): drizzle's bun-sqlite migrator over drizzle/.
 *  Both are idempotent and safe to run at every boot.
 */
import { getDb, getPgClient, isPgMode } from "./client";
import { migrate as migrateSqlite } from "drizzle-orm/bun-sqlite/migrator";
import path from "node:path";
import { readdirSync, readFileSync } from "node:fs";
import { SITE_ROOT } from "../env";

const SQLITE_FOLDER = path.join(SITE_ROOT, "drizzle");
const PG_FOLDER = path.join(SITE_ROOT, "drizzle", "pg");
let _done = false;

export async function runMigrations(): Promise<void> {
  if (_done) return;
  if (isPgMode()) {
    const pg = getPgClient();
    await pg`CREATE TABLE IF NOT EXISTS drizzle_migrations (
      id serial PRIMARY KEY,
      name text NOT NULL UNIQUE,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`;
    const rows = await pg`SELECT name FROM drizzle_migrations`;
    const applied = new Set(rows.map((r) => r.name));
    for (const f of readdirSync(PG_FOLDER).filter((f) => f.endsWith(".sql")).sort()) {
      if (applied.has(f)) continue;
      const sqlText = readFileSync(path.join(PG_FOLDER, f), "utf8");
      await pg.unsafe(sqlText);
      await pg`INSERT INTO drizzle_migrations (name) VALUES (${f}) ON CONFLICT (name) DO NOTHING`;
      console.log(`[migrate] applied ${f}`);
    }
    _done = true;
    return;
  }
  getDb(); // ensure client exists (creates DB file)
  migrateSqlite(getDb(), { migrationsFolder: SQLITE_FOLDER });
  _done = true;
}

if (import.meta.main) {
  await runMigrations();
  console.log("[migrate] done");
}
