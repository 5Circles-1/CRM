-- 0056_absence_cover.sql
--
-- The owner, looking at four immediate leads reading "no caller": "if they
-- were supposed to flow to callers and both from the same team are absent
-- they should go to the counsellor. And if counsellors are absent their part
-- of lead must flow down to the callers."
--
-- Until now a team whose callers were all off the floor simply parked its
-- fresh leads - visibly, with a reason, but parked - while its team lead
-- (the counsellor) sat on the floor able to dial. And the opposite hole:
-- the escalation ladder handed two-strike leads to the team counsellor by
-- name, whether or not that counsellor was in the building, where they aged
-- in an empty queue.
--
-- The cover rule, both directions:
--
--   1. Fresh lead, no caller on the floor -> the team lead takes it, if THEY
--      are on the floor. Assigned to their counsellor queue, first-touch
--      clock running, exactly like any owned lead. If the leader is off too,
--      the lead parks as before - handing work to an empty chair helps
--      nobody.
--   2. Escalation to a counsellor who is off the floor does not happen: the
--      lead stays with its caller, keeps its retry schedule, and is offered
--      again on the next failed attempt - the same graceful degradation the
--      daily cap already uses. Their part flows down to the callers.
--
-- What this deliberately does NOT do: move leads that are already owned.
-- The 0049 owner decision stands - a lead sitting with an absent person
-- today is theirs again tomorrow; only NEW work routes around an absence.

-- ---------------------------------------------------------------------------
-- 1. The team's counsellor who is actually on the floor right now.
-- ---------------------------------------------------------------------------
create or replace function crm.team_counsellor_on_floor(p_team_id uuid)
  returns uuid
  language sql stable
as $$
  select u.id
    from crm.users u
    join crm.team_memberships tm
      on tm.user_id = u.id and tm.period @> current_date
   where tm.team_id = p_team_id and u.role = 'counsellor' and u.is_active
     and crm.is_on_shift(u.id)
   order by tm.rotation_order
   limit 1
$$;

comment on function crm.team_counsellor_on_floor is
  'crm.team_counsellor, filtered to someone actually on the floor. Cover
   decisions must never assign work to an empty chair.';

-- ---------------------------------------------------------------------------
-- 2. Fresh distribution: fall back to the team lead when no caller is on.
-- ---------------------------------------------------------------------------
create or replace function crm.assign_lead(p_lead_id uuid)
  returns uuid
  language plpgsql
as $$
declare
  v_lead      crm.leads%rowtype;
  v_team      uuid;
  v_caller    uuid;
  v_leader    uuid;
  v_passed    jsonb;
  v_sla_min   int;
  v_due       timestamptz;
  v_last      crm.distribution_events%rowtype;
