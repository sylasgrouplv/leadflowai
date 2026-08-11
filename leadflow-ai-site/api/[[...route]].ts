/**
 * Vercel serverless entry — Hono adapter (hono/vercel).
 *
 * This catch-all route file is the ONLY function on Vercel. It imports the
 * same assembled Hono app that serve.ts uses locally (src/server/index.ts →
 * createApp()) and exposes it through hono/vercel's `handle` for every HTTP
 * verb. Vercel routes /api/* here; the SPA + widget are served as static
 * files from public/ (see vercel.json for the SPA fallback rewrite).
 *
 * createApp() runs idempotent migrations at boot (cheap on Neon — the ledger
 * is already applied), so every cold start is safe.
 */
import { handle } from "hono/vercel";
import { createApp } from "../src/server";

const app = await createApp();

export const GET = handle(app);
export const POST = handle(app);
export const PUT = handle(app);
export const PATCH = handle(app);
export const DELETE = handle(app);
export const OPTIONS = handle(app);
export const HEAD = handle(app);
