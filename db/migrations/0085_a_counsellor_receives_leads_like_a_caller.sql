-- 0085_a_counsellor_receives_leads_like_a_caller.sql
--
-- The floor is shrinking to two or three people who each work a lead end to
-- end: dial it fresh, counsel it, close it, chase the money (owner decision,
-- 30 Oct). The counsellor role already does almost all of that - it dials its
-- own queue (v_my_pipeline, power dial), closes deals, records walk-ins,
-- transfers leads. What a counsellor could not do was RECEIVE a lead the way
-- a caller does. Four caller-only assumptions, all the same assumption:
--
--   1. Absence cover handed ALL of a team's fresh leads to ONE counsellor -
--      crm.team_counsellor_on_floor picked by rotation_order alone, so on a
--      floor staffed by counsellors the first in rotation drowned and the
--      rest watched. The pick is now least-covered-today, rotation order
--      breaking ties - the same fairness shape the caller pick has had since
--      0005, minus tiers, which are a caller concept.
--
--   2. A counsellor's first failed dial on a COVERED lead parked it in the
--      re-tap pool. The stuck->re-tap rule (0049) was written for two-strike
--      escalations - "the counsellor ALSO could not get through" - but cover
--      (0056) reused escalation_stage = 'counsellor' for fresh work the
--      counsellor is the FIRST person to dial, and the branch could not tell
--      the two apart. One not_answered on a brand-new covered lead and it
--      left the pipeline. escalated_at is the difference: the ladder stamps
--      it, cover and hand-assignment never do. The branch now requires it.
--
--   3. crm.transfer_lead refused every target who was not an active caller,
--      so on a counsellor-staffed floor Requirement 8 had no legal move at
--      all. A counsellor can now receive a transfer - into their counsellor
--      queue, exactly where escalation and cover put a lead, with the pending
--      callback following (0084) and the transfer cap unchanged. Two rules
--      sharpened on the way: "already with" now compares the queue the lead
--      actually sits in, so an escalated lead CAN be handed back down to its
--      own caller; and a paying client (won/handed_off) can be transferred
--      only to a counsellor, because leads.caller_id on a won lead is the
--      win's credit (0080) and a transfer must never quietly move a sale.
--
--   4. crm.assign_unowned_lead and crm.hand_over_leads had the same wall:
--      fresh stages demanded a caller, hand-overs demanded callers on both
--      sides. An unowned fresh lead can now be assigned to a counsellor, and
--      a departed person's book - caller's or counsellor's - can be handed
--      to a counsellor. A counsellor's book holds counselling work, so it
--      goes to another counsellor, never down to a caller.
--
-- What this deliberately does NOT change: fresh distribution still prefers
-- callers (crm.next_caller_for_team is untouched - counsellors receive fresh
-- work only when no caller is eligible, which on an all-counsellor floor is
-- always); the escalation ladder, tiers and the ACE seat still apply to
-- callers only and simply lie idle on a floor that has none; and the 15-day
-- stale mover still moves between callers only. A mixed floor behaves exactly
-- as before, except that cover now spreads instead of drowning one person.

-- ---------------------------------------------------------------------------
-- 1. The covering counsellor: least-covered-today, rotation breaking ties.
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
   order by (select count(*)
               from crm.distribution_events de
              where de.caller_id = u.id
                and crm.ist_date(de.decided_at) = crm.ist_date(now())),
            tm.rotation_order
   limit 1
$$;

comment on function crm.team_counsellor_on_floor is
  'The team''s counsellor who is actually on the floor right now - cover
   decisions must never assign work to an empty chair. Among several, the one
   who has received the fewest leads today (distribution_events names the
   receiver whichever path assigned it), rotation order breaking ties: on a
   floor staffed by counsellors this is the fairness rule, the same
   least-loaded-then-rotation shape as the caller pick (0085).';

-- ---------------------------------------------------------------------------
-- 2. The stuck->re-tap park applies to escalated leads only. The call-attempt
--    engine, reproduced wholesale from 0068 (functions are replaced, not
--    patched); the one change is `escalated_at is not null` on the re-tap
--    branch, so a covered, transferred or hand-assigned lead - one the
--    counsellor works as its FIRST owner - keeps its retry schedule like any
--    caller's lead instead of parking on the first failed dial.
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
  -- Convertible intent stands (0068): from history, or shown on this very call.
  v_green      boolean;
