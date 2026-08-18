---
title: Red flags and green flags
audience: all
order: 7
summary: Every flag in the system — what triggers it, what it costs, and exactly how to clear it.
---

Flags are not opinions. Each one is triggered by a specific condition and each
one has a specific way to clear it.

## 🔴 Red flags — fix these today

| Flag | What triggers it | What it costs | How to clear it |
|---|---|---|---|
| **Overdue follow-up** | `next_action_at` is in the past, in working hours | The lead cools; leakage list grows | Call them, log the call, set the next action |
| **Untouched lead** | Assigned, never dialled | It stays yours and shows as waiting on Fresh leads and the Floor — nobody else will call it | Dial it |
| **Immediate lead not contacted** | Priority lead past {{setting:sla.immediate_first_touch_minutes}} working minutes | Highest-intent lead going cold | Call now |
| **Missed callback** | A scheduled callback passed with no call | The most expensive miss on the floor — they *wanted* to talk | Call, apologise, rebook |
| **Unverified dials** | Logged calls with no matching device call-log entry | Suggests invented activity | Install the companion app; attach the device call when logging |
| **Zero-second connects** | "Connected" with under {{setting:dial.min_talk_seconds_for_connect}} seconds | Makes every conversion rate meaningless | Log the honest disposition instead |
| **"Not interested" on a job enquiry** | Wrong disposition on a non-prospect | Poisons the floor's conversion rate | Change it to *Job enquiry* |
| **Shift not started** | No attendance session today | You receive no fresh leads, and hours do not count | Press **Start shift** |
| **Auto-logged-out** | 1 hour with no activity | Nothing, if genuine — the timer backdates to your last real action | Sign back in |
| **Not answered ×2** | A lead unreached twice in a row | It wears a 📵 badge everywhere and may escalate to the counsellor | Try a different time, WhatsApp them, or let the counsellor tap it |
| **Transfer cap hit** | A lead transferred {{setting:lead.max_transfers}} times | It goes to nurture and leaves the live pipeline | Work it before the cap, or accept nurture |
| **Money in, MITC or KYC not done** | Payment recorded, checkpoint open | Compliance exposure for a SEBI-registered firm | Tick it on Collections once genuinely done |
| **Red client (mentor)** | Concern raised, gone quiet, or follow-up badly overdue | The relationship is at risk | Log a touchpoint |
| **Behind pace** | Collected less than the month's required run-rate | Shown on your 16:00 brief | Work the gap, not the feeling |
| **Security alert** | Bulk reads, or access outside working hours | Investigated by an admin | Explain, then acknowledge |

## 🟢 Green flags — you are doing this right

| Flag | What it means |
|---|---|
| **Empty bell at end of day** | Nothing overdue, nothing missed |
| **Every logged call has a next action** | You cannot leak a lead |
| **Verified dials matching logged dials** | Your numbers are unarguable |
| **Talk time comfortably above the connect threshold** | Real conversations, not dial-padding |
| **Callbacks kept at the promised time** | The single best predictor of conversion |
| **Walk-ins booked** | The number the floor is really judged on |
| **WhatsApp marked after sending** | Your re-tap lists will actually work |
| **Honest dispositions, including the unflattering ones** | Everyone's numbers become usable |
| **Leak list at zero (counsellor)** | The team's pipeline is clean |
| **Green clients (mentor)** | Touched recently, nothing overdue |
| **On or ahead of pace** | The month closes without a scramble |

## The one that matters most

If you take one thing from this page: **an honest bad number is worth more than
a flattering false one.** Every rate in this system — conversion, connect,
score, tier — is built on dispositions. One person inventing outcomes degrades
the numbers for everybody, including their own tier ranking.

```quiz
[
  {
    "q": "Which red flag is described as the most expensive on the floor?",
    "options": ["Untouched lead", "Missed callback", "Shift not started"],
    "answer": 1,
    "why": "They were willing to talk at a time they chose, and nobody called."
  },
  {
    "q": "How do you clear an 'unverified dials' flag?",
    "options": ["Log more calls", "Attach the matching device call when logging, via the companion app", "Ask an admin to remove it"],
    "answer": 1,
    "why": "Verification comes from the phone's own call log."
  },
  {
    "q": "You were auto-logged-out at lunch. Does it cost you hours?",
    "options": ["Yes, an hour", "No — the timer backdates to your last real action"],
    "answer": 1,
    "why": "Auto-logout never inflates or steals time."
  }
]
```