begin
  select * into v_lead from crm.leads where id = p_lead_id for update;
  if not found then
    raise exception 'lead % not found', p_lead_id;
  end if;

  v_team := coalesce(v_lead.team_id, crm.next_team_for_source(v_lead.source_id));

  if v_team is not null then
    select nc.caller_id, nc.passed_over into v_caller, v_passed
      from crm.next_caller_for_team(v_team) nc;

    -- Nobody from the calling pool: the team lead covers, if on the floor.
    -- Their absence too is the only thing that parks the lead.
    if v_caller is null then
      v_leader := crm.team_counsellor_on_floor(v_team);
    end if;
  end if;

  -- Still nobody? If the last decision on this lead was also "nobody", then
  -- this sweep has learned nothing new. Leave without touching the row or the
  -- history: repeating an unchanged non-decision every 60 seconds is what
  -- buried the lead's timeline in the first place.
  if v_caller is null and v_leader is null then
    select * into v_last
      from crm.distribution_events de
     where de.lead_id = p_lead_id
     order by de.decided_at desc
     limit 1;

    if found and v_last.caller_id is null
       and v_last.team_id is not distinct from v_team then
      return null;
    end if;
  end if;

  v_sla_min := case v_lead.priority
                 when 'immediate' then crm.setting_int('sla.immediate_first_touch_minutes', 5)
                 else crm.setting_int('sla.normal_first_touch_minutes', 60)
               end;
  v_due := coalesce(v_lead.first_touch_due_at, crm.add_working_minutes(now(), v_sla_min));

  update crm.leads
     set team_id            = v_team,
         caller_id          = coalesce(v_caller, caller_id),
         -- Cover: the lead lands in the leader's own counsellor queue, so it
         -- is in THEIR pipeline (queue_owner_id) and leaves the waiting list.
         counsellor_id      = coalesce(v_leader, counsellor_id),
         escalation_stage   = case when v_leader is not null then 'counsellor'
                                   else escalation_stage end,
         first_touch_due_at = v_due,
         -- An assigned lead is immediately in someone's day. Requirement 4.
         next_action_at     = coalesce(next_action_at, v_due),
         -- The defaults trigger has usually stamped 'First contact' already;
         -- covering overrides that stock note so the leader can see WHY this
         -- landed with them, without touching a note a person wrote.
         next_action_note   = case
                                when v_leader is not null
                                     and (next_action_note is null or next_action_note = 'First contact')
                                  then 'First contact - covering for absent callers'
                                else coalesce(next_action_note, 'First contact')
                              end,
         status             = case when status = 'new' and (v_caller is not null or v_leader is not null)
                                   then 'working' else status end
   where id = p_lead_id;

  insert into crm.distribution_events (lead_id, team_id, caller_id, strategy, passed_over)
  values (
    p_lead_id, v_team, coalesce(v_caller, v_leader),
    case when v_caller is not null then 'balanced_alternation'
         when v_leader is not null then 'covered_by_team_lead'
         else 'deferred_no_caller_available' end,
    coalesce(v_passed, '[]'::jsonb)
  );

  insert into crm.lead_events (lead_id, event_type, actor_id, payload)
  values (
    p_lead_id,
    case when v_caller is null and v_leader is null then 'assignment_deferred' else 'assigned' end,
    null,
    jsonb_build_object('team_id', v_team, 'caller_id', v_caller,
                       'counsellor_id', v_leader, 'due_at', v_due,
                       'covered_by_team_lead', v_leader is not null)
  );

  return coalesce(v_caller, v_leader);
end
$$;

-- ---------------------------------------------------------------------------
-- 3. The sweeps must not see a covered lead as still waiting - and must not
--    take it back off the leader when a caller returns. Owned is owned.
-- ---------------------------------------------------------------------------
create or replace function crm.assign_pending_leads(p_limit int default 500)
  returns int
  language plpgsql
as $$
declare
  r      record;
  v_done int := 0;
begin
  for r in
    select id from crm.leads
     where caller_id is null
       and counsellor_id is null
       and status in ('new', 'working')
     order by priority desc, created_at asc
     limit p_limit
  loop
    if crm.assign_lead(r.id) is not null then
      v_done := v_done + 1;
    end if;
  end loop;
  return v_done;
end
$$;

create or replace view crm.v_lead_flow_waiting as
with waiting as (
  select coalesce(team_id, '00000000-0000-0000-0000-000000000000'::uuid) as team_key,
         team_id,
         count(*)::int      as waiting,
         min(created_at)    as oldest_at
    from crm.leads
   where caller_id is null and counsellor_id is null
     and status in ('new', 'working')
   group by team_id
),
staff as (
  select tm.team_id,
         count(*) filter (where u.is_active)::int                              as callers,
         count(*) filter (where u.is_active and crm.is_on_shift(u.id))::int    as on_floor,
         count(*) filter (where u.is_active and crm.is_on_shift(u.id)
                            and crm.tier_of(u.id) <> 'restricted')::int        as eligible_now
    from crm.team_memberships tm
    join crm.users u on u.id = tm.user_id
   where tm.period @> current_date and u.role = 'caller'
   group by tm.team_id
)
select
  w.team_id,
  coalesce(t.name, 'No team')            as team_name,
  w.waiting,
  w.oldest_at,
  coalesce(s.callers, 0)                 as callers,
  coalesce(s.on_floor, 0)                as on_floor,
  coalesce(s.eligible_now, 0)            as eligible_now,
  -- The first rule that stops these leads moving. Ordered most-specific first
  -- so the reason names something the reader can actually go and change.
  case
    when w.team_id is null              then 'no_team'
    when coalesce(s.callers, 0) = 0     then 'team_has_no_callers'
    when coalesce(s.on_floor, 0) = 0    then 'nobody_on_shift'
    when coalesce(s.eligible_now, 0) = 0 then 'all_on_floor_restricted'
    else 'engine_should_be_assigning'
  end                                    as reason
