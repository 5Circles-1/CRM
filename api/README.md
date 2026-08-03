# CRM API

TypeScript / Node 22 / Fastify over PostgreSQL 16. No ORM — the schema and its
engines are the source of truth, and an ORM would fight the RLS session model.

## The one thing to understand before changing anything

Row-level security is the access control for this system. Route handlers do
**not** filter by ownership; the database does. That only works if two things
hold on every request:

1. **The connection does not bypass RLS.** A superuser, a role with `BYPASSRLS`,
   or the table owner sees through every policy in migration 0012. The failure
   is silent — everything works and everyone sees every lead — so
   `Database.assertNotBypassingRls()` runs at boot and the server refuses to
   start otherwise. There is a test for this.

2. **`app.user_id` is set.** `Database.withUser()` opens a transaction, sets it
   transaction-locally, and hands back a querier. There is deliberately no
   exported way to run a query outside that wrapper, so a pooled connection
   cannot carry one user's identity into the next request.

This is why `GET /leads/:id` has no ownership check in it. A lead the user
cannot see simply is not found. Adding a `WHERE` clause would put the rule in a
second place, where it would eventually drift.

The same applies to business rules: the transfer authority check, the two-
transfer cap and the "an open lead always has a next action" constraint all live
in Postgres. The route calls `crm.transfer_lead()` and lets the SQLSTATE come
back; `src/http/errors.ts` maps `42501 → 403` and `23514 → 409`.

## Running

```bash
npm install

export DATABASE_URL="postgresql://crm_api:pw@localhost:5432/crm"
export SERVICE_USER_ID="<uuid of a user with the ops role>"

npm run dev          # watch mode
npm start            # production
npm test             # integration tests against a real database
npm run typecheck
```

The database role must inherit `crm_app`:

```sql
create role crm_api login password '...' in role crm_app;
```

### Environment

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | yes | Must be a role inheriting `crm_app` |
| `SERVICE_USER_ID` | for jobs | User with the `ops` role; background jobs run as them |
| `PORT` / `HOST` | no | Default 8080 / 0.0.0.0 |
| `SESSION_COOKIE_NAME` | no | Default `crm_session` |
| `INSECURE_COOKIES` | no | Set `true` only for local plain HTTP |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | for sheets | Otherwise `GOOGLE_APPLICATION_CREDENTIALS` |
| `PG_POOL_MAX` | no | Default 10 |

## Endpoints

**Auth** — `POST /auth/login`, `POST /auth/logout`, `POST /auth/change-password`.
Sessions are random tokens; only their SHA-256 is stored, so a stolen database
yields no usable sessions. Cookie for the web app, `Authorization: Bearer` for
the Android app. Deactivating a user revokes their live sessions immediately via
a database trigger, not at token expiry.

**The caller's screens** (R4, R6, R7) — `GET /me`, `/me/day`, `/me/day/summary`,
`/me/score`, `/me/attendance`.

**Working leads** (R3, R5, R9) — `GET /leads`, `GET /leads/:id`,
`POST /leads/:id/calls`, `POST /leads/:id/callbacks`, `POST /callbacks/:id/cancel`,
`POST /leads/:id/qualify`, `GET /queues/immediate`.

**Transfer** (R8) — `GET /transfers/candidates`, `GET /transfers/targets`,
`POST /leads/:id/transfer`.

**Attendance** (R6) — `POST /attendance/login`, `POST /attendance/logout`,
`GET /attendance/today`, `GET /attendance/day/:date`.

**Dashboards** (R2, R9) — `/dashboards/floor`, `/callers`, `/counsellors`,
`/leakage`, `/thermometer`, `/funnel`, `/security-alerts`.

**Ingestion** (R1) — `POST /ingest/sources/:id/run`, `POST /ingest/sources/:id/csv`,
`GET /ingest/runs`, `POST /ingest/quarantine/:rowId/replay`.

**Admin** — users, teams, sources, quarantine, per-record audit trail, and
`PUT /admin/settings/:key` for every tunable number in the system.

## Ingestion

Google Sheets → `crm.ingested_rows` → `crm.assign_lead`. Three properties, in
priority order:

1. **Re-running is always safe.** The worker re-reads the whole sheet; the
   unique index on `(source_id, source_row_key, payload_hash)` means an
   unchanged row can never produce a second lead.
2. **Nothing is dropped.** A row with an undialable number is quarantined with a
   reason and is replayable — a mistyped number is still a lead you paid for.
3. **One bad row cannot stop the run.** Each row is its own transaction.

Assignment happens in a second pass, after all rows are in, so distribution
balances across the whole batch instead of handing the first N leads to one
caller.

A repeat enquiry from the same number inside the dedupe window attaches to the
existing lead, raises its priority and lands on the timeline — re-enquiry is a
buying signal, not a duplicate to discard.

The sheet reader is behind an interface (`SheetReader`), so the CSV path, the
tests and the Google path all share one pipeline.

```bash
node --experimental-strip-types src/ingest/cli.ts                    # all sources
node --experimental-strip-types src/ingest/cli.ts --source <uuid>
node --experimental-strip-types src/ingest/cli.ts --csv leads.csv --source <uuid>
```

## Background jobs

`src/jobs/scheduler.ts` calls the database engines on a cadence. They run as the
`ops` service account, so they are subject to RLS like everything else. All are
idempotent — a missed tick delays work, it never corrupts it.

Lead assignment sweeps every minute during shift hours (this is what hands out
leads that arrived overnight), callbacks expire and security detection runs
every 5 minutes, scores snapshot every 15 so an intraday check is current.

Without `SERVICE_USER_ID` the jobs are disabled and the server logs a warning.

## Tests

`npm test` rebuilds a test database from `db/migrations`, seeds it, and drives
the real Fastify app with `app.inject()` against a real Postgres. 32 tests:
auth and lockout, RLS boundaries through HTTP, ingestion idempotency and
quarantine, the calling pipeline, transfer authority and cap, attendance, the
dashboards, and the boot-time RLS guard.

Requires a running Postgres 16 and `PGHOST` / `PGPORT` set.

## Deliberate omissions

- **No rate limiting.** Needs to sit at the edge (nginx / Cloudflare), not here.
- **No CORS config.** Set it when the UI's origin is known.
- **No refresh tokens.** A 12-hour session covers a shift and a half; re-login
  is a fair cost for a sales floor.
- **No CSRF token.** Cookies are `SameSite=Lax` and every mutation is POST/PUT.
  Add a token if the UI is ever hosted cross-origin.
- **No password strength rules beyond length.** Add a breach-list check before
  real users exist.

## Not built

The web UI and the Android call-log sync app. The Android app is what makes
`call_attempts.is_verified` meaningful — see `docs/open-questions.md`, question
2, which needs answering first.
