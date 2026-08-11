/**
 * Migration runner. Applies pending SQL migrations from ./drizzle at boot.
 * Migrations are generated with `bun run db:generate` (drizzle-kit).
 */
import { getDb } from "./client";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import path from "node:path";
import { SITE_ROOT } from "../env";

const MIGRATIONS_FOLDER = path.join(SITE_ROOT, "drizzle");

let _done = false;

export function runMigrations(): void {
  if (_done) return;
  getDb(); // ensure client exists (creates DB file)
  migrate(getDb(), { migrationsFolder: MIGRATIONS_FOLDER });
  _done = true;
}

// Allow running directly: `bun run src/server/db/migrate.ts`
if (import.meta.main) {
  runMigrations();
  console.log(`[migrate] applied migrations from ${MIGRATIONS_FOLDER}`);
}
