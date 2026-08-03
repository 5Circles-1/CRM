-- 0009_scoring.sql
-- Requirement 7: every caller and counsellor is scored, to help self-reflection.
--
-- DESIGN NOTE. A single opaque number is something to game. A number with its
-- components exposed is something to learn from, so compute_* returns the full
-- breakdown and the caller UI shows "78, up 6 from last week" with the team
-- average as context - own trend first, ranking second.
--
-- Weights live in a table so the floor's priorities can change without a deploy.

create table crm.score_definitions (
  component   text not null,
  applies_to  crm.user_role not null,
  weight      numeric(5,2) not null check (weight >= 0),
  label       text not null,
  description text not null,
  primary key (component, applies_to)
);

insert into crm.score_definitions (component, applies_to, weight, label, description) values
  ('dial_volume',        'caller', 20, 'Dials',              'Verified dials against the daily target.'),
  ('connect_rate',       'caller', 15, 'Connect rate',       'Genuine connects per dial, benchmarked at 35%.'),
  ('talk_time',          'caller', 10, 'Talk time',          'Minutes on connected calls against a 90-minute benchmark.'),
  ('callback_discipline','caller', 20, 'Callbacks kept',     'Scheduled callbacks completed before they were missed.'),
  ('first_touch_sla',    'caller', 15, 'Speed to lead',      'New leads dialled inside their first-touch SLA.'),
  ('qualification',      'caller', 15, 'Qualified handoffs', 'Connects converted into counsellor-ready leads.'),
  ('data_integrity',     'caller',  5, 'Log accuracy',       'Logged calls backed by a matching device call-log row.'),

  ('conversion',         'counsellor', 25, 'Conversion',        'Deals won from qualified leads received.'),
  ('collected_revenue',  'counsellor', 25, 'Collected revenue', 'Cash collected against the monthly per-counsellor target.'),
  ('collection_health',  'counsellor', 20, 'Collection health', 'Share of own booked value actually collected.'),
  ('pipeline_hygiene',   'counsellor', 15, 'Pipeline hygiene',  'Own open leads carrying a future next action.'),
  ('team_leakage',       'counsellor', 15, 'Team leakage',      'Inverse of the share of team leads sitting overdue.');

insert into crm.settings (key, value, description) values
  ('score.connect_rate_benchmark', '0.35'::jsonb, 'Connect rate scoring 100%.'),
  ('score.talk_minutes_benchmark', '90'::jsonb,   'Daily connected talk minutes scoring 100%.'),
  ('score.qualification_benchmark', '0.20'::jsonb,'Share of connects becoming qualified handoffs, scoring 100%.'),
  ('score.counsellor_monthly_collection_target_inr', '200000'::jsonb,
   'Per-counsellor monthly collection target. PLACEHOLDER - set from the breakeven split.');

-- ---------------------------------------------------------------------------

create table crm.score_snapshots (
  user_id    uuid not null references crm.users(id) on delete cascade,
  score_date date not null,
  role       crm.user_role not null,
  team_id    uuid references crm.teams(id) on delete set null,
  -- {"dial_volume": {"raw": 62, "target": 80, "ratio": 0.775, "points": 15.5}, ...}
  components jsonb not null,
  total      numeric(5,2) not null check (total >= 0 and total <= 100),
  computed_at timestamptz not null default now(),
  primary key (user_id, score_date)
);

create index score_snapshots_date_idx on crm.score_snapshots (score_date, total desc);

-- ---------------------------------------------------------------------------
-- Helper: turn a ratio into weighted points, capped at the weight.
-- ---------------------------------------------------------------------------

create or replace function crm.score_points(p_ratio numeric, p_weight numeric)
  returns numeric
  language sql immutable
as $$
  select round(least(greatest(coalesce(p_ratio, 0), 0), 1) * p_weight, 2)
$$;

-- A component that had nothing to measure is marked not applicable and is
-- excluded from BOTH the points earned and the weight available - the score is
-- then rescaled over what actually applied.
--
-- The alternative, awarding full marks when the denominator is zero, quietly
-- rewards idleness: a caller who made no calls and kept no callbacks collects
-- full credit for "log accuracy" and "callbacks kept" and can out-score someone
-- who worked all day. That is the opposite of what this score is for.
create or replace function crm.score_component(
    p_raw numeric, p_target numeric, p_ratio numeric,
    p_weight numeric, p_applicable boolean)
  returns jsonb
  language sql immutable
as $$
  select jsonb_build_object(
    'raw',        p_raw,
    'target',     p_target,
    'ratio',      round(least(greatest(coalesce(p_ratio, 0), 0), 1), 3),
    'weight',     p_weight,
    'applicable', p_applicable,
    'points',     case when p_applicable then crm.score_points(p_ratio, p_weight) else 0 end
  )
$$;

-- ---------------------------------------------------------------------------
-- Caller score for one business day.
-- ---------------------------------------------------------------------------

create or replace function crm.compute_caller_score(p_user_id uuid, p_date date)
  returns jsonb
  language plpgsql stable
