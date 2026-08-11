-- 0028_lunch_freeze.sql
--
-- The lunch freeze: a daily circuit breaker, seeded 14:00-14:30 IST Mon-Sat.
--
-- Three effects, one mechanism each:
--  * SLA clocks pause: the freeze is subtracted from working time inside
--    add_working_minutes, so no deadline can land - or be missed - inside it.
--  * Nothing moves: the untouched sweep and the escalation ladder return
--    early while crm.in_freeze() is true. New leads still ASSIGN normally;
--    they just cannot be taken away for silence during the window.
--  * Alerts hold: due-type alerts are suppressed during the window and fire
--    the moment it lifts, since their due_at has passed by then.

insert into crm.settings (key, value, description) values
  ('freeze.start_minutes', '840'::jsonb,  'Lunch freeze opens at this IST minute of the day (840 = 14:00). Equal values disable it.'),
  ('freeze.end_minutes',   '870'::jsonb,  'Lunch freeze lifts at this IST minute of the day (870 = 14:30).')
on conflict (key) do nothing;

create or replace function crm.in_freeze(p_at timestamptz default now()) returns boolean
  language sql stable
as $fz$
  select extract(dow from (p_at at time zone 'Asia/Kolkata')) <> 0
     and (extract(hour from (p_at at time zone 'Asia/Kolkata'))::int * 60
          + extract(minute from (p_at at time zone 'Asia/Kolkata'))::int)
         >= crm.setting_int('freeze.start_minutes', 840)
     and (extract(hour from (p_at at time zone 'Asia/Kolkata'))::int * 60
          + extract(minute from (p_at at time zone 'Asia/Kolkata'))::int)
         <  crm.setting_int('freeze.end_minutes', 870)
$fz$;

-- Working minutes now skip the freeze: a 30-minute SLA that starts at 13:50
-- is due 14:40, not 14:20, because 14:00-14:30 contains no working minutes.
create or replace function crm.add_working_minutes(p_from timestamptz, p_minutes int)
  returns timestamptz
  language plpgsql
  stable
as $fn$
declare
  v_start int := crm.setting_int('shift.day_start_minutes', 570);
  v_end   int := crm.setting_int('shift.day_end_minutes', 1110);
  v_fz0   int := crm.setting_int('freeze.start_minutes', 840);
  v_fz1   int := crm.setting_int('freeze.end_minutes', 870);
  v_local timestamp := p_from at time zone 'Asia/Kolkata';
  v_day   date;
  v_mow   int;
  v_left  int := greatest(coalesce(p_minutes, 0), 0);
  v_cap   int;
begin
  loop
    v_day := v_local::date;
    if extract(dow from v_day) = 0 then
      v_local := (v_day + 1) + make_interval(mins => v_start);
      continue;
    end if;
    v_mow := extract(hour from v_local)::int * 60 + extract(minute from v_local)::int;
    if v_mow < v_start then
      v_local := v_day + make_interval(mins => v_start);
      v_mow := v_start;
    elsif v_mow >= v_end then
      v_local := (v_day + 1) + make_interval(mins => v_start);
      continue;
    elsif v_mow >= v_fz0 and v_mow < v_fz1 then
      v_local := v_day + make_interval(mins => v_fz1);
      v_mow := v_fz1;
    end if;
    -- Capacity until the next boundary: the freeze start if it is ahead of
    -- us today, otherwise the end of day.
    v_cap := (case when v_mow < v_fz0 and v_fz0 < v_end then v_fz0 else v_end end) - v_mow;
    if v_left <= v_cap then
      return (v_local + make_interval(mins => v_left)) at time zone 'Asia/Kolkata';
    end if;
    v_left := v_left - v_cap;
    if v_mow < v_fz0 and v_fz0 < v_end then
      v_local := v_day + make_interval(mins => v_fz1);   -- hop the freeze
    else
      v_local := (v_day + 1) + make_interval(mins => v_start);
    end if;
  end loop;
end
$fn$;

create or replace function crm.reassign_untouched_leads(p_limit int default 200)
  returns int
  language plpgsql
  security definer
  set search_path = crm, public
as $$
declare
  v_minutes int := crm.setting_int('sla.untouched_reassign_minutes', 10);
  v_lead    record;
  v_target  uuid;
  v_full_circle boolean;
  v_moved   int := 0;
