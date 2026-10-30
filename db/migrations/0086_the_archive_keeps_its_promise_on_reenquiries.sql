-- 0086_the_archive_keeps_its_promise_on_reenquiries.sql
--
-- Found resetting the floor for the small team (owner, 30 Oct): the admin
-- archived the whole book, the fresh list dropped from 700 to 200 - and the
-- 200 that stayed were every undialled re-enquiry, oldest 29 days, on leads
-- the archive had just parked. The archive panel promises "leaves every
-- pipeline, alert and fresh list"; for exactly this category it did not.
--
-- Why: v_reenquired_leads (0065) clears a row when somebody dials the person
-- AFTER they asked again, or when the lead is deliberately CLOSED after it -
-- "dealt with by a person". But crm.archive_leads_before parks (status
-- nurture, pool previous_month) and never sets closed_at, so to the view an
-- archived lead looked untouched and the row stayed, forever, on a list
-- whose whole point is "never cleared by age".
--
-- The archive is a person's decision exactly like a close - the owner looked
-- at the book and parked it. So the 'archived' timeline event the archive
-- already writes per lead (0050) becomes the third clearing condition:
-- archived AFTER the re-enquiry means dealt with. The order is what keeps
-- "a client who asks twice is never lost" intact: a re-enquiry that arrives
-- AFTER the archive is newer than the archive event, so the row shows again
-- immediately - parking the book never silences a client who asks again.

-- Same columns as 0065; only the WHERE gains the third clearing condition.
create or replace view crm.v_reenquired_leads as
select
  l.id                                  as lead_id,
  case when l.escalation_stage = 'counsellor' then l.counsellor_id else l.caller_id end
                                        as user_id,
  l.caller_id, l.counsellor_id, l.team_id,
  t.name                                as team_name,
  u.full_name                           as owner_name,
  l.full_name, l.phone_e164, l.city,
  l.priority, l.status,
  s.name                                as source_name,
  rs.name                               as reenquiry_source_name,
  e.occurred_at                         as reenquired_at,
  l.reenquiry_count,
  (l.first_touched_at is null)          as never_contacted,
  l.attempt_count,
  l.next_action_at,
  l.created_at,
  -- "Waiting" for a re-enquiry counts from the moment they asked again.
  round(extract(epoch from (now() - e.occurred_at)) / 60)::int
                                        as age_minutes,
  case
    when l.next_action_at is null then null
    else round(extract(epoch from (now() - l.next_action_at)) / 60)::int
  end                                   as minutes_late,
  -- Same three states as v_fresh_leads, measured against the deadline the
  -- re-enquiry set (the worker pulls next_action_at to within 15 minutes).
  case
    when l.next_action_at is null                           then 'waiting'
    when now() < l.next_action_at                           then 'waiting'
    when now() < crm.add_working_minutes(l.next_action_at,
                   crm.setting_int('fresh.flag_after_minutes', 0))
                                                            then 'waiting'
    when now() > crm.add_working_minutes(l.next_action_at,
                   crm.setting_int('sla.breached_after_minutes', 2880))
                                                            then 'breached'
    else 'flagged'
  end                                   as flag
from (
  -- Latest re-enquiry per lead; asking twice in a burst is one row, not two.
  select distinct on (lead_id) lead_id, occurred_at, payload
    from crm.lead_events
   where event_type = 're_enquiry'
   order by lead_id, occurred_at desc
) e
join crm.leads l on l.id = e.lead_id
left join crm.teams t on t.id = l.team_id
left join crm.lead_sources s on s.id = l.source_id
left join crm.lead_sources rs
  on rs.id = case when (e.payload->>'source_id') ~ '^[0-9a-f-]{36}$'
                  then (e.payload->>'source_id')::uuid end
left join crm.users u
  on u.id = case when l.escalation_stage = 'counsellor' then l.counsellor_id else l.caller_id end
-- The row clears only when a person has dealt with it: a call placed AFTER
-- the re-enquiry (compared on when the call happened, so a backfilled device
-- log from before it does not silently answer it); a deliberate close after
-- it; or - 0086 - the admin archiving the lead after it. One closed or
-- archived BEFORE the re-enquiry is still a person waiting.
where not exists (
  select 1 from crm.call_attempts ca
   where ca.lead_id = l.id
     and ca.started_at > e.occurred_at
)
  and (l.closed_at is null or l.closed_at <= e.occurred_at)
  and not exists (
    select 1 from crm.lead_events ae
     where ae.lead_id = l.id
       and ae.event_type = 'archived'
       and ae.occurred_at > e.occurred_at
  );

alter view crm.v_reenquired_leads set (security_invoker = true);
grant select on crm.v_reenquired_leads to crm_app;

comment on view crm.v_reenquired_leads is
  'Leads whose person enquired again and has not been dealt with since.
   Rendered inside the Fresh tab''s list with an "enquired again" badge,
   flagged against the deadline the re-enquiry set, and never dropped for
   age - the row leaves only when a person acts: a call attempt after the
   re-enquiry, a deliberate close after it, or the admin archiving the lead
   after it (0086). A re-enquiry that arrives after the archive shows again
   at once. Still one live lead per phone (0042): this resurfaces the
   existing lead, it does not duplicate it.';