as $$
declare
  w                jsonb := '{}'::jsonb;
  v_target         int := crm.setting_int('dial.daily_target_per_caller', 80);
  v_connect_bench  numeric := crm.setting_num('score.connect_rate_benchmark', 0.35);
  v_talk_bench     numeric := crm.setting_num('score.talk_minutes_benchmark', 90);
  v_qual_bench     numeric := crm.setting_num('score.qualification_benchmark', 0.20);
  v_dials          int;
  v_connects       int;
  v_verified       int;
  v_talk_min       numeric;
  v_cb_due         int;
  v_cb_kept        int;
  v_assigned       int;
  v_in_sla         int;
  v_qualified      int;
  function_weight  numeric;
begin
  select count(*),
         count(*) filter (where is_connect),
         count(*) filter (where is_verified),
         coalesce(round(sum(duration_seconds) filter (where is_connect) / 60.0, 1), 0)
    into v_dials, v_connects, v_verified, v_talk_min
    from crm.call_attempts
   where user_id = p_user_id and crm.ist_date(started_at) = p_date;

  select count(*), count(*) filter (where status = 'completed')
    into v_cb_due, v_cb_kept
    from crm.callbacks
   where assigned_to = p_user_id
     and crm.ist_date(scheduled_at) = p_date
     and status in ('completed', 'missed');

  select count(*), count(*) filter (where first_touched_at <= first_touch_due_at)
    into v_assigned, v_in_sla
    from crm.leads
   where caller_id = p_user_id
     and crm.ist_date(created_at) = p_date
     and first_touch_due_at is not null;

  select count(*) into v_qualified
    from crm.lead_events e
   where e.actor_id = p_user_id
     and e.event_type = 'qualified'
     and crm.ist_date(e.occurred_at) = p_date;

  -- Dials, connect rate, talk time and qualification are the core of the job:
  -- always applicable, so doing none of them scores zero rather than nothing.
  select weight into function_weight from crm.score_definitions
   where component = 'dial_volume' and applies_to = 'caller';
  w := w || jsonb_build_object('dial_volume', crm.score_component(
         v_dials, v_target, v_dials::numeric / nullif(v_target, 0), function_weight, true));

  select weight into function_weight from crm.score_definitions
   where component = 'connect_rate' and applies_to = 'caller';
  w := w || jsonb_build_object('connect_rate', crm.score_component(
         v_connects, round(v_dials * v_connect_bench, 1),
         (v_connects::numeric / nullif(v_dials, 0)) / nullif(v_connect_bench, 0),
         function_weight, true));

  select weight into function_weight from crm.score_definitions
   where component = 'talk_time' and applies_to = 'caller';
  w := w || jsonb_build_object('talk_time', crm.score_component(
         v_talk_min, v_talk_bench, v_talk_min / nullif(v_talk_bench, 0), function_weight, true));

  select weight into function_weight from crm.score_definitions
   where component = 'qualification' and applies_to = 'caller';
  w := w || jsonb_build_object('qualification', crm.score_component(
         v_qualified, round(v_connects * v_qual_bench, 1),
         (v_qualified::numeric / nullif(v_connects, 0)) / nullif(v_qual_bench, 0),
         function_weight, true));

  -- These three only mean something if there was something to measure.
  select weight into function_weight from crm.score_definitions
   where component = 'callback_discipline' and applies_to = 'caller';
  w := w || jsonb_build_object('callback_discipline', crm.score_component(
         v_cb_kept, v_cb_due, v_cb_kept::numeric / nullif(v_cb_due, 0),
         function_weight, v_cb_due > 0));

  select weight into function_weight from crm.score_definitions
   where component = 'first_touch_sla' and applies_to = 'caller';
  w := w || jsonb_build_object('first_touch_sla', crm.score_component(
         v_in_sla, v_assigned, v_in_sla::numeric / nullif(v_assigned, 0),
         function_weight, v_assigned > 0));

  select weight into function_weight from crm.score_definitions
   where component = 'data_integrity' and applies_to = 'caller';
  w := w || jsonb_build_object('data_integrity', crm.score_component(
         v_verified, v_dials, v_verified::numeric / nullif(v_dials, 0),
         function_weight, v_dials > 0));

  return w;
end
$$;

-- ---------------------------------------------------------------------------
-- Counsellor score for one business day (month-to-date for money components,
-- because a single day of collections is too noisy to coach on).
-- ---------------------------------------------------------------------------

create or replace function crm.compute_counsellor_score(p_user_id uuid, p_date date)
  returns jsonb
  language plpgsql stable
as $$
declare
  w             jsonb := '{}'::jsonb;
  v_month_start date := date_trunc('month', p_date)::date;
  v_target      numeric := crm.setting_num('score.counsellor_monthly_collection_target_inr', 200000);
  v_qualified   int;
  v_won         int;
  v_booked      numeric;
  v_collected   numeric;
  v_open        int;
  v_healthy     int;
  v_team        uuid;
  v_team_open   int;
  v_team_overdue int;
  wt            numeric;