begin
  -- Circuit breaker: during the freeze window nothing moves. Whoever holds a
  -- lead keeps it; the engines resume at the window's end. (WP C)
  if crm.in_freeze() then return 0; end if;
  if v_minutes <= 0 then
    return 0;
  end if;

  for v_lead in
    select l.id, l.team_id, l.caller_id, l.original_caller_id, l.na_streak, l.attempt_count
      from crm.leads l
     where l.caller_id is not null
       and l.first_touched_at is null
       and l.attempt_count = 0
       and l.status in ('new', 'working')
       and crm.add_working_minutes(l.assigned_at, v_minutes) < now()
     order by l.assigned_at
     limit p_limit
    for update skip locked
  loop
    -- Someone on the floor who has not already had this lead. Everyone gets
    -- their own ten minutes before anybody gets a second turn.
    select ec.user_id into v_target
      from crm.eligible_callers(v_lead.team_id) ec
     where ec.on_shift
       and crm.fresh_lead_eligible(ec.user_id)   -- no fresh leads via the back door
       and ec.user_id <> v_lead.caller_id
       and not exists (
             select 1 from crm.lead_transfers t
              where t.lead_id = v_lead.id and t.to_caller_id = ec.user_id)
       and ec.user_id is distinct from v_lead.original_caller_id
     order by ec.rotation_order
     limit 1;

    v_full_circle := v_target is null;

    if v_full_circle then
      -- Everyone has had a turn. It goes back to the caller it started with,
      -- who owns it from here - there is nobody left to pass it to, and a lead
      -- circulating forever is how a pipeline leaks while looking busy.
      if v_lead.original_caller_id is null
         or v_lead.caller_id = v_lead.original_caller_id
         or not crm.is_on_shift(v_lead.original_caller_id) then
        continue;
      end if;
      v_target := v_lead.original_caller_id;
    end if;

    insert into crm.lead_transfers
      (lead_id, from_caller_id, to_caller_id, transferred_by, reason, note,
       is_automatic, na_streak_at_transfer, attempts_at_transfer)
    values
      (v_lead.id, v_lead.caller_id, v_target, null, 'caller_unavailable',
       case when v_full_circle
            then format('untouched by everyone - returned to the first caller after %s minutes each', v_minutes)
            else format('untouched for %s minutes', v_minutes) end,
       true, v_lead.na_streak, v_lead.attempt_count);

    update crm.leads
       set caller_id = v_target,
           transfer_count = transfer_count + 1,
           first_touch_due_at = crm.add_working_minutes(now(), v_minutes),
           next_action_at = least(coalesce(next_action_at, now()), now()),
           next_action_note = case when v_full_circle
             then 'Back with you - nobody else picked it up'
             else 'Reassigned - first contact still owed' end,
           updated_at = now()
     where id = v_lead.id;

    insert into crm.lead_events (lead_id, event_type, payload)
    values (v_lead.id, 'transferred',
            jsonb_build_object('automatic', true, 'from', v_lead.caller_id,
                               'to', v_target, 'after_minutes', v_minutes,
                               'returned_to_original', v_full_circle));

    v_moved := v_moved + 1;
  end loop;

  return v_moved;
end
$$;

create or replace function crm.escalate_stuck_leads(p_limit int default 200)
  returns int
  language plpgsql
  security definer
  set search_path = crm, public
as $$
declare
  v_days   int := crm.setting_int('escalation.cross_team_days', 18);
  v_max    int := crm.setting_int('escalation.cross_team_max', 1);
  v_lead   record;
  v_target uuid;
  v_moved  int := 0;
begin
  -- Circuit breaker: during the freeze window nothing moves. Whoever holds a
  -- lead keeps it; the engines resume at the window's end. (WP C)
  if crm.in_freeze() then return 0; end if;
  if v_days <= 0 then
    return 0;
  end if;

  for v_lead in
    select l.*
      from crm.leads l
     where l.status in ('new', 'working', 'callback', 'nurture')
       and l.walked_in_at is null
       and l.cross_team_count < v_max
       and l.team_id is not null
       -- Uploaded history is an archive, not live work; it never auto-moves.
       and l.pool is distinct from 'previous_month'
       -- Nothing has happened to it in the window: last contact (or, if never
       -- contacted, arrival) is older than the cutoff, and any scheduled
       -- action is also past due by that much.
       and coalesce(l.last_contacted_at, l.created_at) < now() - make_interval(days => v_days)
       and coalesce(l.next_action_at, l.created_at) < now() - make_interval(days => v_days)
     order by coalesce(l.last_contacted_at, l.created_at)
     limit p_limit
    for update skip locked
  loop
    v_target := crm.other_team(v_lead.team_id);
    continue when v_target is null;

    update crm.leads
       set team_id          = v_target,
           caller_id        = null,          -- the new team's balancer assigns it
           counsellor_id    = crm.team_counsellor(v_target),
           escalation_stage = 'caller',
           pool             = null,
           retap_since      = null,
           status           = 'working',
           cross_team_count = cross_team_count + 1,
           cross_team_at    = now(),
           first_touch_due_at = now() + make_interval(mins => crm.setting_int('sla.normal_first_touch_minutes', 60)),
           next_action_at   = now() + interval '15 minutes',
           next_action_note = 'Moved from the other team - fresh attempt',
           na_streak        = 0,
           updated_at       = now()
     where id = v_lead.id;

    insert into crm.lead_events (lead_id, event_type, payload)
    values (v_lead.id, 'cross_team_transfer',
            jsonb_build_object('from_team', v_lead.team_id, 'to_team', v_target,
                               'after_days', v_days));

    -- Tell the receiving team's counsellor (notifications table lives in 0022;
    -- guard so this file also applies before 0022 during a partial run).
    if to_regclass('crm.notifications') is not null then
      insert into crm.notifications (user_id, kind, title, body, lead_id)
      select crm.team_counsellor(v_target), 'cross_team_in',
             'Lead moved to your team',
             coalesce(v_lead.full_name, 'A lead') || ' was untouched for '
               || v_days || ' days and has moved to your team.',
             v_lead.id
       where crm.team_counsellor(v_target) is not null;
    end if;

    v_moved := v_moved + 1;
  end loop;

  return v_moved;
end
$$;
