# 5 Circles Sales CRM

Internal sales-floor CRM: lead distribution, calling pipeline, attendance,
scoring, collections and dashboards.

**Status:** database layer complete and tested. API, UI and the ingestion worker
are not built yet.

## What is here

```
db/migrations/   12 forward-only SQL migrations — schema, engines, RLS
db/seed/         development seed data
db/tests/        52 assertions, one group per stated requirement
db/rebuild.sh    drop + recreate + migrate + seed + test
CLAUDE.md        scope boundary and the design decisions that are load-bearing
docs/            open questions and decisions made on your behalf
```

The engines are implemented as database functions, not application code, so the
rules hold regardless of which client is talking to them:

| Engine | Entry point |
|---|---|
| Lead distribution | `crm.assign_lead(lead_id)`, `crm.assign_pending_leads()` |
| Lead transfer | `crm.transfer_lead(lead, to_caller, reason, actor, note)` |
| Callback expiry | `crm.expire_missed_callbacks()` |
| Nurture parking | `crm.park_exhausted_leads()` |
| Overdue instalments | `crm.mark_overdue_instalments()` |
| Scoring | `crm.snapshot_scores(date)` |
| Security monitoring | `crm.detect_bulk_access()`, `crm.detect_off_hours_access()` |

Dashboard views: `v_my_day`, `v_immediate_queue`, `v_caller_day`,
`v_counsellor_mtd`, `v_attendance_day`, `v_my_score`, `v_transfer_candidates`,
`v_pipeline_leakage`, `v_collection_thermometer`, `v_floor_live`.

## Requirements

Requirement → test mapping is in `db/tests/test_requirements.sql`, tagged
`R1`…`R9`, plus `BE` for the breakeven model. All 52 assertions pass.

```
 req | passed | failed
-----+--------+--------
 BE  |      3 |      0     breakeven thermometer
 R1  |      5 |      0     alternate distribution, two teams and two setters
 R2  |      5 |      0     caller and counsellor dashboards
 R3  |      3 |      0     callback reminders
 R4  |      2 |      0     daily pipeline per caller
 R5  |      3 |      0     immediate leads
 R6  |      5 |      0     9-hour login, 09:30-18:30 IST
 R7  |      5 |      0     scoring for self-reflection
 R8  |      5 |      0     counsellor-only transfer of Not Answered leads
 R9  |     16 |      0     no leakage, no unauthorised access
```

## Running it

Requires PostgreSQL 16 with `pgcrypto`, `citext`, `btree_gist` and `pg_trgm`
available.

```bash
export PGHOST=/var/run/postgresql PGPORT=5432 PGUSER=postgres
./db/rebuild.sh --with-tests
```

`rebuild.sh` **drops and recreates the database**. It is a development tool.

To apply migrations without destroying data, run them in filename order:

```bash
for f in db/migrations/*.sql; do psql -v ON_ERROR_STOP=1 -d crm -f "$f"; done
```

## How the application must connect

Row-level security is the access control. The API server connects as a login
role that inherits `crm_app` — **not** as the table owner and **not** as a
superuser, either of which bypasses RLS entirely — and sets the acting user at
the start of every request:

```sql
select set_config('app.user_id', $1, true);   -- true = transaction-scoped
```

Every policy, every audit row and every derived score reads from that setting.
If it is unset, the connection sees nothing.

The app should also write one `crm.lead_access_log` row per lead record opened;
that is what makes a quiet bulk scrape detectable.

## On "no loopholes, no data breach"

Stated plainly, because the requirement deserves an honest answer rather than a
promise: the realistic threat to a sales CRM is not an outside attacker, it is a
departing employee walking out with the lead list.

What the database does about it: a caller physically cannot query another
caller's leads even through a buggy API; nothing is hard-deleted; the lead
timeline and call log cannot be rewritten; every change to a lead, user, deal or
setting is recorded with its actor; and abnormal read volume or off-hours access
raises an alert.

What it does not do, and what still has to be owned by someone with credentials:
TLS and network policy, disk and backup encryption, secret management, patching,
penetration testing, incident response, and offboarding discipline. The goal is
**hard to breach, impossible to breach quietly, quick to recover** — not a claim
that breach is impossible.

## Next

See `docs/open-questions.md`. Five answers are needed before the API layer is
worth writing; none of them change the schema.
