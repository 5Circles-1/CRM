---
title: How the CRM works
audience: all
order: 1
summary: Every tab, what it is for, and the one idea the whole system is built on.
---

## The one idea

**Nothing is ever lost.** Every lead that is still open carries a scheduled
next action. The database refuses to store an open lead without one — this is
not a reminder to be tidy, it is a constraint that rejects the save. If you
cannot find a lead, it did not vanish: it moved to someone else, or it closed.
**Find lead** will show you which.

Everything else in this CRM exists to serve that idea.

## Signing in

Go to the CRM address, enter your email and password. On your first login you
must change the password. If you forget it: use **Password** in the top bar if
you are already signed in, ask an admin to reset it if you are locked out.

You are signed out automatically after **1 hour** with no activity. Your shift
timer stops at your last real action, not at the moment the system noticed —
so an auto-logout never inflates or steals your hours.

## The top of every screen

| Thing | What it is |
|---|---|
| **Ticker strip** | Collected, fresh leads, walk-ins, conversions and who is on the floor — today, with the change against yesterday. |
| **Today banner** | Your own numbers: dials against target, untouched, overdue. Managers see the floor total. Dismiss it and it stays gone until tomorrow. |
| **Shift timer** | Hours logged today out of 9. Press **Start shift** when you sit down. |
| **🔔 Bell** | Only what a person scheduled: a callback the client asked for, or a reminder you set yourself — each rings once with a soft chime and waits here. Zero is the healthy state. Your follow-up work lives in **My Pipeline**, never-called leads in **Fresh leads**; the Alerts tab can show the full work list behind one click. |
| **◐** | Switches between light and dark. Remembered on this browser. |

## The tabs

Not everyone sees all of these — you see the ones your role uses.

| Tab | What it is for |
|---|---|
| **My Pipeline** | Your work for today, in the order it should be done. Callers and counsellors. |
| **Fresh leads** | Everyone nobody has ever called, flagged if past their first-touch deadline. |
| **Alerts** | Everything waiting on you, grouped. Only callbacks interrupt with a popup. |
| **Re-tap** | Leads that went unanswered repeatedly. Quiet by design, worked as a batch. |
| **Floor** | The live floor: leaderboard, who is on shift, what is leaking. Counsellors and admins. |
| **Collections** | The client book: everyone who has paid, one row per product, with the group/KYC/MITC checkpoints, who converted them and the lead source. |
| **Outstanding payments** | Money still owed — instalments, promises to pay, who to chase, and the payment punch-in. |
| **Mentors** | Paying clients kept warm — touchpoints, health, upsell interest. |
| **Events** | Seminars and webinars, and the roster of who was invited and who came. |
| **Dashboards** | Charts: conversion, collections over time, funnel, pipeline leakage. |
| **Find lead** | Search and filter the whole book you are allowed to see. This is the re-tap tool. |
| **Performance** | Per-person numbers — dials, connects, walk-ins, conversion. |
| **Previous months** | Older uploaded records, parked out of the live queue but still tappable. |
| **Team** | Team chat. Everyone can post. |
| **My Score** | Your score, and what each component is measuring. |
| **Attendance** | Your hours, day by day. |
| **Training** | This academy. |
| **Admin** | Users, sources, settings, security, quarantine. Admins and ops. |

## What you can see

You see what is yours. **Callers** see their own leads. **Counsellors** see
their whole team. **Mentors** see paying clients only, never the live sales
pipeline. **Admins** see everything.

This is enforced by the database itself, not by hiding menu items. A lead you
are not allowed to see does not appear even if you know its address — the page
will simply say it does not exist. That is correct behaviour, not a fault.

## The working clock

The CRM's clock runs **Monday to Saturday, 09:30–18:30 IST**, and stops for
lunch between **14:00 and 14:30**. Nothing is ever "late" outside those hours.
A lead that arrives on Saturday evening is due on Monday morning. Sunday does
not count at all.

```quiz
[
  {
    "q": "You cannot find a lead you worked yesterday. What happened?",
    "options": ["It was deleted", "It moved to someone else or it closed", "The system lost it"],
    "answer": 1,
    "why": "Nothing is ever deleted. Find lead will show you where it went."
  },
  {
    "q": "A lead arrives at 18:20 on Saturday. When is it due?",
    "options": ["Saturday 18:50", "Sunday morning", "Monday morning"],
    "answer": 2,
    "why": "The clock is Mon-Sat 09:30-18:30. Sunday does not count."
  },
  {
    "q": "You open a lead's page and it says the lead does not exist.",
    "options": ["A bug — report it", "It is not yours to see, and that is by design", "The database is down"],
    "answer": 1,
    "why": "Row-level security hides other people's leads completely."
  }
]
```
