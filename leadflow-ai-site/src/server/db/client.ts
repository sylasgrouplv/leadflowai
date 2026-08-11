/**
 * Drizzle client factory — dual dialect.
 *
 *   DATABASE_URL set (postgres://…)  -> postgres-js client (Neon, production)
 *   no DATABASE_URL                  -> bun:sqlite (local dev fallback)
 *
 * The schema is dialect-switched too (see ./schema — the facade re-exports the
 * pg schema when DATABASE_URL is set), so query builders always see table
 * metadata matching the active driver. repo.ts is fully async: every drizzle
 * call is awaited, which is harmless for the sync sqlite driver and required
 * for postgres-js — one code path serves both.
 */
import { Database } from "bun:sqlite";
import { drizzle as drizzleSqlite } from "drizzle-orm/bun-sqlite";
import { drizzle as drizzlePg } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";
import { env, SITE_ROOT } from "../env";
import { mkdirSync } from "node:fs";
import path from "node:path";

/** Dual-dialect database handle. Kept `any` so one codebase compiles against
 *  both the sync sqlite and async pg query builders; repo.ts is the only
 *  module that touches the database directly. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Db = any;

let _db: Db | null = null;
let _pgClient: postgres.Sql | null = null;

/** True when running against Postgres (DATABASE_URL set). */
export function isPgMode(): boolean {
  return env.databaseUrl.startsWith("postgres");
}

function sqlitePath(): string {
  const p = env.databasePath;
  return path.isAbsolute(p) ? p : path.join(SITE_ROOT, p);
}

/** The raw postgres-js client (PG mode only). Lazily created. */
export function getPgClient(): postgres.Sql {
  if (!_pgClient) {
    _pgClient = postgres(env.databaseUrl, {
      max: 5,
      idle_timeout: 30,
      connect_timeout: 15,
    });
  }
  return _pgClient;
}

/** The raw bun:sqlite Database (SQLite mode only). Used for BEGIN/COMMIT. */
export function getSqliteRaw(): Database {
  const db = getDb();
  return db.$client as Database;
}

export function getDb(): Db {
  if (_db) return _db;
  if (isPgMode()) {
    _db = drizzlePg(getPgClient(), { schema: schema.activeSchema as never });
    return _db;
  }
  const file = sqlitePath();
  mkdirSync(path.dirname(file), { recursive: true });
  const sqlite = new Database(file);
  sqlite.exec("PRAGMA journal_mode = WAL");
  sqlite.exec("PRAGMA foreign_keys = ON");
  _db = drizzleSqlite(sqlite, { schema: schema.activeSchema as never });
  return _db;
}

/** Close pooled Postgres connections (tests / graceful shutdown). */
export async function closeDb(): Promise<void> {
  if (_pgClient) {
    await _pgClient.end({ timeout: 5 });
    _pgClient = null;
    _db = null;
  }
}
