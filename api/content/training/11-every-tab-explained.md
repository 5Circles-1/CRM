---
title: Every tab, explained
audience: all
order: 11
summary: What each tab is for, who sees it, what to do on it, and the one mistake people make there.
---

One section per tab. If you only ever read one page of this academy, read this
one — then use the **?** beside any page title to come back to the right part.

## My Pipeline

**Who sees it:** callers and counsellors.
**What it is:** your work for today, already in the order it should be done —
immediate leads, then overdue, then due today, then the rest.
**What to do:** start at the top and go down. Log each call as you finish it.
**The mistake:** re-sorting it looking for "easy" leads. The order is the
priority; working out of order is how a promise gets missed.

## Fresh leads

**Who sees it:** callers, counsellors, admins, ops.
**What it is:** every lead **nobody has ever spoken to**. It is the one list
that answers "did something arrive and just sit there?" — and it covers leads
held with no caller at all, which appear in nobody's personal pipeline.
**What to do:** work it to empty. Rows are flagged **in time**, **late** or
**badly late** against the first-touch deadline. A late fresh lead is never
demoted or hidden — it stays on this list, flagged, until somebody actually
speaks to the person. One real attempt removes it for good.
**Counsellors and admins** can switch to *Whole floor* to see leads with no
caller — if any appear there, check **Floor → Lead flow** for the reason.
**The mistake:** assuming your own pipeline covers it. It does not show leads
nobody owns yet.

## Alerts

**Who sees it:** everyone except viewers.
**What it is:** everything waiting on you, grouped by what is wrong — SLA
breached, callbacks due, follow-ups overdue, new leads. The bell in the top bar
is the glance; this is the list you sit down with.
**What to do:** tap a name to open the lead and work it. If you genuinely
cannot get to something today, reschedule it — 1 hour, 3 hours, or tomorrow
morning — and the new time is written into the lead's own history.
**Only two things interrupt you with a popup:** a callback that is due, and one
a few minutes before it is due. Both are appointments the customer chose a time
for. Everything else waits quietly in the bell and on this page — nothing is
suppressed, it just does not interrupt.
**The mistake:** treating rescheduling as clearing. Moving a promise is a
decision about a customer, and the lead records who moved it.

## Re-tap

**Who sees it:** callers, counsellors, admins, ops.
**What it is:** leads that have gone unanswered more than
{{setting:alert.na_quiet_after_attempts}} times in a row. They raise **no**
alerts — that is the whole point — and live here until worked as a batch.
**What to do:** work top down, longest silence first. Filter by "Silent 7
days+" or "No WhatsApp sent". You get one reminder every
{{setting:retap.reminder_days}} days that they are waiting, never one per lead.
**The mistake:** thinking a quiet lead is a dead lead. It is still open, still
yours, still counted — it just stopped shouting. Close it properly if it truly
will never answer.

## Floor

**Who sees it:** counsellors and admins.
**What it is:** the live floor — leaderboard, who is on shift, the follow-up
radar, pipeline leakage, and **Lead flow**.
**What to do:** read it twice a day. Work the leak list to zero before you
leave.
**Lead flow** is the panel that answers "why is X not getting leads?" and "why
are leads waiting?". It names the blocking rule per team: nobody on shift,
everyone on the floor restricted, no callers in the team, or leads belonging to
no team at all. Each reason names the fix.
**The mistake:** reading a floor-wide "leads waiting" number and assuming the
whole floor is starved. Check the per-team breakdown — usually one team is
working and the other has nobody on shift.

## Collections — the client book

*(This tab used to be called Advisory clients.)*

**Who sees it:** counsellors, admins, ops, viewers.
**What it is:** every client who has **paid** — one row per product bought, so
a client who bought two programmes appears twice, which is the truth. Each row
shows **who converted them** (and their team), **where the lead came from**,
and the three checkpoints that gate paid advisory:

1. **Group** — added to the client group
2. **KYC** — completed
3. **MITC** — signed

