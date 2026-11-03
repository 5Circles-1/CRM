-- 0088_a_walk_in_answers_the_re_enquiry.sql
--
-- Floor report (admin, 3 Nov): a paying client enquired again, came into the
-- office the same afternoon, the admin pressed "Walked in" - and the lead
-- kept popping up in the Fresh list. Marking the walk-in again did nothing,
-- because nothing was wrong with the walk-in: the "enquired again" row was
-- what the admin was looking at, and a walk-in was not one of its clearing
-- conditions.
--
-- v_reenquired_leads holds a lead on the Fresh tab until a person deals with
-- the re-enquiry: a call placed AFTER it (0065), a deliberate close after it,
-- or the admin's archive covering it (0086, 0087). A client who walks into
-- the office has been dealt with more thoroughly than any of those - they are
-- sitting across the desk from a counsellor - yet the row survived the visit.
-- For a paying client (0080: a repeat enquiry leaves a won lead won) the gap
-- is permanent: nobody dials a client who already came in, so the one
-- clearing act that remained was a pointless phone call after the fact, and
-- the row sat on Fresh forever looking like neglect.
--
-- So the ARRIVAL becomes the fourth clearing condition. The arrival, not the
-- booking: a booked visit is a promise (that is what the green light is for),
-- and the row rightly holds until the client actually turns up - a no-show
-- never has an arrived_at and still reads as a person waiting. Anchored on
-- arrived_at > the re-enquiry, same as the call-attempt rule, so a visit from
-- BEFORE they asked again does not silently answer them. And the undo path
-- ("Walked in" unticked) cancels the visit and nulls arrived_at, so a
-- mistaken mark resurfaces the row on its own - the two screens cannot
-- disagree about whether this client is still waiting.
--
-- walkin_visits carries the same RLS rule as call_attempts and lead_events
-- (lead visibility decides, crm.can_see_lead), so the security_invoker view
-- reads it identically for every role: the row clears for the caller the
-- moment it clears for the admin.
--
-- The dialler repeats the rule twice (0075, 0077) and learns the same fact
-- below, or power dial keeps auto-ringing an open lead whose client is
-- sitting in the office - as a 'reenquiry', exempt from the re-dial gap.

-- Same columns as 0086/0087; only the WHERE gains the fourth clearing
-- condition.
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
-- it; the admin archiving the lead after it (0086); the admin's archive
-- retiring a pre-cutoff re-enquiry the park could not reach (0087); or the
-- client ARRIVING at the office after it (0088) - they answered the enquiry
-- in person. One closed, archived or walked in BEFORE the re-enquiry is
-- still a person waiting.
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
  )
  and not exists (
    select 1 from crm.walkin_visits wv
     where wv.lead_id = l.id
       and wv.arrived_at is not null
       and wv.arrived_at > e.occurred_at
  );

alter view crm.v_reenquired_leads set (security_invoker = true);
grant select on crm.v_reenquired_leads to crm_app;

comment on view crm.v_reenquired_leads is
  'Leads whose person enquired again and has not been dealt with since.
   Rendered inside the Fresh tab''s list with an "enquired again" badge,
   flagged against the deadline the re-enquiry set, and never dropped for
   age - the row leaves only when a person acts: a call attempt after the
   re-enquiry, a deliberate close after it, the admin''s archive covering
   it (0086, 0087), or the client walking into the office after it (0088).
   A re-enquiry that arrives after any of those shows again at once. Still
   one live lead per phone (0042): this resurfaces the existing lead, it
   does not duplicate it.';

