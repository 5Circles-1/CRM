# Master Upgrade — Audit & Plan (Phase 0)

Requested 9 Aug 2026. No code in this pass: this is the audit the master
prompt demands, produced by the engineer who built most of the system and
knows where the bodies are buried. **Four requirements conflict with
load-bearing design; they are flagged, not silently resolved.**

---

## 1. File map (what exists, what each work package touches)

84 source files. The ones that matter per work package:

| Area | Files | Touched by |
|---|---|---|
| Schema & engines | `db/migrations/0001–0025` (forward-only), `db/tests/test_requirements.sql` (86 assertions) | B, C, D, E, F, H, I |
| RLS session contract | `api/src/db/pool.ts` | every WP (read it before writing any query) |
| Routes | `api/src/routes/{leads,me,dashboards,admin,transfers,deals,attendance,auth,ingest,messages,deviceLogs}.ts` | B, E, F, H, I, J |
| Engines-on-a-timer | `api/src/jobs/scheduler.ts`, `api/src/index.ts` (ingest loop) | B, C, E |
| UI shell & theme | `api/public/{app.css,index.html}`, `js/{main,alerts,charts,util,api}.js` | A, K, L |
| Views | `js/views/{day,floor,people,dash,leads,lead,admin,team,collections,attendance,score,login}.js` | A, J, K |
| Ingestion | `api/src/ingest/{worker,source,cli}.ts` | H |
| Docs/training | `docs/{learning-module,training-*}.md` | G |
| Android companion | `android/` (call-log verification) | J (recording link field) |

## 2. Theme audit (why dark mode is partial)

The current "dim" theme is **deliberately** partial: dark chrome, light
cards, because the chart palette was contrast-validated against a light
surface only. A true two-theme system requires:

- **98 hardcoded colour/inline-style instances** across `js/views/*` (counted, not estimated).
- `charts.js` constants `INK/MUTED/GRID` + white surface rings/gaps on every mark — must become CSS-variable-driven per theme.
- Dark **chart palette steps re-validated** (the dataviz method ships dark-mode steps; each must pass the CVD/contrast gates against the dark surface — this is computable, not eyeballed).
- Toasts, modals, badges (`b-ok/b-warn/...`), banner variants, `.viz-tip` (already dark — inverts wrong in dark mode), scrollbars, date inputs, print.
- Server-side theme persistence (`user_preferences`) instead of localStorage-only.

Verdict: WP A is real and sizeable (~2 days), and the screenshot checklist
is producible with the existing Playwright harness.

## 3. Existing bugs found in this audit (beyond the reported list)

