-- 0011_dashboard_views.sql
-- Requirements 2, 4, 5 and 9: the screens.
--
-- These views are the contract between the database and the UI. Keeping the
-- arithmetic here rather than in application code means the caller screen, the
-- counsellor screen and any export can never disagree about the same number.

-- ---------------------------------------------------------------------------
-- Requirement 4: the caller's pipeline for today.
-- Everything the caller must action, ordered the way it should be worked.
-- ---------------------------------------------------------------------------

create or replace view crm.v_my_day as
select
  l.id                as lead_id,
  l.caller_id,
  l.team_id,
  l.full_name,
  l.phone_e164,
  l.city,
  l.campaign_name,
  l.priority,
  l.status,
  l.next_action_at,
  l.next_action_note,
  l.attempt_count,
  l.na_streak,
  l.last_contacted_at,
  cb.scheduled_at     as callback_at,
  cb.note             as callback_note,
  -- Bucket drives the grouping on screen.
  case
    when l.priority = 'immediate' and l.first_touched_at is null then 'immediate'
    when l.next_action_at < now()                                then 'overdue'
    when cb.id is not null                                       then 'callback'
    when l.first_touched_at is null                              then 'fresh'
    else 'scheduled'
  end                 as bucket,
  case
    when l.next_action_at < now()
      then extract(epoch from (now() - l.next_action_at)) / 60
    else 0
  end::int            as minutes_overdue,
  -- Requirement 5: countdown on an unworked immediate lead.
  case
    when l.priority = 'immediate' and l.first_touched_at is null
      then extract(epoch from (l.first_touch_due_at - now())) / 60
  end::int            as sla_minutes_remaining
from crm.leads l
left join crm.callbacks cb
  on cb.lead_id = l.id and cb.status = 'pending'
where l.status not in ('won', 'lost', 'invalid', 'nurture', 'handed_off')
  and l.next_action_at is not null
  and l.next_action_at < (crm.ist_date(now()) + 1)::timestamp at time zone 'Asia/Kolkata';

comment on view crm.v_my_day is
  'Requirement 4. Filter by caller_id for the caller screen; by team_id for the counsellor view of the floor.';

-- ---------------------------------------------------------------------------
-- Requirement 5: immediate leads awaiting first contact, most urgent first.
-- ---------------------------------------------------------------------------

create or replace view crm.v_immediate_queue as
select
  l.id            as lead_id,
  l.full_name,
  l.phone_e164,
  l.team_id,
  l.caller_id,
  u.full_name     as caller_name,
  l.created_at,
  l.first_touch_due_at,
  extract(epoch from (now() - l.created_at))::int / 60 as age_minutes,
  (now() > l.first_touch_due_at)                       as sla_breached,
  crm.is_on_shift(l.caller_id)                         as caller_on_floor
from crm.leads l
left join crm.users u on u.id = l.caller_id
where l.priority = 'immediate'
  and l.first_touched_at is null
  and l.status not in ('won', 'lost', 'invalid', 'handed_off')
order by l.first_touch_due_at asc;

-- ---------------------------------------------------------------------------
-- Requirement 2: caller performance, one row per caller per day.
-- ---------------------------------------------------------------------------