from waiting w
left join crm.teams t on t.id = w.team_id
left join staff s on s.team_id = w.team_id;

grant select on crm.v_lead_flow_waiting to crm_app;

comment on view crm.v_lead_flow_waiting is
  'Leads currently owned by nobody - not a caller, not a team lead covering -
   grouped by team with the first rule that is stopping them. Since the cover
   rule, a team-level hold means the callers AND the team lead are all off
   the floor.';

-- ---------------------------------------------------------------------------
-- 4. Escalation never hands a lead to an empty chair. The call-attempt
--    engine, reproduced wholesale from 0049 (functions are replaced, not
--    patched); the one change is the counsellor pick, which now requires the
--    counsellor to be on the floor - any on-floor counsellor of the team -
--    and otherwise leaves the lead with its caller, exactly like the cap.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION crm.tg_call_attempt_apply()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
declare
  v_min_talk   int := crm.setting_int('dial.min_talk_seconds_for_connect', 30);
  v_connect    boolean;
  v_retry_min  int;
  v_max_attempts int := crm.setting_int('lead.max_attempts_before_nurture', 9);
  v_lead       crm.leads%rowtype;
  v_actor_role crm.user_role;
  v_esc_after  int := crm.setting_int('escalation.caller_attempts_before_counsellor', 2);
  v_esc_cap    int := crm.setting_int('escalation.counsellor_daily_cap', 15);
  v_esc_today  int;
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
         na_streak         = case when crm.is_unreached(new.disposition) then l.na_streak + 1 else 0 end,
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
    -- Two tries, still no voice on the line: hand it to the counsellor to
    -- tap - an on-floor counsellor of the team. One who is absent today is
    -- skipped entirely: their part of the work flows down to the callers,
    -- not into an empty queue.
    v_counsellor := crm.team_counsellor_on_floor(v_lead.team_id);

    -- ...unless the counsellor already has their day's share. The cap is what
    -- turns "give the counsellors the unreachable leads" into a workable
    -- number instead of a flood: past it, the lead stays with its caller,
    -- keeps its scheduled retry, and is offered again on the next failed
    -- attempt - by which time it may be another day.
    if v_counsellor is not null and v_esc_cap > 0 then
      select count(*) into v_esc_today
        from crm.lead_events e
       where e.event_type = 'escalated_to_counsellor'
         and e.occurred_at >= (crm.ist_date(now()))::timestamp at time zone 'Asia/Kolkata'
         and (e.payload->>'counsellor_id')::uuid = v_counsellor;
      if v_esc_today >= v_esc_cap then
        v_counsellor := null;
      end if;
    end if;

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
$function$;

-- ---------------------------------------------------------------------------
-- 5. Alerts on a covered lead belong to the leader working it, not to the
--    caller column that is empty by design. The alert view, reproduced
--    wholesale from 0035; the one change is that sla_breach and new_lead now
--    follow the queue owner (escalated or covered -> the counsellor), so the
--    Alerts tab names the person actually holding the lead instead of
--    showing "no caller".
-- ---------------------------------------------------------------------------
create or replace view crm.v_my_alerts as
select
  'sla_breach'::text                as kind,
  'critical'::text                  as severity,
  l.id                              as lead_id,
  case when l.escalation_stage = 'counsellor' then l.counsellor_id
       else l.caller_id end         as user_id,
  l.full_name                       as lead_name,
  l.phone_e164,
  l.first_touch_due_at              as due_at,
  'First contact overdue'::text     as title,
  null::uuid                        as callback_id
  from crm.leads l
 where l.first_touched_at is null
   and l.first_touch_due_at is not null
   and l.first_touch_due_at < now()
   and l.status in ('new', 'working')
   and not l.reminder_muted

