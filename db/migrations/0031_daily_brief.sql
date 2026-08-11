-- 0031_daily_brief.sql
--
-- The daily accountability reminder, for callers and counsellors alike.
--
-- Two numbers, personalised, computed - never typed by a manager:
--   1. What today is costing: target minus achieved, leads still untouched,
--      follow-ups already overdue.
--   2. The leap ahead: month-to-date against target, the rupee gap, working
--      days left, and the run-rate now required against the pace actually
--      being run.
--
-- The copy is deliberately flat: numbers and the next action, never
-- exhortation. A reminder that reads as pressure gets muted; a reminder that
-- reads as arithmetic gets acted on.
--
-- Delivery is the existing notification centre plus a dashboard banner. Email
-- and WhatsApp are pluggable hooks, not built: no SMTP credentials and no
-- WhatsApp Business API exist in this workspace (the Meta connection is an
-- ads account). The engine writes rows; a transport can read them later.

insert into crm.settings (key, value, description) values
  ('reminder.enabled', 'true'::jsonb,
   'Master switch for the daily accountability briefs.'),
  ('reminder.morning_minutes', '570'::jsonb,
   'Minute of the IST day for the morning brief (570 = 09:30).'),
  ('reminder.midday_minutes', '960'::jsonb,
   'Minute of the IST day for the midday pace nudge (960 = 16:00).'),
  ('reminder.evening_minutes', '1230'::jsonb,
   'Minute of the IST day for the end-of-day summary (1230 = 20:30).'),
  ('reminder.catchup_minutes', '150'::jsonb,
   'How long after its slot a brief may still be delivered if the scheduler was down.'),
  ('reminder.midday_pace_threshold_pct', '95'::jsonb,
   'The midday nudge only fires below this percentage of required pace. On pace, nobody is nudged.')
on conflict (key) do nothing;

-- Rupees as the floor says them: lakh and crore, not thousands. "₹2.4L to go"
-- is read at a glance; "₹240000.00 to go" is counted digit by digit. Below a
-- lakh, Indian and Western grouping agree, so plain to_char is correct there.
create or replace function crm.fmt_inr(p_amount numeric) returns text
  language sql immutable
as $$
  select case
    when p_amount is null then '—'
    when abs(p_amount) >= 10000000
      then '₹' || trim(trailing '.0' from to_char(round(p_amount / 10000000.0, 2), 'FM999990.00')) || 'Cr'
    when abs(p_amount) >= 100000
      then '₹' || trim(trailing '.0' from to_char(round(p_amount / 100000.0, 2), 'FM999990.00')) || 'L'
    else '₹' || to_char(round(p_amount), 'FM999,999')
  end
$$;

-- ---------------------------------------------------------------------------
-- Per-person targets. Absent a row, the person's share is derived from the
-- office breakeven, so the brief works on day one with nothing configured.
-- ---------------------------------------------------------------------------
create table crm.user_targets (
  user_id      uuid not null references crm.users(id) on delete cascade,
  period_month date not null,
  monthly_collection_target numeric(12,2) check (monthly_collection_target >= 0),
  daily_dial_target int check (daily_dial_target >= 0),
  set_by       uuid references crm.users(id) on delete set null,
  updated_at   timestamptz not null default now(),
  primary key (user_id, period_month),
  constraint user_targets_month_is_first
    check (period_month = date_trunc('month', period_month)::date)
);

alter table crm.user_targets enable row level security;
create policy user_targets_read on crm.user_targets
  for select using (crm.current_user_id() is not null);
create policy user_targets_write on crm.user_targets
  for all using (crm.current_user_role() in ('admin', 'counsellor'))
  with check (crm.current_user_role() in ('admin', 'counsellor'));
grant select, insert, update on crm.user_targets to crm_app;

create trigger user_targets_audit
  after insert or update or delete on crm.user_targets
  for each row execute function crm.tg_audit();

-- One row per person per slot per day: the idempotency record that makes a
-- re-run, a restart or a late catch-up harmless.
create table crm.reminder_log (
  user_id       uuid not null references crm.users(id) on delete cascade,
  business_date date not null,
  slot          text not null check (slot in ('morning', 'midday', 'evening')),
  sent_at       timestamptz not null default now(),
  primary key (user_id, business_date, slot)
);

alter table crm.reminder_log enable row level security;
create policy reminder_log_read on crm.reminder_log
  for select using (
    user_id = crm.current_user_id() or crm.current_user_role() in ('admin', 'ops'));
grant select on crm.reminder_log to crm_app;

-- ---------------------------------------------------------------------------
-- Working days remaining in the month, Mon-Sat, counting today.
-- The run-rate is worthless if it divides by calendar days: it would tell a
-- counsellor on the 30th that they have two days left when they have one.
-- ---------------------------------------------------------------------------
create or replace function crm.working_days_left(p_from date default null)
  returns int
  language sql stable
as $$
  select count(*)::int
    from generate_series(
           coalesce(p_from, crm.ist_date(now())),
           (date_trunc('month', coalesce(p_from, crm.ist_date(now())))
             + interval '1 month - 1 day')::date,
           interval '1 day') d
   where extract(dow from d) <> 0
