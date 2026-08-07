-- 0024_targets_rewards_transfer_shortfall.sql
--
-- Four asks from the floor's owner:
--   * annual targets per person, with an editable reward on completion
--   * a daily end-of-day nudge to each counsellor: today's shortfall, and how
--     the target has moved because of it
--   * the top caller earns the right to hand a set of their leads to teammates
--   * better performers can be fed more fresh leads (opt-in, so nobody starves)

-- ---------------------------------------------------------------------------
-- Annual targets and their rewards. Admin-owned, fully editable.
-- ---------------------------------------------------------------------------

create table crm.annual_targets (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references crm.users(id) on delete cascade,
  year       int  not null check (year between 2020 and 2100),
  -- What is being counted. Kept as text with a check rather than an enum so a
  -- new metric is an ops action, not a migration.
  metric     text not null check (metric in ('deals', 'revenue', 'collected', 'dials', 'connects', 'walkins')),
  target     numeric(14,2) not null check (target > 0),
  reward     text not null,
  note       text,
  created_by uuid references crm.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, year, metric)
);

create index annual_targets_user_idx on crm.annual_targets (user_id, year);

create trigger annual_targets_set_updated_at
  before update on crm.annual_targets
  for each row execute function crm.tg_set_updated_at();

alter table crm.annual_targets enable row level security;
-- Everyone may read their own target (to see the reward they are chasing);
-- privileged roles read all; only admin writes.
create policy annual_targets_select on crm.annual_targets
  for select using (
    user_id = crm.current_user_id()
    or crm.current_user_role() in ('admin', 'ops', 'counsellor', 'viewer')
  );
create policy annual_targets_admin_write on crm.annual_targets
  for all using (crm.current_user_role() = 'admin')
  with check (crm.current_user_role() = 'admin');

grant select, insert, update, delete on crm.annual_targets to crm_app;

-- Progress against each target, computed from the performance view for the year.
create or replace view crm.v_annual_target_progress as
with per_user_year as (
  select p.user_id,
         extract(year from p.day)::int as year,
         sum(p.deals)                  as deals,
         sum(p.revenue)                as revenue,
         sum(p.walked_in)              as walkins,
         sum(p.dials)                  as dials,
         sum(p.connects)               as connects
    from crm.v_person_performance p
   group by p.user_id, extract(year from p.day)
),
collected as (
  select d.counsellor_id as user_id,
         extract(year from crm.ist_date(pay.paid_at))::int as year,
         sum(pay.amount) as collected
    from crm.payments pay
    join crm.deals d on d.id = pay.deal_id
   group by d.counsellor_id, extract(year from crm.ist_date(pay.paid_at))
)
select
  t.id, t.user_id, u.full_name, t.year, t.metric, t.target, t.reward, t.note,
  case t.metric
    when 'deals'     then coalesce(puy.deals, 0)
    when 'revenue'   then coalesce(puy.revenue, 0)
    when 'walkins'   then coalesce(puy.walkins, 0)
    when 'dials'     then coalesce(puy.dials, 0)
    when 'connects'  then coalesce(puy.connects, 0)
    when 'collected' then coalesce(c.collected, 0)
    else 0
  end::numeric as achieved
from crm.annual_targets t
join crm.users u on u.id = t.user_id
left join per_user_year puy on puy.user_id = t.user_id and puy.year = t.year
left join collected c on c.user_id = t.user_id and c.year = t.year;

alter view crm.v_annual_target_progress set (security_invoker = true);
grant select on crm.v_annual_target_progress to crm_app;

comment on view crm.v_annual_target_progress is
  'Each annual target with its achieved-so-far figure, so the person sees the
   reward they are chasing and how close they are.';

-- ---------------------------------------------------------------------------
-- Star-caller transfer rights. A caller normally cannot move leads off their
-- own list (difficult leads would circulate forever). The floor wants the top
-- performer to be an exception: the admin grants a caller the right to hand a
-- set of their own leads to a teammate. It stays capped and fully logged.
-- ---------------------------------------------------------------------------

alter table crm.users
  add column if not exists can_transfer_leads boolean not null default false;