create or replace view crm.v_caller_day as
with dials as (
  select user_id,
         crm.ist_date(started_at) as d,
         count(*)                                   as dials,
         count(*) filter (where is_connect)         as connects,
         count(*) filter (where is_verified)        as verified_dials,
         count(*) filter (where disposition = 'not_answered') as not_answered,
         round(coalesce(sum(duration_seconds) filter (where is_connect), 0) / 60.0, 1) as talk_minutes
    from crm.call_attempts
   group by user_id, crm.ist_date(started_at)
),
assigned as (
  select caller_id as user_id,
         crm.ist_date(created_at) as d,
         count(*) as leads_assigned,
         count(*) filter (where first_touched_at is not null) as leads_touched,
         count(*) filter (where first_touched_at <= first_touch_due_at) as touched_in_sla
    from crm.leads
   where caller_id is not null
   group by caller_id, crm.ist_date(created_at)
),
cbs as (
  select assigned_to as user_id,
         crm.ist_date(scheduled_at) as d,
         count(*) filter (where status = 'pending')   as callbacks_pending,
         count(*) filter (where status = 'completed') as callbacks_kept,
         count(*) filter (where status = 'missed')    as callbacks_missed
    from crm.callbacks
   group by assigned_to, crm.ist_date(scheduled_at)
),
-- Date spine. Joining the three CTEs to each other on the dial date would hide
-- a caller's assigned leads and callbacks until they made their first call -
-- i.e. the whole floor would read as zero every morning.
spine as (
  select user_id, d from (
    select user_id, crm.ist_date(started_at) as d from crm.call_attempts
    union
    select caller_id, crm.ist_date(created_at) from crm.leads where caller_id is not null
    union
    select assigned_to, crm.ist_date(scheduled_at) from crm.callbacks
    union
    -- Always show today for every active caller, even before they do anything.
    select id, crm.ist_date(now()) from crm.users where is_active and role = 'caller'
  ) x
  where user_id is not null
)
select
  u.id                                as user_id,
  u.full_name,
  crm.team_of(u.id, spine.d)          as team_id,
  spine.d                             as business_date,
  coalesce(dials.dials, 0)            as dials,
  coalesce(dials.connects, 0)         as connects,
  coalesce(dials.verified_dials, 0)   as verified_dials,
  coalesce(dials.not_answered, 0)     as not_answered,
  coalesce(dials.talk_minutes, 0)     as talk_minutes,
  round(coalesce(dials.connects, 0)::numeric
        / nullif(coalesce(dials.dials, 0), 0), 3) as connect_rate,
  -- The single strongest fabrication signal: logged calls with no device row.
  coalesce(dials.dials, 0) - coalesce(dials.verified_dials, 0) as unverified_dials,
  coalesce(assigned.leads_assigned, 0) as leads_assigned,
  coalesce(assigned.leads_touched, 0)  as leads_touched,
  coalesce(assigned.touched_in_sla, 0) as touched_in_sla,
  coalesce(cbs.callbacks_pending, 0)   as callbacks_pending,
  coalesce(cbs.callbacks_kept, 0)      as callbacks_kept,
  coalesce(cbs.callbacks_missed, 0)    as callbacks_missed,
  crm.setting_int('dial.daily_target_per_caller', 80) as dial_target
from spine
join crm.users u   on u.id = spine.user_id
left join dials    on dials.user_id    = spine.user_id and dials.d    = spine.d
left join assigned on assigned.user_id = spine.user_id and assigned.d = spine.d
left join cbs      on cbs.user_id      = spine.user_id and cbs.d      = spine.d
where u.role = 'caller';

-- ---------------------------------------------------------------------------
-- Requirement 2: counsellor performance, month to date.
-- ---------------------------------------------------------------------------

