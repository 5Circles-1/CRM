# CRM API + Web UI

TypeScript / Node 22 / Fastify over PostgreSQL 16. No ORM — the schema and
its functions are the source of truth, and an ORM would fight the RLS session
model.

The web UI lives in `public/` and is served by the same process at `/ui/`:
dependency-free ES modules, no build step, no supply chain, same origin as
the API so cookies just work and no CORS surface exists. Routing is
hash-based. Every piece of data on every screen comes from the API under a
session — the shell itself is just markup.

## The one thing to understand before changing anything

Row-level security is the access boundary. Route handlers do **not** fence
data; the database does. Two invariants hold on every request:

1. **The connection does not bypass RLS.** A superuser, a `BYPASSRLS` role,
   or the table owner sees through every policy — silently, totally. So
   `Database.assertNotBypassingRls()` runs at boot and the server refuses to
   start otherwise.

2. **`app.user_id` is set.** `Database.withUser()` opens a transaction, sets
   it transaction-locally, and hands back a querier. There is deliberately no
   exported way to run a query outside that wrapper, so a pooled connection
   cannot carry one user's identity into the next request.

The same applies to business rules: the five call outcomes, the qualified →
follow-up handover, checkpoint authority, assignment authority all live in
Postgres. Routes call `crm.log_call()` and friends and let the SQLSTATE come
back; `src/http/errors.ts` maps `42501 → 403`, `23514 → 409`, `P0002 → 404`.
Never re-check a rule in a handler — that gives it two homes, and they drift.

## Layout

```
src/
  index.ts        entry: server + the scheduled sheet sync (if configured)
  server.ts       Fastify wiring: static UI, context plugin, routes
  config.ts       env -> config
  db/pool.ts      the RLS session contract (withUser / withoutUser)
  auth/           argon2id hashing, session tokens (SHA-256 at rest)
  http/           request context plugin, SQLSTATE -> HTTP error mapping
  routes/
    auth.ts       login / logout / change-password
    me.ts         /me, /reminders (buckets), /reminders/due (the popup feed)
    leads.ts      list + filters, detail + timeline, add, call, note,
                  assign, checkpoint, reopen, picker options
    dashboard.ts  one endpoint, the whole dashboard payload
    admin.ts      users, sources, sync-now, CSV import (admin only)
  ingest/         Google Sheets / CSV -> ingested_rows -> leads
  tools/          bootstrap.ts (first admin + System user),
                  reset-password.ts (server-side rescue)
public/
  js/main.js      shell, nav, theme, the reminder watcher (the one popup)
  js/views/       login, dash, leads, lead, reminders, admin
  js/charts.js    dependency-free SVG charts
  app.css         design tokens, light + dark
test/
  api.test.ts     integration tests through the RLS-constrained role
  e2e.test.ts     Playwright: caller / follow-up / admin / reminder flows
  helpers.ts      test database rebuild + seeded ids + fixtures
```

## Running

```bash
npm install

# Postgres 16 somewhere, then (dev database + roles are created by the tests
# themselves; for a hand-run server use any role inheriting crm_app):
export DATABASE_URL="postgresql://crm_api:pw@localhost:5432/crm"
npm start            # API + UI on :8080

PGHOST=/tmp PGPORT=55432 npm test       # rebuilds crm_api_test, runs suite
PGHOST=/tmp PGPORT=55432 npm run test:e2e
```

Environment:

| Variable | Meaning |
|---|---|
| `DATABASE_URL` | required; must NOT bypass RLS |
| `PORT`, `HOST` | default 8080 / 0.0.0.0 |
| `SERVICE_USER_ID` | the System user's uuid (bootstrap prints it) — enables the scheduled sheet sync |
| `GOOGLE_SERVICE_ACCOUNT_JSON` / `GOOGLE_APPLICATION_CREDENTIALS` | Sheets read-only credentials |
| `INGEST_INTERVAL_MINUTES` | default 5 |
| `INSECURE_COOKIES=true` | plain-HTTP dev only |
| `SESSION_COOKIE_NAME`, `COOKIE_DOMAIN`, `LOG_LEVEL` | optional |

One-off ingestion (cron or by hand):

```bash
node --experimental-strip-types src/ingest/cli.ts                 # every sheet source
node --experimental-strip-types src/ingest/cli.ts --source <uuid>
node --experimental-strip-types src/ingest/cli.ts --csv leads.csv --source <uuid>
```
