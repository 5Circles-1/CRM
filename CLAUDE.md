# 5 Circles Sales CRM

Internal sales-floor CRM for 5 Circles. PostgreSQL 16.

## Scope boundary — read this first

This is a **sales-floor CRM only**. Its job ends at *money collected* and a
*clean handoff*. Everything about servicing a paying advisory client — KYC, KRA,
MITC consent, e-sign, risk profiling, fee caps, research delivery, grievance
registers, the five-year client interaction archive — belongs to the existing
advisory pipeline and must **not** be built here.

| In scope | Out of scope (advisory pipeline) |
|---|---|
| Lead ingestion, distribution, teams and roles | Client KYC and onboarding |
| Caller → counsellor pipeline, callbacks, reminders | Consent and agreements |
| Attendance, scoring, targets, dashboards | Fee-cap and family limits |
| Office visits, counselling response, conversion ratio | Advisory sessions with a paying client |
| Deals, instalments, collections chasing | Service delivery and research |
| Call QA — conduct and coaching | Long-term client records, grievances, audits |

Collections **stays here** even after handoff: the counsellor who closed the
deal chases the instalments.

The handoff runs both directions (`crm.handoff_outbox` / `crm.handoff_inbound`).
The return leg carries onboarding, **refund/cancellation**, and renewal-due
events. Without it, incentive clawback silently fails and renewals are never
created.

## The nine requirements this build serves

1. Leads arrive from a Meta-connected Google Sheet and distribute alternately
   between two teams, then alternately between setters.
2. Dashboards for caller *and* counsellor performance.
3. A caller can set a callback reminder when a client asks to be called back.
4. Each caller sees their own pipeline for the day.
5. An immediate lead is surfaced for contact as soon as possible.
6. A 9-hour login (09:30–18:30 IST) is visible per person per day.
7. Callers and counsellors are scored, for self-reflection.
8. A lead that went Not Answered can be transferred to another caller — by the
   counsellor, who is also the team lead.
9. Interactive dashboards, no pipeline leakage, no data breach.

Requirement → test mapping lives in `db/tests/test_requirements.sql`, tagged
`R1`…`R9`. Every requirement has passing assertions. **If you change behaviour,
change the test.**

## Design decisions that are load-bearing

Do not undo these without understanding why they exist.

- **An open lead always has a `next_action_at`.** Enforced by the check
  constraint `leads_open_requires_next_action`, defaulted on insert by
  `crm.tg_lead_defaults`, and pushed forward automatically by the call-attempt
  trigger. This is the mechanical guarantee against pipeline leakage — the UI
  rule "you cannot close a call without a next action" is just its front end.

- **Distribution is least-loaded-then-rotation, not a naive A-B-A-B counter.**
  Strict alternation permanently starves whoever takes a break: the cursor lands
  on them, they are skipped, they never catch up. Among callers actually on the
  floor, the fewest-leads-today wins; rotation order breaks ties, which yields
  exactly A-B-A-B when everyone is present and level. Catch-up is bounded by
  `distribution.max_catchup_leads` so a returning caller is not flooded.