$$;

create or replace function crm.working_days_elapsed(p_from date default null)
  returns int
  language sql stable
as $$
  select count(*)::int
    from generate_series(
           date_trunc('month', coalesce(p_from, crm.ist_date(now())))::date,
           coalesce(p_from, crm.ist_date(now())),
           interval '1 day') d
   where extract(dow from d) <> 0
$$;

-- ---------------------------------------------------------------------------
-- The brief itself: one row per active caller and counsellor.
-- Every figure is derived here so the banner, the notification body and any
-- future email say the same thing by construction.
-- ---------------------------------------------------------------------------
create or replace view crm.v_daily_brief as
with cfg as (
  select crm.setting_num('finance.monthly_breakeven_inr', 700000) as breakeven,
         crm.setting_num('finance.collection_efficiency_pct', 85) as coll_pct,
         crm.ist_date(now())                                      as today,
         date_trunc('month', crm.ist_date(now()))::date           as month_start
),
-- The breakeven is an office number; a person's default share is an equal
-- split across the closers, grossed up for collection slippage.
closers as (
  select greatest(count(*), 1) as n
    from crm.users where is_active and role = 'counsellor'
),
staff as (
  select u.id, u.full_name, u.role, crm.team_of(u.id, crm.ist_date(now())) as team_id
    from crm.users u
   where u.is_active and u.role in ('caller', 'counsellor')
),
-- Money credited to the person: the closer owns collection, the setter shares
-- the credit for what they set. Both see their own number, never each other's.
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
  -- Target: the person's own if set, else an equal share of the grossed-up
  -- office number. Callers carry no revenue target - theirs is dials and SLA.
  coalesce(ut.monthly_collection_target,
           case when s.role = 'counsellor'
                then round(cfg.breakeven / (cfg.coll_pct / 100.0) / closers.n) end) as monthly_target,
  crm.working_days_left()    as working_days_left,
  crm.working_days_elapsed() as working_days_elapsed,
  greatest(coalesce(ut.monthly_collection_target,
           case when s.role = 'counsellor'
                then round(cfg.breakeven / (cfg.coll_pct / 100.0) / closers.n) end)
           - m.collected_mtd, 0) as gap_to_target,
  -- Required pace: what is left, spread over the working days that remain.
  round(greatest(coalesce(ut.monthly_collection_target,
        case when s.role = 'counsellor'
             then round(cfg.breakeven / (cfg.coll_pct / 100.0) / closers.n) end)
        - m.collected_mtd, 0) / nullif(crm.working_days_left(), 0)) as required_per_day,
  -- Current pace: what has actually been collected per working day so far.
  round(m.collected_mtd / nullif(crm.working_days_elapsed(), 0)) as current_per_day,
  -- Where the month should stand today if it ran evenly. This, not the
  -- month-end number, is what "behind" means on the 11th.
  round(100.0 * m.collected_mtd
        / nullif(coalesce(ut.monthly_collection_target,
                 case when s.role = 'counsellor'
                      then round(cfg.breakeven / (cfg.coll_pct / 100.0) / closers.n) end)
                 * crm.working_days_elapsed()
                 / nullif(crm.working_days_elapsed() + crm.working_days_left() - 1, 0), 0), 1)
    as pace_pct
from staff s
cross join cfg
cross join closers
join money m on m.user_id = s.id
join work  w on w.user_id = s.id
left join crm.user_targets ut
  on ut.user_id = s.id and ut.period_month = cfg.month_start;

alter view crm.v_daily_brief set (security_invoker = true);
grant select on crm.v_daily_brief to crm_app;

comment on view crm.v_daily_brief is
  'One row per active caller and counsellor: today''s cost and the month''s required run-rate, all computed. The notification body, the dashboard banner and any future email all read from here so they cannot disagree.';

-- The manager's rolled-up version: the same arithmetic, per team.
create or replace view crm.v_team_brief as
select
  coalesce(t.name, 'Unassigned')          as team_name,
  b.team_id,
  count(*)::int                           as people,
  sum(b.dials_today)::int                 as dials_today,
  sum(b.untouched_now)::int               as untouched_now,
  sum(b.overdue_now)::int                 as overdue_now,
  sum(b.walkins_today)::int               as walkins_today,
  sum(b.won_today)::int                   as won_today,
  sum(b.collected_today)                  as collected_today,
  sum(b.collected_mtd)                    as collected_mtd,
  sum(b.monthly_target)                   as monthly_target,
  sum(b.gap_to_target)                    as gap_to_target,
  round(sum(b.gap_to_target) / nullif(crm.working_days_left(), 0)) as required_per_day
from crm.v_daily_brief b
left join crm.teams t on t.id = b.team_id
group by b.team_id, t.name;

alter view crm.v_team_brief set (security_invoker = true);
grant select on crm.v_team_brief to crm_app;

-- ---------------------------------------------------------------------------
-- The engine. Runs on a plain interval and works out for itself whether a
-- slot is due - the same idempotent design as every other job here, so a
-- restart at 09:31 still delivers the 09:30 brief instead of skipping it.
-- ---------------------------------------------------------------------------
create or replace function crm.send_due_reminders()
  returns int
  language plpgsql
  security definer
  set search_path = crm, public
