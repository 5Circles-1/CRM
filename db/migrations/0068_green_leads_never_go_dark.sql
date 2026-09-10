-- 0068_green_leads_never_go_dark.sql
--
-- The owner's rule, in the owner's words (10 Sep): "leads which have some
-- potential to get converted must never go lost or vague in any ways -
-- always a scope of green light on those leads must exist."
--
-- 0067 established this for one kind of potential, the promised visit. This
-- migration names the general thing. A lead is GREEN when a client showed
-- real convertible intent that nobody has withdrawn:
--
--   - an open promise to visit (crm.visit_promise_open), or
--   - any real conversation that ended positive - connected_interested,
--     callback_requested, will_visit, will_call_back_self - where "real"
--     means it counted as a connect (dial.min_talk_seconds_for_connect),
--     so a 10-second "interested" cannot mint a green lead.
--
-- A deliberately one-way definition: intent, once shown, stands until a HUMAN
-- ends it - a walk-in recorded, a deal, or an explicit close (not interested,
-- do not call). Silence never downgrades it, because silence is exactly the
-- state in which good leads were getting lost.
--
-- What green buys, all from the one definition:
--
--   1. Never auto-parked. The nine-attempt nurture park and the counsellor
--      stuck->re-tap park now skip green leads: they keep their status and
--      their next action, and leave the pipeline only by a person's decision.
--      The caps still park the never-engaged bulk they were written for.
--   2. Never silenced. The quiet threshold (0035) no longer gates a green
--      lead's overdue alerts (0067 did this for visits; now for all green).
--   3. Never batch-anonymous. v_no_answer_pool excludes green leads wholesale.
--   4. Always visibly green. green_reason rides along on the pipeline and
--      lead-history views, so every list can show the light - and the
--      Visits promised bucket loses its two-day window: a promise for next
--      Wednesday sits in the Visits promised tab, dated, not filed under
--      generic "later" (owner: "it still remains in will visit").
--
-- Still unchanged, deliberately: the 15-day stale mover (a fresh caller ID
-- may ring where a spam-flagged one no longer does - the green light travels
-- with the lead), the transfer rules, and every terminal disposition. Green
-- is identity and visibility, not immortality: a human can always close it.

-- ---------------------------------------------------------------------------
-- The one definition.
-- ---------------------------------------------------------------------------

create or replace function crm.lead_green_reason(p_lead_id uuid)
  returns text
  language sql
  stable
as $$
  select case
    when exists (
      select 1 from crm.leads l
       where l.id = p_lead_id
         and crm.visit_promise_open(l.walkin_expected_at, l.walked_in_at)
    ) then 'will_visit'
    when exists (
      select 1 from crm.call_attempts ca
       where ca.lead_id = p_lead_id
         and ca.is_connect
         and ca.disposition in ('connected_interested', 'callback_requested',
                                'will_visit', 'will_call_back_self')
    ) then 'interested'
  end
$$;

comment on function crm.lead_green_reason(uuid) is
  'Why this lead carries the green light, or NULL for none: ''will_visit'' for
   an open promise to come in, ''interested'' for any real (connect-grade)
   conversation that ended positive. One-way by design: silence never clears
   it; only a walk-in, a deal, or an explicit close does. Every rule that
   would hide, park or batch a lead consults this first.';

-- ---------------------------------------------------------------------------
-- Found while testing this rule: logging a call could not be saved at all
-- when the lead had a pending callback due within the hour.
--
-- The trigger below completes such a callback with completed_attempt_id =
-- new.id - but it is a BEFORE INSERT trigger, so that id is not in
-- call_attempts yet and the foreign key rejected the whole insert (SQLSTATE
-- 23503). On the floor that read as: the client asked to be called at 4pm,
-- the caller rings at 4pm, and the CRM refuses to save exactly that call.
-- Latent since 0021 added the attempt link; nothing before ever logged a
-- call inside the one-hour completion window. The row does exist by commit,
-- so the check simply has to wait until then.
-- ---------------------------------------------------------------------------

