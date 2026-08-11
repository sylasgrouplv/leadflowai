// Production server for LeadFlow AI. Serves the built SPA (dist/client) and
// mounts the Hono API (/api) on port 3000 — the team's single public surface.
// Run `bun run build` first; restart with `bun run publish`.
//
// Starting a new instance supersedes the old one: it frees the port no matter
// which user owns the current server, so publish never collides with an
// already-running server (passwordless sudo makes the takeover work across
// user boundaries).
import { createApp } from "./src/server/index.ts";
import { startSchedulers } from "./src/server/jobs/scheduler.ts";

// Pinned, NOT read from the environment (see the original scaffold's note):
// the published preview URL is reverse-proxied to 0.0.0.0:3000, so the app
// MUST bind there.
const PORT = 3000;
const HOST = "0.0.0.0";
const CLIENT_DIR = `${import.meta.dir}/dist/client`;

const app = createApp();
startSchedulers();

const freePort =
  `for _ in $(seq 1 25); do ` +
  `pids=$(lsof -t -iTCP:${String(PORT)} -sTCP:LISTEN 2>/dev/null || true); ` +
  `if [ -z "$pids" ]; then exit 0; fi; ` +
  `kill $pids 2>/dev/null || true; sleep 0.2; ` +
  `done`;

const indexHtml = () => Bun.file(`${CLIENT_DIR}/index.html`);

for (let attempt = 1; ; attempt++) {
  await Bun.$`sudo sh -c ${freePort}`.quiet().nothrow();
  try {
    Bun.serve({
      port: PORT,
      hostname: HOST,
      async fetch(req) {
        const url = new URL(req.url);

        // API — Hono handles /api/*, including 404s and errors.
        if (url.pathname.startsWith("/api")) {
          return app.fetch(req, url);
        }

        // The embeddable widget script: stable, cacheable, correct JS type.
        // Host sites fetch it cross-origin, so it must be servable standalone
        // (never HTML-wrapped) with an explicit Cache-Control.
        if (url.pathname === "/widget.js") {
          const widget = Bun.file(CLIENT_DIR + "/widget.js");
          if (await widget.exists()) {
            return new Response(widget, {
              headers: {
                "content-type": "text/javascript; charset=utf-8",
                "cache-control": "public, max-age=300, stale-while-revalidate=3600",
                "access-control-allow-origin": "*",
              },
            });
          }
          return new Response("LeadFlow widget not found — run `bun run build` first", { status: 404 });
        }

        // Static assets first, then SPA fallback (client-side routing).
        if (url.pathname !== "/") {
          const file = Bun.file(CLIENT_DIR + url.pathname);
          if (await file.exists()) return new Response(file);
        }
        const index = indexHtml();
        if (await index.exists()) {
          return new Response(index, { headers: { "content-type": "text/html; charset=utf-8" } });
        }
        return new Response("LeadFlow AI — build the client first (bun run build)", { status: 503 });
      },
    });
    break;
  } catch (err) {
    if (attempt >= 10) throw err;
    await Bun.sleep(200);
  }
}
console.log(`LeadFlow AI serving on http://${HOST}:${String(PORT)}`);
