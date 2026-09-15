-- 0072_a_target_is_one_persons_number.sql
--
-- The owner's rule (15 Sep): "Add Individual Targets for counsellors in terms
-- of revenue and callers in terms of walkins."
--
-- Half of this already existed and nobody could see it. crm.user_targets has
-- carried a per-person monthly collection target since 0031 - but the only
-- thing that ever read it was the daily brief notification, there was no
-- screen to set one, and a caller had no target of their own at all. Their
-- number was `dial.daily_target_per_caller`, one setting for the whole floor,
-- which is a floor standard, not a target: it cannot be raised for the caller
-- who is ready for more or held for the one who just joined.
--
-- So: one target row per person per month, two numbers on it.
--
--   COUNSELLOR -> REVENUE. Deliberately the collection target that already
--   exists rather than a second "booked revenue" figure beside it. The floor
--   is judged on money that arrived - the breakeven thermometer, the pace
--   check and the daily brief all already mean collected - and a screen with
--   two revenue targets on it is a screen where nobody knows which one they
--   are behind on. Booked is shown next to it as information.
--
--   CALLER -> WALK-INS. What a caller can actually control is how many people
--   they put in the office; the deal is the counsellor's to close. 0071 made
--   this countable per caller for the first time (crm.walkin_visits.caller_id
--   is who sent them in, never who greeted them), which is what makes it a
--   fair target rather than a shared one.
--
-- Everything defaults. A person with no row set carries their role's default -
-- an equal share of the office breakeven for a counsellor, the floor's
-- walk-in standard for a caller - so the screen is honest on day one and
-- setting a target is an adjustment rather than a prerequisite.

alter table crm.user_targets
  add column if not exists monthly_walkin_target int
    check (monthly_walkin_target >= 0);

comment on column crm.user_targets.monthly_walkin_target is
  'Walk-ins this person is expected to put in the office this month. A
   caller''s number: crm.walkin_visits credits the walk-in to whoever sent
   them in, so this is theirs to hit and not shared with the closer.';

comment on column crm.user_targets.monthly_collection_target is
  'Revenue this person is expected to COLLECT this month - money that
   arrived, the same meaning the thermometer and the daily brief already use.
   A counsellor''s number.';

-- ---------------------------------------------------------------------------
-- The defaults, as functions, so the one derivation is readable from
-- everywhere that needs it. The counsellor default is exactly the arithmetic
-- crm.v_daily_brief has used since 0031 - an equal share of the office
-- breakeven grossed up for collection slippage - lifted out of that view so
-- the brief and the new targets screen cannot quote different numbers at the
-- same person on the same morning.
-- ---------------------------------------------------------------------------
create or replace function crm.monthly_revenue_target(p_user uuid, p_month date default null)
  returns numeric
  language sql stable
as $$
  select coalesce(
    (select ut.monthly_collection_target
       from crm.user_targets ut
      where ut.user_id = p_user
        and ut.period_month = date_trunc('month',
              coalesce(p_month, crm.ist_date(now())))::date),
    (select case when u.role = 'counsellor' then
       round(crm.setting_num('finance.monthly_breakeven_inr', 700000)
             / (crm.setting_num('finance.collection_efficiency_pct', 85) / 100.0)
             / greatest((select count(*) from crm.users c
                          where c.is_active and c.role = 'counsellor'), 1))
     end from crm.users u where u.id = p_user))
$$;

comment on function crm.monthly_revenue_target(uuid, date) is
  'This person''s revenue target for the month: their own row if one is set,
   else an equal share of the office breakeven grossed up for collection
   slippage. Callers have none - their target is walk-ins.';

create or replace function crm.monthly_walkin_target(p_user uuid, p_month date default null)
  returns int
  language sql stable
as $$
  select coalesce(
    (select ut.monthly_walkin_target
       from crm.user_targets ut
      where ut.user_id = p_user
        and ut.period_month = date_trunc('month',
              coalesce(p_month, crm.ist_date(now())))::date),
    (select case when u.role in ('caller', 'counsellor')
                 then crm.setting_int('walkin.monthly_target_per_caller', 10) end
       from crm.users u where u.id = p_user))
$$;

comment on function crm.monthly_walkin_target(uuid, date) is
  'This person''s walk-in target for the month: their own row if one is set,
   else the floor standard from walkin.monthly_target_per_caller.';

grant execute on function crm.monthly_revenue_target(uuid, date) to crm_app;
grant execute on function crm.monthly_walkin_target(uuid, date) to crm_app;