alter table crm.callbacks
  alter constraint callbacks_completed_attempt_id_fkey deferrable initially deferred;

-- ---------------------------------------------------------------------------
-- The call trigger: the automatic parks now step around green leads.
--
-- Reproduced wholesale from 0056. Two changes, both guarded by v_green:
-- the nine-attempt nurture park (status + next_action branches together, so
-- the open-lead-has-a-next-action constraint holds), and the counsellor
-- stuck->re-tap park. v_green includes the attempt being logged right now,
-- because a first-call "will visit" makes the lead green in the same breath.
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
-- The pipeline: the promise loses its two-day window, and every row says
-- why it is green.
--
-- Same view as 0067 with two changes: the will_visit branch no longer
-- requires the next action to fall inside two days - "I will come next
-- Wednesday" belongs in Visits promised, dated, not under generic "later"
-- (owner: "it still remains in will visit") - and green_reason is appended
-- so every screen can draw the light without re-deriving the rule.
-- ---------------------------------------------------------------------------

create or replace view crm.v_my_pipeline as
select
  l.id                as lead_id,
  l.caller_id,
  l.counsellor_id,
  l.team_id,
  case when l.escalation_stage = 'counsellor' then l.counsellor_id else l.caller_id end
                      as queue_owner_id,
  l.escalation_stage,
  l.full_name,
  l.phone_e164,
  l.city,
  l.campaign_name,
  l.priority,
  l.status,
  l.next_action_at,
  l.next_action_note,
  l.attempt_count,
  l.connect_count,
  l.na_streak,
  l.first_touched_at,
  l.last_contacted_at,
  l.whatsapp_sent_at,
  l.walkin_expected_at,
  l.walked_in_at,
  l.reminder_muted,
  l.reminder_at,
  l.created_at,
  cb.scheduled_at     as callback_at,
  cb.note             as callback_note,
  la.disposition      as last_disposition,

  -- One lead, one bucket. Fresh first; then the open promise, which owns its
  -- tab for as long as it stands - however overdue, and however far out the
  -- next date is.
  case
    when l.priority = 'immediate' and l.first_touched_at is null then 'immediate'
    when l.first_touched_at is null                              then 'fresh'
    when crm.visit_promise_open(l.walkin_expected_at, l.walked_in_at)
                                                                 then 'will_visit'
    when l.next_action_at < now() - make_interval(mins =>
           crm.setting_int('sla.breached_after_minutes', 2880))  then 'breached'
    when l.next_action_at < now()                                then 'overdue'
    when cb.id is not null
     and cb.scheduled_at < (crm.ist_date(now()) + 1)::timestamp at time zone 'Asia/Kolkata'
                                                                 then 'callback'
    when cb.id is not null                                       then 'callback_upcoming'
    when l.next_action_at < (crm.ist_date(now()) + 1)::timestamp at time zone 'Asia/Kolkata'
                                                                 then 'followup_today'
    else 'followup_upcoming'
  end                 as bucket,

  case
    when l.next_action_at < now()
      then extract(epoch from (now() - l.next_action_at)) / 60
    else 0
  end::int            as minutes_overdue,
  case
    when l.priority = 'immediate' and l.first_touched_at is null
      then extract(epoch from (l.first_touch_due_at - now())) / 60
  end::int            as sla_minutes_remaining,
  crm.lead_green_reason(l.id) as green_reason
from crm.leads l
left join crm.callbacks cb
  on cb.lead_id = l.id and cb.status = 'pending'
left join lateral (
  select ca.disposition from crm.call_attempts ca
   where ca.lead_id = l.id order by ca.started_at desc limit 1
) la on true
where l.status not in ('won', 'lost', 'invalid', 'nurture', 'handed_off')
  and l.next_action_at is not null;

