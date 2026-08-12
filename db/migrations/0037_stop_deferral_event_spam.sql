-- 0037_stop_deferral_event_spam.sql
--
-- A lead held with no caller was writing a "held for shift start" event to its
-- own history EVERY MINUTE, forever.
--
-- crm.assign_pending_leads runs on a 60-second timer and calls
-- crm.assign_lead for every unassigned lead. assign_lead recorded a
-- distribution_event and a lead_event unconditionally - including when it had
-- decided nothing, because no caller was available. So a lead waiting since
-- the 5th of August accumulated roughly six hundred identical rows a day. The
-- lead's timeline became unreadable, and "passed over today" on the Floor
-- read 9,663 for a caller who had simply been off shift.
--
-- The rule now: a deferral is an EPISODE, not a tick. The first time a lead
-- is held it is recorded, with the reason. Every subsequent sweep that
-- reaches the same conclusion changes nothing and writes nothing. The moment
-- the answer differs - a caller is found, or the team changes - that is a new
-- fact and it is recorded.
--
-- Nothing about the behaviour of distribution changes. The lead is still
-- looked at every minute and still handed out the instant somebody is
-- available; only the duplicate bookkeeping stops.

create or replace function crm.assign_lead(p_lead_id uuid)
  returns uuid
  language plpgsql
as $$
declare
  v_lead      crm.leads%rowtype;
  v_team      uuid;
  v_caller    uuid;
  v_passed    jsonb;
  v_sla_min   int;
  v_due       timestamptz;
  v_last      crm.distribution_events%rowtype;
begin
  select * into v_lead from crm.leads where id = p_lead_id for update;
  if not found then
    raise exception 'lead % not found', p_lead_id;
  end if;

  v_team := coalesce(v_lead.team_id, crm.next_team_for_source(v_lead.source_id));

  if v_team is not null then
    select nc.caller_id, nc.passed_over into v_caller, v_passed
      from crm.next_caller_for_team(v_team) nc;
  end if;

  -- Still nobody? If the last decision on this lead was also "nobody", then
  -- this sweep has learned nothing new. Leave without touching the row or the
  -- history: repeating an unchanged non-decision every 60 seconds is what
  -- buried the lead's timeline in the first place.
  if v_caller is null then
    select * into v_last
      from crm.distribution_events de
     where de.lead_id = p_lead_id
     order by de.decided_at desc
     limit 1;

    if found and v_last.caller_id is null
       and v_last.team_id is not distinct from v_team then
      return null;
    end if;
  end if;

  v_sla_min := case v_lead.priority
                 when 'immediate' then crm.setting_int('sla.immediate_first_touch_minutes', 5)
                 else crm.setting_int('sla.normal_first_touch_minutes', 60)
               end;
  v_due := coalesce(v_lead.first_touch_due_at, crm.add_working_minutes(now(), v_sla_min));

  update crm.leads
     set team_id            = v_team,
         caller_id          = coalesce(v_caller, caller_id),
         first_touch_due_at = v_due,
         -- An assigned lead is immediately in someone's day. Requirement 4.
         next_action_at     = coalesce(next_action_at, v_due),
         next_action_note   = coalesce(next_action_note, 'First contact'),
         status             = case when status = 'new' and v_caller is not null then 'working' else status end
   where id = p_lead_id;

  insert into crm.distribution_events (lead_id, team_id, caller_id, strategy, passed_over)
  values (
    p_lead_id, v_team, v_caller,
    case when v_caller is null then 'deferred_no_caller_available'
         else 'balanced_alternation' end,
    coalesce(v_passed, '[]'::jsonb)
  );

  insert into crm.lead_events (lead_id, event_type, actor_id, payload)
  values (
    p_lead_id,
    case when v_caller is null then 'assignment_deferred' else 'assigned' end,
    null,
    jsonb_build_object('team_id', v_team, 'caller_id', v_caller, 'due_at', v_due)
  );

  return v_caller;
end
$$;

comment on function crm.assign_lead(uuid) is
  'Assigns a lead to a team and caller and stamps its first-touch SLA. Returns
   NULL when no caller was available, in which case the lead is held at team
   level for assignment at shift start. A repeated deferral with the same
   outcome is NOT re-recorded - the sweep runs every minute and would
   otherwise write hundreds of identical rows per lead per day.';

-- ---------------------------------------------------------------------------
-- Clear out what the old behaviour already wrote.
--
-- These are machine-generated duplicates of a single fact - "this lead was
-- held because nobody was on the floor" - not business events. Keeping the
-- first and the last of each run preserves the whole truth (when the hold
-- started, when it was last confirmed) and discards only the repetition.
--
-- This is a migration, not the application: crm_app still has no DELETE
-- privilege on anything, and no lead, call, payment or touchpoint is touched.
-- ---------------------------------------------------------------------------
with ranked as (
  select id, lead_id,
         row_number() over (partition by lead_id order by occurred_at)      as first_rn,
         row_number() over (partition by lead_id order by occurred_at desc) as last_rn
    from crm.lead_events
   where event_type = 'assignment_deferred'
)
delete from crm.lead_events e
 using ranked r
 where e.id = r.id and r.first_rn > 1 and r.last_rn > 1;

with ranked as (
  select id, lead_id,
         row_number() over (partition by lead_id order by decided_at)      as first_rn,
         row_number() over (partition by lead_id order by decided_at desc) as last_rn
    from crm.distribution_events
   where caller_id is null
)
delete from crm.distribution_events d
 using ranked r
 where d.id = r.id and r.first_rn > 1 and r.last_rn > 1;