begin
  v_team := crm.team_of(p_user_id, p_date);

  select count(*) into v_qualified
    from crm.leads
   where counsellor_id = p_user_id
     and crm.ist_date(created_at) between v_month_start and p_date;

  select count(*), coalesce(sum(booked_amount), 0)
    into v_won, v_booked
    from crm.deals
   where counsellor_id = p_user_id
     and status = 'booked'
     and crm.ist_date(booked_at) between v_month_start and p_date;

  select coalesce(sum(p.amount), 0) into v_collected
    from crm.payments p
    join crm.deals d on d.id = p.deal_id
   where d.counsellor_id = p_user_id
     and crm.ist_date(p.paid_at) between v_month_start and p_date;

  select count(*), count(*) filter (where next_action_at > now())
    into v_open, v_healthy
    from crm.leads
   where counsellor_id = p_user_id
     and status not in ('won', 'lost', 'invalid', 'nurture', 'handed_off');

  select count(*), count(*) filter (where next_action_at < now())
    into v_team_open, v_team_overdue
    from crm.leads
   where team_id = v_team
     and status not in ('won', 'lost', 'invalid', 'nurture', 'handed_off');

  select weight into wt from crm.score_definitions where component = 'conversion' and applies_to = 'counsellor';
  w := w || jsonb_build_object('conversion', crm.score_component(
         v_won, round(v_qualified * 0.20, 1),
         (v_won::numeric / nullif(v_qualified, 0)) / 0.20, wt, v_qualified > 0));

  select weight into wt from crm.score_definitions where component = 'collected_revenue' and applies_to = 'counsellor';
  w := w || jsonb_build_object('collected_revenue', crm.score_component(
         v_collected, v_target, v_collected / nullif(v_target, 0), wt, true));

  select weight into wt from crm.score_definitions where component = 'collection_health' and applies_to = 'counsellor';
  w := w || jsonb_build_object('collection_health', crm.score_component(
         v_collected, v_booked, v_collected / nullif(v_booked, 0), wt, v_booked > 0));

  select weight into wt from crm.score_definitions where component = 'pipeline_hygiene' and applies_to = 'counsellor';
  w := w || jsonb_build_object('pipeline_hygiene', crm.score_component(
         v_healthy, v_open, v_healthy::numeric / nullif(v_open, 0), wt, v_open > 0));

  select weight into wt from crm.score_definitions where component = 'team_leakage' and applies_to = 'counsellor';
  w := w || jsonb_build_object('team_leakage', crm.score_component(
         v_team_overdue, v_team_open,
         1 - (v_team_overdue::numeric / nullif(v_team_open, 0)), wt, v_team_open > 0));

  return w;
end
$$;

-- ---------------------------------------------------------------------------
-- Snapshot every active caller and counsellor for a date. Run nightly, and
-- on demand so the caller's own screen can refresh intraday.
-- ---------------------------------------------------------------------------

create or replace function crm.snapshot_scores(p_date date default crm.ist_date(now()))
  returns int
  language plpgsql
as $$
declare
  r        record;
  v_comp   jsonb;
  v_points numeric;
  v_weight numeric;
  v_total  numeric;
  v_count  int := 0;
begin
  for r in
    select id, role from crm.users where is_active and role in ('caller', 'counsellor')
  loop
    v_comp := case r.role
                when 'caller' then crm.compute_caller_score(r.id, p_date)
                else crm.compute_counsellor_score(r.id, p_date)
              end;

    -- Rescale over the components that actually applied today.
    select coalesce(sum((v.value ->> 'points')::numeric), 0),
           coalesce(sum((v.value ->> 'weight')::numeric)
                    filter (where (v.value ->> 'applicable')::boolean), 0)
      into v_points, v_weight
      from jsonb_each(v_comp) v;

    v_total := case when v_weight > 0
                    then least(round(100 * v_points / v_weight, 2), 100)
                    else 0 end;

    insert into crm.score_snapshots (user_id, score_date, role, team_id, components, total)
    values (r.id, p_date, r.role, crm.team_of(r.id, p_date), v_comp, v_total)
    on conflict (user_id, score_date) do update
      set components = excluded.components,
          total      = excluded.total,
          team_id    = excluded.team_id,
          computed_at = now();

    v_count := v_count + 1;
  end loop;
  return v_count;
end
$$;

-- ---------------------------------------------------------------------------
-- What the individual sees: own score, own trend, team average as context.
-- ---------------------------------------------------------------------------

create or replace view crm.v_my_score as
select
  s.user_id,
  u.full_name,
  s.role,
  s.team_id,
  s.score_date,
  s.total,
  s.components,
  round(avg(s.total) over (
    partition by s.user_id order by s.score_date rows between 6 preceding and current row
  ), 1) as own_7day_avg,
  round(avg(s.total) over (partition by s.team_id, s.score_date), 1) as team_avg_that_day,
  s.total - lag(s.total, 7) over (partition by s.user_id order by s.score_date) as change_vs_last_week,
  rank() over (partition by s.team_id, s.score_date order by s.total desc) as rank_in_team
from crm.score_snapshots s
join crm.users u on u.id = s.user_id;

comment on view crm.v_my_score is
  'Requirement 7. Own trend is the headline; rank is available but secondary by design.';