-- ---------------------------------------------------------------------------
-- The brief now reads the same function. Identical arithmetic, one copy of
-- it: before this the default share was written out four times inside one
-- view, and a change to the breakeven policy would have had to find all four.
-- ---------------------------------------------------------------------------
create or replace view crm.v_daily_brief as
with cfg as (
  select crm.setting_num('finance.monthly_breakeven_inr', 700000) as breakeven,
         crm.setting_num('finance.collection_efficiency_pct', 85) as coll_pct,
         crm.ist_date(now())                                      as today,
         date_trunc('month', crm.ist_date(now()))::date           as month_start
),
staff as (
  select u.id, u.full_name, u.role, crm.team_of(u.id, crm.ist_date(now())) as team_id
    from crm.users u
   where u.is_active and u.role in ('caller', 'counsellor')
),
money as (
  select s.id as user_id,
         coalesce(sum(p.amount) filter (where crm.ist_date(p.paid_at) = cfg.today), 0) as collected_today,
         coalesce(sum(p.amount) filter (where crm.ist_date(p.paid_at) >= cfg.month_start), 0) as collected_mtd
    from staff s
    cross join cfg
    left join crm.deals d
      on (case when s.role = 'counsellor' then d.counsellor_id else d.setter_id end) = s.id
    left join crm.payments p
      on p.deal_id = d.id and crm.ist_date(p.paid_at) >= cfg.month_start
   group by s.id
),
work as (
  select s.id as user_id,
         (select count(*) from crm.call_attempts ca
           where ca.user_id = s.id and crm.ist_date(ca.started_at) = cfg.today)::int as dials_today,
         (select count(*) from crm.call_attempts ca
           where ca.user_id = s.id and crm.ist_date(ca.started_at) = cfg.today
             and ca.is_connect)::int as connects_today,
         (select count(*) from crm.leads l
           where l.caller_id = s.id and crm.ist_date(l.created_at) = cfg.today)::int as leads_today,
         (select count(*) from crm.leads l
           where l.caller_id = s.id and l.first_touched_at is null
             and l.status in ('new', 'working'))::int as untouched_now,
         (select count(*) from crm.leads l
           where (l.caller_id = s.id or l.counsellor_id = s.id)
             and l.status not in ('won', 'lost', 'invalid', 'handed_off')
             and l.next_action_at is not null and l.next_action_at < now())::int as overdue_now,
         (select count(*) from crm.callbacks cb
           where cb.assigned_to = s.id and cb.status = 'pending'
             and crm.ist_date(cb.scheduled_at) = cfg.today)::int as callbacks_today,
         (select count(*) from crm.leads l
           where (l.caller_id = s.id or l.counsellor_id = s.id)
             and l.status = 'won' and crm.ist_date(l.closed_at) = cfg.today)::int as won_today,
         (select count(*) from crm.leads l
           where (l.caller_id = s.id or l.counsellor_id = s.id)
             and l.status = 'lost' and crm.ist_date(l.closed_at) = cfg.today)::int as lost_today,
         (select count(*) from crm.leads l
           where l.counsellor_id = s.id and crm.ist_date(l.walked_in_at) = cfg.today)::int as walkins_today
    from staff s cross join cfg
),
tgt as (
  select s.id as user_id,
         crm.monthly_revenue_target(s.id, cfg.month_start) as monthly_target
    from staff s cross join cfg
)
select
  s.id as user_id, s.full_name, s.role, s.team_id,
  cfg.today as business_date,
  w.dials_today, w.connects_today, w.leads_today, w.untouched_now, w.overdue_now,
  w.callbacks_today, w.won_today, w.lost_today, w.walkins_today,
  coalesce(ut.daily_dial_target,
           case when s.role = 'caller'
                then crm.setting_int('dial.daily_target_per_caller', 80) end) as dial_target,
  m.collected_today, m.collected_mtd,
  tgt.monthly_target,
  crm.working_days_left()    as working_days_left,
  crm.working_days_elapsed() as working_days_elapsed,
  greatest(tgt.monthly_target - m.collected_mtd, 0) as gap_to_target,
  -- Required pace: what is left, spread over the working days that remain.
  round(greatest(tgt.monthly_target - m.collected_mtd, 0)
        / nullif(crm.working_days_left(), 0)) as required_per_day,
  -- Current pace: what has actually been collected per working day so far.
  round(m.collected_mtd / nullif(crm.working_days_elapsed(), 0)) as current_per_day,
  -- Where the month should stand today if it ran evenly. This, not the
  -- month-end number, is what "behind" means on the 11th.
  round(100.0 * m.collected_mtd
        / nullif(tgt.monthly_target
                 * crm.working_days_elapsed()
                 / nullif(crm.working_days_elapsed() + crm.working_days_left() - 1, 0), 0), 1)
    as pace_pct
