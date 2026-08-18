---
title: Error playbook
audience: all
order: 9
summary: If X happens, do Y — including every error message the app can show you.
---

## Lead problems

**A lead is assigned to the wrong person.**
Ask a counsellor or admin to transfer it, with a reason. Callers cannot
transfer. If it has already been transferred {{setting:lead.max_transfers}}
times it will go to nurture instead — pull it back from **Find lead**.

**The same person is in the book twice.**
Log the newer one as **Duplicate** and work the original — the original carries
the history. Do not delete anything; nothing is deletable by design.

**A lead is in the wrong stage.**
Log a call with the correct disposition, or change the status on the lead page.
The stage follows the outcome; do not fight it by editing around it.

**A lead vanished from my pipeline.**
It closed, it escalated to your counsellor after two unreached attempts, or a
counsellor transferred it. Search **Find lead** — the lead's history shows
exactly when and why. Leads never move between callers on their own.

**The customer says they were already called by someone else.**
Open the lead and read its history — every attempt, by whom, is there. If it
was a colleague, apologise; the history will show the transfer or escalation
that explains it. This is normal and not anyone's fault.

**I cannot close the call form.**
You have not set a next action. Every open lead must carry one. If there is
genuinely nothing next, close the lead with the correct outcome instead.

## Import and sync problems

**"Unable to parse range."**
The worksheet name does not match the tab at the bottom of the sheet. Copy the
tab name exactly, including spacing.

**"The sheet name is ambiguous."**
Two tabs differ only by whitespace or case. Rename one in the sheet. The sync
refuses to guess on purpose.

**An import created nothing.**
Usually the rows are already there — matching is idempotent, so re-running a
sync never duplicates. Check the summary line: created / duplicates /
quarantined.

**Rows went to Quarantine.**
The phone number was not dialable. Fix the number in the sheet and re-sync, or
fix and replay from **Admin → Quarantine**. Quarantined rows are never lost.

## Money problems

**A payment was recorded twice.**
Do not delete it — you cannot. Record the correction and tell an admin; the
audit log holds both entries and the reason. The instalment total will be
visibly wrong until corrected, which is intended.

**A payment went against the wrong deal.**
Same: correct forward, with a note. Never edit history quietly.

**The collections total looks wrong.**
Check whether an instalment is marked paid without a payment behind it. Every
rupee should have a payment row.

## Attendance and timer problems

**My shift timer shows 0 but I am working.**
You have not pressed **Start shift**. Press it now; hours count from then.

**It says I am on shift but I am not.**
You were auto-logged-out only after an hour of inactivity. If a session was
left open from a previous day, it will already have been closed automatically —
today's presence only counts a session started today.

**I was marked absent but I was here.**
Ask an admin to correct it. Corrections are logged.

## Access problems

**"Not permitted" (403).**
Your role cannot do that. Callers cannot transfer leads or create events;
viewers cannot edit anything; only admins can pin tiers or reset passwords.

**"Not found" (404) on a lead I was sent a link to.**
It is not yours to see. That is row-level security working, not a broken link.
Ask the owner or a counsellor.

**I am locked out.**
An admin resets your password. If the admin is locked out too, the server
rescue tool exists.

**"Your session has expired."**
One hour of inactivity. Sign in again; nothing was lost.

## Error messages you may see

| Message | Meaning | Do this |
|---|---|---|
| `not permitted` | Your role lacks that authority | Ask someone whose role has it |
| `not found` | It does not exist, or is not yours to see | Search Find lead; ask a counsellor |
| `that phone number is not dialable` | Fails normalisation | Correct the number |
| `a touchpoint cannot be dated in the future` | Date is after today | Use today or earlier |
| `clients can only be assigned to an active mentor` | Target is not a mentor | Pick a mentor, or change their role |
| `no paying client with that deal id` | No payment recorded yet | Record the payment first |
| `the sheet name is ambiguous` | Two tabs nearly identical | Rename one |
| `open lead requires a next action` | Anti-leakage constraint | Set a follow-up, or close the lead |
| `transfer limit reached` | Hit {{setting:lead.max_transfers}} transfers | It goes to nurture |

## When none of this fits

Take a screenshot **including the top bar**, note the time, and send it to your
admin. The time matters: the audit log can be read directly, and with a
timestamp the exact sequence of events can be reconstructed.

```quiz
[
  {
    "q": "A customer says another caller already rang them.",
    "options": ["Deny it", "Read the lead history — every attempt and who made it is there", "Close the lead"],
    "answer": 1,
    "why": "Reassignment by the ten-minute rule is normal and fully recorded."
  },
  {
    "q": "A payment was entered twice. What do you do?",
    "options": ["Delete one", "Correct forward with a note and tell an admin"],
    "answer": 1,
    "why": "Nothing is deletable. The audit log keeps both entries and the reason."
  },
  {
    "q": "'Unable to parse range' when syncing the sheet.",
    "options": ["The sheet is corrupt", "The worksheet name does not match the tab name"],
    "answer": 1,
    "why": "Copy the tab name exactly, including spacing."
  },
  {
    "q": "You get 404 on a lead link a colleague sent.",
    "options": ["The link is broken", "It is not yours to see — row-level security"],
    "answer": 1,
    "why": "A lead you cannot see reads as not found. That is the correct behaviour."
  }
]
```
