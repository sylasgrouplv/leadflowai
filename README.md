# LeadFlow AI

LeadFlow AI is a multi-tenant SaaS platform that helps local service businesses (HVAC, plumbing, roofing, landscaping, cleaning, auto repair, restoration, home services) turn more leads into customers automatically. AI agents respond instantly, qualify and score leads, book appointments, follow up with unconverted prospects, and hand unusual or sensitive situations to a human — while owners get real performance analytics.

This repository contains the full website and product codebase in [`leadflow-ai-site/`](leadflow-ai-site/).

## What's in `leadflow-ai-site/`

- **Product (MVP + AI Agent Brain)** — Vite + React SPA frontend with a Hono/Bun backend, Drizzle ORM over SQLite (Postgres-portable schema), and migrations `0000`–`0007`.
  - Core loop: Capture → Respond → Qualify → Book → Follow Up → Convert → Measure
  - Lead scoring (HOT/WARM/COLD/UNQUALIFIED/HUMAN_REVIEW), owner dashboard with funnel analytics, AI receptionist grounded in each business's knowledge base, conversation inbox with human takeover, real availability booking, follow-up automation, notifications, embeddable website chat widget (`public/widget.js`), and a seeded demo business ("Smith's HVAC").
  - AI Agent Brain: intent detection + 7 specialized agents, formal tool registry with permission levels and audit logging, confidence system, short-term conversation memory, global AI safety rules, events + background automation engine, review agent, business intelligence agent (weekly reports), revenue attribution, agent configuration and admin controls, usage/cost tracking, system health dashboard.
  - External providers (AI, SMS, email, calendar, CRM, Stripe) run behind interfaces with mock implementations — swap in live providers via env vars (see `src/server/integrations/`).
- **Docs** — `docs/leadflow-ai-spec.md` (MVP spec) and `docs/ai-agent-brain-spec.md` (AI Agent Brain & Automation spec), plus `SITE.md` for site operations.

## Requirements

- [Bun](https://bun.sh) 1.x

## Run it

```bash
cd leadflow-ai-site
bun install                 # install dependencies
bun run db:migrate          # apply drizzle migrations (creates .data/leadflow.db)
bun run db:seed             # seed the demo business (optional)
bun run publish             # build + serve on port 3000 (the team's public surface)
```

`publish.sh` builds the Vite app and starts the production server detached on port 3000. The server log is written to `.run/server.log`. For a live production deploy, see `go-live.sh` (requires a `VERCEL_TOKEN`).

### Tests

Root-level test scripts (run with `bun <script>.ts`):

- `auto-test.ts` — end-to-end MVP acceptance (20 criteria)
- `tools-test.ts`, `brain-test.ts`, `brain4-test.ts` — AI Agent Brain / tool registry / events & automation suites
- `verify-fresh.ts` — fresh-account verification of all 20 MVP criteria
- `smoke.ts` — quick server smoke test

## Environment variables

Copy `.env.example` to `.env` and adjust. Bun auto-loads `.env` at startup.

| Variable | Purpose | Default |
| --- | --- | --- |
| `DATABASE_PATH` | SQLite file path | `.data/leadflow.db` |
| `DATABASE_URL` | Postgres connection string (optional; schema is portable) | — |
| `SESSION_SECRET` | Long random string for auth sessions (else generated + persisted in `.data/.session_secret`) | — |
| `AI_PROVIDER` | `mock` or live provider key | `mock` |
| `SMS_PROVIDER` / `EMAIL_PROVIDER` / `CALENDAR_PROVIDER` / `CRM_PROVIDER` / `STRIPE_PROVIDER` | Provider selection for each integration | `mock` |

**Never commit** real `.env` files, the SQLite database (`.data/`), or session secrets — see `.gitignore`.

## Demo credentials (seeded)

- Owner: `demo@leadflow.ai` / `demo1234` — Sarah Smith, "Smith's HVAC" (full demo data)
- Admin: `admin@leadflow.ai` / `admin1234`
- Team member: `team@leadflow.ai` / `team1234`

## Layout notes

- `src/server/` — Hono API, DB (schema, migrations, repo), auth, AI brain (orchestrator, agents, tools, events/automation), integrations (mock/live providers)
- `src/client/` — React SPA (landing/marketing pages, app UI), content in `src/client/content.ts`
- `public/widget.js` — embeddable chat widget (vanilla JS, shadow DOM)
- `drizzle/` — SQL migrations + meta snapshots
- `.data/` — runtime SQLite DB + session secret (git-ignored, never committed)