**What to do:** work the highlighted rows. A highlighted row means money is in
and at least one checkpoint is still open. Ticks are one-way and record who
ticked them and when. Use the **Paperwork open** filter to see only those.
**Adding a client by hand:** the **Add a client** button is for someone who
paid outside the CRM — an offline sale, a migrated record, a payment taken
before this system. It creates a real lead, deal and payment, so they behave
like every other client, and marks them *manual* so reporting stays honest.
Anyone who pays **through** the CRM appears automatically; you never need the
button for them.
**The form checks the book as you type the phone number.** If the person
already exists it says so right there — who they are, which deals are open,
with whom, and what is outstanding — and offers **Record this payment against
it** in one click. No form gets filled just to be refused at the end. If the
open deal sits with the other team, the form says so and names them; if it is
fully paid, more money for the same product means correcting the amount, not
a second entry.
**Converted by and Lead source:** the form asks who actually made the sale and
where the person originally came from. The counsellor you name gets the deal
on their team and chases the instalments — a counsellor entering their own
sale is preselected, but an admin doing data entry **must** name the closer.
**A second product:** the same person buying another programme is a new entry
with the new product — the CRM adds a second deal to the same client. What it
refuses is the **same** product twice: that is a double-entry, not a purchase.
**Correcting a record:** the **Edit** button on each row fixes typos. Name and
phone can be corrected on any client. Product, amount, **paid date**, mode,
reference, converted-by and source can be corrected only on hand-entered
clients — money that went through the CRM's own flow is an audit record and
stays one, and once a client has more than one payment the original entry is
real history too. Every correction is written into the client's history: what
it was, what it became, and who changed it. Nothing is ever silently
rewritten.
**The mistake:** ticking a checkpoint before it is genuinely done. The tick is
a compliance record for a SEBI-registered firm, not a to-do list item.

## Outstanding payments

*(This tab used to be called Collections.)*

**Who sees it:** counsellors, admins, ops.
**What it is:** money still owed — instalments, promises to pay, who to chase.
**What to do:** record a promise to pay as a structured promise, not a note.
That is what turns chasing into forecasting.
**Punching in a payment:** the **Punch in a payment** button takes a name or
the last digits of a number, an amount and a mode — the CRM spreads it oldest
instalment first and refuses an amount larger than what is outstanding, so a
mistyped zero cannot corrupt the money numbers.
**Somebody new pays:** if the search finds no open deal, you do not leave the
screen — **Punch in for a new client** is right there. It opens the same
Add-a-client form the Collections tab uses, prefilled with what you typed, and
asks two questions that matter: **who converted them** (the deal, its team and
the chasing all follow that counsellor — not whoever did the typing) and
**what the lead source was**. One form, and the client exists everywhere with
the money already recorded.
**The mistake:** thinking the chasing ends at handover. **The counsellor who
closed the deal chases the instalments**, permanently.

## Mentors

**Who sees it:** mentors, counsellors, admins, ops, viewers.
**What it is:** every paying client, whatever product they bought, kept warm —
touchpoints, a computed health chip, and upsell interest.
**What to do:** if you are a mentor, work red first, then amber, oldest silence
first, and log a touchpoint in three taps after every contact. If you are a
counsellor, the **warm pipeline** at the top is a pre-qualified call list.
**Health rules** are in *The Mentor's job* — they are computed, never set by
hand.
**The mistake:** editing a touchpoint. You cannot — the log is append-only. Log
a new one instead.

## Events

**Who sees it:** everyone.
**What it is:** seminars, webinars and office days, with the roster of who was
invited and who came.
**What to do:** create the event, then **Import leads** with a filter. Press
**Preview** first — the count it shows is exactly the number that will be
added. Mark attendance on the day. Work the post-event follow-up list after.
**Importing copies a lead.** The original keeps its owner, stage, next action
and history untouched. That is why both teams can work one roster.
**The mistake:** expecting the event roster to change the pipeline. It never
does — that is the point.

## Dashboards

**Who sees it:** counsellors, admins, ops, viewers.
**What it is:** the charts — conversion, collections over time, the funnel,
pipeline leakage.
**What to do:** read it weekly, or when a number needs explaining.
**The mistake:** using it as a daily to-do list. Dashboards explain; My
Pipeline and Alerts are where work happens.

## Find lead

