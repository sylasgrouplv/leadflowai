/**
 * Vercel serverless entry — Hono adapter (hono/vercel).
 *
 * This catch-all route file is the ONLY function on Vercel. It imports the
 * same assembled Hono app that serve.ts uses locally (src/server/index.ts →
 * createApp()) and exposes it through hono/vercel's `handle` for every HTTP
 * verb. Vercel routes /api/* here; the SPA + widget are served as static
 * files from public/ (see vercel.json for the SPA fallback rewrite).
 *
 * Boot notes (why this file is shaped this way — both were hard-won on Vercel):
 *  - The import specifier is explicit (../src/server/index.js). Vercel's node
 *    builder sometimes traces instead of bundles, and the emitted specifier is
 *    used verbatim by Node ESM at runtime — directory imports ("../src/server")
 *    and extensionless imports both throw ERR_UNSUPPORTED_DIR_IMPORT /
 *    ERR_MODULE_NOT_FOUND. ".js" resolves to the compiled index.js in trace
 *    mode and to index.ts at typecheck time.
 *  - createApp() is awaited lazily on the first request, never at module top
 *    level. A top-level await forces @vercel/node's esbuild step to fall back
 *    to unbundled tracing (it bundles to CJS, where TLA is illegal), which
 *    ships the raw compiled tree with unresolvable imports. Lazy init keeps
 *    the function a single bundled file and lets cold starts fail per-request
 *    instead of taking the whole function down at import time.
 *  - createApp() runs idempotent migrations once per warm instance (guarded
 *    by a module-level _done flag inside runMigrations()).
 */
import { handle } from "hono/vercel";
import { createApp } from "../src/server/index.js";

let appPromise: Promise<Awaited<ReturnType<typeof createApp>>> | null = null;

function getApp(): Promise<Awaited<ReturnType<typeof createApp>>> {
  if (!appPromise) appPromise = createApp();
  return appPromise;
}

async function handler(req: Request): Promise<Response> {
  const app = await getApp();
  return handle(app)(req);
}

export const GET = handler;
export const POST = handler;
export const PUT = handler;
export const PATCH = handler;
export const DELETE = handler;
export const OPTIONS = handler;
export const HEAD = handler;