comment on column crm.users.can_transfer_leads is
  'When true, this caller may transfer their OWN leads to a teammate - the
   reward the leaderboard leader earns. Off by default; granted by an admin.';


-- transfer_lead reproduced (from 0021) with two changes: a caller who holds the
-- can_transfer_leads grant may transfer a lead they currently own, and the
-- function is now SECURITY DEFINER.
--
-- Why definer: a transfer necessarily reassigns the lead to someone else, which
-- the leads RLS WITH CHECK forbids a caller from doing (the resulting row is not
-- theirs). The authority that used to be RLS's job is now fully inside this
-- function - role, the grant, current ownership, an active target, and the
-- transfer cap are all checked here - so it is the single, audited gate. A
-- buggy route cannot widen it; it can only call this function, which decides.
create or replace function crm.transfer_lead(
    p_lead_id   uuid,
    p_to_caller uuid,
    p_reason    crm.transfer_reason,
    p_actor     uuid default crm.current_user_id(),
    p_note      text default null
  ) returns void
  language plpgsql
  security definer
  set search_path = crm, public
as $$
declare
  v_lead        crm.leads%rowtype;
  v_actor_role  crm.user_role;
  v_actor_grant boolean;
  v_to_role     crm.user_role;
  v_to_active   boolean;
  v_max         int := crm.setting_int('lead.max_transfers', 2);
begin
  if p_actor is null then
    raise exception 'transfer_lead requires an acting user'
      using errcode = 'insufficient_privilege';
  end if;

  select role, can_transfer_leads into v_actor_role, v_actor_grant
    from crm.users where id = p_actor and is_active;

  select * into v_lead from crm.leads where id = p_lead_id for update;
  if not found then
    raise exception 'lead % not found', p_lead_id;
  end if;

  -- Authority: counsellor/admin always; a granted caller only for leads that
  -- are currently their own.
  if v_actor_role in ('counsellor', 'admin') then
    null; -- allowed
  elsif v_actor_role = 'caller' and coalesce(v_actor_grant, false)
        and v_lead.caller_id = p_actor then
    null; -- allowed: a star caller handing off their own lead
  else
    raise exception 'you are not allowed to transfer this lead (role: %)',
      coalesce(v_actor_role::text, 'unknown')
      using errcode = 'insufficient_privilege';
  end if;

  if v_lead.caller_id = p_to_caller then
    raise exception 'lead % is already assigned to that caller', p_lead_id;
  end if;

  select role, is_active into v_to_role, v_to_active from crm.users where id = p_to_caller;
  if v_to_role is distinct from 'caller' or not coalesce(v_to_active, false) then
    raise exception 'transfer target must be an active caller';
  end if;

  if v_lead.transfer_count >= v_max then
    raise exception 'lead % has already been transferred % times; park it in nurture instead',
      p_lead_id, v_lead.transfer_count
      using errcode = 'check_violation';
  end if;

  insert into crm.lead_transfers (
    lead_id, from_caller_id, to_caller_id, transferred_by, reason, note,
    na_streak_at_transfer, attempts_at_transfer
  ) values (
    p_lead_id, v_lead.caller_id, p_to_caller, p_actor, p_reason, p_note,
    v_lead.na_streak, v_lead.attempt_count
  );

  update crm.leads
     set caller_id        = p_to_caller,
         team_id          = coalesce(crm.team_of(p_to_caller, current_date), team_id),
         escalation_stage = 'caller',
         transfer_count   = transfer_count + 1,
         na_streak        = 0,
         next_action_at   = greatest(now(), now() + interval '15 minutes'),
         next_action_note = 'Transferred in - first attempt',
         status = case when status = 'nurture' then 'working' else status end
   where id = p_lead_id;

  insert into crm.lead_events (lead_id, event_type, actor_id, payload)
  values (p_lead_id, 'transferred', p_actor,
          jsonb_build_object('from', v_lead.caller_id, 'to', p_to_caller,
                             'reason', p_reason, 'note', p_note));
end
$$;

