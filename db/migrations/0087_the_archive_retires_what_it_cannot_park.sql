-- 0087_the_archive_retires_what_it_cannot_park.sql
--
-- The floor reset, part three (owner, 30 Oct: "clear everything"). 0086
-- taught the fresh list that an archived lead's re-enquiry is dealt with -
-- and the list dropped from 200 to 99. The 97 "enquired again" rows that
-- remained sat on leads the archive deliberately never parks: 74 closed as
-- invalid, 23 paying clients with deals. No park, no 'archived' event,
-- nothing to clear them - the one list that never ages off was carrying
-- flags that nothing could ever retire.
--
-- The cutoff is the admin saying "everything before this date is dealt
-- with". So the archive now says it about re-enquiries too: on the real
-- run, every undialled re-enquiry OLDER than the cutoff - on a closed lead,
-- a paying client, a deal-shielded lead, anything it cannot park - gets a
-- 'reenquiry_archived' timeline event, which v_reenquired_leads reads as
-- handled. Three things deliberately survive:
--
--   - The sale and the close. Only the "call them back" flag retires;
--     status, closed_at, caller_id (the win's credit) and the deal are
--     untouched.
--   - A re-enquiry AT or AFTER the cutoff. That is current work, not
--     history - a client who asked this morning stays on Fresh.
--   - The never-lost rule. A client who enquires again after the archive is
--     newer than the retirement event, so they pop straight back up.
--
-- The function now returns both numbers - leads parked and re-enquiries
-- retired - because a button that quietly does a second thing is a button
-- nobody can trust. The dry run counts both without writing either.

-- Return shape changes (int -> two-column row), so drop and recreate.
drop function crm.archive_leads_before(date, boolean);

create function crm.archive_leads_before(
  p_cutoff  date,
  p_dry_run boolean default false
) returns table (archived int, reenquiries_retired int)
  language plpgsql
  security definer
  set search_path = crm, public
as $$
declare
  v_role    text := crm.current_user_role();
  v_actor   uuid := crm.current_user_id();
  v_cut     timestamptz;
  v_count   int;
  v_retired int;
begin
  -- Definer rights see the whole book, so the door is guarded here, not in
  -- the API: parking the floor's data is an owner-level act.
  if v_role not in ('admin', 'ops') then
    raise exception 'only an admin may archive the lead book'
      using errcode = 'insufficient_privilege';
  end if;
  if p_cutoff is null or p_cutoff > current_date + 1 then
    raise exception 'the cutoff must be a real past date'
      using errcode = 'check_violation';
  end if;

  v_cut := (p_cutoff)::timestamp at time zone 'Asia/Kolkata';

  if p_dry_run then
    select count(*) into v_count
      from crm.leads l
     where l.created_at < v_cut
       and coalesce(l.last_contacted_at, l.created_at) < v_cut
       and l.status in ('new', 'working', 'callback', 'qualified', 'negotiation', 'nurture')
       and l.pool is distinct from 'previous_month'
       and not exists (select 1 from crm.deals d where d.lead_id = l.id);

    -- The re-enquiries the real run would retire: pre-cutoff, undialled,
    -- not already cleared, on leads this run would NOT park (a parked
    -- lead's flag is cleared by its own 'archived' event instead).
    select count(*) into v_retired
      from (select distinct on (e.lead_id) e.lead_id, e.occurred_at
              from crm.lead_events e
             where e.event_type = 're_enquiry'
             order by e.lead_id, e.occurred_at desc) le
      join crm.leads l on l.id = le.lead_id
     where le.occurred_at < v_cut
       and not exists (select 1 from crm.call_attempts ca
                        where ca.lead_id = le.lead_id
                          and ca.started_at > le.occurred_at)
       and (l.closed_at is null or l.closed_at <= le.occurred_at)
       and not exists (select 1 from crm.lead_events ae
                        where ae.lead_id = le.lead_id
                          and ae.event_type in ('archived', 'reenquiry_archived')
                          and ae.occurred_at > le.occurred_at)
       and not (l.created_at < v_cut
                and coalesce(l.last_contacted_at, l.created_at) < v_cut
                and l.status in ('new', 'working', 'callback', 'qualified', 'negotiation', 'nurture')
                and l.pool is distinct from 'previous_month'
                and not exists (select 1 from crm.deals d where d.lead_id = l.id));

    return query select v_count, v_retired;
    return;
  end if;

  -- Park the leads and write each one's own "why I left the pipeline" line in
  -- the same statement, so the count, the rows and the history cannot drift.
  with parked as (
    update crm.leads l
       set status           = 'nurture',
           pool             = 'previous_month',
           next_action_at   = null,
           next_action_note = 'Archived - created before ' || to_char(p_cutoff, 'DD Mon YYYY'),
           reminder_at      = null,
           updated_at       = now()
     where l.created_at < v_cut
       and coalesce(l.last_contacted_at, l.created_at) < v_cut
       and l.status in ('new', 'working', 'callback', 'qualified', 'negotiation', 'nurture')
       and l.pool is distinct from 'previous_month'
       and not exists (select 1 from crm.deals d where d.lead_id = l.id)
     returning l.id
  ),
  noted as (
    insert into crm.lead_events (lead_id, event_type, actor_id, payload)
    select p.id, 'archived', v_actor, jsonb_build_object('cutoff', p_cutoff)
      from parked p
    returning 1
  )
  select count(*) into v_count from parked;

  -- A callback on a parked lead would keep ringing the bell forever. Cancel
  -- (never delete) every pending one across the previous-months pool.
  update crm.callbacks c
     set status = 'cancelled', updated_at = now()
   where c.status = 'pending'
     and exists (select 1 from crm.leads l
                  where l.id = c.lead_id and l.pool = 'previous_month');

  -- Retire the pre-cutoff re-enquiries the park could not reach. Runs after
  -- the park on purpose: a lead parked a moment ago already carries a fresh
  -- 'archived' event, which the last condition reads as cleared - one lead,
  -- one clearing record, never two.
  with latest as (
    select distinct on (e.lead_id) e.lead_id, e.occurred_at
      from crm.lead_events e
     where e.event_type = 're_enquiry'
     order by e.lead_id, e.occurred_at desc
  ),
  retired as (
    insert into crm.lead_events (lead_id, event_type, actor_id, payload)
    select le.lead_id, 'reenquiry_archived', v_actor, jsonb_build_object('cutoff', p_cutoff)
      from latest le
      join crm.leads l on l.id = le.lead_id
     where le.occurred_at < v_cut
       and not exists (select 1 from crm.call_attempts ca
                        where ca.lead_id = le.lead_id
                          and ca.started_at > le.occurred_at)
       and (l.closed_at is null or l.closed_at <= le.occurred_at)
       and not exists (select 1 from crm.lead_events ae
                        where ae.lead_id = le.lead_id
                          and ae.event_type in ('archived', 'reenquiry_archived')
                          and ae.occurred_at > le.occurred_at)
    returning 1
  )
  select count(*) into v_retired from retired;

  return query select v_count, v_retired;
end
$$;

comment on function crm.archive_leads_before(date, boolean) is
  'Parks every undealt, unworked-since-cutoff lead created before the cutoff
   into the previous_month pool, stamping each lead''s history - and retires
   every pre-cutoff undialled re-enquiry on the leads it cannot park (closed,
   paying, deal-shielded) with a reenquiry_archived event, leaving the sale
   and the close untouched (0087). Returns both counts. Admin/ops only;
   dry_run counts without moving. The Admin -> Data button calls this;
   db/ops/archive-before.sql is the same act from psql.';

revoke all on function crm.archive_leads_before(date, boolean) from public;
grant execute on function crm.archive_leads_before(date, boolean) to crm_app;

-- ---------------------------------------------------------------------------
-- The view reads the retirement event exactly like the park's own event.
-- Same columns as 0086; only the clearing event list widens.
-- ---------------------------------------------------------------------------
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
-- it; the admin archiving the lead after it (0086); or the admin's archive
-- retiring a pre-cutoff re-enquiry the park could not reach (0087). One
-- closed or archived BEFORE the re-enquiry is still a person waiting.
where not exists (
  select 1 from crm.call_attempts ca
   where ca.lead_id = l.id
     and ca.started_at > e.occurred_at
)
  and (l.closed_at is null or l.closed_at <= e.occurred_at)
  and not exists (
    select 1 from crm.lead_events ae
     where ae.lead_id = l.id
       and ae.event_type in ('archived', 'reenquiry_archived')
       and ae.occurred_at > e.occurred_at
  );

alter view crm.v_reenquired_leads set (security_invoker = true);
grant select on crm.v_reenquired_leads to crm_app;

comment on view crm.v_reenquired_leads is
  'Leads whose person enquired again and has not been dealt with since.
   Rendered inside the Fresh tab''s list with an "enquired again" badge,
   flagged against the deadline the re-enquiry set, and never dropped for
   age - the row leaves only when a person acts: a call attempt after the
   re-enquiry, a deliberate close after it, or the admin''s archive covering
   it (0086, 0087). A re-enquiry that arrives after the archive shows again
   at once. Still one live lead per phone (0042): this resurfaces the
   existing lead, it does not duplicate it.';
