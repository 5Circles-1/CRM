-- 0038_unreached_streak.sql
--
-- "There are people I have seen that have gone unanswered" - and the Re-tap
-- tab said zero. It was right about its own rule and the rule was wrong.
--
-- na_streak only counted the literal 'not_answered' disposition. Every other
-- outcome reset it to zero - including switched off, busy and incoming
-- unavailable, which are all "we did not get to speak to them". A real
-- sequence on the floor looks like:
--
--     not answered -> switched off -> not answered -> busy -> not answered
--
-- Five failed attempts to reach one person, and na_streak finished on 1,
-- because three of the five reset it. The lead never reached the threshold,
-- never went quiet, and never appeared in the re-tap pool. The counter was
-- measuring one disposition; the floor means "could not get through".
--
-- From here the streak counts every no-contact outcome and is reset only by
-- an outcome where somebody actually engaged. Nothing else changes: the
-- threshold, the quiet behaviour and the five-day reminder all stay as they
-- are, and now they fire on the cases they were written for.
--
-- Deliberately NOT counted as unreached:
--   disconnected_after_intro - they answered and hung up on the pitch. A
--     different problem, and one a re-tap batch will not fix.
--   wrong_person / invalid_number / do_not_call - terminal. Close them.
--   will_call_back_self / callback_requested - contact was made.

create or replace function crm.is_unreached(p_disposition crm.disposition)
  returns boolean
  language sql immutable
as $$
  select p_disposition in (
    'not_answered',
    'busy',
    'switched_off',
    'incoming_unavailable'
  )
$$;

comment on function crm.is_unreached(crm.disposition) is
  'True when an attempt failed to reach the person at all. Drives the
   consecutive-unreached streak behind the Re-tap pool. "Disconnected after
   introduction" is excluded on purpose: they answered.';

-- ---------------------------------------------------------------------------
-- The call trigger, with one line changed: the streak now counts every
-- no-contact outcome rather than one of them. Taken from the live definition
-- so nothing later migrations added to this function is lost.
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
$function$;

-- ---------------------------------------------------------------------------
-- Recompute the streak on existing leads.
--
-- Without this the fix only helps leads called from today onwards, and the
-- people the floor has already failed to reach four times - the exact ones
-- that prompted this - stay invisible. The streak is derived data, not
-- history: it is recomputed from the call attempts, which are untouched.
--
-- For each lead, count backwards from its most recent attempt and stop at the
-- first outcome where somebody actually engaged. That is the same rule the
-- trigger applies going forward, applied once to what already happened.
-- ---------------------------------------------------------------------------
with ordered as (
  select lead_id, started_at, crm.is_unreached(disposition) as unreached,
         row_number() over (partition by lead_id order by started_at desc, id desc) as rn
    from crm.call_attempts
),
first_contact as (
  -- Position of the most recent attempt that DID reach them, if any.
  select lead_id, min(rn) as rn
    from ordered where not unreached
   group by lead_id
),
streaks as (
  select o.lead_id, count(*)::int as streak
    from ordered o
    left join first_contact f on f.lead_id = o.lead_id
   where o.unreached
     and (f.rn is null or o.rn < f.rn)
   group by o.lead_id
)
update crm.leads l
   set na_streak = s.streak
  from streaks s
 where l.id = s.lead_id
   and l.na_streak is distinct from s.streak;
