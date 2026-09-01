# CRM API + Web UI

TypeScript / Node 22 / Fastify over PostgreSQL 16. No ORM — the schema and its
engines are the source of truth, and an ORM would fight the RLS session model.

The web UI lives in `public/` and is served by the same process at `/ui/`:
dependency-free ES modules, no build step, no supply chain, same origin as the
API so cookies just work and no CORS surface exists. Routing is hash-based.
Every piece of data on every screen comes from the API under a session — the
shell itself is just markup.

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
| `CALLYZER_API_KEY` | for Callyzer | Bearer token from the Callyzer dashboard; enables the scheduled pull |
| `CALLYZER_WEBHOOK_SECRET` | for Callyzer | Shared secret; enables `POST /integrations/callyzer/webhook` |
| `CALLYZER_SYNC_MINUTES` | no | Default 15 |
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

**Money** — `GET /products`, `POST /leads/:id/deals` (books the deal, closes the
lead, schedules instalments; the schedule must sum to the booked amount, checked
in paise), `GET /collections/due` (the dues queue with the latest open promise),
`POST /deals/:id/payments` (overpay rejected), `POST /instalments/:id/promise`.

**Device call log** (the Android contract) — `POST /device-logs/sync` bulk-uploads
the handset call log, idempotent on `(user_id, device_row_key)`; rows matching a
visible lead get linked. `GET /leads/:id/device-log-suggestion` returns the most
recent unclaimed device call to that lead's number; attaching its id to a logged
call is what flips `is_verified`. A caller's raw device log stays visible only
to them and admin — supervision sees the reconciled attempts, not the personal
log (a counsellor additionally sees rows *matched* to leads they can see, which
is where the coaching recording lives).

**Callyzer** (a second writer to the same table; see migration 0063) —
`POST /integrations/callyzer/webhook` takes Callyzer's push, authenticated by
the shared secret (`?secret=` on the URL or an `x-callyzer-secret` header),
compared in constant time. `GET /integrations/callyzer/health` is the
counsellor/admin readout: sync and webhook liveness, the handset roster with
unmapped numbers, open quarantine. `POST /integrations/callyzer/sync`
(admin/ops) reconciles on demand, optionally deeper (`{"hours": n}`). Both
the webhook and the scheduled pull feed one `SECURITY DEFINER` door,
`crm.ingest_callyzer_logs()`: employee SIM → `users.dialing_msisdn` (the one
mapping fact, editable via `PUT /admin/users/:id/dialing-msisdn`), client
number → lead match, upsert on re-delivery (notes and recordings arrive late),
quarantine for anything unplaceable — never a silent drop. Callyzer's Lead
APIs, statuses and reminders are deliberately not connected: it is a sensor,
never a second CRM.

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

`src/jobs/scheduler.ts` calls the database engines on a cadence, as the `ops`
service account. The engines themselves are `SECURITY DEFINER` (migration 0014)
because they are system invariants that must cross role boundaries — score
snapshots write rows for everyone, security detection reads the admin-only
access log. All are idempotent — a missed tick delays work, it never corrupts
it.

Lead assignment sweeps every minute during shift hours (this is what hands out
leads that arrived overnight), callbacks expire and security detection runs
every 5 minutes, scores snapshot every 15 so an intraday check is current.

Without `SERVICE_USER_ID` the jobs are disabled and the server logs a warning.

## Tests

`npm test` rebuilds a test database from `db/migrations`, seeds it, and drives
the real Fastify app with `app.inject()` against a real Postgres: auth and
lockout, RLS boundaries through HTTP, ingestion idempotency and quarantine,
the calling pipeline, transfer authority and cap, attendance, dashboards,
deals/collections/promises, the device-log sync contract, the Callyzer
webhook/pull/health surface (with a fake Callyzer server), and the boot-time
RLS guard. `test/callyzer.test.ts` unit-tests the rate-limit queue and the
client's 429/403 handling against a virtual clock — no database needed.

`npm run test:e2e` goes one layer further: it boots the server on a real port
and drives the real UI in headless Chromium — caller logs a call with a
callback, counsellor transfers a Not Answered lead from the queue, admin reads
the breakeven thermometer. Screenshots land in `test/shots/` (or
`E2E_SHOT_DIR`).

Both require a running Postgres 16 and `PGHOST` / `PGPORT` set.

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

The Android call-log sync app — the client for `POST /device-logs/sync`. The
endpoint, matching, suggestion flow and verified-dial loop are all live and
tested; the app is a thin uploader. See `docs/open-questions.md`, question 2
(Android or iPhone), which needs answering first.
