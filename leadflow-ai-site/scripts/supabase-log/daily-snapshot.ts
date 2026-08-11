#!/usr/bin/env bun
/**
 * daily-snapshot.ts — summarize the day's team activity entries.
 *
 * Reads every entry under activity-logs/<YYYY-MM-DD>/ (listing the bucket
 * folder via the Storage API, then downloading each object) and uploads a
 * derived summary:
 *
 *   activity-logs/<YYYY-MM-DD>/daily-summary.json
 *   { date, entryCount, byType: {...}, entries: [...] }
 *
 * Usage:
 *   bun run scripts/supabase-log/daily-snapshot.ts
 *
 * Env (same as log.ts):
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_BUCKET (optional)
 *
 * Fallback: when Supabase is not configured, scans the local fallback dir
 * /home/team/shared/activity-logs-local/<YYYY-MM-DD>/ instead and writes
 * daily-summary.json there. Exits 0 either way when the local path is used.
 * Ops tool only — no changes to src/ or the deployed app.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  downloadObject,
  ensureBucket,
  formatDate,
  listObjects,
  readConfig,
  uploadObject,
  writeFileLocal,
  LOCAL_ROOT,
} from "./common";

interface EntryLike {
  timestamp: string;
  type: string;
  [key: string]: unknown;
}

function isEntryLike(v: unknown): v is EntryLike {
  return typeof v === "object" && v !== null && typeof (v as EntryLike).timestamp === "string";
}

function buildSummary(date: string, entries: unknown[]): { date: string; entryCount: number; byType: Record<string, number>; entries: EntryLike[] } {
  const valid = entries.filter(isEntryLike).sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const byType: Record<string, number> = {};
  for (const e of valid) {
    const t = e.type || "unknown";
    byType[t] = (byType[t] || 0) + 1;
  }
  return { date, entryCount: valid.length, byType, entries: valid };
}

async function main(): Promise<void> {
  const today = formatDate(new Date());
  const prefix = `${today}/`;
  const { config, missing } = readConfig();

  if (!config) {
    // Graceful degradation: local fallback, exit 0.
    const dir = path.join(LOCAL_ROOT, today);
    const files = existsSync(dir)
      ? readdirSync(dir).filter((f) => f.endsWith(".json") && f !== "daily-summary.json")
      : [];
    const entries = files
      .map((f) => {
        try {
          return JSON.parse(readFileSync(path.join(dir, f), "utf8"));
        } catch {
          return null;
        }
      })
      .filter((v): v is unknown => v !== null);
    const summary = buildSummary(today, entries);
    const out = path.join(dir, "daily-summary.json");
    await writeFileLocal(out, JSON.stringify(summary, null, 2));
    console.warn(
      `WARNING: Supabase not configured (missing: ${missing.join(", ")}); ` +
        `summary written locally to ${out} — no upload happened.`
    );
    console.log(`snapshot ${today}: ${summary.entryCount} entries, ${Object.keys(summary.byType).length} type(s)`);
    process.exit(0);
  }

  try {
    await ensureBucket(config);
    const names = (await listObjects(config, prefix)).filter(
      (n) => n.endsWith(".json") && !n.endsWith("daily-summary.json")
    );
    const entries: unknown[] = [];
    for (const name of names) {
      const body = await downloadObject(config, `${today}/${name}`);
      try {
        entries.push(JSON.parse(body));
      } catch {
        console.warn(`skipping unparseable object ${name}`);
      }
    }
    const summary = buildSummary(today, entries);
    const summaryPath = `${prefix}daily-summary.json`;
    await uploadObject(config, summaryPath, JSON.stringify(summary, null, 2));
    console.log(
      `snapshot ${today}: ${summary.entryCount} entries, ${Object.keys(summary.byType).length} type(s) -> ${config.bucket}/${summaryPath}`
    );
  } catch (err) {
    console.error(`ERROR: snapshot failed: ${(err as Error).message}`);
    console.error("(Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY, or unset them to use the local fallback.)");
    process.exit(1);
  }
}

main();
