---
title: How leads are distributed
audience: all
order: 2
summary: Tiers, the two-thirds rule, what happens when you are not logged in, the lunch freeze, and transfers.
---

> The numbers on this page are read live from the system's own configuration.
> If an admin changes a setting, this page changes with it. Training cannot
> drift from reality here.

## Where leads come from

Leads arrive from the Meta-connected Google Sheet and are shared **alternately
between the two teams**, then handed out **inside** each team. They also arrive
from the website form and from offline imports.

## Who gets the next lead

Not a strict A-B-A-B counter. Strict alternation punishes anyone who steps
away: the cursor lands on them, they are skipped, and they never catch back up.

Instead, among the callers **actually on the floor**, the one with the **fewest
leads today** gets the next one. Rotation order breaks a tie. When everyone is
present and level, that produces exactly A-B-A-B — but nobody is starved for
taking a break.

If you come back after time away, you catch up — but only by up to
**{{setting:distribution.max_catchup_leads}} leads**, so you are not buried the
moment you sit down.

## The three tiers

Fresh leads follow performance. Every caller is in one of three tiers:

| Tier | Share of fresh leads |
|---|---|
| **ACE** | Holds **{{setting:distribution.ace_share_pct}}%** of the team's fresh leads |
| **STANDARD** | Splits the rest equally |
| **RESTRICTED** | Receives **no** fresh leads |

Tiers are decided by **walk-in conversion measured against everyone else** —
best relative performance, not a fixed quota you must hit. An admin can also
**pin** someone to a tier. A pin always carries a **named decision-maker, a
written reason and an expiry date**, all recorded in the audit log. When the
expiry passes, the pin lapses on its own and the person returns to STANDARD.

### If you are RESTRICTED

The road back is real, and it is worked rather than waited for.

You still receive **internal transfers, re-tap lists and offline imports** —
and conversions earned on those count **exactly the same** toward the ranking
that decides tiers. The metric is walk-in conversion, and a walk-in booked off
a re-tapped lead is worth every bit as much as one off a fresh lead.

Nobody is restricted by a formula alone. A pin is a management decision you can
see, with a reason attached, and you can ask about it.

## What happens when you are not logged in

Distribution only counts people **on shift today**. If you have not started
your shift, you are passed over — and the pass-over is written to the audit log
with the reason, so "why am I not getting leads?" always has an answer. The
**Floor → Lead flow** panel shows it directly.

If nobody in a team is on the floor, the lead is **held at team level**, not
forced onto an absent person. It is handed out the moment someone starts a
shift.

## The ten-minute rule

A **new** lead you have not called within **{{setting:sla.untouched_reassign_minutes}}
working minutes** moves to the next caller in the team. Then the next. Once
everybody has had their turn, it comes **back to whoever had it first**, and
stays with them — a lead circulating forever is how a pipeline leaks while
looking busy.

This only applies to leads **nobody has called yet**. A lead you have already
dialled never moves on its own.

## The lunch freeze

Between **14:00 and 14:30** the clock stops. No lead breaches, no SLA runs, the
ten-minute sweep pauses and no escalation fires. A banner counts it down. Work
carries on if you want to — nothing is blocked — but the system will not hold
that half hour against anybody.

## Immediate leads

A lead marked **immediate** must be contacted within
**{{setting:sla.immediate_first_touch_minutes}} working minutes**. These are
people who asked to be called back right now.

## Transfers

**Only a counsellor or an admin can transfer a lead.** Callers cannot push
leads off their own list — if they could, difficult leads would circulate
forever and nobody would own anything.

A lead can be transferred at most **{{setting:lead.max_transfers}} times**.
After that it goes to nurture rather than round the floor again.

Automatic movement (the ten-minute rule, escalation) is separate and does not
count against you.

```quiz
[
  {
    "q": "You took a two-hour break. What happens when you come back?",
    "options": ["You are skipped for the rest of the day", "You catch up, but only by a capped number of leads", "You get every lead you missed at once"],
    "answer": 1,
    "why": "Least-loaded wins, so you catch up — but catch-up is capped so you are not buried."
  },
  {
    "q": "You are RESTRICTED. How do you get out?",
    "options": ["Wait for the pin to expire", "Convert walk-ins from transfers, re-taps and imports — they count the same", "Ask for fresh leads"],
    "answer": 1,
    "why": "The exit metric is walk-in conversion, and it does not care where the lead came from."
  },
  {
    "q": "Who can transfer a lead that has already been called once?",
    "options": ["Any caller", "Only a counsellor or admin", "Nobody"],
    "answer": 1,
    "why": "Callers cannot push leads off their own list."
  },
  {
    "q": "It is 14:10 and a follow-up was due at 14:05. Are you breaching?",
    "options": ["Yes", "No — the clock is frozen for lunch until 14:30"],
    "answer": 1,
    "why": "Nothing breaches during the freeze."
  }
]
```
