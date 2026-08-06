# KPI framework — what good looks like, in numbers

Every KPI below is enforced or measured by the system itself, not by a weekly
spreadsheet. Each one names where it lives, so changing a target is an ops
action in **Admin → Settings**, never a code change.

The scores these KPIs feed update **every 15 minutes** during the day, the
leaderboard recomputes on **every page refresh (~30 s)**, and the follow-up
radar is **live**. Nobody should learn on Friday that Tuesday went badly.

---

## Caller KPIs (daily)

Weights are the score components in `crm.score_definitions`; targets are
settings.

| KPI | Target | Weight | Setting / source |
|---|---|---|---|
| Dials | 80 verified dials/day | 20 | `dial.daily_target_per_caller` |
| Connect rate | 35% of dials | 15 | `score.connect_rate_benchmark` |
| Talk time | 90 min connected talk/day | 10 | `score.talk_minutes_benchmark` |
| Callbacks kept | 100% before they expire | 20 | callback engine |
| Speed to lead | First dial inside SLA (5 min immediate / 60 min normal) | 15 | `sla.immediate_first_touch_minutes`, `sla.normal_first_touch_minutes` |
| Qualified handoffs | 20% of connects | 15 | `score.qualification_benchmark` |
| Log accuracy | Every logged call backed by a device log row | 5 | Android companion app |

**A connect requires 30+ seconds of real talk** (`dial.min_talk_seconds_for_connect`).
Logging a 5-second call as "connected" does not move any KPI — by design.

### Non-negotiables (not scored, enforced)

- **No lead leaves a call without a next action.** The database refuses it.
- **9-hour floor presence, 09:30–18:30 IST**, measured by Start/End shift.
- **A new lead untouched for 10 minutes moves to the next caller**
  (`sla.untouched_reassign_minutes`) and the pass is recorded.

## Counsellor KPIs (monthly)

| KPI | Target | Weight | Setting / source |
|---|---|---|---|
| Conversion | Deals won / qualified leads received | 25 | pipeline |
| Collected revenue | ₹2,00,000/month (set from breakeven) | 25 | `score.counsellor_monthly_collection_target_inr` |
| Collection health | Collected / own booked value | 20 | payments |
| Pipeline hygiene | Own open leads carrying a future next action | 15 | leads |
| Team leakage | Inverse of team leads sitting overdue | 15 | `v_pipeline_leakage` |

Counsellors also own the **transfer queue** (not-answered streaks) and the
**follow-up radar** — an overdue row on the radar is a conversation today, not
at month end.

## Office KPI — the breakeven thermometer

| Number | Meaning | Setting |
|---|---|---|
| Monthly breakeven | What the office must collect | `finance.monthly_breakeven_inr` |
| Required booking | Breakeven grossed up for collection slippage | `finance.collection_efficiency_pct` |
| Daily collection floor | Any day below this loses money | `finance.working_days_per_month` |

Status escalates green → amber → red → founder intervention on pace vs. today.

## Overall leaderboard weights

The overall standings blend every metric into one 0–100 number. Weights are
settings (`leaderboard.weight_*`): deals 25, revenue 25, connects 15, dials 10,
interested 10, walk-ins 10, talk time 5. Each metric is normalised against the
best on the floor in the window, so the board is always a race, never a fixed
bar.

## Review cadence

| When | Who | Looks at |
|---|---|---|
| Live, all day | Everyone | Follow-up radar, alerts bell, My Pipeline |
| Daily stand-up | Counsellor + callers | Yesterday's scoreboard, today's overdue |
| Weekly | Admin + counsellors | Leaderboard (This week), funnel, transfers |
| Monthly | Founder | Thermometer, counsellor MTD, KPI target review |
