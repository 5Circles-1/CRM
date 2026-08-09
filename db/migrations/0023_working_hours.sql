-- 0023_working_hours.sql
--
-- The clock only runs while the floor is open.
--
-- Every deadline was wall-clock, so a lead arriving Saturday evening was
-- "breached" all through Sunday and greeted Monday's shift as a failure nobody
-- caused. Sunday is the team's day off; working time is Mon-Sat 09:30-18:30
-- IST, and every SLA and retry now counts only those minutes.
--
-- crm.add_working_minutes() is the single clock. A deadline computed through
-- it can only fall inside working hours, so "breached" can only become true
-- inside working hours too - the views need no change, because now() passes a
-- working-time deadline only while the floor is open.

insert into crm.settings (key, value, description) values
  ('shift.day_start_minutes', '570'::jsonb,  'Working day opens 09:30 IST, minute 570 of the day.'),
  ('shift.day_end_minutes',  '1110'::jsonb,  'Working day closes 18:30 IST, minute 1110 of the day.')
on conflict (key) do nothing;

-- The floor asked for a 30-minute first-touch window, counted in working time.
update crm.settings set value = '30'::jsonb, updated_at = now()
 where key = 'sla.immediate_first_touch_minutes' and value = '5'::jsonb;

create or replace function crm.add_working_minutes(p_from timestamptz, p_minutes int)
  returns timestamptz
  language plpgsql
  stable
as $fn$
declare
  v_start int := crm.setting_int('shift.day_start_minutes', 570);
  v_end   int := crm.setting_int('shift.day_end_minutes', 1110);
  v_local timestamp := p_from at time zone 'Asia/Kolkata';
  v_day   date;
  v_mow   int;
  v_left  int := greatest(coalesce(p_minutes, 0), 0);
  v_cap   int;
begin
  loop
    v_day := v_local::date;
    if extract(dow from v_day) = 0 then      -- Sunday: closed all day
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
    end if;
    v_cap := v_end - v_mow;
    if v_left <= v_cap then
      return (v_local + make_interval(mins => v_left)) at time zone 'Asia/Kolkata';
    end if;
    v_left := v_left - v_cap;
    v_local := (v_day + 1) + make_interval(mins => v_start);
  end loop;
end
$fn$;

comment on function crm.add_working_minutes(timestamptz, int) is
  'The SLA clock. Counts minutes only Mon-Sat 09:30-18:30 IST, so a deadline it
   produces can only fall - and only be missed - while the floor is open.';

-- The functions below are their existing definitions with every deadline
-- routed through the working-time clock. Extracted and transformed from the
-- migrations that last defined them, not retyped.

create or replace function crm.tg_lead_defaults() returns trigger
  language plpgsql
as $$
declare
  v_sla int;
begin
  if new.first_touch_due_at is null then
    v_sla := case new.priority
               when 'immediate' then crm.setting_int('sla.immediate_first_touch_minutes', 5)
               else crm.setting_int('sla.normal_first_touch_minutes', 60)
             end;
    new.first_touch_due_at := crm.add_working_minutes(now(), v_sla);
  end if;

  if new.next_action_at is null
     and new.status not in ('won', 'lost', 'invalid', 'nurture', 'handed_off') then
    new.next_action_at   := new.first_touch_due_at;
    new.next_action_note := coalesce(new.next_action_note, 'First contact');
  end if;

  new.phone_e164 := coalesce(crm.normalise_phone(new.phone_e164), new.phone_e164);
  return new;
end
$$;

create or replace function crm.tg_call_attempt_apply() returns trigger
  language plpgsql
as $$
declare
  v_min_talk   int := crm.setting_int('dial.min_talk_seconds_for_connect', 30);
  v_connect    boolean;
  v_retry_min  int;
  v_max_attempts int := crm.setting_int('lead.max_attempts_before_nurture', 9);
  v_lead       crm.leads%rowtype;
  v_actor_role crm.user_role;
  v_esc_after  int := crm.setting_int('escalation.caller_attempts_before_counsellor', 2);
  v_counsellor uuid;
  -- Outcomes that mean "still could not get anywhere with them".
  v_stuck      boolean;