- **Only counsellors and admins can transfer leads.** If callers could push
  leads off their own list, difficult leads would circulate forever and nobody
  would own anything. Enforced inside `crm.transfer_lead`, not in the UI.
  Capped at `lead.max_transfers` (2), then the lead goes to nurture.
  **The "Give to" picker offers exactly what `crm.transfer_lead` accepts — every
  active caller.** `/transfers/targets` used to narrow that to the *acting*
  user's team: an admin holds no team membership, so the comparison was
  `= crm.current_user_team()` against NULL, the dropdown rendered empty, and
  every Transfer button on Floor could only answer "No caller available to
  receive it" while the floor was full. A counsellor could not hand a lead
  across teams either, though the function does exactly that (it re-stamps
  `team_id` to the new caller's team), and a caller whose membership row had
  lapsed vanished from the list with no message saying why. A picker narrower
  than the rule it fronts is the rule living in a second place. The lead's own
  team is grouped first so crossing one stays a decision rather than a slip,
  and a RESTRICTED caller stays on the list: that tier stops the *engine*
  handing them fresh leads, never a human handing them one by name.

- **Every refusal carries a SQLSTATE, or it reaches the floor as a crash**
  (0073). `crm.transfer_lead` makes six checks. Three raised bare, and a bare
  `raise exception` is `P0001`, which is in no map in `src/http/errors.ts` — so
  an ordinary refusal fell through to the catch-all and the floor read
  **"something went wrong"**: the same five words for a lead a colleague had
  already moved, for a target who cannot receive leads, and for a lead id that
  does not resolve. A 500 also asserts the server is broken, which sends people
  to the wrong place entirely. The rules did not change; their SQLSTATE and
  wording did — `no_data_found` → 404, `check_violation` → 409 — and the text
  names the caller, because it is read on the floor mid-shift, where "that
  caller" is a uuid's way of saying nothing. The Floor list reloads itself after
  a refusal, since the usual cause is a snapshot older than the database and a
  second supervisor working the same pile. **When adding a rule to a
  `SECURITY`-sensitive function, give the raise an errcode or the API cannot
  tell it from a crash.**

- **A team is changeable, because a screen that names a problem must offer a
  button for it.** Admin → Users showed a person's team and badged a caller who
  had none ("no team — gets no leads"), but `teamId` was accepted only when the
  user was first created — so correcting it afterwards meant hand-written SQL
  against the live database, by the one person least likely to be able to write
  it. `PUT /admin/users/:id/team` (admin only) is the button behind that badge.
  Membership is a *period*, not a flag: `crm.team_memberships` holds a daterange
  per user under an exclusion constraint forbidding overlaps, and every "which
  team is this person on" read asks `period @> current_date`. So a move closes
  today's spell and opens the next, and last month still reads correctly. A
  membership that only started **today** is corrected in place instead — that is
  somebody fixing their own mistake, and closing it would strand a zero-length
  range for ever, since the app cannot `DELETE`. Rotation order defaults to the
  same expression `POST /admin/users` uses, so the two doors into a team cannot
  disagree about where a newcomer lands. The button shows only for callers and
  counsellors: admin and ops hold no team by design, and a "Set team" call to
  action on them would invent a missing setting.

- **Absence is covered forward, never sideways** (0056, owner decision). A
  fresh lead whose team has no caller on the floor goes to the team lead
  (counsellor) if they are on the floor; otherwise it parks visibly. The
  escalation ladder hands up only to an on-floor counsellor — an absent
  counsellor's share stays with the callers. Owned leads never move because
  of an absence: only new work routes around an empty chair.

- **An inbound call is the one lead a caller may create** (0055), and only to
  themselves — the fairness engine is untouched. Always immediate priority,
  born first-touched, and its mandatory follow-up date is a pending callback,
  so missing it rings.

- **Leads do not move between callers on their own — except after 15 silent
  days** (0049, 0066, both owner decisions). The ten-MINUTE untouched sweeper
  and the cross-team mover stay disabled (`sla.untouched_reassign_minutes` =
  0, `escalation.cross_team_days` = 0) and unscheduled; ownership at that
  timescale is sacred. The 15-DAY horizon is different (owner, 3 Sep): an
  open, **overdue** lead with not one dial in `sla.stale_reassign_days` (15)
  moves to a different on-floor caller on its team — preferring one who never
  tried it, because by then the number may be spam-flagged for the old
  caller's SIM and a fresh caller ID may ring where theirs no longer does.
  Leads with a future booked callback, counsellor-stage leads, and
  previous-month history never move; capped by `sla.stale_reassign_max` (2).
  The other automatic hand-up is caller → counsellor after two no-connect
  attempts, bounded by `escalation.counsellor_daily_cap` (15/day) — past the
  cap the lead stays with its caller wearing a visible "Not answered ×N" badge.

- **Popups interrupt only for appointments a person chose** — the callback a
  client asked for and the reminder the lead's owner set (`alerts.popup_kinds`),
  once each (`alerts.repeat_minutes` = 0), with one soft chime (`alerts.chime`).
  The bell badge counts the same appointments plus the intake emergency
  (`alerts.bell_kinds`) — zero is its healthy state. The intake alarm names
  the failing source, never duplicates while unread, and stands itself down
  with an `intake_recovered` all-clear the moment intake is healthy again
  (0054, 0058) — an intake alarm on the bell is always a live problem. The full engine-raised
  work list is never dropped: `/me/alerts?scope=work` serves it, the Alerts
  tab offers it behind one click, and overdue work keeps its home in the
  pipeline buckets.

- **A repeat enquiry never creates a second lead — and is worked like a fresh
  one** (0042, 0064, 0065, owner decision). A form submission whose phone
  matches a live lead (or any lead inside `lead.dedupe_window_days`) attaches
  to that lead: priority jumps to immediate, the next action is pulled to
  within 15 minutes, the timeline gets a `re_enquiry` event, and the owner is
  notified on the Alerts work list. The owner's rule (3 Sep) is that every
  enquiry lands on the Fresh tab — the earlier call may have hit a
  spam-flagged number and never been picked up — so `crm.v_reenquired_leads`
  rows render *inside* the fresh list with an "enquired again" badge, flagged
  against the deadline the re-enquiry set, and leave only when a call attempt
  lands after the re-enquiry — never for age. A re-enquiry that reopens a
  parked lead **with no owner at all** is adopted by the team's counsellor
  (`crm.adopt_orphan_reenquiries`, 0066, owner decision) — before that rule,
  revived leads sat on the whole-floor list belonging to nobody. The bell
  stays appointments-only (0052). Dedupe keys on the phone alone, so the same
  human enquiring under a new number is a new lead — accepted, because the
  phone is the dialing identity.

- **A green lead never goes dark on its own** (0067, 0068, owner decisions).
  "Will visit" on call one, "not answered" from call two used to re-file the
  lead by its *last* outcome into the not-answered bulk piles — which is
  where good leads died. Two named definitions now stand between potential
  and the bulk machinery. `crm.visit_promise_open()` — "they said they would
  come and have not yet come" — holds the `will_visit` bucket for as long as
  the promise stands: never `breached`, no two-day window (a visit promised
  for next Wednesday sits in Visits promised, dated), and the date is the
  **caller's chosen date** — the API refuses a `will_visit` without one, the
  chosen date becomes `walkin_expected_at`, and a re-promise moves it.
  `crm.lead_green_reason()` is the wider rule — an open visit promise, or any
  connect-grade positive conversation (`connected_interested`,
  `callback_requested`, `will_visit`, `will_call_back_self`) — and while it
  holds the lead keeps its overdue alerts past the quiet threshold, stays out
  of `v_no_answer_pool`, is **never parked by the nine-attempt nurture cap or
  the counsellor's stuck→re-tap park** (those caps still park the
  never-engaged bulk they were written for), and wears a green badge (🚶 /
  🟢) on every list, with a `green=yes` filter and a "🟢 Potential" preset on
  Find lead. Green is one-way by design: silence never clears it; only a
  walk-in, a deal, or an explicit close does — so a green lead leaves the
  pipeline only by a person's decision. When logging an unreached outcome on
  a green lead the UI requires the person to choose the next follow-up date
  themselves. Still applying: the 15-day stale mover (a fresh caller ID may
  ring where a spam-flagged one doesn't — the green light travels with the
  lead) and the transfer rules. Green is identity and visibility, not
  immortality.