union all

select
  'new_lead', 'warning', l.id,
  case when l.escalation_stage = 'counsellor' then l.counsellor_id else l.caller_id end,
  l.full_name, l.phone_e164,
  l.first_touch_due_at, 'New lead assigned to you', null
  from crm.leads l
 where l.first_touched_at is null
   and l.attempt_count = 0
   and l.status in ('new', 'working')
   and l.assigned_at > now() - interval '2 hours'
   and (l.first_touch_due_at is null or l.first_touch_due_at >= now())
   and not l.reminder_muted

union all

select
  'callback_due', 'critical', c.lead_id, c.assigned_to, l.full_name, l.phone_e164,
  c.scheduled_at, 'Callback due', c.id
  from crm.callbacks c
  join crm.leads l on l.id = c.lead_id
 where c.status = 'pending'
   and c.scheduled_at <= now()
   and not l.reminder_muted

union all

select
  'callback_soon', 'warning', c.lead_id, c.assigned_to, l.full_name, l.phone_e164,
  c.scheduled_at, 'Callback due shortly', c.id
  from crm.callbacks c
  join crm.leads l on l.id = c.lead_id
 where c.status = 'pending'
   and c.scheduled_at > now()
   and c.scheduled_at <= now() + interval '15 minutes'
   and not l.reminder_muted

union all

-- A follow-up that has just come due. A nudge, not a failure.
select
  'follow_up_due', 'warning', l.id,
  case when l.escalation_stage = 'counsellor' then l.counsellor_id else l.caller_id end,
  l.full_name, l.phone_e164,
  l.next_action_at, coalesce(l.next_action_note, 'Follow-up due now'), null
  from crm.leads l
 where l.next_action_at is not null
   and l.next_action_at <= now()
   and l.next_action_at > now() - make_interval(mins => crm.setting_int('sla.followup_grace_minutes', 30))
   and l.status in ('new', 'working', 'callback')
   and l.first_touched_at is not null
   and not l.reminder_muted
   and l.na_streak <= crm.setting_int('alert.na_quiet_after_attempts', 3)

union all

-- Past the grace period. Now it is a problem - but parked pools never nag.
select
  'action_overdue', 'critical', l.id,
  case when l.escalation_stage = 'counsellor' then l.counsellor_id else l.caller_id end,
  l.full_name, l.phone_e164,
  l.next_action_at, coalesce(l.next_action_note, 'Follow-up overdue'), null
  from crm.leads l
 where l.next_action_at is not null
   and l.next_action_at <= now() - make_interval(mins => crm.setting_int('sla.followup_grace_minutes', 30))
   and l.status in ('new', 'working', 'callback')
   and l.first_touched_at is not null
   and not l.reminder_muted
   and l.na_streak <= crm.setting_int('alert.na_quiet_after_attempts', 3)

union all

-- The reminder the owner set for themselves, at the time they chose.
select
  'custom_reminder', 'warning', l.id,
  case when l.escalation_stage = 'counsellor' then l.counsellor_id else l.caller_id end,
  l.full_name, l.phone_e164,
  l.reminder_at, coalesce(l.reminder_note, 'Your reminder for this lead'), null
  from crm.leads l
 where l.reminder_at is not null
   and l.reminder_at <= now()
   and l.status not in ('won', 'lost', 'invalid', 'handed_off')

union all

select
  'reassigned_in', 'info', t.lead_id, t.to_caller_id, l.full_name, l.phone_e164,
  t.created_at, 'Reassigned to you - first contact still owed', null
  from crm.lead_transfers t
  join crm.leads l on l.id = t.lead_id
 where t.is_automatic
   and t.created_at > now() - interval '2 hours'
   and l.first_touched_at is null;

alter view crm.v_my_alerts set (security_invoker = true);
grant select on crm.v_my_alerts to crm_app;