as $$
declare
  v_now_min   int;
  v_catchup   int := crm.setting_int('reminder.catchup_minutes', 150);
  v_threshold numeric := crm.setting_num('reminder.midday_pace_threshold_pct', 95);
  v_today     date := crm.ist_date(now());
  v_slot      text;
  v_slot_min  int;
  v_b         record;
  v_title     text;
  v_body      text;
  v_sent      int := 0;
begin
  if not crm.setting_bool('reminder.enabled', true) then
    return 0;
  end if;

  -- Sunday is off. A brief on the team's day off is exactly the kind of
  -- vague pressure this feature is supposed to replace.
  if extract(dow from v_today) = 0 then
    return 0;
  end if;

  v_now_min := extract(hour from now() at time zone 'Asia/Kolkata')::int * 60
             + extract(minute from now() at time zone 'Asia/Kolkata')::int;

  foreach v_slot in array array['morning', 'midday', 'evening'] loop
    v_slot_min := case v_slot
      when 'morning' then crm.setting_int('reminder.morning_minutes', 570)
      when 'midday'  then crm.setting_int('reminder.midday_minutes', 960)
      else                crm.setting_int('reminder.evening_minutes', 1230)
    end;

    continue when v_now_min < v_slot_min or v_now_min >= v_slot_min + v_catchup;

    for v_b in
      select b.* from crm.v_daily_brief b
       where not exists (
         select 1 from crm.reminder_log r
          where r.user_id = b.user_id and r.business_date = v_today and r.slot = v_slot)
    loop
      -- The midday slot is a pace check, not a roll-call: on pace, silence.
      if v_slot = 'midday'
         and (v_b.pace_pct is null or v_b.pace_pct >= v_threshold)
         and v_b.overdue_now = 0 and v_b.untouched_now = 0 then
        insert into crm.reminder_log (user_id, business_date, slot)
        values (v_b.user_id, v_today, v_slot);
        continue;
      end if;

      if v_slot = 'morning' then
        v_title := 'Morning brief';
        v_body := case when v_b.role = 'caller' then
            format('%s leads in hand, %s not yet touched. %s callback%s due today. Target %s dials.',
                   v_b.leads_today, v_b.untouched_now, v_b.callbacks_today,
                   case when v_b.callbacks_today = 1 then '' else 's' end,
                   coalesce(v_b.dial_target, 0))
          else
            format('%s to go this month over %s working day%s - %s a day. Pace so far: %s a day. %s follow-up%s already overdue.',
                   crm.fmt_inr(v_b.gap_to_target), v_b.working_days_left,
                   case when v_b.working_days_left = 1 then '' else 's' end,
                   crm.fmt_inr(v_b.required_per_day), crm.fmt_inr(v_b.current_per_day),
                   v_b.overdue_now, case when v_b.overdue_now = 1 then '' else 's' end)
          end;

      elsif v_slot = 'midday' then
        v_title := 'Pace check';
        v_body := case when v_b.role = 'caller' then
            format('%s dials so far against %s. %s untouched, %s overdue - clear those before 18:30.',
                   v_b.dials_today, coalesce(v_b.dial_target, 0),
                   v_b.untouched_now, v_b.overdue_now)
          else
            format('At %s%% of the pace this month needs. %s still to collect over %s working day%s = %s a day. %s overdue follow-up%s.',
                   coalesce(v_b.pace_pct, 0), crm.fmt_inr(v_b.gap_to_target),
                   v_b.working_days_left,
                   case when v_b.working_days_left = 1 then '' else 's' end,
                   crm.fmt_inr(v_b.required_per_day),
                   v_b.overdue_now, case when v_b.overdue_now = 1 then '' else 's' end)
          end;

      else
        v_title := 'End of day';
        v_body := case when v_b.role = 'caller' then
            format('%s dials, %s connects, %s walk-in%s booked. Carrying %s untouched and %s overdue into tomorrow.',
                   v_b.dials_today, v_b.connects_today, v_b.walkins_today,
                   case when v_b.walkins_today = 1 then '' else 's' end,
                   v_b.untouched_now, v_b.overdue_now)
          else
            format('Closed %s, lost %s, collected %s today. %s left this month over %s working day%s.',
                   v_b.won_today, v_b.lost_today, crm.fmt_inr(v_b.collected_today),
                   crm.fmt_inr(v_b.gap_to_target), v_b.working_days_left,
                   case when v_b.working_days_left = 1 then '' else 's' end)
          end;
      end if;

      insert into crm.notifications (user_id, kind, title, body)
      values (v_b.user_id, 'daily_brief_' || v_slot, v_title, v_body);

      insert into crm.reminder_log (user_id, business_date, slot)
      values (v_b.user_id, v_today, v_slot);

      v_sent := v_sent + 1;
    end loop;
  end loop;

  return v_sent;
end
$$;

revoke execute on function crm.send_due_reminders() from public;
grant execute on function crm.send_due_reminders() to crm_app;