- **An office visit is a row, and a conversion is never typed twice** (0071,
  owner decision 15 Sep). A walk-in used to be one nullable timestamp on the
  lead, which can say a visit happened and nothing else — so "office visits to
  conversions" was not a ratio anybody could compute: the numerator (deals) is
  per counsellor and the denominator belonged to nobody. `crm.walkin_visits`
  carries who sent them in, who sat with them, what was said and what it turned
  into, through `expected → arrived → counselled`. Two doors, both the owner's:
  the **caller books it** from the pipeline (`crm.assign_walkin`, a named day
  required) and the **counsellor punches it in** at the desk
  (`crm.record_walkin_arrival`, which completes a booking rather than opening a
  second visit — one person in the office is one visit). The counselling
  response is the counsellor's to write, never the caller's
  (`crm.record_walkin_response`, 42501 like `transfer_lead`). **`converted` is
  refused by hand**: booking the deal marks the visit converted and carries the
  product and amount across, because a hand-typed conversion is a second record
  of the money and two records of the same money always drift apart. A deal
  closed before the client ever came in cancels the booked visit rather than
  counting as an office visit. `leads.walked_in_at` keeps its meaning and is
  set from this table, so every existing walk-in figure still reads — including
  the lead page's own "Mark walked in", which now goes through the same
  function so the two numbers cannot disagree.

