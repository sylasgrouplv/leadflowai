/**
 * CAMPAIGN PROSPECT IMPORT script (dogfooding Phase 1a — Chunk B vehicle).
 *
 * Imports a campaign CSV into a tenant through the SAME shared logic the API
 * route uses (src/server/import/prospects.ts) — no HTTP, no auth; target DB
 * is chosen by the environment exactly like the other ops scripts:
 *
 *   Local SQLite:  unset DATABASE_URL && bun run scripts/import-prospects.ts --file <csv> --business <id>
 *   Production:    DATABASE_URL=postgresql://… bun run scripts/import-prospects.ts --file <csv> --business <id>
 *
 * Business id defaults to the dogfood tenant when --business is omitted.
 * Prints a per-row summary (created / skipped + reason) and exits non-zero if
 * any row failed to create. Re-running the same file is a no-op (duplicates
 * are skipped by phone/email).
 */
import { readFileSync } from "node:fs";
import { importProspectCsv, PROSPECT_IMPORT_SOURCE } from "../src/server/import/prospects";
import { runMigrations } from "../src/server/db/migrate";

export const DOGFOOD_BUSINESS_ID = "1ff4a8f3-3e3b-4d9e-a326-d1d7ce8de70a";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

if (import.meta.main) {
  const file = arg("file");
  const businessId = arg("business") ?? DOGFOOD_BUSINESS_ID;
  if (!file) {
    console.error("usage: bun run scripts/import-prospects.ts --file <campaign.csv> [--business <id>]");
    process.exit(2);
  }
  await runMigrations();
  const csvText = readFileSync(file, "utf8");
  console.log(`[import-prospects] ${file} -> business ${businessId} (${csvText.trim().split("\n").length - 1} data rows)`);
  const result = await importProspectCsv(businessId, csvText);
  for (const r of result.rows) {
    if (r.status === "created") console.log(`  created  row ${r.row}  ${r.name ?? ""} (${r.leadId})`);
    else console.log(`  skipped  row ${r.row}  ${r.name ?? ""}  reason=${r.reason}`);
  }
  console.log(`[import-prospects] done: total=${result.total} created=${result.created} skipped=${result.skipped} source=${PROSPECT_IMPORT_SOURCE}`);
  if (result.created === 0 && result.total === 0) {
    console.error("[import-prospects] no rows processed (empty CSV?)");
    process.exit(1);
  }
  process.exit(0);
}