**Who sees it:** callers, counsellors, admins, ops.
**What it is:** search and filter every lead you are allowed to see. This is
the re-tap tool, and it is the second pipeline.
**What to do:** combine filters. "Not answered + overdue". "Follow-up round 3".
"No WhatsApp sent". Searching digits matches the **end** of a phone number, so
type the last few digits off a missed call.
**Adding a lead by hand:** the **Add lead** button (counsellors, admins, ops)
is for someone who did not come through the sheet — a phone-in, a walk-past, a
referral. Leave "Give it to" on **fair distribution** unless the person asked
for someone by name: manual entry goes through the same engine as every sheet
lead and is not a way to jump the queue. The same number twice is refused,
naming who already has the lead.
**The mistake:** not using it. Most recoverable money on this floor is in
people who were already spoken to once.

## Performance

**Who sees it:** callers, counsellors, admins, ops. A caller sees only
themselves.
**What it is:** dials, connects, talk time, walk-ins booked, conversion.
**What to do:** managers, read it before any coaching conversation.
**The mistake:** reading "—" as zero. A caller with no dials has no
denominator, so no percentage is shown. A 0% would rank idleness beside effort.

## Previous months

**Who sees it:** counsellors, admins, ops, viewers.
**What it is:** older uploaded records, parked out of the live queue but fully
tappable.
**What to do:** run re-tap campaigns from here without polluting today's
pipeline.

## Team

**Who sees it:** everyone.
**What it is:** team chat. Anyone can post, to their own team or the whole floor.

## My Score

**Who sees it:** callers and counsellors.
**What it is:** your score and what each component measures. It is for
self-reflection, not a league table.
**The mistake:** assuming an empty component scores zero. Components with
nothing to measure are excluded and the total is rescaled — doing nothing does
not protect a score.

## Attendance

**Who sees it:** everyone.
**What it is:** your hours, day by day, against the 9-hour expectation.
**The mistake:** forgetting **Start shift**. No shift, no fresh leads, no hours.

## Training

**Who sees it:** everyone.
**What it is:** this academy — modules, a searchable glossary of every button
and badge, a quick check per module and a recorded acknowledgement.
**What to do:** finish your track. The banner tells you what you still owe.

## Admin

**Who sees it:** admins and ops.
**What it is:** users, lead sources, settings, tiers, security alerts,
quarantine.
**What to do:** see *The Admin's job*. Every tunable number is a setting, so
changing a target is an ops action rather than a deployment.

```quiz
[
  {
    "q": "The Floor says leads are waiting for a caller, but two callers are working. What is going on?",
    "options": ["A bug", "The waiting leads belong to a different team — check the per-team reason", "The engine is off"],
    "answer": 1,
    "why": "Lead flow now names the blocked team and the exact rule stopping them."
  },
  {
    "q": "How many checkpoints must be ticked for each client on Collections?",
    "options": ["Two — KYC and MITC", "Three — group added, KYC and MITC"],
    "answer": 1,
    "why": "Added to the client group is the third."
  },
  {
    "q": "A client's name is misspelt and the amount has an extra zero. What can you do?",
    "options": ["Nothing — ask a developer", "Edit on Collections — and the change is written into the client's history", "Delete and re-enter them"],
    "answer": 1,
    "why": "Corrections are allowed, silent rewrites are not: every edit records what it was, what it became, and who changed it. Nothing here is ever deleted."
  },
  {
    "q": "A Traders Discovery client now buys Advisory too. What happens?",
    "options": ["The CRM refuses — one deal per person", "Add them again with the new product — a second deal joins the same client"],
    "answer": 1,
    "why": "One person can hold deals for different products. Only the same product twice is refused, because that is a double-entry."
  },
  {
    "q": "When do you need the 'Add a client' button?",
    "options": ["For every new client", "Only for someone who paid outside the CRM"],
    "answer": 1,
    "why": "Anyone who pays through the CRM appears in both books automatically."
  },
  {
    "q": "A lead has not answered six times. Where is it?",
    "options": ["Deleted", "In the Re-tap tab, raising no alerts but still open and yours", "Closed automatically"],
    "answer": 1,
    "why": "Quiet is about the bell, not the pipeline."
  },
  {
    "q": "You cannot get to 20 overdue follow-ups today.",
    "options": ["Ignore them; they will clear", "Reschedule them from Alerts — the new time is recorded on each lead"],
    "answer": 1,
    "why": "Nothing hides an alert. Moving a promise is a recorded decision."
  }
]
```
