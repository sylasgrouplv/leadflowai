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
 *
 * Serverless note (Vercel): `bun:sqlite` and `drizzle-orm/bun-sqlite` are
 * Bun-only and are therefore NOT imported at module top level — the module
 * scope only ever pulls in postgres-js/drizzle core (pure JS, Node-safe). The
 * sqlite driver pair is loaded lazily via import.meta.require (Bun's sync
 * require) with a computed specifier so no bundler can trace "bun:sqlite" into
 * a Node bundle; the SQLite branch is unreachable wherever DATABASE_URL is
 * set (which is always the case on Vercel).
 */
import type { Database as BunSqliteDatabase } from "bun:sqlite";
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
export function getSqliteRaw(): BunSqliteDatabase {
  const db = getDb();
  return db.$client as BunSqliteDatabase;
}

export function getDb(): Db {
  if (_db) return _db;
  if (isPgMode()) {
    _db = drizzlePg(getPgClient(), { schema: schema.activeSchema as never });
    return _db;
  }
  const file = sqlitePath();
  mkdirSync(path.dirname(file), { recursive: true });
  // Bun-only driver pair, loaded lazily with computed specifiers (see the
  // module header). Never reached on Vercel, where DATABASE_URL is always set.
  const { Database } = import.meta.require("bun" + ":" + "sqlite") as typeof import("bun:sqlite");
  const { drizzle: drizzleSqlite } = import.meta.require("drizzle-orm" + "/bun-sqlite") as typeof import("drizzle-orm/bun-sqlite");
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
