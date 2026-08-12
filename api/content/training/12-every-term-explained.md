---
title: Every term explained
audience: all
order: 12
summary: A to Z. Every word this CRM uses, in plain English, with the live numbers where there are any.
---

If a word on any screen is not clear, it is here. Terms are alphabetical.
Numbers in bold are read live from the system's own settings, so this page
cannot go out of date.

## A

**ACE** — the top performance tier. An ACE caller receives
**{{setting:distribution.ace_share_pct}}%** of their team's fresh leads. It is
earned on walk-in conversion measured against everyone else, and recalculated —
it is not permanent.

**Alert** — something waiting on you: an overdue follow-up, a callback, a new
lead. Alerts appear in the 🔔 bell and on the **Alerts** tab. Only callbacks
interrupt with a popup.

**Append-only** — a record that can be added to but never edited or deleted.
Call attempts, lead history and mentor touchpoints are all append-only. To
correct something you add a new entry; the original stays.

**Assigned** — a lead has been given to a specific caller. Until then it is
*held* at team level.

**Attempt** — one logged call. Counted whether or not anyone answered.

**Audit log** — the permanent record of who changed what and when. Transfers,
tier pins, password resets and setting changes all land there.

## B

**Badly late** — on the Fresh leads tab, a lead never contacted and now well
past its deadline (over **{{setting:sla.breached_after_minutes}}** working
minutes).

**Breach / Breached** — past a promised time. A first-contact breach means an
immediate lead went untouched beyond **{{setting:sla.immediate_first_touch_minutes}}**
working minutes. Nothing breaches outside working hours, on a Sunday, or during
the lunch freeze.

**Bucket** — the group a lead falls into on My Pipeline: immediate, fresh,
callback, overdue and so on. One lead is in exactly one bucket, chosen by the
most urgent true thing about it.

## C

**Callback** — a time the customer themselves asked to be called. The one thing
that always interrupts, and the most expensive thing on the floor to miss.

**Catch-up cap** — when you return after time away you receive extra leads to
level up, but no more than **{{setting:distribution.max_catchup_leads}}** so you
are not buried.

**Connect** — a call where you actually spoke, meaning talk time above
**{{setting:dial.min_talk_seconds_for_connect}} seconds**. A shorter "connected"
call is not counted as a connect anywhere.

**Conversion** — a lead that became a paying customer. Conversion rate is
calculated over people who could realistically have bought, which is why wrong
numbers and job enquiries must be logged as such.

## D

**Deferred** — the distribution engine looked at a lead and could not hand it
out, usually because nobody from its team is on shift. Recorded once per
episode, not once per attempt.

**Disposition** — what happened on a call: connected, not answered, switched
off, wrong number, job enquiry and so on. Every rate in the CRM is built on
these, which is why honest dispositions matter more than flattering ones.

## E

**Escalation** — a lead moving up from caller to counsellor. Happens
automatically after two no-connect attempts.

**Event** — a seminar, webinar or office day, with a roster of invitees.

## F

**First touch** — the very first contact attempt on a lead. The deadline for it
is the first-touch SLA.

**Flagged** — on Fresh leads, a never-contacted lead now past its deadline. It
stays on the list, flagged, until somebody actually calls.

**Freeze / Circuit breaker** — the lunch window,
**{{setting:freeze.start_minutes}}**–**{{setting:freeze.end_minutes}}** minutes
into the day (14:00–14:30). The clock stops, nothing breaches, and the automatic
engines pause.

**Fresh lead** — a lead nobody has ever contacted. Has its own tab.

**FU1…FU5** — follow-up rounds one to five: how many attempts a lead has had.
**Find lead** filters by exactly this.

## G

**Group added** — the first of the three advisory checkpoints: the paying
client has been added to the client group.

## H

**Handoff** — passing a paid client from this sales CRM to the advisory
pipeline. Collections stays here regardless.

**Health chip** — the green / amber / red dot on a mentor's client. Computed
from touchpoint recency and outcome; never set by hand.

**Held** — a lead waiting at team level with no caller yet.

## I

**Immediate** — a lead who asked to be contacted right now. Must be reached
within **{{setting:sla.immediate_first_touch_minutes}}** working minutes.

**Instalment** — one scheduled part-payment of a deal.

**Invalid** — not a real prospect at all. Not the same as *not interested*.

## J

**Job enquiry** — somebody asking about a vacancy, not the product. Log it as
this, never as *not interested* — they were never a prospect and marking them
lost damages everyone's conversion rate.

## K

**KYC** — Know Your Customer. The second advisory checkpoint.

## L

**Leakage** — anything sitting where it should not be: overdue, untouched,
unowned. The Floor tab lists it; an empty list means a clean pipeline.

