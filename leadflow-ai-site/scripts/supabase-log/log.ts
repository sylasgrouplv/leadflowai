#!/usr/bin/env bun
/**
 * log.ts — append one team activity entry to the Supabase `activity-logs`
 * storage bucket under a date-named folder:
 *
 *   activity-logs/2026-08-11/HHMMSS-mmm-<type>-<slug>.json
 *
 * Usage:
 *   bun run scripts/supabase-log/log.ts --type <activity-type> \
 *       --summary "<short text>" \
 *       [--detail '<json>' | --detail-file <path>] [--actor <name>]
 *
 * Env (owner provides; build/tool must work without them):
 *   SUPABASE_URL              — project URL (Project Settings → API)
 *   SUPABASE_SERVICE_ROLE_KEY — service_role key (admin; keep out of the repo)
 *   SUPABASE_BUCKET           — optional bucket override (default: activity-logs)
 *
 * Fallback: when SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is missing/empty,
 * the entry is written to /home/team/shared/activity-logs-local/<YYYY-MM-DD>/
 * and the tool exits 0 — it never crashes on missing config.
 *
 * One file per entry: no read-modify-write appends, so concurrent runs cannot
 * race. Ops tool only — no changes to src/ or the deployed app.
 */
import { buildEntry, ensureBucket, parseMaybeJson, readConfig, slugify, timeStamp, uploadObject, writeFileLocal, LOCAL_ROOT } from "./common";

const USAGE = `usage: bun run scripts/supabase-log/log.ts --type <type> --summary "<text>"
       [--detail '<json>' | --detail-file <path>] [--actor <name>]`;

function fail(msg: string): never {
  console.error(`ERROR: ${msg}`);
  console.error(USAGE);
  process.exit(1);
}

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") {
      console.log(USAGE);
      process.exit(0);
    }
    if (!a.startsWith("--")) continue;
    const key = a.slice(2).replace(/-/g, "_"); // --detail-file -> detail_file
    const val = argv[i + 1];
    if (val === undefined || val.startsWith("--")) {
      out[key] = "";
    } else {
      out[key] = val;
      i++;
    }
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const type = (args.type || "").trim();
  const summary = (args.summary || "").trim();
  if (!type) fail("--type is required");
  if (!summary) fail("--summary is required");
  if (args.detail !== undefined && args.detail_file !== undefined) {
    fail("provide either --detail or --detail-file, not both");
  }

  let detail: unknown = null;
  if (args.detail !== undefined) {
    detail = parseMaybeJson(args.detail);
  } else if (args.detail_file !== undefined) {
    const file = args.detail_file.trim();
    const text = await Bun.file(file).text().catch(() => "");
    if (!text) fail(`--detail-file "${file}" could not be read (or is empty)`);
    detail = parseMaybeJson(text);
  }

  const entry = buildEntry(type, summary, detail, args.actor || "");
  const json = JSON.stringify(entry, null, 2);

  const { config, missing } = readConfig();
  if (!config) {
    // Graceful degradation: no Supabase config → local fallback, exit 0.
    const file = `${LOCAL_ROOT}/${entry.date}/${timeStamp(new Date())}-${slugify(type)}.json`;
    await writeFileLocal(file, json);
    console.warn(
      `WARNING: Supabase not configured (missing: ${missing.join(", ")}); ` +
        `entry written locally to ${file} — no upload happened.`
    );
    process.exit(0);
  }

  try {
    await ensureBucket(config);
    const path = `activity-logs/${entry.date}/${timeStamp(new Date())}-${slugify(type)}.json`;
    await uploadObject(config, path, json);
    console.log(`logged [${type}] ${summary} -> ${config.bucket}/${path}`);
  } catch (err) {
    console.error(`ERROR: activity entry was NOT logged: ${(err as Error).message}`);
    console.error("(Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY, or unset them to use the local fallback.)");
    process.exit(1);
  }
}

main();
