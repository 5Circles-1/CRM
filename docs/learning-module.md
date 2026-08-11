# 5 Circles CRM — Learning Module

One curriculum, three tracks. Each track is a sequence of short sessions with a
practice task and a check — nobody learns a CRM by reading about it, so every
session ends with something done in the system. The role guides referenced
here carry the full detail, red flags and troubleshooting tables:

- `training-caller.md` · `training-counsellor.md` · `training-admin.md`

## The five rules everyone learns first (30 minutes, whole floor together)

1. **Nothing is ever lost.** Every open lead always carries a next action —
   the database refuses anything else. If you cannot find a lead, it moved or
   closed; Find lead shows you which.
2. **The clock runs Mon–Sat, 09:30–18:30 only.** A lead arriving Saturday
   evening is due Monday morning, not "breached" through Sunday. An immediate
   lead must be touched within **30 working minutes**.
3. **Untouched leads move.** 10 working minutes with no call and a new lead
   goes to the next caller, round the team, then back to whoever had it first —
   for good. A lead you have called once never moves on its own.
4. **A connect needs 30+ seconds of real talk.** Outcomes describe what
   happened, not what looks good; job enquiries close as *invalid*, never
   *not interested*.
5. **Fresh leads follow performance.** Three tiers, recomputed against each
   other (best walk-in converter over 30 days wins ACE; the weakest may be
   RESTRICTED): ACE holds 66.7% of fresh leads, STANDARD splits the rest,
   RESTRICTED receives none. **The road back for RESTRICTED is real and it is
   worked, not waited for:** re-tap lists, internal transfers and offline
   imports still flow to you, and conversions earned there count fully toward
   the same ranking. Every exclusion is written to the audit log with a
   reason; every pin has a named decision-maker and an expiry, and an expired
   pin lapses on its own. Nobody is restricted by a formula alone — a pin is
   a management decision you can see and appeal.
6. **You see what is yours.** Callers see their own leads, counsellors their
   team, admin everything. That is the database enforcing it, not politeness.

## Mentor track (one session — and the health-chip rulebook)

A paying client appears on the **Mentors** tab the moment money is recorded —
nobody adds them by hand. The job is one habit: **after every client contact,
log the touchpoint in three taps** (channel → outcome → upsell potential).
Notes, "what to offer" and the next follow-up date are optional but are what
make the timeline worth reading in six months.

The health chip is **computed, never set by hand**. The exact rules (the
day-counts are Settings keys, changeable by admin without code):

| Colour | You are here because… | Default trigger |
|---|---|---|
| 🔴 Red | the last outcome was **concern raised** | immediately |
| 🔴 Red | the client has **never** been touched since paying | 7 days after first payment (`mentor.untouched_red_days`) |
| 🔴 Red | the client has gone quiet | last touch > 21 days old (`mentor.health_red_days`) |
| 🔴 Red | a promised follow-up is badly late | > 3 days past it (`mentor.followup_grace_days`) |
| 🟠 Amber | not yet touched, still inside the first week | — |
| 🟠 Amber | a touch is getting old | last touch > 10 days (`mentor.health_amber_days`) |
| 🟠 Amber | last attempt didn't land | outcome was *no answer* / *rescheduled* |
| 🟠 Amber | a follow-up is due today or just slipped | — |
| 🟢 Green | touched recently, went fine, nothing overdue | — |

Work the book **red first, then amber, oldest silence first** — the default
sort already does this. Upsell flags (High/Medium/Low) build the **warm
pipeline** counsellors see; flag honestly, because a counsellor will call.

| # | Session | Practice task | You pass when |
|---|---|---|---|
| 1 | The book, the 3-tap log, health | Log 5 touchpoints incl. one concern and one upsell flag; watch the chips move | You can say *why* each of your clients is its colour |

## Caller track (three sessions, ~40 min each)

| # | Session | Practice task | You pass when |
|---|---|---|---|
| 1 | Shift, pipeline, logging calls | Start shift, work My Pipeline top to bottom, log 5 calls with honest outcomes and MM:SS talk time | Every logged call left a next step |
| 2 | Callbacks, alerts, WhatsApp, walk-ins | Set a callback, watch it pop, mark WhatsApp sent, mark one walk-in | The bell is empty at the end |
| 3 | Re-tapping | Build "not answered + overdue + no WhatsApp", then "due 3rd follow-up", work both lists | You can name a filter for any list you're asked for |

## Counsellor track (two sessions, after the caller track)

| # | Session | Practice task | You pass when |
|---|---|---|---|
| 1 | Floor: leaderboard, scoreboard, leaks | Read today's leaderboard, work the leak list to zero, execute one transfer with a reason | You can explain why callers cannot transfer |
| 2 | Deals, collections, performance | Book a deal, record a payment, read Performance for your team, read the funnel | You can say who converts best *and why the number is fair* |

## Admin track (two sessions)

| # | Session | Practice task | You pass when |
|---|---|---|---|
| 1 | Users, sources, settings | Create a user, reset a password, pin a source to a team, set a retry gap | You can undo every change you made |
| 2 | Health: backups, security, quarantine | Run a backup, run the restore drill, read Security alerts and Quarantine | The restore count came back non-zero |

## The quiz (ask these before go-live; answers in the role guides)

1. A lead arrives Saturday 18:20. When is it breached? *(Monday ~10:05 — 30 working minutes.)*
2. Who moves a lead a caller has already called once? *(Only a counsellor or admin.)*
3. A caller marks a job-seeker "not interested". What went wrong? *(Closed as lost instead of invalid — it poisons conversion rates.)*
4. Someone forgot their password. The three doors? *(Top-bar Password if signed in; admin reset if locked out; the server rescue tool if the admin is locked out.)*
5. Why does a caller with zero calls show "—" and not 0% conversion? *(No denominator — 0% would rank idleness beside effort.)*
6. Where does "who brought the most walk-ins" live? *(Floor leaderboard trophy, and Performance sorted by Walked in.)*
