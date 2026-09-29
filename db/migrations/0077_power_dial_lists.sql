-- 0077_power_dial_lists.sql
-- Power dialling, with the caller choosing the list (owner request, 28 Sep):
-- "they can choose the list from which they can dial ... if they want to
-- call back to back from the not answered list".
--
-- 0075 gave the dialler one list - everything due now, in the pipeline's
-- order. That is still the default. A caller can now also dial one slice of
-- it (fresh leads, callbacks whose time has come, follow-ups and overdue
-- work), or the Not answered list, and narrow any of them to one source.
--
-- The Not answered list is the one deliberate difference in the rules. The
-- due list never rings work before its next action, because that time was
-- agreed. A no-answer's next action was not agreed with anybody: the call
-- trigger set it as a retry. A caller who chooses "Not answered" is asking to
-- re-tap exactly those people now, so the retry time does not hold them back.
-- The client's own time still does: a lead with a callback booked for later
-- is never in this list. The re-dial gap still applies, and a session never
-- rings the same lead twice (the screen excludes what it already handled).
--
-- Both rules live here, beside v_dial_queue, so the screen only ever asks
-- "the next lead in list X" and never decides membership or order itself.

-- ---------------------------------------------------------------------------
-- 1. Which slice of the due queue a dial reason belongs to. One place, so the
--    list the dialler rings and the count on its button cannot disagree.
-- ---------------------------------------------------------------------------

create or replace function crm.dial_list_of(p_reason text)
  returns text
  language sql
  immutable
as $$
  select case
    when p_reason in ('immediate', 'fresh', 'reenquiry')          then 'fresh'
    when p_reason = 'callback_due'                                 then 'callbacks'
    when p_reason in ('visit_followup', 'overdue', 'breached')     then 'followups'
  end
$$;

comment on function crm.dial_list_of(text) is
  'The power-dial list a v_dial_queue.dial_reason belongs to: fresh (never contacted, re-enquiries), callbacks (a callback whose time has come) or followups (visit follow-ups, overdue, breached).';

-- ---------------------------------------------------------------------------
-- 2. One person's list, in dialling order.
--
--    due        - v_dial_queue as it is (0075).
--    fresh, callbacks, followups
--               - the same queue cut by crm.dial_list_of, same order.
--    not_answered
--               - every open lead of theirs whose last call did not reach
--                 the person (na_streak >= p_min_unreached), whatever the
--                 retry time says; never one with a callback booked for
--                 later. Due retries first, then the longest since a call.
--
--    p_campaign narrows any list to one source. p_min_hours_since_call keeps
--    recently tried numbers out of the Not answered list ("same time, same
--    result"). Invoker rights: every row passes the reader's RLS, like the
--    views it reads.
-- ---------------------------------------------------------------------------

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
  'One person''s power-dial list in dialling order: due (v_dial_queue), fresh, callbacks, followups (slices of it), or not_answered (open leads whose last call did not reach the person, whatever the retry time; never one with a callback booked for later). dialable is false inside power_dial.redial_gap_minutes of the last call.';

-- ---------------------------------------------------------------------------
-- 3. The counts on the list picker, from the same two rules.
-- ---------------------------------------------------------------------------

create or replace function crm.dial_list_counts(
  p_owner                uuid,
  p_campaign             text default null,
  p_min_unreached        int  default 1,
  p_min_hours_since_call int  default 0
) returns table (list text, ready int, held int)
  language sql
  stable
  set search_path = crm, public
as $$
  with q as (
    select crm.dial_list_of(dial_reason) as list, dialable
      from crm.v_dial_queue
     where queue_owner_id = p_owner
       and (p_campaign is null or campaign_name = p_campaign)
  )
  select 'due', count(*) filter (where dialable)::int, count(*) filter (where not dialable)::int
    from q
  union all
  select k.list,
         count(q.list) filter (where q.dialable)::int,
         count(q.list) filter (where not q.dialable)::int
    from (values ('fresh'), ('callbacks'), ('followups')) k(list)
    left join q on q.list = k.list
   group by k.list
  union all
  select 'not_answered',
         count(*) filter (where d.dialable)::int,
         count(*) filter (where not d.dialable)::int
    from crm.dial_list(p_owner, 'not_answered', p_campaign, p_min_unreached, p_min_hours_since_call) d
$$;

grant execute on function crm.dial_list_counts(uuid, text, int, int) to crm_app;

comment on function crm.dial_list_counts(uuid, text, int, int) is
  'How many leads each power-dial list holds for one person right now: ready to ring, and held by the re-dial gap.';
