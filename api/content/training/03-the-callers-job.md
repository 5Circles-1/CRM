---
title: The Caller's job
audience: caller
order: 3
summary: The daily loop, start to finish — shift, queue, dial, disposition, callback, walk-in, handover.
---

## Your day, in order

1. **Press Start shift.** Before anything else. You do not receive fresh leads
   until you do, and your hours do not count.
2. **Clear the bell.** Anything already overdue comes first.
3. **Work My Pipeline top to bottom.** It is already in the right order:
   immediate leads, then overdue, then due today, then the rest.
4. **Log every call as you finish it**, not in a batch at 18:00. A batch is
   guesswork and the talk times give it away.
5. **Before you leave, check the bell is empty** and My Pipeline has nothing
   red.

## Logging a call

Open the lead, press **Log call**. You need three things: what happened, how
long you talked, and what happens next.

**Talk time is in MM:SS.** Enter what the phone says. A call counts as a real
**connect** only above **{{setting:dial.min_talk_seconds_for_connect}} seconds**
— below that, the disposition accuracy is fiction and so is every conversion
rate built on it.

If the companion Android app is installed, the matching call from your phone's
log is offered under the form. One tap attaches it and the attempt is marked
**verified**. Verified calls are the ones nobody can argue with.

### Choosing the outcome honestly

| Outcome | Use it when |
|---|---|
| **Connected — interested** | You spoke, they want to know more. |
| **Connected — not interested** | You spoke, they genuinely do not want the product. |
| **Will visit** | They committed to coming in. Book the walk-in. |
| **Will call back himself/herself** | They said they would call you. Still set your own follow-up. |
| **Callback requested** | They named a time. Set it exactly. |
| **Not answered** | Rang out. |
| **Incoming unavailable** | Their phone is not receiving calls. |
| **Switched off / Busy** | Exactly what it says. |
| **Disconnected after introduction** | They hung up once you said who you were. |
| **Wrong number** | Not the person. |
| **Invalid** | Not a real prospect at all. |
| **Job enquiry** | They were looking for work, not the product. |
| **Language barrier** | You could not communicate. Hand to someone who can. |
| **Duplicate** | Same person already in the book. |

### The two people get wrong

**A job enquiry is not "not interested".** Someone who rang about a vacancy was
never a prospect. Closing them as *not interested* poisons your conversion rate
and everyone else's. Use **Job enquiry**.

**A wrong number is not "not interested" either.** Use **Wrong number** or
**Invalid**. Your conversion rate is calculated over people who could actually
have bought.

## Every call needs a next action

You cannot close the form without one. This is the anti-leakage rule, and the
database backs it up: an open lead cannot exist without a scheduled next step.

If you genuinely have nothing to do next, the lead is not open — close it with
the right outcome.

## Callbacks

When someone asks to be called back, set the callback for **the time they
said**. It appears in My Pipeline at that time and the bell rings. A missed
callback is the most expensive thing on this floor: they were willing to talk,
and you were not there.

## Walk-ins

When someone commits to visiting, book it from the call screen: date, time and
the counsellor who will see them. It lands on that counsellor's pipeline
immediately, so they are expecting the person.

Booked walk-ins are the number your work is really judged on.

## WhatsApp

After you send a WhatsApp, mark it on the lead. It is a manual punch-in — the
CRM is not connected to WhatsApp and cannot detect it. Marking it lets you
build the "spoke to, not yet messaged" list later, which is one of the most
productive re-tap lists there is.

## When someone stops answering

After **{{setting:alert.na_quiet_after_attempts}} no-answers in a row**, a lead
**goes quiet**. It stops alerting you, stops appearing in the bell, and moves
to the **Re-tap** tab.

This is on purpose. A handful of people who never pick up can generate a
hundred red alerts between them, and a bell full of those is a bell you stop
reading — including for the callbacks that genuinely matter.

Nothing is lost. The lead keeps its next action, still appears in My Pipeline
and Find lead, still counts in every leakage figure, and is still yours. Only
the interrupting stops.

**Every {{setting:retap.reminder_days}} days you get one notification** — not
one per lead — telling you how many are waiting and how long the oldest has
been silent. Open the **Re-tap** tab and work them as a batch, longest silence
first. A WhatsApp often restarts one of these when a call will not.

One thing does *not* go quiet: **a callback the customer asked for**. That
still interrupts however many times they have missed your calls, because it is
a promise rather than chasing.

If a lead genuinely will never answer, close it with the honest outcome instead
of leaving it in the pool forever.

## Re-tapping — finding people you already spoke to

**Find lead** is your second pipeline. Combine filters:

- **Not answered + overdue** — the biggest pile of recoverable money.
- **Follow-up round 3 / 4 / 5** — the floor thinks in FU1..FU5 and so does the filter.
- **No WhatsApp sent** — people you spoke to but never messaged.
- **Callbacks today** — never let one of these slide.

## Handing over to a counsellor

You are not expected to close. When a lead is genuinely interested, book the
walk-in or hand to your counsellor. Two no-connect attempts also escalate a
lead to the counsellor automatically.

## Your numbers

**My Score** shows what you are measured on. A component with nothing to
measure is excluded rather than scored as full marks — if you made no dials,
your dial score is not 100%, it is simply not counted, and the total is
rescaled. Idleness does not out-score effort here.

```quiz
[
  {
    "q": "Somebody rings asking whether you are hiring. What do you log?",
    "options": ["Not interested", "Job enquiry", "Wrong number"],
    "answer": 1,
    "why": "They were never a prospect. Logging 'not interested' poisons everyone's conversion rate."
  },
  {
    "q": "You spoke for 12 seconds and they hung up. Is that a connect?",
    "options": ["Yes, they answered", "No — a connect needs real talk time"],
    "answer": 1,
    "why": "Below the minimum talk time it is not counted as a connect."
  },
  {
    "q": "When do you log a call?",
    "options": ["As you finish it", "In a batch at the end of the day"],
    "answer": 0,
    "why": "Batched logging is guesswork, and the talk times show it."
  },
  {
    "q": "You sent a WhatsApp. Does the CRM know?",
    "options": ["Yes, automatically", "No — you mark it yourself"],
    "answer": 1,
    "why": "There is no WhatsApp connection. It is a manual punch-in."
  }
]
```
