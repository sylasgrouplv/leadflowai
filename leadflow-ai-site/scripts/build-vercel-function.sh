#!/usr/bin/env bash
#
# build-vercel-function.sh — assemble a WORKING Vercel serverless function for
# the LeadFlow AI catch-all API route, then fix the routing config.
#
# WHY THIS EXISTS (hard-won on Vercel, see api/[[...route]].ts for the full
# story): `vercel build` with @vercel/node emits an UNBUNDLED function (nft
# trace: compiled api/*.js + src/**/*.js + node_modules). Node ESM cannot run
# that tree — the entry's directory import ("../src/server") throws
# ERR_UNSUPPORTED_DIR_IMPORT and every internal extensionless import
# ("./routes/auth") throws ERR_MODULE_NOT_FOUND, so every /api/* call 500s
# with FUNCTION_INVOCATION_FAILED. The reliable fix: bundle the whole server
# tree into ONE self-contained ESM file with esbuild (externals resolved from
# the traced node_modules), point the runtime at it, and drop the traced tree.
#
# It also reinstalls the known-good routes config.json: `vercel build` emits a
# broken one (SPA rewrite BEFORE the /api catch-all + a "/api(/.*)? -> 404"
# rule that blocks deep /api paths).
#
# Usage:  scripts/build-vercel-function.sh [SITE_DIR] [BUILD_DIR]
#   SITE_DIR  source of truth (default /home/team/shared/site)
#   BUILD_DIR vercel build workspace (default /tmp/lfbuild)
#
set -euo pipefail

SITE="${1:-/home/team/shared/site}"
BUILD="${2:-/tmp/lfbuild}"
ENTRY="$SITE/api/[[...route]].ts"
FUNC="$BUILD/.vercel/output/functions/api/[[...route]].func"

[ -f "$ENTRY" ] || { echo "entry not found: $ENTRY" >&2; exit 1; }
[ -d "$FUNC" ]  || { echo "func dir not found (run \`vercel build\` first): $FUNC" >&2; exit 1; }

# 1. Bundle the entry + the whole server tree into a single ESM file.
"$SITE/node_modules/.bin/esbuild" "$ENTRY" \
  --bundle \
  --platform=node \
  --format=esm \
  --target=node24 \
  --packages=external \
  --outfile="$FUNC/index.js"

# 2. Point the runtime at the bundle.
node -e '
const fs = require("fs");
const p = process.argv[1];
const cfg = JSON.parse(fs.readFileSync(p, "utf8"));
cfg.handler = "index.js";
fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + "\n");
console.log("vc-config handler -> index.js");
' "$FUNC/.vc-config.json"

# 3. Drop the stale traced tree — the bundle replaces it (node_modules stays
#    for the external packages: hono, drizzle-orm, postgres, zod).
rm -rf "$FUNC/api" "$FUNC/src"

# 4. Install the known-good route config: /api catch-all FIRST, then SPA
#    rewrite, 404 for non-api, plus the automation cron.
node -e '
const fs = require("fs");
const p = process.argv[1];
const cfg = JSON.parse(fs.readFileSync(p, "utf8"));
cfg.routes = [
  { "handle": "filesystem" },
  { "src": "^/api(?:/(.*))?$", "dest": "/api/[[...route]]?[...route]=$1", "check": true },
  { "src": "^(?:/((?!api/).*))$", "dest": "/index.html", "check": true },
  { "handle": "error" },
  { "status": 404, "src": "^(?!/api).*$", "dest": "/404.html" },
  { "handle": "miss" }
];
fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + "\n");
console.log("config.json routes fixed (api catch-all + SPA rewrite + cron kept)");
' "$BUILD/.vercel/output/config.json"

echo "Function assembled: $FUNC/index.js ($(wc -c < "$FUNC/index.js") bytes)"