-- ---------------------------------------------------------------------------
-- Performance-weighted distribution (opt-in). Off by default so the tested
-- least-loaded A-B-A-B behaviour is unchanged; when an admin turns it on, the
-- tie between equally-loaded callers is broken by recent performance instead
-- of plain rotation, so the better performer is fed first.
-- ---------------------------------------------------------------------------

insert into crm.settings (key, value, description) values
  ('distribution.performance_weighting', 'false'::jsonb,
   'When true, equally-loaded callers are ranked by recent conversion score so better performers get fresh leads first. Least-loaded still wins overall, so nobody is starved.'),
  ('distribution.performance_window_days', '7'::jsonb,
   'How many days of performance feed the weighting tie-break.')
on conflict (key) do nothing;

-- A recent-performance score per caller: connects + 5x deals over the window.
-- Cheap and monotonic; it only ever breaks ties, so precision is not critical.
create or replace function crm.caller_perf_score(p_user_id uuid)
  returns numeric
  language sql stable
as $$
  select coalesce(sum(p.connects) + 5 * sum(p.deals) + 3 * sum(p.walked_in), 0)::numeric
    from crm.v_person_performance p
   where p.user_id = p_user_id
     and p.day > crm.ist_date(now()) - crm.setting_int('distribution.performance_window_days', 7)
$$;

-- Rebuild next_caller_for_team with the optional performance tie-break.
create or replace function crm.next_caller_for_team(p_team_id uuid)
  returns table (caller_id uuid, passed_over jsonb)
  language plpgsql
as $$
declare
  v_require_shift boolean := crm.setting_bool('distribution.require_on_shift', true);
  v_max_catchup   int     := crm.setting_int('distribution.max_catchup_leads', 5);
  v_weighted      boolean := crm.setting_bool('distribution.performance_weighting', false);
  v_cursor        int;
  v_max_load      int;
  v_chosen        uuid;
  v_passed        jsonb := '[]'::jsonb;
begin
  perform pg_advisory_xact_lock(hashtext('crm.dist.team'), hashtext(p_team_id::text));

  insert into crm.distribution_cursors (scope_kind, scope_id)
  values ('team', p_team_id)
  on conflict do nothing;

  select last_rotation_order into v_cursor
    from crm.distribution_cursors
   where scope_kind = 'team' and scope_id = p_team_id
   for update;

  select coalesce(jsonb_agg(jsonb_build_object('user_id', ec.user_id, 'reason', 'off_shift')), '[]'::jsonb)
    into v_passed
    from crm.eligible_callers(p_team_id) ec
   where v_require_shift and not ec.on_shift;

  select max(ec.load_today) into v_max_load
    from crm.eligible_callers(p_team_id) ec
   where ec.on_shift or not v_require_shift;

  -- Least-loaded (clamped for catch-up) first, always. The tie-break is either
  -- rotation (default) or recent performance (when weighting is on).
  select ec.user_id into v_chosen
    from crm.eligible_callers(p_team_id) ec
   where ec.on_shift or not v_require_shift
   order by
     greatest(ec.load_today, coalesce(v_max_load, 0) - v_max_catchup) asc,
     case when v_weighted then crm.caller_perf_score(ec.user_id) else 0 end desc,
     case when ec.rotation_order > v_cursor then 0 else 1 end asc,
     ec.rotation_order asc
   limit 1;

  if v_chosen is not null then
    update crm.distribution_cursors c
       set last_rotation_order = (
             select ec.rotation_order from crm.eligible_callers(p_team_id) ec
              where ec.user_id = v_chosen
           ),
           updated_at = now()
     where c.scope_kind = 'team' and c.scope_id = p_team_id;
  end if;

  return query select v_chosen, v_passed;
end
$$;

-- ---------------------------------------------------------------------------
-- Daily shortfall reminder for counsellors.
--
-- Each counsellor carries a monthly collection target; the daily share is that
-- over the working days. At end of day, if they collected less than the daily
-- share, they are told the shortfall AND the new daily figure needed for the
-- rest of the month - the target "moving" because today was missed.
-- ---------------------------------------------------------------------------

