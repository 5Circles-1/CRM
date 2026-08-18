-- 0049_quiet_popups_and_leads_stay_put.sql
--
-- The owner's round of feedback, in three sentences: the popups are disturbing
-- the floor, leads keep moving around on their own, and the counsellors should
-- be handed a bounded number of unreachable leads a day - not flooded, not
-- starved. Everything here is that feedback made mechanical.
--
-- 1. POPUPS INTERRUPT ONLY FOR APPOINTMENTS A PERSON SET. Two kinds pop: the
--    callback a client asked for, and the reminder the owner of the lead set
--    for themselves ("remind me Friday 4pm"). Both are times a human chose.
--    callback_soon stops popping - it is the same appointment announced twice.
--    NOTHING leaves the bell or the Alerts tab; only the interrupting stops.
--
-- 2. NO REPEAT NAGGING. alerts.repeat_minutes goes to 0: a reminder pops once,
--    with a soft chime, and then waits in the bell. The ten-minute re-pop
--    trained the floor to dismiss without reading, which is how the popup that
--    actually mattered got clicked away.
--
-- 3. LEADS STAY WHERE THEY LAND. The untouched-lead sweeper (leads moving to
--    another caller within minutes) and the cross-team escalation (leads
--    moving to the other team after N days) are both OFF. A lead belongs to
--    the caller it was distributed to until a counsellor or admin moves it by
--    hand - crm.transfer_lead, requirement 8, is unchanged. The engine
--    functions stay in place so the settings can turn either back on, but the
--    shipped state is: nothing moves a lead automatically between callers.
--
-- 4. THE ONE AUTOMATIC HAND-UP THAT REMAINS IS BOUNDED. After two attempts
--    with no real conversation the lead still escalates to the team's
--    counsellor to tap (that ladder is what makes "not answered twice" visible
--    work instead of a dead row), but a counsellor now receives at most
--    escalation.counsellor_daily_cap of these per day - default 15. Past the
--    cap the lead simply STAYS WITH ITS CALLER, keeps its scheduled retry, and
--    wears its "not answered xN" badge; the next failed attempt offers it up
--    again when the counsellor has room.

-- ---------------------------------------------------------------------------
-- 1 + 2. The popup diet, and the chime.
-- ---------------------------------------------------------------------------

update crm.settings
   set value = '["callback_due","custom_reminder"]'::jsonb,
       description = 'Alert kinds that interrupt with a popup. Only times a person '
                     || 'chose: the callback the client asked for, and the reminder '
                     || 'the lead''s owner set. Everything else waits in the bell.',
       updated_at = now()
 where key = 'alerts.popup_kinds';

update crm.settings
   set value = '0'::jsonb,
       description = 'How often an unresolved critical reminder pops again, in minutes. '
                     || '0 = a reminder pops once and then waits in the bell - no nagging.',
       updated_at = now()
 where key = 'alerts.repeat_minutes';

insert into crm.settings (key, value, description) values
  ('alerts.chime', 'true'::jsonb,
   'Play one soft chime when a reminder or callback pops. false silences the sound floor-wide.')
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- 3. Leads stay put: both automatic movers off.
-- ---------------------------------------------------------------------------

update crm.settings
   set value = '0'::jsonb,
       description = 'Minutes a newly assigned lead may sit untouched before it moves to '
                     || 'another caller. 0 disables it - the floor rule is that a lead '
                     || 'stays with its caller until a counsellor transfers it by hand.',
       updated_at = now()
 where key = 'sla.untouched_reassign_minutes';

update crm.settings
   set value = '0'::jsonb,
       description = 'Days a lead may sit un-worked before it moves to the other team. '
                     || '0 disables it - leads do not change teams on their own.',
       updated_at = now()
 where key = 'escalation.cross_team_days';

-- ---------------------------------------------------------------------------
-- 4. The counsellor hand-up, bounded at a daily number.
-- ---------------------------------------------------------------------------

insert into crm.settings (key, value, description) values
  ('escalation.counsellor_daily_cap', '15'::jsonb,
   'Most leads that may escalate from callers to one counsellor per day. Past the cap '
   || 'the lead stays with its caller and is offered again on the next failed attempt. '
   || '0 = no cap.')
on conflict (key) do nothing;

-- The cap counts today's hand-ups from the event log - append-only, so a lead
-- the counsellor already worked and moved on still counts against the day.
create index if not exists lead_events_escalations_idx
  on crm.lead_events (occurred_at)
  where event_type = 'escalated_to_counsellor';

-- The call-attempt engine, reproduced wholesale from 0038 (functions are
-- replaced, not patched) with one addition: the escalation branch checks the
-- counsellor's daily cap before moving the lead.
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
    -- Two tries, still no voice on the line: hand it to the counsellor to tap.
    v_counsellor := crm.team_counsellor(v_lead.team_id);

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
