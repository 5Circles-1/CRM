# 5 Circles CRM — v2 (pan-India program)

A deliberately small CRM for a floor of two to four people. PostgreSQL 16,
TypeScript/Fastify API, dependency-free web UI. This is the **v2 full reset**
(owner decision, 3 Nov): the earlier Kanpur sales-floor build — teams,
attendance, targets, scoring, tiers, escalation ladders, alerts engine,
re-tap, office visits, deals/instalments, Tata Tele telephony, the Android
companion app — was removed wholesale. Its history lives in git; do not
re-grow it piecemeal.

## The product in one paragraph

Leads arrive from ChatGPT and Meta (Google Sheets the importer polls, plus
CSV paste and manual add). Fresh leads rotate between the **callers**
(Sanya, Harsh) who make the first call. A call has exactly **five possible
outcomes**: Qualified, Call back later, Not answered, Switched off, Not
qualified ("no, don't call me" — the only way a lead closes as lost). A
qualified lead passes automatically to the **follow-up** person (Aisha), who
works it through the webinar checkpoints — invite sent, confirmed,
**converted**. Everyone sees everything, like a shared Google Sheet; the
admin additionally manages accounts and sources.

## The four screens

Dashboard (now + range numbers + funnel + who-did-what), Leads (the
spreadsheet: filters by day / person / status / source / due), Reminders
(overdue / today / upcoming, computed), Admin (team, sources, CSV import,
quarantine). The **only popup** in the product is a reminder whose time has
come: once, with one soft chime, then it sits in Reminders until the call is
logged.

## Design decisions that are load-bearing

- **An open lead always has `next_follow_up_at`.** Check constraint
  `leads_open_requires_next_action`, defaulted on insert, moved by every call
  outcome. Reminders, the due buckets and the popup are all reads of this one
  column — there is no reminder table and no alerts engine, so nothing can
  drift. Clearing a reminder = logging the call.

- **Stage and last outcome are separate columns.** `stage` (new → calling →
  qualified → converted | not_qualified) is where the lead stands;
  `last_outcome` (+ `na_streak`) is what the latest call said. Folding them
  together was how good leads used to vanish into "not answered" piles.

- **Five outcomes, and not one more.** The dropdown IS the enum
  `crm.call_outcome`. The owner's rule: not-qualified only on an explicit no;
  everything else keeps the lead alive with a date.

- **Converting is a checkpoint, never a call outcome** (`crm.set_checkpoint`),
  so the win is recorded exactly once. Undoing a conversion is admin-only.

- **Assignment is least-loaded-today among active callers, rotation order
  breaking ties** (`crm.assign_next_caller`) — A-B-A-B when everyone is
  present and level, and nobody is starved after a day off. No callers → the
  follow-up person; nobody → the lead parks loudly as Unassigned. Admins
  (and the System service account) never receive leads. The function is
  deliberately VOLATILE: a STABLE one reads the statement snapshot and piles
  a whole batch insert on one caller.

- **Qualified hands over automatically** (inside `crm.log_call`): a caller's
  qualified call reassigns to the least-loaded active `followup` user. A
  follow-up user's or admin's own qualified call keeps the lead.

- **Transparency is the access model.** Every active user reads the whole
  pipeline and may log a call on any lead (a 3-person floor covers for each
  other); the append-only `crm.activities` table records who did what, and is
  protected both by trigger (SQLSTATE 38000) and by revoking UPDATE from
  `crm_app` — RLS filters before triggers fire, so a denied update would
  otherwise read as success. Ownership moves only via the qualified handover
  or `crm.assign_lead` (admin, or self-claim of an unassigned lead).

- **RLS is still the boundary that matters**: no session or a deactivated
  account sees nothing; credentials and api_sessions are unreadable by
  `crm_app` entirely (narrow SECURITY DEFINER functions, migration 0002);
  the server refuses to boot on a role that bypasses RLS.