create or replace view crm.v_counsellor_daily_shortfall as
with cfg as (
  select crm.setting_num('score.counsellor_monthly_collection_target_inr', 200000) as monthly_target,
         crm.setting_int('finance.working_days_per_month', 25)  as working_days,
         date_trunc('month', crm.ist_date(now()))::date         as month_start
),
elapsed as (
  select extract(day from crm.ist_date(now()))::int as day_of_month,
         extract(day from (date_trunc('month', crm.ist_date(now()))
                 + interval '1 month - 1 day'))::int as days_in_month
),
collected_today as (
  select d.counsellor_id as user_id, coalesce(sum(p.amount), 0) as collected
    from crm.payments p join crm.deals d on d.id = p.deal_id
   where crm.ist_date(p.paid_at) = crm.ist_date(now())
   group by d.counsellor_id
),
collected_mtd as (
  select d.counsellor_id as user_id, coalesce(sum(p.amount), 0) as collected
    from crm.payments p join crm.deals d on d.id = p.deal_id, cfg
   where crm.ist_date(p.paid_at) >= cfg.month_start
   group by d.counsellor_id
)
select
  u.id                                   as user_id,
  u.full_name,
  round(cfg.monthly_target / cfg.working_days)         as daily_target,
  coalesce(ct.collected, 0)                            as collected_today,
  greatest(round(cfg.monthly_target / cfg.working_days) - coalesce(ct.collected, 0), 0) as shortfall_today,
  coalesce(cm.collected, 0)                            as collected_mtd,
  -- What each remaining working day now needs, given what is still outstanding.
  round(
    greatest(cfg.monthly_target - coalesce(cm.collected, 0), 0)
    / nullif(greatest(cfg.working_days
        - round(cfg.working_days * elapsed.day_of_month::numeric / nullif(elapsed.days_in_month,0)), 1), 0)
  )                                                    as new_daily_target
from crm.users u
cross join cfg
cross join elapsed
left join collected_today ct on ct.user_id = u.id
left join collected_mtd   cm on cm.user_id = u.id
where u.role = 'counsellor' and u.is_active;

alter view crm.v_counsellor_daily_shortfall set (security_invoker = true);
grant select on crm.v_counsellor_daily_shortfall to crm_app;

-- The job: once per counsellor per day, in the evening, drop a notification.
create or replace function crm.notify_daily_shortfall()
  returns int
  language plpgsql
  security definer
  set search_path = crm, public
as $$
declare
  v_ist_hour int := extract(hour from (now() at time zone 'Asia/Kolkata'))::int;
  v_ist_min  int := extract(minute from (now() at time zone 'Asia/Kolkata'))::int;
  r          record;
  v_count    int := 0;
begin
  -- Only after the shift ends (18:30 IST), and only once a day per person.
  if (v_ist_hour * 60 + v_ist_min) < 18 * 60 + 30 then
    return 0;
  end if;

  for r in select * from crm.v_counsellor_daily_shortfall loop
    if exists (
      select 1 from crm.notifications n
       where n.user_id = r.user_id and n.kind = 'daily_shortfall'
         and crm.ist_date(n.created_at) = crm.ist_date(now())
    ) then
      continue;
    end if;

    insert into crm.notifications (user_id, kind, title, body)
    values (
      r.user_id, 'daily_shortfall',
      case when r.shortfall_today > 0
           then 'End of day: you were short today'
           else 'End of day: target met' end,
      case when r.shortfall_today > 0
           then format('Collected %s of the %s daily target - short by %s. To stay on the monthly number you now need %s per remaining day.',
                       to_char(r.collected_today, 'FM99,99,999'),
                       to_char(r.daily_target, 'FM99,99,999'),
                       to_char(r.shortfall_today, 'FM99,99,999'),
                       to_char(r.new_daily_target, 'FM99,99,999'))
           else format('Collected %s against a %s daily target. On track - keep it up.',
                       to_char(r.collected_today, 'FM99,99,999'),
                       to_char(r.daily_target, 'FM99,99,999')) end
    );
    v_count := v_count + 1;
  end loop;

  return v_count;
end
$$;

revoke all on function crm.notify_daily_shortfall() from public;
grant execute on function crm.notify_daily_shortfall() to crm_app;
