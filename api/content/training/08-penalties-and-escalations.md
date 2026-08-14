---
title: Penalties and escalations
audience: all
order: 8
summary: What behaviour triggers what consequence — stated precisely, with no ambiguity.
---

This page exists so that nothing on it is ever a surprise. Every consequence
below is automatic unless it says a person decides it.

## Automatic — the system does this, immediately, to everyone equally

| Behaviour | Consequence | When |
|---|---|---|
| A new lead not dialled | It moves to the next caller | After {{setting:sla.untouched_reassign_minutes}} working minutes |
| Nobody in the team dials it | It returns to the first caller and stays there | After everyone has had a turn |
| Two no-connect attempts | The lead escalates to the counsellor | Immediately on the second |
| Shift not started | You receive no fresh leads | Until you start |
| One hour with no activity | Signed out; shift ends at your last real action | Hourly check |
| A lead transferred {{setting:lead.max_transfers}} times | It goes to nurture, out of the live pipeline | On the next transfer attempt |
| A callback time passes with no call | Marked missed; it counts against callback adherence in your score | Within 5 minutes |
| An instalment passes its due date | Flagged overdue on Outstanding payments | Hourly |
| A connect logged under {{setting:dial.min_talk_seconds_for_connect}} seconds | Not counted as a connect in any rate | At once |
| Reading an unusual volume of leads | A security alert is raised for an admin | Within 5 minutes |
| Access outside working hours | A security alert is raised | Within 15 minutes |

## Ranked — the system measures, and position follows

**Tier placement** follows walk-in conversion measured against everyone else,
recomputed regularly. Falling to RESTRICTED means no fresh leads until it
recovers. Transfers, re-taps and imports still flow to you and count fully.

**Your score** excludes components with nothing to measure rather than awarding
full marks for them. Doing nothing does not protect a score.

## Decided by a person — and recorded

| Action | Who | What is required |
|---|---|---|
| Transferring a lead already called | Counsellor or admin | A reason, logged |
| Pinning someone to a tier | Admin | A written reason **and** an expiry date, logged under their name |
| Resetting a password | Admin | Logged |
| Changing a target or SLA | Admin | Logged; it changes everyone's numbers |
| Acknowledging a security alert | Admin | Logged |

Every one of these is in the audit log with a name and a timestamp. That
protects the person doing it as much as the person it is done to.

## What is never a penalty

- **Auto-logout.** Your hours are backdated to your last real action.
- **The lunch freeze.** Nothing breaches between 14:00 and 14:30.
- **Sunday.** The clock does not run at all.
- **A lead the sweep moved away from you before you could reach it**, if you
  were on another call — the pass-over is recorded with its reason, and the
  reason is visible.
- **An honest bad disposition.** Logging *not interested* truthfully is doing
  the job correctly, not failing at it.

## What is treated seriously

**Inventing activity.** Logged calls that never happened, connects with no talk
time, dispositions chosen to look good. This is the one behaviour the system is
explicitly built to detect — unverified dials, sub-threshold connects, and
device-log mismatches all surface it.

It is treated seriously because it is not a private matter: fabricated
dispositions corrupt the conversion rates that decide tiers, targets and
staffing for everybody on the floor.

```quiz
[
  {
    "q": "Is being auto-logged-out a penalty?",
    "options": ["Yes, you lose the hour", "No — hours backdate to your last real action"],
    "answer": 1,
    "why": "It is a tidy-up, not a punishment."
  },
  {
    "q": "How many no-connect attempts before a lead escalates to the counsellor?",
    "options": ["One", "Two", "Five"],
    "answer": 1,
    "why": "Two no-connect caller attempts and it moves up."
  },
  {
    "q": "What must an admin supply to pin someone to a tier?",
    "options": ["Nothing", "A written reason and an expiry date, under their own name"],
    "answer": 1,
    "why": "Pins are personnel decisions and expire on their own."
  },
  {
    "q": "Why is inventing call activity treated as serious rather than private?",
    "options": ["It looks bad", "It corrupts the conversion rates that set tiers and targets for everyone"],
    "answer": 1,
    "why": "The damage is to the whole floor's numbers, not just your own."
  }
]
```