begin
  v_connect := new.disposition in ('connected_interested', 'connected_not_interested',
                                   'callback_requested', 'wrong_person', 'language_barrier',
                                   'disconnected_after_intro', 'will_visit',
                                   'will_call_back_self')
               and new.duration_seconds >= v_min_talk;
  new.is_connect := v_connect;

  select * into v_lead from crm.leads where id = new.lead_id for update;

  v_green := crm.lead_green_reason(new.lead_id) is not null
             or new.disposition = 'will_visit'
             or (v_connect and new.disposition in ('connected_interested',
                                                   'callback_requested',
                                                   'will_call_back_self'));

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
           -- The attempt cap parks the never-engaged; a green lead is not
           -- bulk, so it stays open until a person decides otherwise.
           when l.attempt_count + 1 >= v_max_attempts and not v_connect and not v_green
             then 'nurture'::crm.lead_status
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
           when l.attempt_count + 1 >= v_max_attempts and not v_connect and not v_green then null
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
     -- Only the ladder stamps escalated_at. A covered, transferred or
     -- hand-assigned lead is the counsellor's FIRST attempt at the client,
     -- not a re-tap of a lead a caller already failed twice - it keeps its
     -- retry schedule like any caller's lead (0085).
     and v_lead.escalated_at is not null
     and v_stuck
     and not v_green
  then
    -- The counsellor also could not get through. It is not a failure and it is
    -- not overdue - it goes to the re-tap pool to be worked again later.
    -- Unless the lead is green: shown intent is never batch-parked, so a green
    -- lead keeps its scheduled retry with the counsellor instead.
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
-- 3. transfer_lead: a counsellor can receive a lead. Body from 0084; the
--    changes are the target check, the stage-aware "already with" and cap
--    attribution, the paying-client guard, and the counsellor branch.
-- ---------------------------------------------------------------------------
create or replace function crm.transfer_lead(
    p_lead_id   uuid,
    p_to_caller uuid,
    p_reason    crm.transfer_reason,
    p_actor     uuid default crm.current_user_id(),
    p_note      text default null
  ) returns void
  language plpgsql
as $$
declare
  v_lead        crm.leads%rowtype;
  v_actor_role  crm.user_role;
  v_owner       uuid;
  v_to_role     crm.user_role;
  v_to_active   boolean;
  v_to_name     text;
  v_from_name   text;
  v_max         int := crm.setting_int('lead.max_transfers', 2);