create or replace view crm.v_counsellor_mtd as
with period as (
  select date_trunc('month', crm.ist_date(now()))::date as month_start,
         crm.ist_date(now()) as today
),
received as (
  select counsellor_id as user_id, count(*) as leads_received
    from crm.leads, period
   where counsellor_id is not null
     and crm.ist_date(created_at) between period.month_start and period.today
   group by counsellor_id
),
booked as (
  select d.counsellor_id as user_id,
         count(*) as deals_won,
         coalesce(sum(d.booked_amount), 0)   as booked_amount,
         coalesce(sum(d.discount_amount), 0) as discount_given
    from crm.deals d, period
   where d.status = 'booked'
     and crm.ist_date(d.booked_at) between period.month_start and period.today
   group by d.counsellor_id
),
collected as (
  select d.counsellor_id as user_id,
         coalesce(sum(p.amount), 0) as collected_amount
    from crm.payments p
    join crm.deals d on d.id = p.deal_id, period
   where crm.ist_date(p.paid_at) between period.month_start and period.today
   group by d.counsellor_id
),
overdue as (
  select d.counsellor_id as user_id,
         coalesce(sum(i.amount - i.paid_amount), 0) as overdue_amount,
         count(*) as overdue_instalments
    from crm.instalments i
    join crm.deals d on d.id = i.deal_id
   where i.status = 'overdue'
   group by d.counsellor_id
)
select
  u.id                                    as user_id,
  u.full_name,
  crm.team_of(u.id, current_date)         as team_id,
  coalesce(r.leads_received, 0)           as leads_received,
  coalesce(b.deals_won, 0)                as deals_won,
  round(coalesce(b.deals_won, 0)::numeric
        / nullif(coalesce(r.leads_received, 0), 0), 3) as conversion_rate,
  coalesce(b.booked_amount, 0)            as booked_amount,
  coalesce(b.discount_given, 0)           as discount_given,
  coalesce(c.collected_amount, 0)         as collected_amount,
  round(coalesce(c.collected_amount, 0)
        / nullif(coalesce(b.booked_amount, 0), 0), 3) as collection_efficiency,
  coalesce(o.overdue_amount, 0)           as overdue_amount,
  coalesce(o.overdue_instalments, 0)      as overdue_instalments,
  crm.setting_num('score.counsellor_monthly_collection_target_inr', 200000) as collection_target
from crm.users u
left join received  r on r.user_id = u.id
left join booked    b on b.user_id = u.id
left join collected c on c.user_id = u.id
left join overdue   o on o.user_id = u.id
where u.role = 'counsellor' and u.is_active;

-- ---------------------------------------------------------------------------
-- Requirement 9: leakage. Anything sitting where it should not be.
-- This view is the one the counsellor works from every morning.
-- ---------------------------------------------------------------------------

create or replace view crm.v_pipeline_leakage as
select 'untouched_immediate' as leak_type, l.id as lead_id, l.team_id, l.caller_id,
       l.full_name, l.phone_e164,
       extract(epoch from (now() - l.first_touch_due_at))::int / 60 as minutes_late,
       'high' as severity
  from crm.leads l
 where l.priority = 'immediate' and l.first_touched_at is null
   and now() > l.first_touch_due_at
   and l.status not in ('won','lost','invalid','handed_off')
union all
select 'untouched_24h', l.id, l.team_id, l.caller_id, l.full_name, l.phone_e164,
       extract(epoch from (now() - l.created_at))::int / 60,
       'high'
  from crm.leads l
 where l.first_touched_at is null
   and l.created_at < now() - interval '24 hours'
   and l.status not in ('won','lost','invalid','nurture','handed_off')
union all
select 'overdue_next_action', l.id, l.team_id, l.caller_id, l.full_name, l.phone_e164,
       extract(epoch from (now() - l.next_action_at))::int / 60,
       case when l.next_action_at < now() - interval '48 hours' then 'high' else 'medium' end
  from crm.leads l
 where l.next_action_at < now()
   and l.status not in ('won','lost','invalid','nurture','handed_off')
union all
select 'missed_callback', l.id, l.team_id, l.caller_id, l.full_name, l.phone_e164,
       extract(epoch from (now() - cb.scheduled_at))::int / 60,
       'high'
  from crm.callbacks cb
  join crm.leads l on l.id = cb.lead_id
 where cb.status = 'missed'
   and cb.scheduled_at > now() - interval '7 days'
union all
select 'unassigned', l.id, l.team_id, null, l.full_name, l.phone_e164,
       extract(epoch from (now() - l.created_at))::int / 60,
       'medium'
  from crm.leads l
 where l.caller_id is null
   and l.status in ('new', 'working');

comment on view crm.v_pipeline_leakage is
  'Requirement 9. Every way a lead can go quiet, in one list. If this view is empty the pipeline is clean.';

-- ---------------------------------------------------------------------------
-- The breakeven thermometer. Anchored to the real monthly cost of the office.
-- ---------------------------------------------------------------------------