from staff s
cross join cfg
join money m on m.user_id = s.id
join work  w on w.user_id = s.id
join tgt   on tgt.user_id = s.id
left join crm.user_targets ut
  on ut.user_id = s.id and ut.period_month = cfg.month_start;

alter view crm.v_daily_brief set (security_invoker = true);
grant select on crm.v_daily_brief to crm_app;

comment on view crm.v_daily_brief is
  'One row per active caller and counsellor: today''s cost and the month''s required run-rate, all computed. The notification body, the dashboard banner and any future email all read from here so they cannot disagree.';

-- ---------------------------------------------------------------------------
-- The targets screen, as one function over a month.
--
-- A function rather than a view because "how did we do in August" is the
-- second question anybody asks of a target, and a view fixed to the current
-- month cannot answer it. Invoker rights on purpose: RLS decides whose
-- progress the asker may read, so a caller opening this sees their own number
-- and a counsellor their team's, with no role check written here.
-- ---------------------------------------------------------------------------
create or replace function crm.user_target_progress(p_month date default null)
  returns table (
    user_id            uuid,
    full_name          text,
    role               crm.user_role,
    team_id            uuid,
    team_name          text,
    period_month       date,
    revenue_target     numeric,
    revenue_collected  numeric,
    revenue_booked     numeric,
    revenue_pct        numeric,
    revenue_per_day_needed numeric,
    walkin_target      int,
    walkins            int,
    walkins_converted  int,
    walkin_pct         numeric,
    walkins_per_day_needed numeric,
    is_custom          boolean,
    set_by             uuid,
    set_by_name        text,
    working_days_elapsed int,
    working_days_left  int
  )
  language sql stable
as $$
  with cfg as (
    select date_trunc('month', coalesce(p_month, crm.ist_date(now())))::date as month_start,
           least((date_trunc('month', coalesce(p_month, crm.ist_date(now())))
                  + interval '1 month - 1 day')::date,
                 crm.ist_date(now()))                                        as month_end,
           -- Pace only means anything for the month being lived through. For
           -- a month already over, "days left" is zero and the percentage is
           -- the final score.
           case when date_trunc('month', coalesce(p_month, crm.ist_date(now())))
                     = date_trunc('month', crm.ist_date(now()))
                then crm.working_days_left() else 0 end                      as days_left,
           -- Elapsed counts to today inside the current month, and to the
           -- month's end once it is over: "12 of 26 days" must not read as
           -- "12" forever on a month that finished in June.
           crm.working_days_elapsed(
             least((date_trunc('month', coalesce(p_month, crm.ist_date(now())))
                    + interval '1 month - 1 day')::date,
                   crm.ist_date(now())))                                     as days_elapsed
  ),
  staff as (
    select u.id, u.full_name, u.role, crm.team_of(u.id, crm.ist_date(now())) as team_id
      from crm.users u
     where u.role in ('caller', 'counsellor')
       and (u.is_active
            or exists (select 1 from crm.user_targets ut
                        where ut.user_id = u.id and ut.period_month = (select month_start from cfg)))
  ),
  money as (
    select s.id as user_id,
           coalesce(sum(p.amount), 0) as collected
      from staff s
      cross join cfg
      left join crm.deals d
        on (case when s.role = 'counsellor' then d.counsellor_id else d.setter_id end) = s.id
      left join crm.payments p
        on p.deal_id = d.id
       and crm.ist_date(p.paid_at) between cfg.month_start and cfg.month_end
     group by s.id
  ),
  booked as (
    select s.id as user_id,
           coalesce(sum(d.booked_amount), 0) as booked
      from staff s
      cross join cfg
      left join crm.deals d
        on (case when s.role = 'counsellor' then d.counsellor_id else d.setter_id end) = s.id
       and crm.ist_date(d.booked_at) between cfg.month_start and cfg.month_end
     group by s.id
  ),
  -- Walk-ins credited to whoever sent them in (0071). Deliberately NOT
  -- leads.walked_in_at counted against the counsellor: that is the closer's
  -- number and it is not what a caller is being asked for.
  visits as (
    select s.id as user_id,
           count(*) filter (where v.has_arrived)::int  as walkins,
           count(*) filter (where v.is_converted)::int as converted
      from staff s
      cross join cfg
      left join crm.v_walkin_visits v
        on v.caller_id = s.id
       and v.visit_date between cfg.month_start and cfg.month_end
     group by s.id
  )
  select
    s.id, s.full_name, s.role, s.team_id, t.name,
    cfg.month_start,
    crm.monthly_revenue_target(s.id, cfg.month_start),
    m.collected,
    b.booked,
    case when crm.monthly_revenue_target(s.id, cfg.month_start) > 0
         then round(100.0 * m.collected
                    / crm.monthly_revenue_target(s.id, cfg.month_start), 1) end,
    case when cfg.days_left > 0
         then round(greatest(crm.monthly_revenue_target(s.id, cfg.month_start)
                             - m.collected, 0) / cfg.days_left) end,
    crm.monthly_walkin_target(s.id, cfg.month_start),
    v.walkins,
    v.converted,
    case when crm.monthly_walkin_target(s.id, cfg.month_start) > 0
         then round(100.0 * v.walkins
                    / crm.monthly_walkin_target(s.id, cfg.month_start), 1) end,
    case when cfg.days_left > 0
         then round(greatest(crm.monthly_walkin_target(s.id, cfg.month_start)
                             - v.walkins, 0)::numeric / cfg.days_left, 1) end,
    (ut.user_id is not null),
    ut.set_by,
    su.full_name,
    cfg.days_elapsed,
    cfg.days_left
  from staff s
  cross join cfg
  left join crm.teams t on t.id = s.team_id
  join money  m on m.user_id = s.id
  join booked b on b.user_id = s.id
  join visits v on v.user_id = s.id
  left join crm.user_targets ut
    on ut.user_id = s.id and ut.period_month = cfg.month_start
  left join crm.users su on su.id = ut.set_by
  order by s.role, s.full_name