alter view crm.v_my_pipeline set (security_invoker = true);
grant select on crm.v_my_pipeline to crm_app;

-- ---------------------------------------------------------------------------
-- Alerts: the quiet threshold steps around every green lead, not only the
-- promised visits. Reproduced from 0067; the two gate lines widen from
-- visit_promise_open to lead_green_reason.
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
   and (l.na_streak <= crm.setting_int('alert.na_quiet_after_attempts', 3)
        or crm.lead_green_reason(l.id) is not null)

union all

-- Past the grace period. Now it is a problem - but parked pools never nag,
-- unless the lead is green: shown intent never goes quiet.
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
   and (l.na_streak <= crm.setting_int('alert.na_quiet_after_attempts', 3)
        or crm.lead_green_reason(l.id) is not null)

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

-- ---------------------------------------------------------------------------
-- The re-tap batch pool: never a green lead. Reproduced from 0067 with the
-- exclusion widened from the visit promise to the whole green rule.
-- ---------------------------------------------------------------------------

create or replace view crm.v_no_answer_pool as
select
  l.id                          as lead_id,
  case when l.escalation_stage = 'counsellor' then l.counsellor_id else l.caller_id end
                                as user_id,
  l.full_name, l.phone_e164, l.city,
  l.status, l.priority,
  l.na_streak, l.attempt_count, l.connect_count,
  l.last_contacted_at,
  l.whatsapp_sent_at,
  l.next_action_at,
  l.created_at,
  crm.ist_date(now()) - crm.ist_date(coalesce(l.last_contacted_at, l.created_at))
                                as days_since_touch,
  ca.disposition                as last_disposition,
  t.name                        as team_name
from crm.leads l
left join crm.teams t on t.id = l.team_id
left join lateral (
  select disposition from crm.call_attempts a
   where a.lead_id = l.id order by a.started_at desc limit 1
) ca on true
where l.na_streak > crm.setting_int('alert.na_quiet_after_attempts', 3)
  and l.status in ('new', 'working', 'callback')
  and not l.reminder_muted
  and crm.lead_green_reason(l.id) is null;

alter view crm.v_no_answer_pool set (security_invoker = true);
grant select on crm.v_no_answer_pool to crm_app;

comment on view crm.v_no_answer_pool is
  'Leads still open and still owned, but gone unanswered past the quiet
   threshold: they raise no individual alerts and are worked as a batch from
   the Re-tap tab. Excludes every green lead (crm.lead_green_reason) - shown
   intent is quality, not bulk; those keep their own tabs and their own
   alerts. Distinct from crm.v_retap_pool, which holds leads already PARKED
   to nurture after exhausting every attempt.';

-- ---------------------------------------------------------------------------
-- Lead history: the green light rides along, so Find lead can badge and
-- filter on it. Column appended at the end; everything else as 0017 left it.
-- ---------------------------------------------------------------------------

create or replace view crm.v_lead_history as
select
  l.id as lead_id, l.full_name, l.phone_e164, l.city, l.status, l.priority,
  l.caller_id, l.counsellor_id, l.team_id,
  l.attempt_count, l.connect_count, l.na_streak,
  l.first_touched_at, l.last_contacted_at, l.next_action_at, l.next_action_note,
  l.whatsapp_sent_at, l.walkin_expected_at, l.walked_in_at, l.created_at,
  la.disposition   as last_disposition,
  la.started_at    as last_call_at,
  la.duration_seconds as last_duration_seconds,
  crm.lead_green_reason(l.id) as green_reason
from crm.leads l
left join lateral (
  select ca.disposition, ca.started_at, ca.duration_seconds
    from crm.call_attempts ca
   where ca.lead_id = l.id
   order by ca.started_at desc
   limit 1
) la on true;

alter view crm.v_lead_history set (security_invoker = true);
grant select on crm.v_lead_history to crm_app;