create or replace view crm.v_collection_thermometer as
with cfg as (
  select crm.setting_num('finance.monthly_breakeven_inr', 700000)   as breakeven,
         crm.setting_num('finance.collection_efficiency_pct', 85)   as coll_pct,
         crm.setting_int('finance.working_days_per_month', 25)      as working_days
),
mtd as (
  select coalesce(sum(p.amount), 0) as collected
    from crm.payments p
   where crm.ist_date(p.paid_at) >= date_trunc('month', crm.ist_date(now()))::date
),
booked as (
  select coalesce(sum(d.booked_amount), 0) as booked
    from crm.deals d
   where d.status = 'booked'
     and crm.ist_date(d.booked_at) >= date_trunc('month', crm.ist_date(now()))::date
),
elapsed as (
  select extract(day from crm.ist_date(now()))::int as day_of_month,
         extract(day from (date_trunc('month', crm.ist_date(now()))
                 + interval '1 month - 1 day'))::int as days_in_month
)
select
  cfg.breakeven                                              as monthly_breakeven,
  -- Booking target must gross up for collection slippage: you do not need to
  -- book the cost number, you need to book cost / collection efficiency.
  round(cfg.breakeven / (cfg.coll_pct / 100.0))              as required_booking,
  round(cfg.breakeven / cfg.working_days)                    as daily_collection_floor,
  mtd.collected                                              as collected_mtd,
  booked.booked                                              as booked_mtd,
  round(100.0 * mtd.collected / nullif(cfg.breakeven, 0), 1) as pct_of_breakeven,
  -- Where collection should be by today if it ran evenly.
  round(cfg.breakeven * elapsed.day_of_month / nullif(elapsed.days_in_month, 0)) as expected_by_today,
  round(100.0 * mtd.collected
        / nullif(cfg.breakeven * elapsed.day_of_month / nullif(elapsed.days_in_month, 0), 0), 1)
                                                             as pct_of_pace,
  greatest(cfg.breakeven - mtd.collected, 0)                 as gap_to_breakeven,
  case
    when mtd.collected >= cfg.breakeven * elapsed.day_of_month / nullif(elapsed.days_in_month, 0) then 'green'
    when mtd.collected >= 0.85 * cfg.breakeven * elapsed.day_of_month / nullif(elapsed.days_in_month, 0) then 'amber'
    when mtd.collected >= 0.70 * cfg.breakeven * elapsed.day_of_month / nullif(elapsed.days_in_month, 0) then 'red'
    else 'founder_intervention'
  end                                                        as status
from cfg, mtd, booked, elapsed;

comment on view crm.v_collection_thermometer is
  'Collected month-to-date against the office breakeven, with the pace check. Status escalates green / amber / red / founder_intervention.';

-- ---------------------------------------------------------------------------
-- Live floor view for the counsellor: who is on, and what they are doing.
-- ---------------------------------------------------------------------------

create or replace view crm.v_floor_live as
select
  u.id            as user_id,
  u.full_name,
  u.role,
  crm.team_of(u.id, current_date) as team_id,
  ad.currently_logged_in,
  coalesce(ad.logged_minutes, 0)  as logged_minutes_today,
  ad.expected_minutes,
  ad.is_late,
  coalesce(cd.dials, 0)           as dials_today,
  coalesce(cd.connects, 0)        as connects_today,
  cd.dial_target,
  (select count(*) from crm.v_my_day m
    where m.caller_id = u.id and m.bucket in ('overdue', 'immediate')) as urgent_in_queue,
  (select max(started_at) from crm.call_attempts ca where ca.user_id = u.id) as last_call_at
from crm.users u
left join crm.v_attendance_day ad
  on ad.user_id = u.id and ad.business_date = crm.ist_date(now())
left join crm.v_caller_day cd
  on cd.user_id = u.id and cd.business_date = crm.ist_date(now())
where u.is_active and u.role in ('caller', 'counsellor');
