# Open questions

Five answers are needed before the API and UI layers are worth writing. None of
them block the database — every one is absorbed by a row in `crm.settings` or a
row in `crm.teams` / `crm.users`, so the schema does not change when they land.

Current placeholder values are marked **PLACEHOLDER** in the settings table:

```sql
select key, value, description from crm.settings order by key;
```

## 1. How many callers per team, and how many teams?

Built for 2 teams. `crm.teams.rotation_order` generalises to N teams with no
schema change, and team size is unbounded.

**Affects:** nothing structural. Only the seed data and the per-caller targets.

## 2. Android or iPhone for the callers?

The scoring model treats a logged call with no matching device call-log row as
the strongest single signal of fabricated activity
(`crm.call_attempts.is_verified`, surfaced as `unverified_dials` on the caller
dashboard). That depends on reading the device call log, which **Android allows
and iOS does not**.

If the floor is on iPhone, `is_verified` is always false and the
`data_integrity` score component must be dropped — or calls must route through
CRM telephony instead of personal SIMs, which is a different and larger build.

The server side no longer waits on this answer: `POST /device-logs/sync` is
live, idempotent, and tested, and the log-call form already offers the matching
device call so one click makes the attempt verified. What remains is the thin
Android uploader itself.

**Affects:** whether requirement 7 can be honest. Answer this one first.

## 3. What is the daily dial target per caller?

`dial.daily_target_per_caller` is set to **80** as a placeholder. It is the
denominator of the largest single score component (weight 20), so a wrong number
makes every caller score wrong in the same direction.

Set it from two weeks of measured baseline, not from aspiration.

## 4. How do the sheets split?

One Meta-connected sheet feeding both teams, or one sheet per team or campaign?

Both are supported: `crm.lead_sources.pinned_team_id` pins a source to one team,
and leaving it NULL alternates across all active teams. The column mapping is
data (`lead_sources.column_map`), so ops can re-map when Meta changes the form.

**Affects:** seed configuration only.

## 5. What does the advisory handoff carry?

`crm.handoff_outbox` currently carries whatever payload the worker writes. The
outbound contract needs pinning down — proposed: customer identity, product and
plan, tenure, amount booked, payment schedule, closer and setter IDs, source and
campaign, contact consent status, counsellor notes.

The **return leg matters more** and is the one that gets forgotten:
`crm.handoff_inbound` accepts `onboarded`, `refunded`, `cancelled`,
`renewal_due`. Without refund events, incentive clawback silently fails and
commission is paid on refunded deals.

**Also undecided:** who owns renewals? Current assumption is that the advisory
pipeline emits `renewal_due` and the CRM creates an opportunity for the sales
team to work. If the servicing team already handles renewals, drop it.

---

## Decisions made on your behalf

Flagged because they were judgement calls, not requirements. Each is reversible.

| Decision | Why | Reverse by |
|---|---|---|
| Distribution balances by load, not strict alternation | Strict A-B-A-B permanently starves anyone who takes a break | Set `distribution.max_catchup_leads` to 0 |
| Callers cannot transfer their own leads | Otherwise difficult leads circulate and nobody owns them | Widen the role check in `crm.transfer_lead` |
| Transfers capped at 2, then nurture | Endless redialling of a dead number is not a strategy | `lead.max_transfers` |
| A call under 30s is not a connect | Otherwise conversion rates are built on fiction | `dial.min_talk_seconds_for_connect` |
| Off-shift callers receive no leads | A lead handed to someone who went home is a lost lead | `distribution.require_on_shift` |
| Founders/viewers see all leads read-only | Simpler than aggregate-only, and they own the P&L | Tighten the `leads_select` policy |
| A caller's raw device call log is visible only to them and admin | Personal handsets; supervision needs the reconciled `call_attempts`, not the personal log | `device_call_logs_select` policy |

## The one thing worth raising with your Compliance Officer

Pre-sale conversations with prospects live in this CRM, not the advisory system.
If any SEBI retention obligation attaches to *prospective*-client interactions,
this is where those records sit — and the retention rules here are currently
"keep everything, delete nothing", which is safe but undeclared.

Five minutes with your CO before the API layer is written, not after.
