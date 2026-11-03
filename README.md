# 5 Circles CRM

A deliberately small CRM for the pan-India program: leads in from ChatGPT and
Meta, a two-to-four-person floor (callers make the first call, a follow-up
person works qualified leads to conversion), and four screens — Dashboard,
Leads, Reminders, Admin. Everything is visible to everyone, like a shared
Google Sheet, and the only popup in the product is a reminder whose time has
come.

**This is v2, a full reset** (owner decision, 3 Nov 2026). The earlier
Kanpur sales-floor build — teams, attendance, targets, scoring, telephony,
walk-ins, collections, the Android companion app — was removed wholesale;
it lives in git history. `docs/product-brief.md` is the brief this build
serves; `CLAUDE.md` records the design decisions that are load-bearing.

**Status:** database, API, ingestion and web UI are built and tested —
10 database test groups, 30 API integration tests, 4 real-browser E2E flows,
all passing.

## What is here

```
db/migrations/   5 forward-only SQL migrations — schema, auth, rules, RLS, views
db/seed/         development seed: Admin, Sanya, Harsh, Aisha + 3 sources
db/tests/        test_core.sql — assignment, outcomes, handover, RLS, dedupe
db/rebuild.sh    DEV ONLY: drop + recreate + migrate + seed [+ tests]
db/migrate.sh    production migration runner (applies each file exactly once)
db/diagnose.sh   "why are no leads arriving?" — read-only, run on the server
api/             TypeScript / Node 22 / Fastify + importer + web UI (api/README.md)
docs/            product-brief.md — the owner's brief and how the build answers it
deploy/          Caddyfile, systemd unit, update.sh, backup.sh
```

The rules are database functions, not application code, so they hold no
matter which client calls them:

| Rule | Entry point |
|---|---|
| Round-robin assignment | `crm.assign_next_caller()` (fires on lead insert) |
| Log a call, apply the outcome, qualified → follow-up | `crm.log_call(lead, outcome, note, next_at)` |
| Invite sent / confirmed / converted | `crm.set_checkpoint(lead, kind, on)` |
| Move / claim a lead | `crm.assign_lead(lead, user)` |
| Reopen a "not qualified" | `crm.reopen_lead(lead)` |
| Repeat enquiry attaches, never duplicates | `crm.attach_enquiry(lead, source, payload)` |

## Running it

Requires PostgreSQL 16 with `pgcrypto`, `citext` and `pg_trgm` available.

```bash
export PGHOST=/var/run/postgresql PGPORT=5432 PGUSER=postgres
./db/rebuild.sh --with-tests
```

`rebuild.sh` **drops and recreates the database**. It is a development tool.

The API and UI are one process:

```bash
cd api && npm install
export DATABASE_URL="postgresql://crm_api:pw@localhost:5432/crm"
npm test           # integration tests against a real database
npm run test:e2e   # Playwright flows driving the real UI in Chromium
npm start          # open http://host:8080/ui/
```

## First-time production setup

v2 needs a **fresh, empty database** — the v1 schema is not migrated, because
the product was reset while unused.

```bash
createdb crm
CRM_DB=crm ./db/migrate.sh

cd api
DATABASE_URL="postgresql://postgres@/crm?host=/var/run/postgresql" \
  npm run bootstrap -- --admin-email you@company.in \
  --admin-name "Your Name" --admin-password 'a-long-temporary-password'
# prints SERVICE_USER_ID for the .env file
```

Then in `.env`: `DATABASE_URL` (a login role that inherits `crm_app` — never
the owner or a superuser; the server refuses to boot on one), optionally
`SERVICE_USER_ID` + `GOOGLE_SERVICE_ACCOUNT_JSON` to poll the Meta/ChatGPT
sheets every few minutes (`INGEST_INTERVAL_MINUTES`, default 5). Without
Google credentials the Admin screen's "Sync now" and CSV import still work.
Sheet setup: Admin → Sources → paste the Google Sheet URL, and share the
sheet with the service account's email (`db/google-address.sh` prints it).

Everything else is in `deploy/`: Caddy for TLS, the systemd unit, `update.sh`
(pull + migrate + restart, used by the GitHub Action), nightly `backup.sh`.

## How the application must connect

Row-level security is the boundary. The API connects as a role that inherits
`crm_app` and sets the acting user per request, transaction-scoped:

```sql
select set_config('app.user_id', $1, true);
```

No session → no rows. A deactivated account → no rows, and its live sessions
are revoked the moment it is deactivated. Credentials and session tokens are
unreadable by the app role entirely (narrow SECURITY DEFINER functions).
Inside the floor, visibility is deliberately total — transparency is the
product — and accountability comes from the append-only `crm.activities`
timeline, which cannot be updated or deleted by the application role.
