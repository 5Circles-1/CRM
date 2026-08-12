---
title: The rulebook
audience: all
order: 10
summary: Everything you must do and must never do, on one page.
---

One page. Read it once properly, then use it to settle arguments.

## You must

1. **Press Start shift** when you sit down. No shift, no fresh leads, no hours.
2. **Log every call as you finish it**, with the honest outcome and the real
   talk time in MM:SS.
3. **Set a next action on every open lead.** The system will not let you skip
   it; do not treat that as an obstacle.
4. **Keep callbacks at the time you promised.** If you cannot, call earlier —
   never later without warning.
5. **Book the walk-in from the call screen** the moment someone commits, with
   the counsellor's name on it.
6. **Mark WhatsApp after you send it.** The CRM cannot see it.
7. **Use the correct disposition**, including *Job enquiry*, *Wrong number* and
   *Invalid*, even when they make your day look worse.
8. **Clear the bell before you leave.**
9. **Chase your own collections** if you closed the deal. It stays yours.
10. **Log a mentor touchpoint after every client contact.** Three taps.
11. **Tick MITC and KYC only when they are genuinely done.** Money is already in.
12. **Give a reason with every transfer and every tier pin**, and expect it to
    be read.

## You must never

1. **Never invent activity.** No logged call that did not happen, no connect
   with no conversation, no disposition chosen because it looks better. This is
   the one thing the system is built to detect, and it corrupts everyone's
   numbers, not just yours.
2. **Never log a job enquiry or a wrong number as "not interested."**
3. **Never close a call without a next action.** (You cannot, but do not try to
   work around it either.)
4. **Never share your password or work signed in as someone else.** Every
   action is recorded against the name that is signed in.
5. **Never take lead data out of the CRM** — no personal spreadsheets, no
   photos of the screen, no forwarding lists. The lead book is the company's
   asset and a regulated one.
6. **Never edit history to make it tidy.** Correct forward, always.
7. **Never run `rebuild.sh` against production.** It drops the database.
8. **Never run `backup.sh` before restoring on the same day.** It overwrites the
   dump you need.
9. **Never bypass the CRM for a walk-in or a payment.** If it is not recorded,
   it did not happen, and nobody gets credit for it.
10. **Never leave a paying client untouched for a month.** The Mentors tab will
    turn them red, and by then it is usually too late.

## The rules the system enforces for you

You do not have to remember these — the database will simply refuse.

- An open lead cannot exist without a next action.
- A caller cannot transfer a lead, or see another team's leads.
- A mentor cannot see the live sales pipeline.
- A touchpoint cannot be logged in someone else's name, or edited afterwards.
- Nothing can be deleted by the application, at all.
- Nothing breaches on a Sunday, outside 09:30–18:30, or during the lunch freeze.

## The standard behind all of it

The purpose of every rule on this page is that **the numbers on the screen are
true**. A CRM whose numbers are approximately right is worse than no CRM,
because people act on it with confidence.

If something in the system is telling a lie about your work — a flag you do not
deserve, a number that looks wrong — say so, and it gets fixed. That is a
better outcome for everyone than working around it quietly.

```quiz
[
  {
    "q": "You are behind on dials. Which of these is acceptable?",
    "options": ["Log a few extra calls to catch up", "Report the real number"],
    "answer": 1,
    "why": "Inventing activity is the one behaviour the system is built to detect."
  },
  {
    "q": "You want to work a list of leads at home this evening.",
    "options": ["Export it to a personal spreadsheet", "Do not take lead data out of the CRM"],
    "answer": 1,
    "why": "The lead book is a regulated company asset."
  },
  {
    "q": "A walk-in came in and paid cash, and you were busy.",
    "options": ["Record it in the CRM as soon as you can", "Sort it out later informally"],
    "answer": 0,
    "why": "If it is not recorded, it did not happen and nobody gets credit."
  },
  {
    "q": "A flag on your profile looks unfair.",
    "options": ["Work around it quietly", "Say so — a system telling a lie about your work gets fixed"],
    "answer": 1,
    "why": "The whole point is that the numbers are true."
  }
]
```