- **A repeat enquiry never creates a second lead.** The importer matches a
  live lead at any age (unique index `leads_one_live_per_phone_idx` backs
  this at schema level) or any lead inside `lead.dedupe_window_days`, then
  calls `crm.attach_enquiry`: enquiry_count++, follow-up pulled to NOW, a
  closed lead reopens, timeline row added. Manual add answers 409 with the
  existing lead's id so the UI opens it instead of dead-ending.

- **Ingestion is idempotent and lossless.** Unique
  (source_id, source_row_key, payload_hash); rows with undialable or
  non-+91 phones are quarantined with the reason, never dropped; one bad row
  is one row's transaction. No second assignment pass — the insert trigger
  assigns. The importer runs as SERVICE_USER_ID (the seeded System user:
  admin role, `is_service`, no credentials so it can never log in) or as the
  admin who clicked Sync/Import.

- **Every refusal carries a SQLSTATE** (42501 → 403, 23514 → 409, P0002 →
  404…) and the message is written for the person on the floor. A bare
  `raise exception` is P0001, which is in no map and surfaces as "something
  went wrong" — never do that in `crm.*` functions.

- **Every tunable lives in `crm.settings`** (`follow_up.retry_hours`,
  `lead.dedupe_window_days`, auth knobs).

## API rules that matter

- **The API never filters by ownership** and never re-implements a SQL rule.
  Routes call `crm.log_call` / `crm.set_checkpoint` / `crm.assign_lead` /
  `crm.reopen_lead` / `crm.attach_enquiry` and map SQLSTATEs
  (`api/src/http/errors.ts`).
- **All query access goes through `Database.withUser()`** (RLS session
  contract, `api/src/db/pool.ts`); there is no way to query outside it.
- **The server refuses to boot on a role that bypasses RLS.**
- `bigint` → JS number; `numeric` stays a string.
- Lead lists read `crm.v_lead_list` (security_invoker), so every screen shows
  the same shape.

## Layout

```
db/
  migrations/   0001 foundation · 0002 users+auth · 0003 leads+rules ·
                0004 RLS · 0005 views   (forward-only)
  seed/         dev seed: Admin, System, Sanya, Harsh, Aisha + 3 sources
  tests/        test_core.sql — run by rebuild.sh --with-tests
  rebuild.sh    DEV ONLY: drop + recreate + migrate + seed [+ tests]
  migrate.sh    production runner: applies pending migrations exactly once
  diagnose.sh   "why are no leads arriving?" — read-only, run on the server
api/
  src/db/       the RLS session contract — read this first
  src/routes/   auth · me(+reminders) · leads · dashboard · admin
  src/ingest/   Google Sheets / CSV -> ingested_rows -> leads
  src/tools/    bootstrap.ts (first admin + System), reset-password.ts
  public/       the UI: ES modules, no build step; views/ = 4 screens + lead
  test/         api.test.ts (integration) · e2e.test.ts (Playwright)
docs/           product-brief.md — the owner's brief this build serves
deploy/         Caddyfile, systemd unit, update.sh, backup.sh
```

## Running

```bash
# needs a running postgres 16 and PGHOST/PGPORT/PGUSER set
./db/rebuild.sh --with-tests

cd api && npm install && npm test   # API integration tests
npm run test:e2e                    # real Chromium driving the real UI
npm start                           # serves API + UI on one port; open /ui/
```

**v2 needs a fresh database.** The v1 production database (if any survives)
is not migratable — the owner reset the product. Create an empty database,
run `db/migrate.sh`, then `npm run bootstrap` for the first admin +
SERVICE_USER_ID.

## Conventions

- Timestamps are `timestamptz`; business dates use `crm.ist_date()`
  (Asia/Kolkata) — never the UTC date, or daily rollups shift by 5.5 hours.
- Phones are canonicalised by `crm.normalise_phone()`; NULL means quarantine,
  never drop.
- Migrations are forward-only once applied anywhere real.
- Nothing is hard-deleted by the application; `DELETE` is revoked from
  `crm_app`.
- If you change behaviour, change the tests (`db/tests/test_core.sql`,
  `api/test/api.test.ts`).
