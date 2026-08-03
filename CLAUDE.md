# 5 Circles Sales CRM

Internal sales-floor CRM for 5 Circles. PostgreSQL 16.

## Scope boundary — read this first

This is a **sales-floor CRM only**. Its job ends at *money collected* and a
*clean handoff*. Everything about servicing a paying advisory client — KYC, KRA,
MITC consent, e-sign, risk profiling, fee caps, research delivery, grievance
registers, the five-year client interaction archive — belongs to the existing
advisory pipeline and must **not** be built here.

| In scope | Out of scope (advisory pipeline) |
|---|---|
| Lead ingestion, distribution, teams and roles | Client KYC and onboarding |
| Caller → counsellor pipeline, callbacks, reminders | Consent and agreements |
| Attendance, scoring, dashboards | Fee-cap and family limits |
| Deals, instalments, collections chasing | Service delivery and research |
| Call QA — conduct and coaching | Long-term client records, grievances, audits |

Collections **stays here** even after handoff: the counsellor who closed the
deal chases the instalments.

The handoff runs both directions (`crm.handoff_outbox` / `crm.handoff_inbound`).
The return leg carries onboarding, **refund/cancellation**, and renewal-due
events. Without it, incentive clawback silently fails and renewals are never
created.

## The nine requirements this build serves

1. Leads arrive from a Meta-connected Google Sheet and distribute alternately
   between two teams, then alternately between setters.
2. Dashboards for caller *and* counsellor performance.
3. A caller can set a callback reminder when a client asks to be called back.
4. Each caller sees their own pipeline for the day.
5. An immediate lead is surfaced for contact as soon as possible.
6. A 9-hour login (09:30–18:30 IST) is visible per person per day.
7. Callers and counsellors are scored, for self-reflection.
8. A lead that went Not Answered can be transferred to another caller — by the
   counsellor, who is also the team lead.
9. Interactive dashboards, no pipeline leakage, no data breach.

Requirement → test mapping lives in `db/tests/test_requirements.sql`, tagged
`R1`…`R9`. Every requirement has passing assertions. **If you change behaviour,
change the test.**

## Design decisions that are load-bearing

Do not undo these without understanding why they exist.

- **An open lead always has a `next_action_at`.** Enforced by the check
  constraint `leads_open_requires_next_action`, defaulted on insert by
  `crm.tg_lead_defaults`, and pushed forward automatically by the call-attempt
  trigger. This is the mechanical guarantee against pipeline leakage — the UI
  rule "you cannot close a call without a next action" is just its front end.

- **Distribution is least-loaded-then-rotation, not a naive A-B-A-B counter.**
  Strict alternation permanently starves whoever takes a break: the cursor lands
  on them, they are skipped, they never catch up. Among callers actually on the
  floor, the fewest-leads-today wins; rotation order breaks ties, which yields
  exactly A-B-A-B when everyone is present and level. Catch-up is bounded by
  `distribution.max_catchup_leads` so a returning caller is not flooded.

- **Only counsellors and admins can transfer leads.** If callers could push
  leads off their own list, difficult leads would circulate forever and nobody
  would own anything. Enforced inside `crm.transfer_lead`, not in the UI.
  Capped at `lead.max_transfers` (2), then the lead goes to nurture.

- **Score components that had nothing to measure are excluded from both the
  points earned and the weight available**, and the total is rescaled over what
  applied. Awarding full marks for an empty component rewards idleness — before
  this was fixed, a caller with zero dials out-scored an active one 29 to 26.

- **A connect requires real talk time**, not just a connected disposition
  (`dial.min_talk_seconds_for_connect`, default 30s). Otherwise disposition
  accuracy is fiction and so is every conversion rate built on it.

- **Row-level security is the access control, not the API.** The app connects as
  `crm_app` (no BYPASSRLS, not the table owner) and sets `app.user_id` per
  request. A missing `WHERE` clause in a route handler is then a bug that
  returns too few rows, never one that leaks the lead book.

- **Append-only tables have `UPDATE` revoked at the privilege level**, not only
  blocked by trigger. RLS filters before triggers fire, so a denied update would
  otherwise silently affect zero rows and read as success.

- **Every tunable number lives in `crm.settings`**, not in code — SLA minutes,
  dial targets, breakeven, transfer caps. Changing a target is an ops action.

## Layout

```
db/
  migrations/    forward-only, applied in filename order
  seed/          dev seed: 2 teams, 4 callers, 2 counsellors
  tests/         requirement tests, tagged R1..R9
  rebuild.sh     drop + recreate + migrate + seed [+ test]
docs/            requirement traceability, open questions
```

## Running

```bash
# needs a running postgres 16 and PGHOST/PGPORT/PGUSER set
./db/rebuild.sh --with-tests
```

`rebuild.sh` **drops the database**. It is a development tool; never point it at
anything real.

## Conventions

- All timestamps are `timestamptz`. Business dates use `crm.ist_date()`
  (Asia/Kolkata) — never the UTC date, or daily rollups shift by 5.5 hours.
- Money is `numeric(12,2)` in INR. Never floats.
- Phone numbers are canonicalised by `crm.normalise_phone()` on insert. It
  returns NULL for undialable input — quarantine those rows, never drop them.
- Migrations are forward-only. Add a new numbered file; do not edit an applied
  one once it has run anywhere real.
- Nothing is hard-deleted by the application; `DELETE` is revoked from `crm_app`.

## Not built yet

The database and its engines are complete and tested. Still to come: the
ingestion worker (Google Sheets → `crm.ingested_rows` → `crm.assign_lead`), the
HTTP API, the web UI, and the Android call-log sync app. See
`docs/open-questions.md` — five answers are needed before the API layer is worth
writing, and the stack for it has not been chosen.
