import { defineConfig } from "drizzle-kit";

// Generates SQL migrations for the SQLite dialect:
//   bun run db:generate   -> writes ./drizzle/<n>_*.sql
//   bun run db:migrate    -> applies them
// For a Postgres target later: set dialect "postgresql", dbCredentials with
// the connection string, and regenerate — the schema is portable.
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/server/db/schema.ts",
  out: "./drizzle",
});
