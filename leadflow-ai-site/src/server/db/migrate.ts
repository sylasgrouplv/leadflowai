/**
 * Migration runner — dual dialect.
 *  - Postgres (DATABASE_URL set): applies the embedded PG migrations in order
 *    (see pg-migrations.generated.ts — generated from drizzle/pg/*.sql so the
 *    runner works on serverless runtimes where the repo folder isn't bundled),
 *    tracked in the drizzle_migrations ledger table.
 *  - SQLite (no DATABASE_URL): drizzle's bun-sqlite migrator over drizzle/.
 *  Both are idempotent and safe to run at every boot.
 */
import { getDb, getPgClient, isPgMode } from "./client";
import { PG_MIGRATIONS } from "./pg-migrations.generated";
import path from "node:path";
import { SITE_ROOT } from "../env";

const SQLITE_FOLDER = path.join(SITE_ROOT, "drizzle");
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
    for (const name of Object.keys(PG_MIGRATIONS).sort()) {
      if (applied.has(name)) continue;
      await pg.unsafe(PG_MIGRATIONS[name]);
      await pg`INSERT INTO drizzle_migrations (name) VALUES (${name}) ON CONFLICT (name) DO NOTHING`;
      console.log(`[migrate] applied ${name}`);
    }
    _done = true;
    return;
  }
  getDb(); // ensure client exists (creates DB file)
  // Bun-only migrator, loaded lazily like the sqlite driver (see db/client.ts).
  const { migrate: migrateSqlite } = import.meta.require(
    "drizzle-orm" + "/bun-sqlite/migrator"
  ) as typeof import("drizzle-orm/bun-sqlite/migrator");
  migrateSqlite(getDb(), { migrationsFolder: SQLITE_FOLDER });
  _done = true;
}

if (import.meta.main) {
  await runMigrations();
  console.log("[migrate] done");
}