1. **Auto-refresh vs. leaderboard state** — Floor redraws every 30s; the leaderboard period picker resets to "Today" on each redraw.
2. **`v_my_alerts` "reassigned_in" window** uses wall-clock 2 hours; after the working-hours migration it should use working time (Monday morning loses Friday-evening reassignment notices — minor, but inconsistent).
3. **Ingest loop runs Sundays** (by design — capture, don't assign), but its `assign_pending_leads` call runs too; harmless only while `require_on_shift` stays true. Should be belt-and-braces gated.
4. **`fmtINR` renders paise** on some deal amounts (cosmetic).
5. **WP D's premise is stale**: the Mahi/Simon "timer shows 0" root causes were found and fixed *today* (stale multi-day sessions; `is_on_shift` now requires a today-IST session; hour-idle auto-logout with backdating; scheduler Sunday gate). The timer is already server-authoritative; there is no client-clock path. What WP D still adds of value: heartbeat, idempotent double-start guard (exclusion constraint already prevents overlap — verify the error is friendly), admin shift-correction UI. **Recommend: verify-then-harden, not rebuild.**

## 4. Data model gaps (new tables per WP)

| WP | New tables | Note |
|---|---|---|
| B | `performance_tiers`, `tier_history`, `distribution_ledger` (+reason codes on existing `distribution_events`) | `routing_config` = existing `crm.settings` (keep one config store, don't add a second) |
| C | `freeze_windows` | integrates into `add_working_minutes` + engine gates |
| D | none (harden `attendance_sessions`: heartbeat_at column) | |
| E | `daily_targets`, `notifications`, `reminder_log` | targets partially exist (`dial targets`, breakeven) |
| F | `events`, `event_leads` (copy-linked, originals untouched — matches existing append-only philosophy) | |
| G | `training_modules`, `training_acks`, `ui_registry` | content source = existing docs |
| H | `import_batches` (+batch_id on `ingested_rows`) | CSV path exists; adds xlsx, mapper, rollback |
| I | `mentor_touchpoints` (+mentor role) | **see conflict #1 before building** |
| K | `user_preferences` | also used by A (theme) |

`audit_log`, `assignment_audit`, `shifts`, `breaks`(→`work_shifts` exists),
dedup, role guards, IST handling: **already exist** — the prompt was written
against an imagined codebase; roughly a third of WP L is already true here
and covered by 144 API tests + 86 DB assertions + 6 browser flows.

## 5. Risk list — conflicts needing an explicit decision

**R1 — Mentors tab vs. the SEBI scope boundary (WP I).** `CLAUDE.md`, first
section: this is a *sales-floor* CRM; servicing paying clients — touchpoints,
research delivery, long-term client records — **must not be built here**; it
belongs to the advisory pipeline, and the handoff outbox exists precisely to
carry paid clients out. Mentor touchpoints + upsell pipeline on paid clients
is client servicing. For a SEBI-registered advisory this boundary is
compliance posture, not taste. *Recommendation:* keep WP I out of this CRM;
surface "paid, handed off, upsell-flagged" as a read-only warm list fed back
through `handoff_inbound`. Build the full Mentors module only on an explicit,
recorded override of the scope boundary.

**R2 — RESTRICTED tier (WP B) vs. anti-starvation distribution.** The
existing engine is least-loaded-then-rotation *because* strict exclusion
starves people (documented load-bearing decision; R1 tests assert fair
alternation). A zero-fresh-leads tier is buildable as config, but note: by
the prompt's own sample-size rule (20 walk-ins/30d), nobody currently
qualifies for ranking — so Kajal = RESTRICTED on day one is a **manual pin,
a personnel decision recorded in the audit log with your name on it**, not a
computed outcome. Confirm that's intended. Also several existing R1
assertions will be rewritten to "fairness *within the eligible pool*".

**R3 — WP D rebuild.** Conflicts with today's fixes (see §3.5). Rebuilding a
working server-authoritative timer to a spec written for a different stack
risks re-introducing bugs. Recommend the verify-then-harden subset.

**R4 — Reminder delivery (WP E).** No SMTP or WhatsApp API is configured
anywhere. In-app notification centre + banner ship now; email/WhatsApp are
stub hooks until credentials exist. (The Meta connection in this workspace is
an *ads* account, not a WhatsApp Business API.)

**R5 — Fresh reset interaction.** Tier ranking needs 30 days of walk-in
history; the database was reset to Saturday's state today. Rankings stay
sample-size-suppressed (= everyone STANDARD) for weeks. Expected, but say it
now, not when the leaderboard "looks wrong".

## 6. Build order (nothing breaks mid-way)

- **Phase 1 — foundations** (everything else depends on it):
  `user_preferences` (theme, confetti), `notifications` table + centre,
  full token sweep + two validated themes (WP A5), freeze windows folded
  into the working-hours clock (WP C). ~3 days.
- **Phase 2 — distribution** (WP B): tiers, ledger, reason codes, parking
  queue, Distribution Ledger screen, rewritten R1 tests, acceptance tests
  2–5 as automated tests. ~3 days. *Gated on R2 decision.*
- **Phase 3 — floor features**: WP J (workspace: most items small, several
  exist), WP D hardening, WP K (confetti + boards), WP E (reminders,
  in-app). ~4 days.
- **Phase 4 — modules**: WP F (events), WP H (import v2), WP G (training
  academy + UI registry + acks). ~5 days.
- **WP I**: parked pending R1 decision.
- **WP L** runs as the exit gate of every phase (it is largely the standard
  this repo already holds itself to), plus the acceptance-test suite.

Trading-floor visual identity (ticker, sparklines, candlestick, market
open/close) lands with Phase 1 tokens + Phase 3 polish. Brand hexes will be
sampled from `api/public/brand/logo.png` (the real artwork now deployed) and
reported before applying, per A1.

---
*Answers to the blocking questions in §5 (R1–R4) unblock Phases 2+ — Phase 1
contains no conflicts and can start on go-ahead.*
