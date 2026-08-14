---
title: The Mentor's job
audience: mentor
order: 5
summary: Touchpoints in three taps, the health-chip rulebook, and spotting upsell honestly.
---

## Who is in your book

Everyone who has **paid**, whatever product or plan they bought. They appear on
the **Mentors** tab automatically the moment money is recorded against their
deal — nobody adds them by hand, and nobody can forget to.

For a client who paid outside the CRM, **Add a client** (admins, ops and
counsellors) enters them properly: it creates the same lead, deal and payment a
normal sale would, so they show up in your book and in the advisory register
together, marked *manual*.

A **paperwork open** chip on a client means their group / KYC / MITC checklist
is unfinished on the Collections tab. It is not your job to tick it, but
it is worth knowing before you call them.

You see paying clients and nothing else. The live sales pipeline is not visible
to you, by design.

## The one habit

**After every contact with a client, log the touchpoint.** Three taps:

1. **Channel** — Call, WhatsApp, Email, In person, Video.
2. **Outcome** — Reached (positive / neutral / concern raised), No answer, Rescheduled.
3. **Upsell potential** — High, Medium, Low, None.

Everything else — a note, what to offer, the next follow-up date — is optional,
but it is what makes the timeline worth reading in six months.

The log is **append-only**. You cannot edit a touchpoint after saving it; log a
new one instead. A relationship history that can be quietly rewritten is
worthless the day it matters.

## The health chip — the exact rules

The colour is **computed**. Nobody sets it by hand, and you cannot override it.
The day-counts below are settings an admin can change.

| Colour | Why | Trigger |
|---|---|---|
| 🔴 **Red** | The last outcome was **concern raised** | immediately |
| 🔴 **Red** | **Never** touched since paying | {{setting:mentor.untouched_red_days}} days after first payment |
| 🔴 **Red** | Gone quiet | last touch older than {{setting:mentor.health_red_days}} days |
| 🔴 **Red** | A promised follow-up is badly late | more than {{setting:mentor.followup_grace_days}} days past it |
| 🟠 **Amber** | Not yet touched, still inside the first week | — |
| 🟠 **Amber** | Touch getting old | last touch older than {{setting:mentor.health_amber_days}} days |
| 🟠 **Amber** | Last attempt did not land | outcome was *no answer* or *rescheduled* |
| 🟠 **Amber** | A follow-up is due today or just slipped | — |
| 🟢 **Green** | Touched recently, went fine, nothing overdue | — |

## How to work the book

**Red first, then amber, oldest silence first.** The default sort already does
this, so working top-down is the right order.

A red client is not a telling-off. It is the system saying *this relationship
is at risk and nobody has been near it* — which is exactly when a call is worth
most.

## Upsell flags build the warm pipeline

When you flag a client **High**, **Medium** or **Low**, they appear in the warm
pipeline that **counsellors** can see and act on. Add a note saying what to
offer.

Flag honestly. A counsellor will call these people, and a wrongly flagged
client gets a sales call they did not want — which is the fastest way to turn a
green client red.

## What is not your job here

Research delivery, consent documents, risk profiling, grievances and the
long-term client record all live in the advisory pipeline, not in this CRM.
This tab is the relationship log and nothing more.

```quiz
[
  {
    "q": "How does a client get into your book?",
    "options": ["An admin adds them", "Automatically, when a payment is recorded", "The counsellor emails you"],
    "answer": 1,
    "why": "Paid means listed. Nobody can forget to add someone."
  },
  {
    "q": "You logged a touchpoint with the wrong outcome. What do you do?",
    "options": ["Edit it", "Log a new one — the record is append-only"],
    "answer": 1,
    "why": "History you can quietly rewrite is worthless the day it matters."
  },
  {
    "q": "A client raised a concern today. What colour are they?",
    "options": ["Green — you just spoke to them", "Red, immediately"],
    "answer": 1,
    "why": "A concern outranks recency."
  },
  {
    "q": "What happens when you flag a client as High upsell?",
    "options": ["Nothing until you follow up", "They appear in the counsellors' warm pipeline and will be called"],
    "answer": 1,
    "why": "Which is why the flag has to be honest."
  }
]
```