-- ---------------------------------------------------------------------------
-- The dialler carries the same rule in two more places (0075's queue and
-- 0077's Not answered list both say "the same rule as v_reenquired_leads"),
-- and both must learn the same fact, or power dial keeps auto-ringing a
-- client who is sitting in the office - ranked as a re-enquiry, and exempt
-- from the re-dial gap, because a re-enquiry is an appointment. Close and
-- archive need no mention here: a closed or archived lead is not in
-- v_my_pipeline at all, but a walked-in lead stays open (the counselling
-- response is due), which is exactly why only this clearing act was missing.
-- ---------------------------------------------------------------------------

-- Same as 0075; only the re-enquiry lateral learns about the arrival.
create or replace view crm.v_dial_queue as
select q.*,
       (q.redial_held_until is null) as dialable,
       row_number() over (
         partition by q.queue_owner_id
         order by (q.redial_held_until is not null), q.dial_rank,
                  q.minutes_overdue desc, q.created_at desc, q.next_action_at asc, q.lead_id
       ) as dial_position
  from (
    select p.*,
           re.reenquired_at,
           case
             when p.bucket = 'immediate'                               then 0
             when p.callback_at is not null and p.callback_at <= now() then 1
             when p.bucket = 'fresh' or re.reenquired_at is not null   then 2
             when p.bucket = 'will_visit'                              then 3
             when p.bucket = 'overdue'                                 then 4
             else 5
           end as dial_rank,
           case
             when p.bucket = 'immediate'                               then 'immediate'
             when p.callback_at is not null and p.callback_at <= now() then 'callback_due'
             when re.reenquired_at is not null                         then 'reenquiry'
             when p.bucket = 'fresh'                                   then 'fresh'
             when p.bucket = 'will_visit'                              then 'visit_followup'
             when p.bucket = 'overdue'                                 then 'overdue'
             else 'breached'
           end as dial_reason,
           case
             when p.callback_at is not null and p.callback_at <= now() then null
             when re.reenquired_at is not null                         then null
             when la.last_call_at + make_interval(
                    mins => crm.setting_int('power_dial.redial_gap_minutes', 30)) > now()
               then la.last_call_at + make_interval(
                    mins => crm.setting_int('power_dial.redial_gap_minutes', 30))
           end as redial_held_until
      from crm.v_my_pipeline p
      -- The latest re-enquiry nobody has dialled since - the same "cleared
      -- only by a person acting after it" rule as crm.v_reenquired_leads:
      -- a call placed after it, or the client arriving at the office (0088).
      left join lateral (
        select e.occurred_at as reenquired_at
          from crm.lead_events e
         where e.lead_id = p.lead_id
           and e.event_type = 're_enquiry'
           and not exists (select 1 from crm.call_attempts ca
                            where ca.lead_id = p.lead_id
                              and ca.started_at > e.occurred_at)
           and not exists (select 1 from crm.walkin_visits wv
                            where wv.lead_id = p.lead_id
                              and wv.arrived_at is not null
                              and wv.arrived_at > e.occurred_at)
         order by e.occurred_at desc
         limit 1
      ) re on true
      left join lateral (
        select max(ca.started_at) as last_call_at
          from crm.call_attempts ca
         where ca.lead_id = p.lead_id
      ) la on true
     where p.bucket in ('immediate', 'fresh', 'overdue', 'breached')
        or (p.bucket = 'will_visit' and p.next_action_at <= now())
        or re.reenquired_at is not null
  ) q;

alter view crm.v_dial_queue set (security_invoker = true);
grant select on crm.v_dial_queue to crm_app;

comment on view crm.v_dial_queue is
  'Each person''s due-now work in power-dial order. dialable is false while a lead sits inside power_dial.redial_gap_minutes of its last call (a due callback and an undialled re-enquiry are never held). A re-enquiry stops counting once a call lands after it or the client walks in after it (0088). Built on v_my_pipeline under the reader''s RLS, so nobody''s queue can contain a lead they cannot see.';

-- Same as 0077; only the Not answered list's re-enquiry lateral learns it,
-- so "they enquired again since" stops waiving the re-dial gap for a client
-- who answered that enquiry in person.
create or replace function crm.dial_list(
  p_owner                uuid,
  p_list                 text,
  p_campaign             text default null,
  p_min_unreached        int  default 1,
  p_min_hours_since_call int  default 0
) returns table (
  lead_id           uuid,
  list_reason       text,
  dialable          boolean,
  redial_held_until timestamptz,
  list_position     bigint
)
  language sql
  stable
  set search_path = crm, public
as $$
  select q.lead_id,
         q.dial_reason,
         q.dialable,
         q.redial_held_until,
         row_number() over (order by q.dial_position)
    from crm.v_dial_queue q
   where p_list in ('due', 'fresh', 'callbacks', 'followups')
     and q.queue_owner_id = p_owner
     and (p_list = 'due' or crm.dial_list_of(q.dial_reason) = p_list)
     and (p_campaign is null or q.campaign_name = p_campaign)
  union all
  select u.lead_id,
         'not_answered',
         u.redial_held_until is null,
         u.redial_held_until,
         row_number() over (order by (u.redial_held_until is not null),
                                     (u.next_action_at > now()),
                                     u.last_call_at asc nulls first,
                                     u.lead_id)
    from (
      select p.lead_id,
             p.next_action_at,
             la.last_call_at,
             -- The re-dial gap, exactly as in v_dial_queue: a number rung
             -- minutes ago is not rung again, unless it is an appointment - the
             -- client's callback time has come, or they enquired again since.
             case
               when p.callback_at is not null and p.callback_at <= now() then null
               when re.reenquired_at is not null                         then null
               when la.last_call_at + make_interval(
                      mins => crm.setting_int('power_dial.redial_gap_minutes', 30)) > now()
                 then la.last_call_at + make_interval(
                      mins => crm.setting_int('power_dial.redial_gap_minutes', 30))
             end as redial_held_until
        from crm.v_my_pipeline p
        left join lateral (
          select max(ca.started_at) as last_call_at
            from crm.call_attempts ca
           where ca.lead_id = p.lead_id
        ) la on true
        left join lateral (
          select e.occurred_at as reenquired_at
            from crm.lead_events e
           where e.lead_id = p.lead_id
             and e.event_type = 're_enquiry'
             and not exists (select 1 from crm.call_attempts ca
                              where ca.lead_id = p.lead_id
                                and ca.started_at > e.occurred_at)
             and not exists (select 1 from crm.walkin_visits wv
                              where wv.lead_id = p.lead_id
                                and wv.arrived_at is not null
                                and wv.arrived_at > e.occurred_at)
           order by e.occurred_at desc
           limit 1
        ) re on true
       where p_list = 'not_answered'
         and p.queue_owner_id = p_owner
         and p.na_streak >= greatest(coalesce(p_min_unreached, 1), 1)
         -- The client chose that time; the retry time is only the machine's.
         and not (p.callback_at is not null and p.callback_at > now())
         and (p_campaign is null or p.campaign_name = p_campaign)
         and (coalesce(p_min_hours_since_call, 0) <= 0
              or la.last_call_at is null
              or la.last_call_at <= now() - make_interval(hours => p_min_hours_since_call))
    ) u
$$;

grant execute on function crm.dial_list(uuid, text, text, int, int) to crm_app;

comment on function crm.dial_list(uuid, text, text, int, int) is
  'One person''s power-dial list in dialling order: due (v_dial_queue), fresh, callbacks, followups (slices of it), or not_answered (open leads whose last call did not reach the person, whatever the retry time; never one with a callback booked for later). dialable is false inside power_dial.redial_gap_minutes of the last call. A re-enquiry answered by a later call or walk-in no longer counts as one (0088).';
