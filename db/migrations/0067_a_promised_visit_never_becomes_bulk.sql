-- 0067_a_promised_visit_never_becomes_bulk.sql
--
-- "My callers mark someone as will visit on the first call, on the 2nd call it
-- goes not answered - and then the lead falls into Not answered. Not answered
-- is worked as bulk. Good quality leads are lost this way." (owner, 10 Sep)
--
-- Traced, the loss happens in four places, all the same mistake: the system
-- classified the lead by its LATEST outcome, so one unanswered dial erased the
-- promise a human being made on a connected call.
--
--   1. The Find-lead "Will visit" list filtered on last_disposition, so the
--      lead left it the moment a later dial went unanswered - and surfaced on
--      the "Did not answer" list instead, indistinguishable from the pile that
--      never answered at all. (Fixed in the API/UI, on top of this migration.)
--   2. In the pipeline, 'breached' outranked 'will_visit', so 48 hours past
--      due the promise vanished into the breached bulk tab.
--   3. Past the quiet threshold (na_streak > 3) the lead stopped raising
--      overdue alerts - correct for chasing, wrong for a promise. 0035's own
--      rule already draws this line: "a callback the customer asked for still
--      interrupts, however quiet the lead - those are promises, not chasing."
--      A promised visit is the same kind of thing: the client committed.
--   4. The same threshold dropped it into v_no_answer_pool, the re-tap batch,
--      which is the literal definition of being worked as bulk.
--
-- The durable fact was already recorded - walkin_expected_at is set on the
-- will_visit call and only walked_in_at resolves it - it was just consulted
-- nowhere. From here, ONE named predicate says "they promised to come and
-- have not yet come", and every classifier defers to it. The lead still
-- appears in the not-answered re-tap lists (it does still need re-dialling;
-- hiding it would trade one loss for another) - but wearing its promise as a
-- badge, and it never LOSES its own home to them.
--
-- Deliberately unchanged: the nine-attempt nurture cap, the 15-day stale
-- mover and the transfer rules all still apply. A promise is not immortality;
-- it is identity. The lead can still be parked or handed over - it just can
-- never be mistaken for bulk while the promise is open.

-- ---------------------------------------------------------------------------
-- The one definition. Everything that classifies a lead as quality-vs-bulk
-- calls this, so the rule cannot drift apart across views.
-- ---------------------------------------------------------------------------

create or replace function crm.visit_promise_open(p_expected timestamptz, p_walked_in timestamptz)
  returns boolean
  language sql immutable
as $$
  select p_expected is not null and p_walked_in is null
$$;

comment on function crm.visit_promise_open(timestamptz, timestamptz) is
  'True while a lead has promised to visit and has not yet come in. The promise
   outranks any silence that follows it: a lead with an open visit promise
   keeps its will_visit home, keeps alerting, and never joins a bulk pool.
   Resolved only by recording the walk-in (or un-promising via lead close).';

-- ---------------------------------------------------------------------------
-- The pipeline: the promise now outranks 'breached'.
--
-- Same view as 0021, same columns; only the bucket CASE moves. Being long
-- past due is a fact about the lead, but "they said they would come in" is
-- the fact the floor needs first - minutes_overdue still rides along, so the
-- lateness is shown inside the Visits promised tab rather than costing the
-- lead its identity.
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

  -- One lead, one bucket. Fresh first; then the open promise, which can no
  -- longer fall through to 'breached' however many dials go unanswered after
  -- it - an overdue promise is by definition inside the two-day window, so
  -- the will_visit branch always catches it first.
  case
    when l.priority = 'immediate' and l.first_touched_at is null then 'immediate'
    when l.first_touched_at is null                              then 'fresh'
    when crm.visit_promise_open(l.walkin_expected_at, l.walked_in_at)
     and l.next_action_at < (crm.ist_date(now()) + 2)::timestamp at time zone 'Asia/Kolkata'
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
  end::int            as sla_minutes_remaining
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
-- Alerts: the quiet threshold no longer silences an open promise.
--
-- Reproduced wholesale from 0056; the one change is the na_streak gate on
-- follow_up_due and action_overdue, which now lets a lead with an open visit
-- promise keep alerting however long it goes unanswered. This does NOT bring
-- back popup nagging: since 0049 only the callback the client asked for and
-- the owner's own reminder pop; these kinds live on the Alerts work list.
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
        or crm.visit_promise_open(l.walkin_expected_at, l.walked_in_at))

union all

-- Past the grace period. Now it is a problem - but parked pools never nag,
-- unless the lead is sitting on an open promise to visit.
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
        or crm.visit_promise_open(l.walkin_expected_at, l.walked_in_at))

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
-- The re-tap batch pool: never an open promise.
--
-- Reproduced from 0035 with one added condition. The pool exists so leads
-- that are "simply not answering" are worked as a batch without nagging;
-- a lead that promised to visit is neither of those things - it keeps its
-- will_visit home and its individual alerts instead. It still shows in the
-- Not-answered re-tap lists on Find lead and the day board (it does still
-- need re-dialling), wearing its promise badge there.
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
  and not crm.visit_promise_open(l.walkin_expected_at, l.walked_in_at);

alter view crm.v_no_answer_pool set (security_invoker = true);
grant select on crm.v_no_answer_pool to crm_app;

comment on view crm.v_no_answer_pool is
  'Leads still open and still owned, but gone unanswered past the quiet
   threshold: they raise no individual alerts and are worked as a batch from
   the Re-tap tab. Excludes any lead with an open promise to visit - a promise
   is quality, not bulk, and those keep their own tab and their own alerts.
   Distinct from crm.v_retap_pool, which holds leads already PARKED to nurture
   after exhausting every attempt.';
