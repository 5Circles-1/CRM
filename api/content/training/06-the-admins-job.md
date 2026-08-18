---
title: The Admin's job
audience: admin
order: 6
summary: Users, sources, settings, tiers, security, backups and corrections.
---

## Users

**Admin → Users → New user.** Name, email, role, team, temporary password (10
characters minimum). They must change it at first login.

Roles: **caller**, **counsellor**, **mentor**, **ops**, **viewer**, **admin**.
Only callers receive distributed leads — that is role-gated in the engine, so a
mentor or counsellor with a team membership still never enters the rotation.

To reset a password: **Admin → Users → Reset**. If *you* are locked out, the
server rescue tool exists — it prompts for the password rather than taking it
as an argument, so it never lands in shell history.

## Lead sources

Two mistakes here cost a day each:

1. **The Sheet ID is not the URL.** It is the long string between `/d/` and
   `/edit`.
2. **The worksheet name is the tab name at the bottom of the sheet**, not the
   file name. If it is ambiguous, the sync refuses rather than guessing.

The first sync reads the whole sheet. That is intentional and safe — rows are
matched idempotently, so re-running a sync never duplicates.

Rows with an undialable phone number go to **Quarantine** with the reason.
They are never dropped. Fix the number, replay the row.

## Settings you will actually change

Every tunable number lives in **Admin → Settings**, not in code. Changing a
target is an ops action, not a deployment.

| Setting | Now | What it controls |
|---|---|---|
| `dial.daily_target_per_caller` | {{setting:dial.daily_target_per_caller}} | The dial target on every caller's brief |
| `sla.immediate_first_touch_minutes` | {{setting:sla.immediate_first_touch_minutes}} | How long an immediate lead may go untouched |
| `sla.untouched_reassign_minutes` | {{setting:sla.untouched_reassign_minutes}} | The retired sweep — 0 keeps leads with their caller |
| `escalation.counsellor_daily_cap` | {{setting:escalation.counsellor_daily_cap}} | Most caller→counsellor hand-ups per counsellor per day |
| `distribution.ace_share_pct` | {{setting:distribution.ace_share_pct}} | ACE's guaranteed share of fresh leads |
| `distribution.max_catchup_leads` | {{setting:distribution.max_catchup_leads}} | Catch-up cap for someone returning |
| `lead.max_transfers` | {{setting:lead.max_transfers}} | Transfers before a lead goes to nurture |
| `dial.min_talk_seconds_for_connect` | {{setting:dial.min_talk_seconds_for_connect}} | What counts as a real connect |
| `finance.monthly_breakeven_inr` | {{setting:finance.monthly_breakeven_inr}} | The office breakeven behind every target |
| `freeze.start_minutes` / `freeze.end_minutes` | {{setting:freeze.start_minutes}} / {{setting:freeze.end_minutes}} | The lunch freeze window |
| `reminder.morning_minutes` | {{setting:reminder.morning_minutes}} | When the morning brief goes out |

## Keeping the floor on current data

**Admin → Data** parks every lead created before a date you pick — and not
worked since it — into **Previous months**: out of every pipeline, alert and
fresh list, still searchable, one click from being worked again. Two steps on
purpose: first it tells you exactly how many would move, then you press
Archive. Nothing is ever deleted, and paying clients are never touched. Use it
after a launch so the first sheet sync's months of history do not bury the
floor.

## Tiers — ranked daily, overridable by a person

**ACE is picked automatically every day**: each team's best caller on the
leaderboard over the last {{setting:tier.rank_window_days}} completed days —
with at least {{setting:tier.min_dials_to_rank}} dials in that window —
becomes ACE and holds the guaranteed
{{setting:distribution.ace_share_pct}}% of the team's fresh leads. The pick
changes overnight, never mid-day, and the ranking never sets RESTRICTED on
its own. `tier.auto_rank` switches the whole thing off.

Pinning someone to **RESTRICTED** or **ACE** (Admin → Users → Tier) outranks
the ranking. A pin requires a **reason**, may carry an **expiry date**, and
is written to the audit log under your name. When the expiry passes, the seat
returns to the daily ranking automatically.

Do not use a pin as a substitute for a conversation. The person can see the
tier, and they should hear the reason from you before they read it on a screen.

## Security

**Admin → Security alerts** shows bulk-read detection and out-of-hours access.
Callers cannot see this screen at all.

Acknowledge alerts you have investigated so the list stays meaningful. A list
nobody clears is a list nobody reads.

## Backups

Run `backup.sh` daily. Two rules that have already cost time once:

- **Never run `backup.sh` before restoring on the same day.** It overwrites
  that date's dump — you would destroy the thing you are about to restore from.
- **Never point `rebuild.sh` at production.** It drops the database. It is a
  development tool.

After any restore, run `migrate.sh` — a dump taken before today's migrations
does not contain them.

Copy dumps off the server regularly. A backup on the same droplet as the
database is not a backup.

## Corrections

Nothing is hard-deleted; the application has no delete privilege at all. To fix
something, correct it forward — a new payment, a new touchpoint, a status
change — and the audit log carries the whole story.

```quiz
[
  {
    "q": "You need to restore this morning's data. What must you NOT do first?",
    "options": ["Stop the app", "Run backup.sh — it would overwrite the dump you need", "Tell the team"],
    "answer": 1,
    "why": "backup.sh overwrites the same date's file."
  },
  {
    "q": "Where is the daily dial target changed?",
    "options": ["In the code, needs a deploy", "Admin → Settings"],
    "answer": 1,
    "why": "Every tunable number is a setting. Changing a target is an ops action."
  },
  {
    "q": "What does a tier pin require?",
    "options": ["Nothing, just pick a tier", "A written reason and an expiry date, logged under your name"],
    "answer": 1,
    "why": "It is a personnel decision and it is recorded as one."
  },
  {
    "q": "A row failed to import because the phone number is unusable.",
    "options": ["It was dropped", "It is in Quarantine with the reason, fixable and replayable"],
    "answer": 1,
    "why": "Nothing is ever dropped."
  }
]
```
