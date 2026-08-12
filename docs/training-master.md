# 5 Circles CRM — Complete Training Guide

> **The canonical training now lives inside the CRM**, under the **Training**
> tab: role-aware modules, a searchable UI glossary, a per-module check and a
> recorded acknowledgement, with the live configuration substituted into the
> text. Source: `api/content/training/`. This file remains for classroom and
> offline use — if the two ever disagree, the in-app module is correct.

*One document for the whole floor: callers, counsellors, and admins. Written to
be read once end-to-end (about 20 minutes), then used as a reference. A short
role-specific version of each section exists in the repo (`training-caller.md`,
`training-counsellor.md`, `training-admin.md`).*

---

## 1. What this CRM is, in one paragraph

Leads arrive from Meta lead forms and the website, are dealt out automatically
to callers, called until they are qualified, handed to a counsellor, closed,
and then chased until every rupee booked is collected. The system's one
unbreakable rule: **an open lead always carries a next action with a time on
it.** You cannot close a call without deciding what happens next — which means
no lead can quietly fall through the cracks.

## 2. Signing in

- Open the CRM in Chrome (phone or desktop). Sign in with your email and
  password. First sign-in asks you to set a new password (10+ characters).
- **Press "Start shift" as soon as you sit down.** This is not just
  attendance — *the distribution engine only gives leads to callers who are on
  shift.* If you never press it, you never receive a lead.
- Press "End shift" when you leave. Your 9-hour day (09:30–18:30 IST) is
  measured from these.

The green **Live** badge in the top bar means the page refreshes itself —
never press F5 to check for new work; it appears on its own.

## 3. The caller's day

Work **My Pipeline** top to bottom. It is already in the right order:

1. **Call now** — immediate leads inside their 5-minute window
2. **Overdue** — past the time you promised; clear these first
3. **Callbacks today** — times the client asked for
4. **Fresh** — never dialled
5. **Follow-ups today**, then everything booked for later days

If you find yourself choosing what to call next, tell your counsellor — the
ordering is wrong, and that is a bug, not your job.

### Logging a call

Press **Log a call** on the lead and record what actually happened:

- **Talk time** goes in as `mm:ss` (e.g. `3:07`). Be honest — under 30 seconds
  is not a connect no matter what outcome you pick, and every rate on the
  floor is built on this.
- If the phone app has already seen the call, the CRM offers it: **Use it**
  makes your log device-verified in one click.
- Pick the real outcome. "Interested" and "asked to call back" require a
  follow-up time — that is the next-action rule doing its job.
- Terminal outcomes (not interested, invalid number, do-not-call, job enquiry)
  close the lead. Everything else schedules the retry automatically with
  sensible gaps (a switched-off phone is retried in 4 hours, not 1).

### The ten-minute rule

A brand-new lead untouched for 10 minutes moves to the next caller on your
team, goes round everyone once, and comes back to you if nobody starts it. The
moves are recorded. The fix is simple: start your leads.

### Reminders

- The **bell** shows everything that needs you; the count also shows in the
  browser tab.
- **Pop-ups** interrupt for callbacks due, follow-ups due, and new leads.
  Critical ones (a callback the client asked for, an overdue follow-up)
  **re-appear every 10 minutes until you deal with the lead** — dismissing the
  popup does not dismiss the obligation.

### WhatsApp and walk-ins

Mark **WhatsApp sent** when you message a lead, and **Walked in** when they
actually visit. "Will visit" (a promise) and "walked in" (a fact) are counted
separately — only one of them is revenue.

## 4. The counsellor's day

Your home is **Floor**. Top to bottom:

- **Leaderboard** — overall standings (weighted across everything) plus a
  trophy per metric. It updates live as calls are logged.
- **Follow-up radar** — one row per person: what is overdue *right now*, due
  within the hour, and missed this week. An overdue row is a conversation
  today, not at review time. If the radar is clean, nobody on your floor is
  sitting on a promise.
- **Lead flow** — why each caller is or is not receiving leads (see §6).
- **Immediate queue** — untouched hot leads with their SLA clocks.
- **Not answered — reassign?** — leads with 4+ unanswered attempts, ready to
  hand to another caller. Only you (and admins) can transfer; two transfers
  and the lead parks in nurture.
