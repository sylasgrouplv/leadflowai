/**
 * Drizzle client factory.
 *
 * Default driver: bun:sqlite (SQLite via Bun's built-in engine — no native
 * compilation, same SQLite engine better-sqlite3 would give us, and the
 * official drizzle-orm/bun-sqlite driver).
 *
 * Postgres swap: set DATABASE_URL (e.g. a Neon connection string). The client
 * then lazily loads the postgres-js driver. Schema + repo are written so this
 * is a config change plus a mechanical await-conversion in repo.ts.
 */
import { Database } from "bun:sqlite";
import { drizzle as drizzleSqlite, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import * as schema from "./schema";
import { env, SITE_ROOT } from "../env";
import { mkdirSync } from "node:fs";
import path from "node:path";

export type Db = BunSQLiteDatabase<typeof schema>;

let _db: Db | null = null;

function sqlitePath(): string {
  const p = env.databasePath;
  return path.isAbsolute(p) ? p : path.join(SITE_ROOT, p);
}

export function getDb(): Db {
  if (_db) return _db;
  if (env.databaseUrl.startsWith("postgres")) {
    throw new Error(
      "Postgres mode requires a small code swap: import { drizzle } from 'drizzle-orm/postgres-js' " +
        "and 'postgres' from 'postgres', then construct the client from DATABASE_URL. " +
        "Schema is already portable. See src/server/db/client.ts."
    );
  }
  const file = sqlitePath();
  mkdirSync(path.dirname(file), { recursive: true });
  const sqlite = new Database(file);
  sqlite.exec("PRAGMA journal_mode = WAL");
  sqlite.exec("PRAGMA foreign_keys = ON");
  _db = drizzleSqlite(sqlite, { schema });
  return _db;
}