- **A target is one person's number** (0072, owner decision 15 Sep). A
  counsellor carries a **revenue** target, a caller a **walk-in** target, in
  `crm.user_targets` for a month. Revenue deliberately means *collected* — the
  same figure the thermometer and the daily brief already use — rather than a
  second booked-revenue number beside it, because a screen with two revenue
  targets on it is a screen where nobody knows which one they are behind on. A
  caller's number is walk-ins because the deal is not theirs to close, and it
  is fair only because `crm.walkin_visits` credits the walk-in to whoever sent
  the client in. Nobody needs a target for the screen to be honest: an unset
  person carries their role's default (`crm.monthly_revenue_target`,
  `crm.monthly_walkin_target`) and clearing one falls back to that default,
  never to zero. The daily brief now reads the same default function, so the
  brief and the Targets screen cannot quote different numbers at the same
  person on the same morning.

- **Two leaderboards, one per job** (owner decision 15 Sep). `crm.rate_standings`
  normalises every component against the best rate *on the board*, so a board
  holding both roles measures a caller's revenue against a counsellor's and a
  counsellor's dials against a caller's — two jobs on one curve, and the loser
  is whichever role the weights happen to suit less. `/performance/overall`
  takes a `role`, and Floor and Performance render callers and counsellors as
  separate boards, each ranked from 1 within itself. Still one formula: the
  same function the nightly ACE pick uses. The volume trophies stay on raw
  totals — "most calls" meaning most calls is a fact, not a ranking.

- **Score components that had nothing to measure are excluded from both the
  points earned and the weight available**, and the total is rescaled over what
  applied. Awarding full marks for an empty component rewards idleness — before
  this was fixed, a caller with zero dials out-scored an active one 29 to 26.

- **A day nobody worked is not a bad day — it is not a day** (0061, 0062).
  `crm.was_present()` is the single definition (real logged time by
  `attendance.min_present_minutes`, or any dial, or any deal closed), and
  everything that rates, averages or ranks a person divides by days that pass
  it. Three things were wrong before, all the same arithmetic:
  - **The ACE seat.** Each team's best caller holds
    `distribution.ace_share_pct` (66.7%) of its fresh leads, picked nightly —
    but on totals a week of leave was identical to a week of doing nothing, so
    returning from five days off silently cost the floor's best caller two
    thirds of her leads. `tier.min_dials_to_rank` is now measured at the
    person's own pace, and a caller with fewer than `tier.min_days_to_rank`
    (2) measured days is **not judged at all** — they keep the tier they
    earned, so a returning ACE returns as the ACE. Two ACEs in a team is the
    deliberate transitional state; they split evenly until the returner has
    completed days to be ranked on.
  - **The leaderboard.** `/performance/overall` summed totals over the window,
    so the board and the ACE pick disagreed — one ranked volume, the other
    rate. Both now call `crm.rate_standings()`, the one formula, normalised
    within the floor or within a team. The volume trophies stay on raw totals:
    "most calls" meaning most calls is a fact, not a ranking, and no leads
    depend on it.
  - **The daily score.** Four caller components are always applicable by
    design, so `crm.snapshot_scores()` wrote a hard 0/100 for an absent day and
    five days' leave put five zeroes into the seven-day average on the caller's
    own My Score page. An absent day now gets no snapshot at all, and a zero
    already recorded for one is cleared.

  The share is on the Floor page (`v_lead_flow.fresh_share_pct`): a share that
  moves on its own must be visible, or "why did all the leads go to her today?"
  has no answer on any screen.

- **A connect requires real talk time**, not just a connected disposition
  (`dial.min_talk_seconds_for_connect`, default 30s). Otherwise disposition
  accuracy is fiction and so is every conversion rate built on it.

