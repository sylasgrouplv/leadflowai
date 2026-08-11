/**
 * Generates src/server/db/pg-migrations.generated.ts from drizzle/pg/*.sql.
 *
 * Why: on serverless (Vercel) the function bundle doesn't contain the repo's
 * drizzle/pg folder (and nft can't trace readdirSync/readFileSync), so the
 * PG migration runner reads SQL from an embedded module instead of the disk.
 * Re-run after adding/editing a .sql migration:
 *
 *   bun run scripts/gen-pg-migrations.ts
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(new URL("..", import.meta.url).pathname); // site root
const pgDir = path.join(root, "drizzle", "pg");
const out = path.join(root, "src", "server", "db", "pg-migrations.generated.ts");

const files = readdirSync(pgDir).filter((f) => f.endsWith(".sql")).sort();
if (files.length === 0) {
  console.error(`no .sql files found in ${pgDir}`);
  process.exit(1);
}
const entries = files
  .map((f) => `  ${JSON.stringify(f)}: ${JSON.stringify(readFileSync(path.join(pgDir, f), "utf8"))},`)
  .join("\n");

writeFileSync(
  out,
  [
    "// GENERATED FILE — do not edit by hand. Regenerate with: bun run scripts/gen-pg-migrations.ts",
    "// Embeds the Postgres SQL migrations so they run on serverless runtimes",
    "// (Vercel) where the drizzle/pg folder is not part of the function bundle.",
    "export const PG_MIGRATIONS: Record<string, string> = {",
    entries,
    "};",
    "",
  ].join("\n")
);
console.log(`wrote ${out} (${files.length} migration(s): ${files.join(", ")})`);
