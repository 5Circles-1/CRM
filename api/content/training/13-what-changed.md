---
title: What changed recently
audience: all
order: 13
summary: Everything added or changed in the last release, why, and what it means for your day.
---

Read this once. Each entry says what changed, why, and what you should do
differently — if anything.

## Far fewer popups

**What changed.** Eight kinds of alert used to interrupt you. Now only two do:
a **callback that is due**, and one a few minutes **before** it is due.

**Why.** A popup every few minutes trains people to dismiss without reading,
and then a genuine callback gets clicked away with everything else.

**What it means for you.** Nothing is suppressed. Every other alert still
appears in the 🔔 bell, still counts in the badge, and still has a row on the
**Alerts** tab. You now go to them rather than being interrupted by them — so
**check the bell yourself** at the start of the day, after lunch, and before you
leave.

## A new Alerts tab

**What changed.** Everything waiting on you, grouped by what is wrong, on one
page you can actually work through. The bell shows a summary and the most
urgent twelve; this tab has all of it.

**What it means for you.** Tap any name to open the lead. If you genuinely
cannot get to something today, reschedule it — 1 hour, 3 hours, or tomorrow
morning. That decision is written into the lead's own history.

**What you cannot do:** simply mark a lead alert as "read". An overdue
follow-up is a promise to a customer; the only honest ways to clear it are to
work it or to move it.

## A new Fresh leads tab

**What changed.** Every lead **nobody has ever spoken to**, in one list,
flagged **in time** / **late** / **badly late**.

**Why.** This is the most recoverable money on the floor and it was the easiest
thing to overlook — especially leads sitting with **no caller at all**, which
appear in nobody's personal pipeline.

**What it means for you.** Start your day here and work it to empty. A late
fresh lead is never hidden or re-labelled: it stays on this list until somebody
actually calls. Counsellors, admins, ops and the founder can switch to **Whole
floor** to see leads nobody owns.

## A new Re-tap tab, and no more nagging about no-answers

**What changed.** After **{{setting:alert.na_quiet_after_attempts}} no-answers
in a row**, a lead goes **quiet**: it stops raising alerts and moves to the
**Re-tap** tab. Once every **{{setting:retap.reminder_days}} days** you get
**one** notification saying how many are waiting — never one per lead.

**Why.** A handful of people who never pick up were generating a hundred red
alerts between them.

**What it means for you.** Quiet does not mean lost. The lead keeps its next
action, is still yours, still appears in Find lead, and still counts in every
leakage figure. Work the Re-tap tab as a batch, longest silence first. A
WhatsApp often restarts one of these when a call will not.

## The lead history stopped repeating itself

**What changed.** A lead waiting with no caller used to record "held for shift
start" in its own history **every single minute**. Some leads had hundreds of
identical rows. That is fixed: a hold is now recorded once, and again only if
the situation genuinely changes.

**What it means for you.** Lead timelines are readable again. Older duplicate
rows are still there — history is never deleted here — but they are folded into
one line with a count.

## Lead flow now tells you *why*

**What changed.** The Floor tab used to say "83 leads waiting with no caller"
while two callers were visibly working. Both were true: the waiting leads
belonged to the other team. It now names the team and the exact blocker —
nobody on shift, everyone on the floor restricted, no callers in the team, or
leads belonging to no team at all.

**What it means for you.** Counsellors and admins: each reason names the fix.
Admins also get a **Hand out now** button.

## A daily brief

**What changed.** At 09:30, 16:00 and 20:30 you get a short brief with your own
numbers. Callers: leads in hand, untouched, callbacks, dial target. Counsellors:
what is left to collect this month, working days remaining, the run-rate that
requires, and the pace you are actually running. The 16:00 one stays silent if
you are on pace. There is also a **Today** strip across the top of every screen.

## Advisory clients: three checkpoints, and manual entry

**What changed.** The register now has **three** one-way ticks — **added to the
client group**, **KYC done**, **MITC signed** — with a *Paperwork open* filter.
There is also **Add a client** for someone who paid outside the CRM.

**What it means for you.** Anyone who pays *through* the CRM still appears
automatically; you never need the button for them.

## Mentors

**What changed.** Every paying client, whatever product they bought, with a
computed health chip and three-tap touchpoint logging. Clients whose paperwork
is unfinished carry a *paperwork open* chip.

## Events

**What changed.** A tab for seminars and webinars with a roster. Importing
leads **copies** them — the original keeps its owner, stage and history — which
is why both teams can work the same roster.

## Training, and this academy

**What changed.** All of this documentation now lives inside the CRM instead of
in a document nobody opens. Modules are role-aware, searchable, and quote the
system's **live** settings, so training cannot drift from reality. There is a
glossary of every screen element and a dictionary of **every term**.

**What it means for you.** Finish your track. The banner on the Training tab
tells you what you still owe, and a module that changes asks to be read again.

## Everything else

- **Dark mode** is complete — the ◐ button top-right. White bands on dark
  screens are fixed.
- The **browser tab** shows the plain product name again, with no count.
- **Searching a name** in Find lead returns matches instead of your whole book.
- Auto-logout after an hour never costs you time — your shift ends at your last
  real action.

```quiz
[
  {
    "q": "Fewer popups — does that mean some alerts are now hidden?",
    "options": ["Yes, low-priority ones are dropped", "No — everything is still in the bell and the Alerts tab; only the interrupting stopped"],
    "answer": 1,
    "why": "Being nagged about a lead and losing a lead are different problems."
  },
  {
    "q": "A fresh lead passes its deadline. Where does it go?",
    "options": ["It stays on the Fresh leads tab, flagged", "It is moved to Overdue", "It is closed"],
    "answer": 0,
    "why": "It stays until somebody actually calls the person."
  },
  {
    "q": "Which screen should you start your day on?",
    "options": ["Dashboards", "Fresh leads, then the bell", "Performance"],
    "answer": 1,
    "why": "Nobody has ever spoken to those people, and the bell is what is already owed."
  }
]
```
