# Product brief — the v2 reset (owner, 3 Nov)

What the owner asked for, in their own terms, and how this build answers it.
This replaces every earlier requirements document; the Kanpur-era build those
described was removed in the v2 reset.

## The brief

- The old CRM went unused: **"unnecessary and chaotic pop ups"**, too many
  options, too many screens. Clean everything.
- A **completely new, separate product**, pan-India, not the Kanpur floor.
- Leads come from **ChatGPT and Meta** and must show up in the CRM.
- **Two to four people**: Sanya and Harsh make the first call; partially
  qualified leads **pass down to Aisha** for follow-up.
- The response to every call must be **clearly and simply recorded** — not
  "10,000 options". Not qualified **only** when somebody says "no, not
  interested, don't call me". Otherwise qualified-side: call me back later,
  not answered, switched off.
- A tab where **all leads of a day** are visible — a specific day, filtered
  by who they're assigned to; the admin sees everyone, and **who has done
  what follow-ups and in what way**.
- **No** attendance, training, targets, office visits / walk-ins, floor
  screen, alerts, re-tap, inbound calls, mentors, Tata Tele cloud calling,
  multiple products / payment collection.
- **Dashboards are very important** — improve them.
- Reminders: **"it pops up and then falls into the reminder section"**.
- Webinar flow: follow-ups, whether the **template/invite was sent**, whether
  the **confirmation** is there, whether the person **converted** — but built
  generally, the way a proper CRM works, not webinar-only.
- Everything transparent, **like a Google Sheet**.

## How the build answers it

| Ask | Where it lives |
|---|---|
| Leads from ChatGPT / Meta | `lead_sources` + sheet importer + CSV paste + manual add |
| 2–4 person floor, first call → follow-up | roles `caller` / `followup`; round-robin assignment; qualified auto-passes to follow-up (`crm.log_call`) |
| Simple response recording | five outcomes (`crm.call_outcome`) — the dropdown is the enum |
| "No" is the only loss | `not_qualified` stage, reopenable; everything else keeps a follow-up date |
| Day tab / per-person / admin sees all | Leads screen filters: date chips, assignee, status, source, due; everyone sees everything |
| Who did what, in what way | append-only `activities` timeline on every lead; "Who did what" table on the dashboard |
| Dashboards | one screen: right-now tiles, range totals, day-by-day chart, funnel, per-person, per-source |
| Reminder pops then falls into a section | one popup per due reminder (soft chime, once) + Reminders tab buckets; logging the call clears it |
| Template sent / confirmed / converted | three checkpoints on the lead; converting is a checkpoint, recorded once |
| Google-Sheet transparency | every active user reads the whole pipeline; RLS still fences out non-users and deactivated accounts |

## Explicitly out of scope (removed in the reset)

Teams, attendance/shifts, targets, scoring/tiers/ACE, escalation ladders,
transfer caps, alerts engine and bell, re-tap pools, office visits/walk-ins,
deals/instalments/collections, products, advisory handoff, mentors, training,
events/chat, inbound-call register, Tata Tele Smartflo, power dialling, the
Android call-log app. If one of these is needed again, design it fresh for
this product — do not resurrect the old code by reflex (it is in git
history, pre-reset).