begin
  v_connect := new.disposition in ('connected_interested', 'connected_not_interested',
                                   'callback_requested', 'wrong_person', 'language_barrier',
                                   'disconnected_after_intro', 'will_visit',
                                   'will_call_back_self')
               and new.duration_seconds >= v_min_talk;
  new.is_connect := v_connect;

  select * into v_lead from crm.leads where id = new.lead_id for update;

  v_retry_min := case new.disposition
    when 'not_answered'  then crm.setting_int('sla.retry_after_not_answered_minutes', 180)
    when 'busy'          then crm.setting_int('sla.retry_after_busy_minutes', 60)
    when 'switched_off'  then crm.setting_int('sla.retry_after_switched_off_minutes', 240)
    when 'incoming_unavailable'     then crm.setting_int('sla.retry_after_unavailable_minutes', 240)
    when 'disconnected_after_intro' then crm.setting_int('sla.retry_after_intro_drop_minutes', 1440)
    when 'will_call_back_self'      then crm.setting_int('sla.retry_after_will_call_back_minutes', 2880)
    when 'will_visit'               then crm.setting_int('sla.walkin_followup_minutes', 1440)
    else null
  end;

  update crm.leads l
     set attempt_count     = l.attempt_count + 1,
         connect_count     = l.connect_count + (case when v_connect then 1 else 0 end),
         na_streak         = case when new.disposition = 'not_answered' then l.na_streak + 1 else 0 end,
         last_contacted_at = case when v_connect then new.started_at else l.last_contacted_at end,
         first_touched_at  = coalesce(l.first_touched_at, new.started_at),
         walkin_expected_at = case
           when new.disposition = 'will_visit'
             then coalesce(l.walkin_expected_at, crm.add_working_minutes(new.started_at, v_retry_min))
           else l.walkin_expected_at
         end,
         status = case
           when new.disposition = 'invalid_number' then 'invalid'::crm.lead_status
           when new.disposition = 'job_enquiry'    then 'invalid'::crm.lead_status
           when new.disposition = 'do_not_call'    then 'lost'::crm.lead_status
           when new.disposition = 'connected_not_interested' then 'lost'::crm.lead_status
           when l.attempt_count + 1 >= v_max_attempts and not v_connect then 'nurture'::crm.lead_status
           when l.status = 'new' then 'working'::crm.lead_status
           else l.status
         end,
         closed_at = case
           when new.disposition in ('invalid_number', 'job_enquiry', 'do_not_call',
                                    'connected_not_interested')
             then coalesce(l.closed_at, now())
           else l.closed_at
         end,
         lost_reason = case
           when new.disposition = 'connected_not_interested' then coalesce(l.lost_reason, 'Not interested')
           when new.disposition = 'do_not_call'              then coalesce(l.lost_reason, 'Do not call')
           when new.disposition = 'job_enquiry'              then coalesce(l.lost_reason, 'Job enquiry, not a client')
           else l.lost_reason
         end,
         next_action_at = case
           when new.disposition in ('invalid_number', 'job_enquiry', 'do_not_call',
                                    'connected_not_interested') then null
           when l.attempt_count + 1 >= v_max_attempts and not v_connect then null
           when v_retry_min is not null then crm.add_working_minutes(greatest(now(), new.started_at), v_retry_min)
           else l.next_action_at
         end,
         next_action_note = case
           when new.disposition = 'will_visit'          then 'Check whether they visited'
           when new.disposition = 'will_call_back_self' then 'They said they would call - check in if they have not'
           when v_retry_min is not null then 'Retry after ' || replace(new.disposition::text, '_', ' ')
           else l.next_action_note
         end,
         updated_at = now()
   where l.id = new.lead_id;

  update crm.callbacks
     set status = 'completed', completed_at = now(), completed_attempt_id = new.id,
         updated_at = now()
   where lead_id = new.lead_id and status = 'pending' and scheduled_at <= now() + interval '1 hour';

  insert into crm.lead_events (lead_id, event_type, actor_id, payload)
  values (new.lead_id, 'call_logged', new.user_id,
          jsonb_build_object('disposition', new.disposition,
                             'duration_seconds', new.duration_seconds,
                             'is_connect', v_connect));

  -- ----- the escalation ladder --------------------------------------------
  select role into v_actor_role from crm.users where id = new.user_id;
  select * into v_lead from crm.leads where id = new.lead_id;

  -- "Stuck" = could not get anywhere: no answer, unreachable, or a flat no.
  v_stuck := new.disposition in ('not_answered', 'busy', 'switched_off',
                                 'incoming_unavailable', 'disconnected_after_intro',
                                 'connected_not_interested');

  if v_actor_role = 'caller'
     and v_lead.escalation_stage = 'caller'
     and v_lead.status in ('new', 'working', 'callback')
     and not v_connect
     and v_lead.connect_count = 0
     and v_lead.attempt_count >= v_esc_after
  then
    -- Two tries, still no voice on the line: hand it to the counsellor to tap.
    v_counsellor := crm.team_counsellor(v_lead.team_id);
    if v_counsellor is not null then
      -- na_streak is deliberately NOT reset: it is the lead's unanswered
      -- history, and the counsellor's reassign queue still reads it.
      update crm.leads
         set escalation_stage = 'counsellor',
             counsellor_id    = v_counsellor,
             escalated_at     = now(),
             status           = case when status = 'new' then 'working' else status end,
             next_action_at   = now() + interval '10 minutes',
             next_action_note = 'Escalated - caller could not reach; counsellor to tap',
             updated_at       = now()
       where id = new.lead_id;
      insert into crm.lead_events (lead_id, event_type, actor_id, payload)
      values (new.lead_id, 'escalated_to_counsellor', new.user_id,
              jsonb_build_object('after_attempts', v_lead.attempt_count,
                                 'counsellor_id', v_counsellor));
    end if;

  elsif v_actor_role = 'counsellor'
     and v_lead.escalation_stage = 'counsellor'
     and v_stuck
  then
    -- The counsellor also could not get through. It is not a failure and it is
    -- not overdue - it goes to the re-tap pool to be worked again later.
    update crm.leads
       set status           = 'nurture',
           pool             = 'retap',
           retap_since      = now(),
           next_action_at   = null,
           next_action_note = 'Re-tap pool - tap again when you choose',
           closed_at        = null,
           lost_reason      = null,
           updated_at       = now()
     where id = new.lead_id;
    insert into crm.lead_events (lead_id, event_type, actor_id, payload)
    values (new.lead_id, 'moved_to_retap', new.user_id,
            jsonb_build_object('disposition', new.disposition));
  end if;

  return new;
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
           first_touch_due_at = crm.add_working_minutes(now(), crm.setting_int('sla.normal_first_touch_minutes', 60)),
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