begin
  if p_actor is null then
    raise exception 'transfer_lead requires an acting user'
      using errcode = 'insufficient_privilege';
  end if;

  select role into v_actor_role from crm.users where id = p_actor and is_active;
  if v_actor_role is null or v_actor_role not in ('counsellor', 'admin') then
    raise exception 'only a counsellor or admin may transfer a lead (actor role: %)',
      coalesce(v_actor_role::text, 'unknown')
      using errcode = 'insufficient_privilege';
  end if;

  select * into v_lead from crm.leads where id = p_lead_id for update;
  if not found then
    -- Absent, or fenced off by RLS - indistinguishable on purpose, and 404 is
    -- the honest answer to both.
    raise exception 'that lead no longer exists, or is not yours to move'
      using errcode = 'no_data_found';
  end if;

  select full_name, role, is_active into v_to_name, v_to_role, v_to_active
    from crm.users where id = p_to_caller;

  -- "Already with" means the queue the lead sits in NOW - the counsellor's at
  -- counsellor stage, the caller's otherwise. Comparing caller_id alone used
  -- to refuse handing an escalated lead back down to its own caller, which is
  -- a legitimate move (0085).
  v_owner := case when v_lead.escalation_stage = 'counsellor'
                  then v_lead.counsellor_id else v_lead.caller_id end;
  if v_owner = p_to_caller then
    -- Reached when the list on screen is older than the database - somebody
    -- else moved this lead first. Naming the person says so without jargon.
    raise exception 'this lead is already with %; refresh the list',
      coalesce(v_to_name, 'that person')
      using errcode = 'check_violation';
  end if;

  if v_to_role is null or v_to_role not in ('caller', 'counsellor')
     or not coalesce(v_to_active, false) then
    raise exception '% cannot receive leads - a transfer target must be an active caller or counsellor',
      coalesce(v_to_name, 'that person')
      using errcode = 'check_violation';
  end if;

  -- leads.caller_id on a won lead is the win's credit (0080). A paying
  -- client's follow-up is counselling work: a counsellor may take it; handing
  -- it to a caller would quietly move a past sale.
  if v_lead.status in ('won', 'handed_off') and v_to_role = 'caller' then
    raise exception 'this is a paying client - their follow-up goes to a counsellor, and the sale stays where it is'
      using errcode = 'check_violation';
  end if;

  if v_lead.transfer_count >= v_max then
    select full_name into v_from_name from crm.users where id = v_owner;
    raise exception 'this lead has already been transferred % times (the cap is %); it stays with % or goes to nurture',
      v_lead.transfer_count, v_max, coalesce(v_from_name, 'its caller')
      using errcode = 'check_violation';
  end if;

  insert into crm.lead_transfers (
    lead_id, from_caller_id, to_caller_id, transferred_by, reason, note,
    na_streak_at_transfer, attempts_at_transfer
  ) values (
    p_lead_id, v_owner, p_to_caller, p_actor, p_reason, p_note,
    v_lead.na_streak, v_lead.attempt_count
  );

  if v_to_role = 'caller' then
    update crm.leads
       set caller_id        = p_to_caller,
           team_id          = coalesce(crm.team_of(p_to_caller, current_date), team_id),
           -- Handed to a specific caller: it belongs on the caller ladder again.
           escalation_stage = 'caller',
           transfer_count   = transfer_count + 1,
           na_streak        = 0,
           next_action_at   = greatest(now(), now() + interval '15 minutes'),
           next_action_note = 'Transferred in - first attempt',
           status = case when status = 'nurture' then 'working' else status end
     where id = p_lead_id;
  else
    -- A counsellor receives it into their own counsellor queue - exactly
    -- where escalation and absence cover put a lead. caller_id stays as
    -- history (and, on a paying client, as the win's credit). escalated_at
    -- stays untouched: this is not the ladder, so the re-tap park does not
    -- apply (section 2).
    update crm.leads
       set counsellor_id    = p_to_caller,
           team_id          = coalesce(crm.team_of(p_to_caller, current_date), team_id),
           escalation_stage = 'counsellor',
           transfer_count   = transfer_count + 1,
           na_streak        = 0,
           next_action_at   = greatest(now(), now() + interval '15 minutes'),
           next_action_note = 'Transferred in - call them',
           status = case when status = 'nurture' then 'working' else status end
     where id = p_lead_id;
  end if;

  -- The booked time is the client's; who it rings must be whoever now owns
  -- the lead. callbacks.assigned_to is what rings (0052, 0084).
  update crm.callbacks
     set assigned_to = p_to_caller,
         updated_at  = now()
   where lead_id = p_lead_id
     and status = 'pending';

  insert into crm.lead_events (lead_id, event_type, actor_id, payload)
  values (p_lead_id, 'transferred', p_actor,
          jsonb_build_object('from', v_owner, 'to', p_to_caller,
                             'to_role', v_to_role,
                             'reason', p_reason, 'note', p_note));
end
$$;

comment on function crm.transfer_lead(uuid, uuid, crm.transfer_reason, uuid, text) is
  'Requirement 8. Moves a lead to another active caller or counsellor (0085) -
   a counsellor takes it into their counsellor queue. Authority (counsellor or
   admin) and the lead.max_transfers cap are enforced here, not in the API. A
   paying client may only go to a counsellor: caller_id on a won lead is the
   win''s credit. The pending callback follows the lead (0084). Every refusal
   carries an explicit SQLSTATE so api/src/http/errors.ts can turn it into a
   sentence the floor can act on rather than a 500.';

-- ---------------------------------------------------------------------------
-- 4. assign_unowned_lead: an unowned fresh lead can go to a counsellor too.
--    Body from 0084; the changes are the target check and the counsellor
--    branch accepting fresh stages (status new -> working, like cover).
-- ---------------------------------------------------------------------------
create or replace function crm.assign_unowned_lead(
    p_lead_id uuid,
    p_to_user uuid,
    p_actor   uuid default crm.current_user_id(),
    p_note    text default null
  ) returns void
  language plpgsql
as $$
declare
  v_lead       crm.leads%rowtype;
  v_actor_role crm.user_role;
  v_owner      uuid;
  v_owner_name text;
  v_to_role    crm.user_role;
  v_to_active  boolean;
  v_to_name    text;
  v_fresh      boolean;
  v_paying     boolean;
begin
  select role into v_actor_role from crm.users where id = p_actor and is_active;
  if v_actor_role is distinct from 'admin' then
    raise exception 'only an admin may assign a lead that has no owner (actor role: %)',
      coalesce(v_actor_role::text, 'unknown')
      using errcode = 'insufficient_privilege';
  end if;

  select * into v_lead from crm.leads where id = p_lead_id for update;
  if not found then
    raise exception 'that lead no longer exists'
      using errcode = 'no_data_found';
  end if;

  -- The same owner v_fresh_leads and v_reenquired_leads show.
  v_owner := case when v_lead.escalation_stage = 'counsellor'
                  then v_lead.counsellor_id else v_lead.caller_id end;
  if v_owner is not null then
    select full_name into v_owner_name from crm.users where id = v_owner;
    raise exception 'this lead is already with %; refresh the list',
      coalesce(v_owner_name, 'someone')
      using errcode = 'check_violation';
  end if;

  v_paying := v_lead.status in ('won', 'handed_off');
  v_fresh  := v_lead.status in ('new', 'working', 'callback');
  if not v_fresh and v_lead.status not in ('qualified', 'negotiation', 'won', 'handed_off') then
    raise exception 'this lead is % - reopen it before assigning it', v_lead.status
      using errcode = 'check_violation';
  end if;

  select full_name, role, is_active into v_to_name, v_to_role, v_to_active
    from crm.users where id = p_to_user;
  -- Fresh work can go to anyone who works leads - a caller, or a counsellor
  -- who takes it into their own queue (0085). Past the caller, counselling
  -- work still goes only to a counsellor.
  if v_to_role is null or not coalesce(v_to_active, false)
     or (v_fresh and v_to_role not in ('caller', 'counsellor'))
     or (not v_fresh and v_to_role is distinct from 'counsellor') then
    raise exception '% cannot take this lead - %',
      coalesce(v_to_name, 'that person'),
      case when v_paying then 'a paying client who enquired again goes to an active counsellor'
           when not v_fresh then 'a lead at counsellor stage goes to an active counsellor'
           else 'pick an active caller or counsellor' end
      using errcode = 'check_violation';
  end if;

  if v_to_role = 'caller' then
    update crm.leads
       set caller_id        = p_to_user,
           team_id          = coalesce(crm.team_of(p_to_user, current_date), team_id),
           escalation_stage = 'caller',
           -- The original first-touch deadline is kept, so the Fresh tab still
           -- tells the truth about how late the client's first call is.
           next_action_at   = now() + interval '15 minutes',
           next_action_note = 'Assigned by admin - first contact',
           status           = case when status = 'new' then 'working' else status end
     where id = p_lead_id;
  else
    -- Counsellor. For a paying client nothing about the sale moves: status,
    -- closed_at and caller_id (the win's credit) stay as they are. A fresh
    -- lead starts working, exactly as cover does; escalated_at stays null, so
    -- the re-tap park does not apply (section 2).
    update crm.leads
       set counsellor_id    = p_to_user,
           escalation_stage = 'counsellor',
           next_action_at   = now() + interval '15 minutes',
           next_action_note = case when v_paying
                                   then 'Paying client enquired again - call them back'
                                   when v_fresh
                                   then 'Assigned by admin - first contact'
                                   else 'Assigned by admin - call them' end,
           status           = case when status = 'new' then 'working' else status end
     where id = p_lead_id;
  end if;

  -- The ring follows the lead (0084), exactly as in transfer_lead and
  -- hand_over_leads.
  update crm.callbacks
     set assigned_to = p_to_user,
         updated_at  = now()
   where lead_id = p_lead_id
     and status = 'pending';

  insert into crm.distribution_events (lead_id, team_id, caller_id, strategy)
  values (p_lead_id, crm.team_of(p_to_user, current_date), p_to_user, 'assigned_by_admin');

  insert into crm.lead_events (lead_id, event_type, actor_id, payload)
  values (p_lead_id, 'assigned', p_actor,
          jsonb_build_object(case when v_to_role = 'caller' then 'caller_id' else 'counsellor_id' end,
                             p_to_user,
                             'team_id', crm.team_of(p_to_user, current_date),
                             'by_admin', true, 'paying_client', v_paying, 'note', p_note));
end
$$;

comment on function crm.assign_unowned_lead(uuid, uuid, uuid, text) is
  'Admin-only, by choice: hands a lead with no owner to a named person. The
   stage decides who: new/working/callback to an active caller or counsellor
   (0085); qualified/negotiation and paying clients (won/handed_off) who
   enquired again to an active counsellor, leaving the sale and its credit
   untouched. Spends no transfer. A pending callback follows the lead (0084).
   Owned leads are refused - they move by transfer_lead.';

-- ---------------------------------------------------------------------------
-- 5. hand_over_leads: a departed person's book - caller's or counsellor's -
--    can be handed to a counsellor. Dropped and recreated because the second
--    parameter is no longer necessarily a caller.
-- ---------------------------------------------------------------------------
drop function crm.hand_over_leads(uuid, uuid, uuid, text);

create function crm.hand_over_leads(
    p_from_user uuid,
    p_to_user   uuid,
    p_actor     uuid default crm.current_user_id(),
    p_note      text default null
  ) returns table (leads_moved int, callbacks_moved int, sales_kept int, to_name text)
  language plpgsql
as $$
declare
  v_actor_role  crm.user_role;
  v_from_name   text;
  v_from_role   crm.user_role;
  v_from_active boolean;
  v_to_role     crm.user_role;
  v_to_active   boolean;
  v_to_name     text;
  v_to_team     uuid := crm.team_of(p_to_user, current_date);
  v_note        text;
  v_moved       int;
  v_callbacks   int;
  v_kept        int;
begin
  select role into v_actor_role from crm.users where id = p_actor and is_active;
  if v_actor_role is distinct from 'admin' then
    raise exception 'only an admin may hand over a person''s leads (actor role: %)',
      coalesce(v_actor_role::text, 'unknown')
      using errcode = 'insufficient_privilege';
  end if;

  select full_name, role, is_active into v_from_name, v_from_role, v_from_active
    from crm.users where id = p_from_user;
  if not found then
    raise exception 'no such person'
      using errcode = 'no_data_found';
  end if;

  if v_from_role not in ('caller', 'counsellor') then
    raise exception '% is a % - only a caller''s or counsellor''s leads are handed over here',
      v_from_name, v_from_role
      using errcode = 'check_violation';
  end if;

  if v_from_active then
    raise exception '% is still active - deactivate them first; an active person''s leads move one at a time by Transfer',
      v_from_name
      using errcode = 'check_violation';
  end if;

  select full_name, role, is_active into v_to_name, v_to_role, v_to_active
    from crm.users where id = p_to_user;
  if v_to_role is null or v_to_role not in ('caller', 'counsellor')
     or not coalesce(v_to_active, false) then
    raise exception '% cannot receive leads - pick an active caller or counsellor',
      coalesce(v_to_name, 'that person')
      using errcode = 'check_violation';
  end if;

  -- A counsellor's book is counselling work - qualified leads, escalations,
  -- fresh work they covered. It goes to another counsellor, never down to a
  -- caller.
  if v_from_role = 'counsellor' and v_to_role <> 'counsellor' then
    raise exception '%''s book is counselling work - hand it to an active counsellor',
      v_from_name
      using errcode = 'check_violation';
  end if;

  v_note := format('Handed over from %s (left)', v_from_name)
            || coalesce(' - ' || nullif(btrim(p_note), ''), '');

  if v_from_role = 'caller' then
    -- Lock the book first so a concurrent transfer cannot slip a lead in or
    -- out between the statements below. Every statement before the final
    -- UPDATE reads the set by its old owner.
    perform 1 from crm.leads
     where caller_id = p_from_user and status not in ('won', 'handed_off')
       for update;

    select count(*)::int into v_kept
      from crm.leads where caller_id = p_from_user and status in ('won', 'handed_off');

    insert into crm.lead_transfers (
      lead_id, from_caller_id, to_caller_id, transferred_by, reason, note,
      na_streak_at_transfer, attempts_at_transfer
    )
    select l.id, p_from_user, p_to_user, p_actor, 'caller_unavailable', v_note,
           l.na_streak, l.attempt_count
      from crm.leads l
     where l.caller_id = p_from_user and l.status not in ('won', 'handed_off');

    insert into crm.lead_events (lead_id, event_type, actor_id, payload)
    select l.id, 'transferred', p_actor,
           jsonb_build_object('from', p_from_user, 'to', p_to_user,
                              'reason', 'caller_unavailable', 'note', v_note,
                              'hand_over', true)
      from crm.leads l
     where l.caller_id = p_from_user and l.status not in ('won', 'handed_off');

    update crm.callbacks c
       set assigned_to = p_to_user,
           updated_at  = now()
      from crm.leads l
     where c.lead_id = l.id
       and c.status = 'pending'
       and l.caller_id = p_from_user and l.status not in ('won', 'handed_off');
    get diagnostics v_callbacks = row_count;

    -- Owner and team only. The follow-up date and note are what the leaver
    -- agreed with the client, the streak and attempts are their true history,
    -- and transfer_count is not spent - see the header.
    if v_to_role = 'caller' then
      update crm.leads
         set caller_id = p_to_user,
             team_id   = coalesce(v_to_team, team_id)
       where caller_id = p_from_user and status not in ('won', 'handed_off');
    else
      -- A counsellor takes the whole book into their counsellor queue, the
      -- same place cover and a counsellor transfer put a lead. The leaver's
      -- name leaves the caller column; the calls they logged stay on each
      -- lead, marked with their name, as always.
      update crm.leads
         set caller_id        = null,
             counsellor_id    = p_to_user,
             escalation_stage = 'counsellor',
             team_id          = coalesce(v_to_team, team_id)
       where caller_id = p_from_user and status not in ('won', 'handed_off');
    end if;
    get diagnostics v_moved = row_count;

  else
    -- A counsellor's book: the leads whose counsellor queue is theirs. A
    -- dormant counsellor_id on a lead that is back at caller stage is
    -- history, not work, and stays as it is.
    perform 1 from crm.leads
     where counsellor_id = p_from_user and escalation_stage = 'counsellor'
       and status not in ('won', 'handed_off')
       for update;

    select count(*)::int into v_kept
      from crm.leads
     where counsellor_id = p_from_user and status in ('won', 'handed_off');

    insert into crm.lead_transfers (
      lead_id, from_caller_id, to_caller_id, transferred_by, reason, note,
      na_streak_at_transfer, attempts_at_transfer
    )
    select l.id, p_from_user, p_to_user, p_actor, 'caller_unavailable', v_note,
           l.na_streak, l.attempt_count
      from crm.leads l
     where l.counsellor_id = p_from_user and l.escalation_stage = 'counsellor'
       and l.status not in ('won', 'handed_off');

    insert into crm.lead_events (lead_id, event_type, actor_id, payload)
    select l.id, 'transferred', p_actor,
           jsonb_build_object('from', p_from_user, 'to', p_to_user,
                              'reason', 'caller_unavailable', 'note', v_note,
                              'hand_over', true)
      from crm.leads l
     where l.counsellor_id = p_from_user and l.escalation_stage = 'counsellor'
       and l.status not in ('won', 'handed_off');

    update crm.callbacks c
       set assigned_to = p_to_user,
           updated_at  = now()
      from crm.leads l
     where c.lead_id = l.id
       and c.status = 'pending'
       and l.counsellor_id = p_from_user and l.escalation_stage = 'counsellor'
       and l.status not in ('won', 'handed_off');
    get diagnostics v_callbacks = row_count;

    update crm.leads
       set counsellor_id = p_to_user,
           team_id       = coalesce(v_to_team, team_id)
     where counsellor_id = p_from_user and escalation_stage = 'counsellor'
       and status not in ('won', 'handed_off');
    get diagnostics v_moved = row_count;
  end if;

  return query select v_moved, v_callbacks, v_kept, v_to_name;
end
$$;

comment on function crm.hand_over_leads(uuid, uuid, uuid, text) is
  'Admin-only: moves every lead of a DEACTIVATED caller or counsellor to one
   active person, except paying clients (won / handed_off), whose place in the
   book is the win''s credit. A caller''s book may go to a caller or - whole,
   into their counsellor queue - to a counsellor (0085); a counsellor''s book
   goes to another counsellor. Call history stays on each lead, so the new
   owner reads every past response. Pending callbacks follow the lead;
   follow-up dates are kept; no transfer is spent. Writes a lead_transfers row
   and a timeline event per lead.';

grant execute on function crm.hand_over_leads(uuid, uuid, uuid, text) to crm_app;