$$;

comment on function crm.user_target_progress(date) is
  'One row per caller and counsellor for a month: the target they carry
   (their own if set, else their role''s default), what they have actually
   done against it, and the pace needed to finish. The Targets screen, the
   caller''s My Score page and any export read this one function.';

grant execute on function crm.user_target_progress(date) to crm_app;

-- ---------------------------------------------------------------------------
-- Setting a target. Counsellor or admin only, enforced here rather than in
-- the route - the same shape as every other authority rule in this schema.
-- A null clears that half of the target and the person falls back to the
-- role default, which is why the columns are nullable.
-- ---------------------------------------------------------------------------
create or replace function crm.set_user_target(
  p_user_id        uuid,
  p_month          date,
  p_revenue_target numeric default null,
  p_walkin_target  int     default null,
  p_daily_dials    int     default null
) returns crm.user_targets
  language plpgsql
as $$
declare
  v_actor uuid := crm.current_user_id();
  v_role  text := crm.current_user_role()::text;
  v_month date := date_trunc('month', coalesce(p_month, crm.ist_date(now())))::date;
  v_row   crm.user_targets;
begin
  if v_role not in ('counsellor', 'admin') then
    raise exception 'only a counsellor or admin sets targets'
      using errcode = 'insufficient_privilege';
  end if;

  if not exists (select 1 from crm.users u
                  where u.id = p_user_id and u.role in ('caller', 'counsellor')) then
    raise exception 'targets are carried by callers and counsellors'
      using errcode = 'check_violation';
  end if;

  -- A target set for a month already over cannot be met and changes the
  -- score of a month people have already been paid on.
  if v_month < date_trunc('month', crm.ist_date(now()))::date then
    raise exception 'that month is closed - a target cannot be set backwards'
      using errcode = 'check_violation';
  end if;

  insert into crm.user_targets
    (user_id, period_month, monthly_collection_target, monthly_walkin_target,
     daily_dial_target, set_by)
  values (p_user_id, v_month, p_revenue_target, p_walkin_target, p_daily_dials, v_actor)
  on conflict (user_id, period_month) do update
     set monthly_collection_target = excluded.monthly_collection_target,
         monthly_walkin_target     = excluded.monthly_walkin_target,
         daily_dial_target         = excluded.daily_dial_target,
         set_by                    = excluded.set_by,
         updated_at                = now()
  returning * into v_row;

  return v_row;
end
$$;

comment on function crm.set_user_target(uuid, date, numeric, int, int) is
  'Set or clear one person''s targets for a month. Counsellor or admin only
   (42501 otherwise); a null clears that number and the person falls back to
   their role''s default. Never backwards into a closed month.';

grant execute on function crm.set_user_target(uuid, date, numeric, int, int) to crm_app;
