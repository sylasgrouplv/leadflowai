#!/usr/bin/env bash
# Deploy LeadFlow AI to Vercel (production) and print the live URL.
#
# The team's VERCEL_TOKEN is a limited token the Vercel CLI cannot
# authenticate with, so this drives the deploy through the REST API via
# scripts/deploy-vercel.ts (build SPA -> bundle -> project -> env vars ->
# deployment -> live URL).
#
# Required env:
#   VERCEL_TOKEN   (required) — owner-collected Vercel token.
#   DATABASE_URL   (required) — the real Neon pooled URL.
#   SESSION_SECRET / INTERNAL_TOKEN — optional; generated if the project
#                     doesn't already have them.
#   VERCEL_TEAM_ID — optional; resolved from the token by default.
set -euo pipefail
cd "$(dirname "$0")"
umask 002
: "${VERCEL_TOKEN:?set VERCEL_TOKEN (collect it from the owner first)}"
bun run scripts/deploy-vercel.ts
