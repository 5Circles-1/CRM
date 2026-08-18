---
title: The Counsellor's job
audience: counsellor
order: 4
summary: Walk-ins, follow-up cadence, collections, transfers, imports and running your team.
---

## Your day, in order

1. **Start shift.**
2. **Check today's walk-ins** on My Pipeline — these people are physically
   coming in. Nothing outranks them.
3. **Clear the bell**, then work overdue follow-ups.
4. **Read the Floor tab** once mid-morning and once mid-afternoon: leaderboard,
   who is on shift, and the leak list.
5. **Work the leak list to zero** before you leave.

## What only you can do

- **Transfer a lead** that has already been called. Callers cannot. You are the
  team lead, and the point of the rule is that difficult leads cannot be
  quietly passed around until nobody owns them.
- **Book a deal** and record payments.
- **See your whole team's** leads and numbers.

Every transfer takes a reason. It goes in the audit log with your name on it.

## Walk-ins

A caller books the walk-in; it appears on your pipeline. When the person
arrives, work them through and record the outcome the same day. A walk-in
recorded three days later is not data anybody can act on.

## Follow-up cadence

The floor thinks in follow-up rounds — FU1 through FU5 — and **Find lead**
filters by exactly that. A lead that has had five follow-ups with no movement
should be closed or moved to nurture, not carried forever. Carrying dead leads
inflates your pipeline and hides the real number.

## The chasing stays with you

Closing the deal does not end your job. **The counsellor who closed the deal
chases the instalments.** Outstanding payments is your tab, permanently.

- Record a **promise to pay** as a structured promise, not a note. That is what
  turns chasing into forecasting.
- Overdue instalments are flagged automatically.
- Money is recorded in rupees to the paisa. Never round.

## Collections — the client book

Once someone has paid, they appear on **Collections** (the tab that used to be
called Advisory clients) with three compliance checkpoints: **added to the
client group**, **KYC done** and **MITC signed**. Highlighted rows are the
dangerous ones — money collected and a checkpoint still open. The **Paperwork
open** filter shows only those.

Ticks are one-way and record who ticked them and when. Service delivery itself
is not done here; it belongs to the advisory pipeline.

If a client paid outside the CRM — an offline sale, a migrated record — use
**Add a client**. It creates a real lead, deal and payment so they behave like
everyone else, and marks them *manual*. Anyone who pays through the CRM is
added automatically and never needs it. A client buying a **second product**
is entered the same way — a new deal joins the same person; only the same
product twice is refused. Typos are fixed with **Edit** on the row, and every
correction is written into the client's history with old and new values.

## Untouched leads, read as a signal

Leads are never swept between callers any more — an untouched lead stays with
its caller and shows as waiting on **Fresh leads** and **Floor → Lead flow**.
A caller whose untouched count keeps growing is not a system problem, it is a
coaching signal, and moving the lead is now your call: **Transfer** it by hand
if it genuinely needs another voice.

Leads your callers could not reach twice arrive on your own pipeline to tap —
at most {{setting:escalation.counsellor_daily_cap}} a day, so the hand-ups are
a workable list rather than a flood. Past the cap they stay with the caller,
badged **📵 Not answered ×2**, and the "Not answered — reassign?" queue on the
Floor still lists the worst of them for a manual decision.

## Watching your callers, honestly

**Performance** shows dials, connects, talk time, walk-ins booked and
conversion per person.

Read it with care:

- A caller with **zero dials** shows "—", not 0%. There is no denominator. A
  0% would rank idleness alongside effort.
- **Unverified dials** — logged calls with no matching entry in the phone's
  call log — are the single strongest signal that numbers are being invented.
  One or two is noise. A pattern is a conversation.
- **Connects need real talk time.** Someone with many "connects" all just over
  the threshold is worth a listen.

## Offline imports

Old lists and previous months can be uploaded. They land in **Previous months**,
parked out of the live queue so they never pollute today's pipeline, and stay
fully tappable for re-tap campaigns.

## Your daily brief

At 09:30, 16:00 and 20:30 you get a brief with the month's arithmetic: what is
left to collect, how many working days remain, the run-rate that now requires,
and the pace you are actually running. The 16:00 one stays silent if you are on
pace.

```quiz
[
  {
    "q": "A deal is closed and handed off. Who chases the instalments?",
    "options": ["Accounts", "The counsellor who closed it", "Nobody — it is automatic"],
    "answer": 1,
    "why": "Collections stays with the closer, permanently."
  },
  {
    "q": "A caller shows 40 dials and 38 unverified. What is that?",
    "options": ["Normal", "The strongest available signal that calls are being invented", "A phone fault"],
    "answer": 1,
    "why": "Unverified means no matching call on the device log."
  },
  {
    "q": "Why does a caller with no dials show '—' instead of 0%?",
    "options": ["A display bug", "There is no denominator — 0% would rank idleness beside effort"],
    "answer": 1,
    "why": "Empty components are excluded, not scored as zero or full."
  },
  {
    "q": "Money is in and MITC is not ticked. Where does that show?",
    "options": ["Nowhere", "A highlighted row on Collections"],
    "answer": 1,
    "why": "That single state is what the screen exists to make impossible to miss."
  }
]
```