- **Tata Tele Smartflo is the dialler and the sensor, never a second CRM**
  (0074, replacing Callyzer, which was retired wholesale before go-live —
  owner decision 22 Sep). Two jobs only. It **places** the call:
  `POST /leads/:id/call` bridges the caller's phone to the client's
  (back-to-back calling, no number ever typed or exposed to the browser),
  recording every click in `crm.telephony_calls` with Smartflo's `ref_id` —
  a click that never became a call is a countable row, not silence. And it
  **reports** the call: CDRs from the webhook and the rate-limited pull land
  in `crm.device_call_logs` (source `tata_tele`, row-key prefix `tata:`, so
  the in-house app and Smartflo can never double-count), tied back to the
  click by `ref_id`, and `answered_seconds`/`billsec` is the stored talk
  time — ring time verifying a connect is exactly the fiction the table
  exists to prevent. Smartflo's lead ids, dispositions, broadcasts and
  dialler campaigns are deliberately not connected: a second system
  distributing leads would fight the fairness engine, RLS and the
  `next_action_at` guarantee. The agent mapping IS `users.dialing_msisdn`
  (one fact, one place — the number Smartflo rings first and reports back);
  rows that cannot be placed are quarantined whole and re-ingest themselves
  once the cause is fixed, except the inbound call no agent ever answered,
  which names nobody, has no fix that ever places it, and is counted rather
  than parked in quarantine forever. Stamps arrive zoneless and are read in
  `tata_tele.timezone`, because a wrong zone moves calls across
  `crm.ist_date()` boundaries. `tata_tele.enabled` ships off; the watchdog
  (`crm.check_tata_tele_health`) raises a named bell alarm — Smartflo's
  90-day password rotation by name — and stands itself down, like the intake
  alarm. Recordings are coaching material for counsellors and admin, never
  shown to the caller themselves. Historical `callyzer` rows in
  `device_call_logs` stay: they verified real attempts, and deleting them
  would falsify every past dial count.

- **Power dialling works the due list; the outcome between calls stays
  human** (0075, owner request 23 Sep). The Power dial screen (`#/dial`, or
  "▶ Power dial my list" on My Pipeline) rings the next due lead after a
  `power_dial.countdown_seconds` countdown, and the next one the moment the
  outcome is saved — no picking, no Call button. *What is due, in what order*
  is `crm.v_dial_queue`, never the browser: immediate, then a **callback whose
  time has come** (the client chose it, and it is marked missed after
  `sla.callback_grace_minutes`), then fresh work and re-enquiries alike, then
  due visit follow-ups, overdue, breached; within a rank the pipeline
  screen's own order. Work agreed for later is never rung early. A lead
  called within `power_dial.redial_gap_minutes` is held back — `wrong_person`
  and `language_barrier` leave an overdue lead overdue, and without the gap
  the dialler would ring the same client straight back — except a due
  callback and an undialled re-enquiry, which are appointments. Auto-dialling
  keeps to `power_dial.start_hour`–`end_hour` IST (TRAI's 09:00–21:00); one
  press of Call on a lead never does. The outcome is never skipped: it sets
  the follow-up, fires callbacks, keeps green leads green and feeds every
  score, so the dialler waits for it — with no pre-chosen answer, because a
  default "Connected — interested" saved by reflex invents a green lead. A
  save gives Tata Tele's call record up to 15 s to land and links it (matched
  by the click's server time, `?since=`, so an older unlogged call is never
  taken for this one), because an unverified dial reads as a fabricated one.
  Safe unattended: Smartflo rings the *caller* first, so a client is only
  dialled when someone answers; a second click inside
  `tata_tele.click_cooldown_seconds` is refused (409); leaving the screen
  stops the loop. The dialler is its own route because My Pipeline redraws
  itself every 30 s, which would throw away an outcome form mid-call.

- **Row-level security is the access control, not the API.** The app connects as
  `crm_app` (no BYPASSRLS, not the table owner) and sets `app.user_id` per
  request. A missing `WHERE` clause in a route handler is then a bug that
  returns too few rows, never one that leaks the lead book.

- **Append-only tables have `UPDATE` revoked at the privilege level**, not only
  blocked by trigger. RLS filters before triggers fire, so a denied update would
  otherwise silently affect zero rows and read as success.

- **Engine functions run by the scheduler are `SECURITY DEFINER`** (migration
  0014): payment rollups, callback expiry, score snapshots, security detection.
  Run as the invoker they silently under-execute — the ops account cannot read
  the admin-only access log, so bulk-read detection would never fire. Authority-
  checking functions (`crm.transfer_lead`) deliberately stay invoker-rights.