**Lead flow** — the Floor panel explaining why each caller is or is not
receiving leads, and why any leads are waiting.

## M

**Manual client** — a paying client entered by hand because they paid outside
the CRM. Marked *manual* so reporting stays honest.

**MITC** — Most Important Terms and Conditions. The third advisory checkpoint;
signed before paid advisory is delivered.

## N

**NA streak / No-answer streak** — consecutive calls with no answer. Past
**{{setting:alert.na_quiet_after_attempts}}** the lead goes quiet and moves to
the Re-tap tab.

**Next action** — the scheduled next step every open lead must carry. The
database refuses to store an open lead without one. This is the anti-leakage
rule.

**Nurture** — parked, out of the live queue, still searchable. Where a lead goes
after **{{setting:lead.max_transfers}}** transfers or once attempts are
exhausted.

## O

**Overdue** — past the next action time you promised, inside working hours.

## P

**Parked** — moved out of the live queue without being closed.

**Passed over** — the engine considered a caller and skipped them, with a
reason: off shift, or restricted. Visible on Floor → Lead flow.

**Promise to pay** — a structured commitment to pay by a date. Recorded as a
promise, not a note, which is what turns chasing into forecasting.

## Q

**Quiet** — a lead that has stopped raising alerts because it went unanswered
repeatedly. Still open, still owned, still counted. Only the interrupting stops.

**Quarantine** — imported rows with an undialable phone number. Never dropped;
fixable and replayable.

## R

**Re-tap** — calling somebody again who was contacted before. Also the tab
holding leads that went quiet.

**RESTRICTED** — the tier that receives no fresh leads. Still receives
transfers, re-taps and offline imports, and conversions on those count exactly
the same toward getting out.

**Roster** — the list of people invited to an event. Roster rows are copies;
the original leads are never modified.

**RLS (Row-level security)** — the database itself deciding which rows you can
see. It is why a lead you do not own reads as "not found" rather than being
hidden by the menu.

## S

**SLA** — the promised time limit for an action. First contact has one;
follow-ups have one.

**Setter** — the caller who set up a deal; shares credit with the closer.

**Shift** — your working session. Press **Start shift** on arrival: no shift
means no fresh leads and no hours counted.

**STANDARD** — the middle tier. Splits whatever fresh leads ACE does not take.

## T

**Talk time** — how long you actually spoke, in MM:SS.

**Ten-minute rule** — a new lead not dialled within
**{{setting:sla.untouched_reassign_minutes}}** working minutes moves to the next
caller, round the team, then back to whoever had it first.

**Tier** — ACE, STANDARD or RESTRICTED. Decides your share of fresh leads.

**Touchpoint** — a mentor's logged contact with a paying client. Append-only.

**Transfer** — moving a lead to another caller. Only a counsellor or admin may
do it, always with a reason, capped at **{{setting:lead.max_transfers}}**.

## U

**Unverified dial** — a logged call with no matching entry in the phone's own
call log. One or two is noise; a pattern is a conversation.

**Untouched** — assigned but never dialled.

**Upsell potential** — a mentor's High / Medium / Low flag on a paying client,
which builds the warm pipeline counsellors work.

## V

**Verified** — a logged call matched to the phone's call log by the companion
app. These are the numbers nobody can argue with.

## W

**Walk-in** — a customer physically coming to the office. Booked from the call
screen, and the number the floor is really judged on.

**Warm pipeline** — upsell-flagged paying clients, pre-qualified for a call.

**Working minutes** — time counted only inside working hours: Monday to
Saturday, 09:30–18:30 IST, minus the lunch freeze. Every deadline in the CRM is
measured in these, never in wall-clock hours.

```quiz
[
  {
    "q": "What is a 'connect'?",
    "options": ["Any answered call", "A call with real talk time above the threshold", "Any dial"],
    "answer": 1,
    "why": "Below the minimum talk time it is not counted as a connect anywhere."
  },
  {
    "q": "A lead is 'quiet'. What does that mean?",
    "options": ["It was closed", "It stopped raising alerts but is still open, owned and counted", "It went to another team"],
    "answer": 1,
    "why": "Quiet is about the bell, not the pipeline."
  },
  {
    "q": "What are 'working minutes'?",
    "options": ["Wall-clock minutes", "Minutes inside Mon-Sat 09:30-18:30, minus the lunch freeze"],
    "answer": 1,
    "why": "Every deadline in the CRM is measured this way."
  },
  {
    "q": "What are the three advisory checkpoints?",
    "options": ["KYC, MITC, payment", "Group added, KYC, MITC", "MITC, contract, invoice"],
    "answer": 1,
    "why": "All three must be ticked before paid advisory is delivered."
  }
]
```