- **Today's scoreboard** — the old end-of-day Excel, filling itself in.
- **Pipeline leaks** — anything sitting where it should not be. Work it to
  zero; each leak type needs a different action.

Qualified leads land on you with a fresh next action. Book deals from the lead
page; the instalment schedule you enter is what Collections chases — **the
counsellor who closed the deal chases its instalments.**

## 5. Collections

**Collections** lists every open instalment, most urgent first. Record
payments as they arrive (UTR/reference included). "I'll pay on the 12th"
becomes a **promise** with a date, amount, and confidence — broken promises
are tracked, not forgotten. The thermometer on Dashboards shows collected
vs. breakeven pace for the month; the daily floor number is what the office
must collect per working day to stay above water.

## 6. "Why is X not getting leads?" — the Lead flow panel

The distribution engine records every decision, including who it skipped and
why. The **Lead flow** panel (Floor) turns that into a verdict per caller:

| Verdict | Meaning | Fix |
|---|---|---|
| **receiving leads** | Eligible and in the rotation | — |
| **off floor — skipped** | Never pressed Start shift (or ended it) | Press **Start shift** |
| **no team — never picked** | Not in any team today; the engine walks teams, so they are invisible | Admin → Users: add to a team |
| **deactivated** | Account disabled | Admin → Users: reactivate |

The panel also shows leads waiting with **no caller** — they hand out
automatically the moment someone eligible is on the floor. "Passed over
today" counts how often the engine looked at someone and moved on.

## 7. Scores, KPIs, and the leaderboard

- **My Score** explains itself: every component shows what you did, the
  target, and the points. A component with nothing to measure is excluded,
  not gifted. Snapshots refresh every 15 minutes.
- KPIs and targets live in one page: see **kpi-framework.md**. Headlines:
  callers — 80 dials, 35% connect rate, 90 talk minutes, callbacks kept,
  speed to lead; counsellors — conversion, ₹2L monthly collection, collection
  health, pipeline hygiene, team leakage.
- The **overall leaderboard** blends deals (25), revenue (25), connects (15),
  dials (10), interested (10), walk-ins (10), and talk time (5) into one
  0–100 number, normalised against the best on the floor. Weights are Admin
  settings (`leaderboard.*`).

## 8. Admin guide

**Users** — create accounts, set roles and teams (a caller *must* be in a team
to receive leads — the list warns you if not), reset passwords, deactivate
(sessions end instantly) and reactivate. **Set icon** uploads a person's
leaderboard picture; it is resized in the browser and shows everywhere
immediately.

**Ingestion** — one source per sheet+tab, never two active on the same feed
(the screen warns: a double-read forces every shared lead to immediate
priority). Manual CSV paste uses the same pipeline, dedupe, and quarantine.

**Quarantine** — rows with undialable phones wait here; fix the JSON and
replay. Nothing is dropped.

**Settings** — every tunable number in the system: SLAs, retry gaps, dial
targets, breakeven, alert cadence (`alerts.repeat_minutes`), live-refresh
cadence (`ui.refresh_seconds`), leaderboard weights. Every change is audited
with who made it.

**Security alerts** — bulk reads and off-hours access raise alerts here.
Quiet is good.

## 9. Troubleshooting checklist

| Symptom | First check |
|---|---|
| "I'm not getting leads" | Floor → Lead flow: the verdict names the rule (usually **Start shift** was never pressed, or no team) |
| "The page is stale" | The Live badge should be visible on live screens; data refreshes every ~30 s. Check the connection; the page keeps the last good data on a failed refresh |
| "A callback got missed" | It is in the bell and pops every 10 min while pending; after expiry it appears under Pipeline leaks → Missed callback, and on the radar's missed count |
| "Score seems wrong" | My Score shows the exact components; note what "did not apply today" means |
| "Deal booked but no collection row" | The instalment schedule must sum to the booked amount — the API refuses otherwise |
| "Import created nothing" | Admin → Ingestion → Recent runs shows per-run errors; quarantined rows are fixable and replayable |

## 10. The rules that protect everyone

- Every record of who did what is append-only; nothing is hard-deleted.
- Row-level security means a caller physically cannot read another caller's
  leads — even through a bug.
- Bulk reads and odd-hours access are detected and alerted to admins.
- All timestamps are IST business days; money is exact rupees, never floats.