- **Every tunable number lives in `crm.settings`**, not in code — SLA minutes,
  dial targets, breakeven, transfer caps. Changing a target is an ops action.

## Layout

```
db/
  migrations/    forward-only, applied in filename order
  seed/          dev seed: 2 teams, 4 callers, 2 counsellors
  tests/         requirement tests, tagged R1..R9
  rebuild.sh     drop + recreate + migrate + seed [+ test]
api/             TypeScript / Node 22 / Fastify. See api/README.md
  src/db/        the RLS session contract - read this first
  src/routes/    one file per requirement area
  src/ingest/    Google Sheets -> ingested_rows -> assign_lead
  src/jobs/      scheduled calls into the database engines
  public/        the web UI: dependency-free ES modules, no build step
  test/          API integration tests + Playwright browser flows
docs/            requirement traceability, open questions
```

## Running

```bash
# needs a running postgres 16 and PGHOST/PGPORT/PGUSER set
./db/rebuild.sh --with-tests

cd api && npm install && npm test   # API integration tests
npm run test:e2e                    # real Chromium driving the real UI
npm start                           # serves API + UI on one port; open /ui/
```

## API rules that matter

- **The API never filters by ownership.** RLS does. A route that adds its own
  `WHERE owner = me` puts the rule in a second place where it will drift. A lead
  the user cannot see reads as 404, which is the correct behaviour.
- **All query access goes through `Database.withUser()`**, which sets
  `app.user_id` transaction-locally. There is no exported way to query outside
  it, so a pooled connection cannot leak one user's identity into the next
  request.
- **The server refuses to boot on a role that bypasses RLS** — superuser,
  `BYPASSRLS`, or table owner. That misconfiguration is otherwise silent and
  total.
- **Business rules stay in SQL.** Routes call `crm.transfer_lead()` and map the
  SQLSTATE (`42501 → 403`, `23514 → 409`) rather than re-implementing the check.
- **`bigint` is parsed to a JS number; `numeric` is not.** Money stays an exact
  string — turning INR into a float is the mistake the schema exists to avoid.

`rebuild.sh` **drops the database**. It is a development tool; never point it at
anything real.

## Conventions

- All timestamps are `timestamptz`. Business dates use `crm.ist_date()`
  (Asia/Kolkata) — never the UTC date, or daily rollups shift by 5.5 hours.
- Money is `numeric(12,2)` in INR. Never floats.
- Phone numbers are canonicalised by `crm.normalise_phone()` on insert. It
  returns NULL for undialable input — quarantine those rows, never drop them.
- Migrations are forward-only. Add a new numbered file; do not edit an applied
  one once it has run anywhere real.
- Nothing is hard-deleted by the application; `DELETE` is revoked from `crm_app`.

## Build status

Everything is built: database, engines, HTTP API, ingestion worker, web UI
(387 database assertions, 347 API tests, 18 browser E2E flows), the
**Android call-log companion app** (`android/` — plain Java, zero
third-party dependencies, compiles to a verified APK), and the **Tata Tele
Smartflo integration** (migration 0074, `api/src/integrations/tata_tele/`) —
click-to-call from the lead page and My Pipeline cards, plus webhook +
rate-limited scheduled CDR pull feeding the same `device_call_logs` table and
the same `is_verified` flip as the app. The log-call form offers the matching
call record and one click makes the attempt `is_verified`. **Power dialling**
(0075, `public/js/views/dial.js`) works a caller's due list back to back on
top of it, sharing one call-outcome form with the lead page
(`public/js/callform.js`). The earlier Callyzer integration (0063) was
retired in 0074, before it ever went live.

Not verifiable from this repository: the app running on a physical handset
(ten-minute test in android/README.md), Smartflo against the live account
(click-to-call, webhook delivery and the CDR pull need the paid Smartflo
plan, agents configured, and API access enabled by TTBS; the contract is
tested against their documented v1 shapes with a fake Smartflo server), and
anything in the go-live runbook that needs a real server. iOS cannot run the
companion app (no call-log access) — see docs/open-questions.md question 2.
