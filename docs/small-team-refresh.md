# Refreshing the CRM for a floor of two or three

Owner decision, 30 Oct: the floor shrinks to **two or three people with access,
each working a lead end to end** — dial it fresh, counsel it, close it, chase
the money — starting from a **clean lead book**, with the feature set kept.
Migration `0085_a_counsellor_receives_leads_like_a_caller.sql` makes the
machinery fit that shape; this runbook is the one-time reset, in order, using
only the product's own buttons (one optional SQL line is marked as such).

## The shape

- Every working person holds the **counsellor** role. It is the end-to-end
  role: a counsellor dials and power-dials their own queue, books walk-ins and
  records the counselling response, closes deals, chases instalments, and
  transfers leads. What a counsellor could not do — *receive* leads the way a
  caller does — is what 0085 added: fresh distribution covers to the on-floor
  counsellors least-loaded-first, and Transfer / Assign / Hand over all accept
  a counsellor, who takes the lead into their own counsellor queue.
- Why not callers: deals, walk-in responses and transfer authority are
  counsellor work **by design** (a caller cannot close), and widening the
  caller role would have rewritten the deal, incentive and collections
  machinery. The counsellor role was already 90% of "everyone does
  everything"; 0085 supplied the missing 10%.
- One **admin** account stays for administration — users, settings, archive,
  hand-overs, assigning parked leads. The same human can hold both logins; the
  admin account itself holds no team and works no leads.
- **One team**, everyone in it. With a single team the alternating team
  rotation is trivially that team, and transfers between the two or three
  people stay within it (a counsellor can transfer within their own team;
  cross-team moves are the admin's).

## The one-time reset, in order

1. **Apply migrations** on the live database (forward-only, filename order —
   0085 must be in).
2. **Create the new people** — Admin → Users, role *counsellor*, team: the
   surviving team. In the SIM modal per person: their Dialing number, 🎧 if
   the softphone should ring in the browser, or 📵 if they call from an
   office/personal phone outside cloud calling.
3. **Deactivate everyone who is leaving** — Admin → Users → Deactivate. This
   stops fresh leads and logins, nothing else; their books move in step 5.
4. **Start the book clean** — Admin → the archive panel: *Check what would
   move* (dry run), then archive with the cutoff set to today. Every lead not
   tied to a deal parks into the previous-months pool and its pending
   callbacks are cancelled. **Paying clients, deals, instalments and
   collections stay live** — money history is never falsified.
5. **Hand over each departed person's remaining book** — on each deactivated
   row in Admin → Users: *Hand over N leads* → pick one of the new
   counsellors. After the archive this is the parked book plus any open
   deal-stage leads; moving it means a client who enquires again rings the
   right person instead of an empty chair. A departed counsellor's book can
   only go to a counsellor — the button's picker already knows.
6. **Point intake at the one team** — Admin → Sources: pin every source to
   the surviving team. Without this, the team rotation can hand an off-hours
   lead to the empty team, where it parks until someone notices. (Equivalent
   owner-level act in SQL, if preferred:
   `update crm.teams set is_active = false where code = 'TB';` — an inactive
   team leaves the rotation entirely.)
7. **Targets** (optional) — each person now carries the counsellor's
   *revenue* target; anyone unset carries the role default, never zero.
   Nothing else in Settings needs touching for the shape itself.

## What changes day to day, and what simply idles

- **Fresh leads** distribute among whoever is on the floor, fewest-today
  first, rotation breaking ties — the same fairness shape callers had. The
  Floor page's share column still shows who received what.
- **Dashboards**: the counsellor board is the leaderboard; the caller board is
  empty. Caller-only machinery lies idle rather than removed: the two-strike
  escalation ladder, tiers and the ACE seat, the 15-day stale mover, walk-in
  targets. Hire a caller again and all of it wakes up — distribution prefers
  callers the moment one is eligible, and the pipeline splits back into
  caller → counsellor with nothing to undo.
- **Unchanged**: the 9-hour attendance day, callbacks and popups, green
  leads, re-enquiry dedupe (every enquiry still lands on Fresh), power dial,
  Smartflo click-to-call and CDR verification, deals and collections chasing,
  RLS. With one team, the working people see the team's book — which is now
  the whole book — and "no data breach" means exactly these two to four
  accounts.

## Things that look odd afterwards but are correct

- A covered fresh lead shows escalation stage *counsellor* with no caller —
  that is its normal resting state now, not a half-escalated error.
- The coverage panel and watchdog still name anyone Smartflo cannot serve;
  📵 on the SIM modal records the people who are outside cloud calling by
  choice, so the panel can go quiet honestly.
- Re-enquiries against archived leads reopen them to whoever received the
  hand-over in step 5 (or surface on Fresh for the admin to assign if a book
  was never handed over). Nothing is lost either way; one path rings a person
  directly, the other waits for a click.
