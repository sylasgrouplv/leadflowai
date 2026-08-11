# Supabase activity logging (team ops)

Ops tooling for the LeadFlow AI team's daily activity log. Every activity entry
is appended as **one JSON file per entry** (no read-modify-write appends, so
concurrent runs never race) into a Supabase storage bucket under date-named
folders:

```
activity-logs/
└── 2026-08-11/
    ├── 153012-401-outbound-email.json      ← one file per entry
    ├── 153045-882-prospect-added.json
    └── daily-summary.json                  ← written by daily-snapshot.ts
```

This is an **ops-only tool** — nothing here is imported by `src/`, and it does
not change the deployed app. It follows the team's graceful-degradation
pattern: with no Supabase config it still works (local fallback, exit 0).

## Setup

The owner pastes these into the team's Secrets store (NOT the repo):

| Var | Where to find it (Supabase dashboard) |
| --- | --- |
| `SUPABASE_URL` | Project Settings → API → **Project URL** (e.g. `https://abcd1234.supabase.co`) |
| `SUPABASE_SERVICE_ROLE_KEY` | Project Settings → API → **service_role** secret |
| `SUPABASE_ANON_KEY` | Project Settings → API → **anon public** key (informational; these tools use the service role) |
| `SUPABASE_BUCKET` | Optional. Bucket name override, default `activity-logs` |

Both scripts read `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` from the
environment (`Bun.env`) — export them or let Bun load them from a `.env` file
(see `../.env.example` style). The service_role key is an admin key: keep it
out of the repo and the frontend.

## Usage

Run from `leadflow-ai-site/`:

### Log one activity entry

```bash
# via npm script (site root):
bun run log-activity -- --type outbound-email --summary "Sent follow-up to Brown & Sons Roofing" --actor sdr

# or directly:
bun run scripts/supabase-log/log.ts --type outbound-email --summary "Sent follow-up to Brown & Sons Roofing" --actor sdr
```

Optional args:

```bash
# structured detail (parsed as JSON if it is valid JSON, else stored as text):
--detail '{"prospect":"Brown & Sons Roofing","channel":"email"}'

# detail from a file:
--detail-file /home/team/shared/campaign/wave2b-tracking.csv

# actor defaults to $USER (or "lead" if unset):
#   --actor <name>
```

Entry schema (uploaded as-is):

```json
{
  "timestamp": "2026-08-11T15:30:12.401Z",
  "date": "2026-08-11",
  "folder": "activity-logs/2026-08-11",
  "type": "outbound-email",
  "summary": "Sent follow-up to Brown & Sons Roofing",
  "detail": { "prospect": "Brown & Sons Roofing", "channel": "email" },
  "actor": "sdr",
  "source": "team-ops"
}
```

### Daily snapshot

```bash
bun run log-activity:snapshot
# or:
bun run scripts/supabase-log/daily-snapshot.ts
```

Lists that day's folder (`activity-logs/<YYYY-MM-DD>/`), downloads each entry,
and uploads `activity-logs/<YYYY-MM-DD>/daily-summary.json`:

```json
{
  "date": "2026-08-11",
  "entryCount": 2,
  "byType": { "outbound-email": 1, "prospect-added": 1 },
  "entries": [ ... ]
}
```

## Fallback behavior (no Supabase config)

If `SUPABASE_URL` or `SUPABASE_SERVICE_ROLE_KEY` is missing/empty, the tools
**never crash**. They write to the local fallback dir instead and exit 0:

- `log.ts` → `/home/team/shared/activity-logs-local/<YYYY-MM-DD>/<HHMMSS-mmm>-<type>.json`
- `daily-snapshot.ts` → scans that same dir, writes
  `/home/team/shared/activity-logs-local/<YYYY-MM-DD>/daily-summary.json`

Both print a one-line `WARNING: Supabase not configured (missing: ...)` so
you know nothing was uploaded. To be extra sure during testing:

```bash
unset SUPABASE_URL SUPABASE_SERVICE_ROLE_KEY
bun run scripts/supabase-log/log.ts --type smoke --summary "test entry" --actor test
```

Once credentials land in the team's Secrets store, just export them (or add
them to `.env`) and re-run — entries then go to the bucket.

## How it talks to Supabase (Storage API, service role)

- **Ensure bucket (idempotent):** `POST {url}/storage/v1/bucket`
  `{"name":"activity-logs","public":false}` — a `400`/`409` "already exists"
  response is treated as success.
- **Upload one entry:** `POST {url}/storage/v1/object/{bucket}/activity-logs/<date>/<HHMMSS-mmm>-<type>-<slug>.json`
- **List a day's objects:** `POST {url}/storage/v1/object/list/{bucket}`
  `{"prefix":"activity-logs/<date>/", ...}`
- **Download:** `GET {url}/storage/v1/object/{bucket}/{path}`

Everything uses Bun's native `fetch`/`Bun.file`/`Bun.write` and `node:fs` —
no new npm dependencies.

## Files

| File | Purpose |
| --- | --- |
| `log.ts` | CLI to append one activity entry (upload or local fallback) |
| `daily-snapshot.ts` | Build/upload (or write locally) the day's `daily-summary.json` |
| `common.ts` | Shared config, date/slug helpers, Storage API calls |
| `README.md` | This file |

`package.json` (site root) wires up `log-activity` and `log-activity:snapshot`.
