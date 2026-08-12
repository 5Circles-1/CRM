-- 0035_retap_pool.sql
--
-- Stop the floor being shouted at about leads that are simply not answering.
--
-- A lead that has gone unanswered three times running is not an emergency; it
-- is a re-tap job. Left in the alert stream it produces exactly the failure
-- the floor reported: a hundred red items, most of them the same handful of
-- people who did not pick up, which trains everybody to ignore the bell -
-- including for the callbacks that genuinely matter.
--
-- So past the threshold a lead goes QUIET. It stops raising per-lead alerts
-- and moves to its own tab, the re-tap pool, where it waits to be worked as a
-- batch. Once every few days each owner gets ONE notification saying how many
-- are waiting. Nothing is hidden and nothing is lost - the lead keeps its
-- next action, still appears in Find lead and My Pipeline, and still counts
-- in every leakage figure. Only the interrupting stops.

insert into crm.settings (key, value, description) values
  ('alert.na_quiet_after_attempts', '3'::jsonb,
   'Consecutive no-answers after which a lead stops raising its own alerts and moves to the re-tap pool.'),
  ('retap.reminder_days', '5'::jsonb,
   'How often each owner gets the single "leads waiting to be re-tapped" notification.'),
  ('retap.min_pool_size', '1'::jsonb,
   'Do not send the re-tap notification for fewer than this many waiting leads.')
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- The alerts view, with the two nagging kinds silenced past the threshold.
--
-- Only follow_up_due and action_overdue are gated. A callback the customer
-- asked for, a first-contact SLA breach and a reminder the owner set for
-- themselves all still interrupt however many times the phone went unanswered
-- - those are promises, not chasing.
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
   and not l.reminder_muted

union all

select
  'new_lead', 'warning', l.id, l.caller_id, l.full_name, l.phone_e164,
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

-- ---------------------------------------------------------------------------
-- The re-tap pool: the quiet leads, with what a caller needs to work them.
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
  and not l.reminder_muted;

alter view crm.v_no_answer_pool set (security_invoker = true);
grant select on crm.v_no_answer_pool to crm_app;

comment on view crm.v_no_answer_pool is
  'Leads still open and still owned, but gone unanswered past the quiet
   threshold: they raise no individual alerts and are worked as a batch from
   the Re-tap tab. Distinct from crm.v_retap_pool, which holds leads already
   PARKED to nurture after exhausting every attempt - this one is the quiet
   stage before that, and these leads are still very much in play.';

-- ---------------------------------------------------------------------------
-- One notification per owner, every few days. Not per lead, and not daily.
-- ---------------------------------------------------------------------------
create or replace function crm.send_retap_reminders()
  returns int
  language plpgsql
  security definer
  set search_path = crm, public
as $$
declare
  v_days  int := crm.setting_int('retap.reminder_days', 5);
  v_min   int := crm.setting_int('retap.min_pool_size', 1);
  v_row   record;
  v_sent  int := 0;
begin
  -- The team is off on Sunday, and a nudge nobody can act on is just noise.
  if extract(dow from crm.ist_date(now())) = 0 then
    return 0;
  end if;

  for v_row in
    select p.user_id,
           count(*)::int                 as waiting,
           max(p.days_since_touch)::int  as oldest_days
      from crm.v_no_answer_pool p
     where p.user_id is not null
     group by p.user_id
    having count(*) >= v_min
  loop
    -- Cadence is measured from the last one actually sent to this person, so
    -- a restart or a missed day never turns into two in a row.
    if exists (
      select 1 from crm.notifications n
       where n.user_id = v_row.user_id
         and n.kind = 'retap_due'
         and n.created_at > now() - make_interval(days => v_days)
    ) then
      continue;
    end if;

    insert into crm.notifications (user_id, kind, title, body)
    values (
      v_row.user_id, 'retap_due',
      format('%s lead%s waiting to be re-tapped',
             v_row.waiting, case when v_row.waiting = 1 then '' else 's' end),
      format('They have gone unanswered more than %s times, so they no longer interrupt you. '
             || 'The oldest has not been touched for %s day%s. Work them as a batch from the Re-tap tab.',
             crm.setting_int('alert.na_quiet_after_attempts', 3),
             v_row.oldest_days, case when v_row.oldest_days = 1 then '' else 's' end)
    );
    v_sent := v_sent + 1;
  end loop;

  return v_sent;
end
$$;

revoke execute on function crm.send_retap_reminders() from public;
grant execute on function crm.send_retap_reminders() to crm_app;
