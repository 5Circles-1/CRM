-- 0065_a_reenquiry_is_worked_like_a_fresh_lead.sql
--
-- 0064 made re-enquiries visible - in a separate list, for a few days. The
-- owner looked at it and asked for more (owner decision, 3 Sep): "each and
-- every lead comes up as a fresh lead. If a person is enquiring again and
-- again we should definitely be aware - sometimes our numbers go into spam
-- and the calls don't get picked up."
--
-- The insight is right: a repeat enquiry IS fresh work. The person raised
-- their hand again, is waiting right now, and the earlier attempt may never
-- have reached them at all (spam-flagged caller ID, missed ring). So a
-- re-enquiry now behaves exactly like a fresh lead on the Fresh tab:
--
--   - It appears IN the fresh list itself, wearing an "enquired again"
--     badge, flagged in time / late / badly late against its own deadline
--     (the next action the re-enquiry pulled forward).
--   - It NEVER falls off for getting old. The 0064 show-window is gone;
--     like a fresh lead, the row leaves the list only when somebody
--     actually dials the person again after their re-enquiry.
--
-- What deliberately does NOT change: the database still keeps one live lead
-- per phone (0042). The fresh row is the same lead record, resurfaced - not
-- a duplicate for a second caller to fight over.

-- The window is gone: presence on the list is now "not yet re-contacted",
-- the same promise the fresh list makes, so the setting has nothing to tune.
delete from crm.settings where key = 'fresh.reenquiry_show_days';

-- The 0064 shape had different columns (a show-window's minutes_ago); a
-- replace cannot reshape a view's column list, so recreate it.
drop view crm.v_reenquired_leads;

create view crm.v_reenquired_leads as
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
-- The row clears the way a fresh lead does: only when somebody actually
-- dials the person AFTER they asked again. Compared on when the call
-- happened (started_at), not when it was typed in, so a backfilled device
-- log from before the re-enquiry does not silently answer it. A lead
-- deliberately closed after the re-enquiry (won, or marked lost/invalid by
-- a person) has also been dealt with; one closed BEFORE it - a won client
-- asking again - is still a person waiting.
where not exists (
  select 1 from crm.call_attempts ca
   where ca.lead_id = l.id
     and ca.started_at > e.occurred_at
)
  and (l.closed_at is null or l.closed_at <= e.occurred_at);

alter view crm.v_reenquired_leads set (security_invoker = true);
grant select on crm.v_reenquired_leads to crm_app;

comment on view crm.v_reenquired_leads is
  'Leads whose person enquired again and has not been dialled since. Rendered
   inside the Fresh tab''s list with an "enquired again" badge, flagged
   against the deadline the re-enquiry set, and never dropped for age - the
   row leaves only when a call attempt lands after the re-enquiry. Still one
   live lead per phone (0042): this resurfaces the existing lead, it does
   not duplicate it.';
