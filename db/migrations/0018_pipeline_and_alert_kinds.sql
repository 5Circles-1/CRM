-- 0018_pipeline_and_alert_kinds.sql
--
-- Four things the floor found in testing.
--
-- THE BIG ONE: a follow-up scheduled for after today was invisible. v_my_day
-- ends at midnight tonight by design - it is the day's work list - but nothing
-- showed the rest. Call someone on Monday, agree to ring back on Thursday, and
-- between Monday night and Thursday morning that lead appeared on no screen at
-- all. It was not lost (the constraint guarantees a next action) but a caller
-- could not see their own week, which is why "there is no follow-up section"
-- was the complaint.
--
-- Also: alerts for follow-ups, overdue actions and new leads were folded into
-- one kind, so they could not be turned on or off separately.

-- ---------------------------------------------------------------------------
-- The whole pipeline, not just today.
-- ---------------------------------------------------------------------------

create or replace view crm.v_my_pipeline as
select
  l.id                as lead_id,
  l.caller_id,
  l.counsellor_id,
  l.team_id,
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
  l.created_at,
  cb.scheduled_at     as callback_at,
  cb.note             as callback_note,
  la.disposition      as last_disposition,

  -- One lead, one bucket. Ordered by urgency: the first branch that matches
  -- wins, so an overdue callback is 'overdue' rather than 'callback' - being
  -- late is the more useful fact about it.
  case
    when l.priority = 'immediate' and l.first_touched_at is null then 'immediate'
    when l.next_action_at < now()                                then 'overdue'
    when cb.id is not null
     and cb.scheduled_at < (crm.ist_date(now()) + 1)::timestamp at time zone 'Asia/Kolkata'
                                                                 then 'callback'
    when cb.id is not null                                       then 'callback_upcoming'
    when l.first_touched_at is null                              then 'fresh'
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

comment on view crm.v_my_pipeline is
  'Every open lead a person owns, bucketed. Unlike v_my_day this does NOT stop
   at midnight: a follow-up agreed for next week has to be visible somewhere,
   and "search for it by name" is not somewhere.';

grant select on crm.v_my_pipeline to crm_app;

-- ---------------------------------------------------------------------------
-- Alerts, split so each kind can be turned on or off on its own
--
-- "Follow-up due", "follow-up overdue" and "new lead" were one kind between
-- them, so silencing the noisy one silenced all three. The grace period is the
-- dividing line: due is a nudge, overdue is a problem.
-- ---------------------------------------------------------------------------

create or replace view crm.v_my_alerts as
select
  'sla_breach'::text                as kind,
  'critical'::text                  as severity,
  l.id                              as lead_id,
  l.caller_id                       as user_id,
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

union all

-- A lead just landed and has not been started. Distinct from the breach above:
-- this one is still inside its window, and is the notification a caller wants.
select
  'new_lead', 'warning', l.id, l.caller_id, l.full_name, l.phone_e164,
  l.first_touch_due_at, 'New lead assigned to you', null
  from crm.leads l
 where l.first_touched_at is null
   and l.attempt_count = 0
   and l.status in ('new', 'working')
   and l.assigned_at > now() - interval '2 hours'
   and (l.first_touch_due_at is null or l.first_touch_due_at >= now())

union all

select
  'callback_due', 'critical', c.lead_id, c.assigned_to, l.full_name, l.phone_e164,
  c.scheduled_at, 'Callback due', c.id
  from crm.callbacks c
  join crm.leads l on l.id = c.lead_id
 where c.status = 'pending'
   and c.scheduled_at <= now()

union all

select
  'callback_soon', 'warning', c.lead_id, c.assigned_to, l.full_name, l.phone_e164,
  c.scheduled_at, 'Callback due shortly', c.id
  from crm.callbacks c
  join crm.leads l on l.id = c.lead_id
 where c.status = 'pending'
   and c.scheduled_at > now()
   and c.scheduled_at <= now() + interval '15 minutes'

union all

-- A follow-up that has just come due. A nudge, not a failure.
select
  'follow_up_due', 'warning', l.id, l.caller_id, l.full_name, l.phone_e164,
  l.next_action_at, coalesce(l.next_action_note, 'Follow-up due now'), null
  from crm.leads l
 where l.next_action_at is not null
   and l.next_action_at <= now()
   and l.next_action_at > now() - make_interval(mins => crm.setting_int('sla.followup_grace_minutes', 30))
   and l.status in ('new', 'working', 'callback')
   and l.first_touched_at is not null

union all

-- Past the grace period. Now it is a problem.
select
  'action_overdue', 'critical', l.id, l.caller_id, l.full_name, l.phone_e164,
  l.next_action_at, coalesce(l.next_action_note, 'Follow-up overdue'), null
  from crm.leads l
 where l.next_action_at is not null
   and l.next_action_at <= now() - make_interval(mins => crm.setting_int('sla.followup_grace_minutes', 30))
   and l.status in ('new', 'working', 'callback')
   and l.first_touched_at is not null

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

insert into crm.settings (key, value, description) values
  ('sla.followup_grace_minutes', '30'::jsonb,
   'How long after a follow-up falls due before it counts as overdue rather than simply due.')
on conflict (key) do nothing;

-- Every kind pops by default now. They were asked for by name, and each one
-- fires ONCE per lead - the interruption complaint was hourly repeats of the
-- same dead lead, which the retry gaps fixed, not the alerts themselves.
update crm.settings
   set value = '["callback_due","callback_soon","follow_up_due","action_overdue","new_lead","reassigned_in"]'::jsonb,
       updated_at = now()
 where key = 'alerts.popup_kinds';
