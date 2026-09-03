-- 0066_stale_leads_move_and_orphans_get_a_counsellor.sql
--
-- Three owner decisions from the same conversation (3 Sep), all about leads
-- that are visible but that nobody is actually going to dial:
--
--   1. "Assign the leads to someone else if they have gone untapped for more
--      than 15 days." The re-tap pool showed leads silent for 26-30 days,
--      still parked with the caller who could not reach them. 0049's rule -
--      leads do not move on their own - was made when the sweeper moved
--      leads after TEN MINUTES and made ownership meaningless. Fifteen DAYS
--      of silence is a different fact: the owner has had every chance, and
--      by now the number may simply be spam-flagged for that caller's SIM -
--      a different caller's number may ring where theirs no longer does.
--
--   2. "Why is there no caller here? Show these leads to counsellors."
--      A re-enquiry that reopens a parked lead (nurture, previous months)
--      reopened it UNOWNED: status working, no caller, no counsellor -
--      priority immediate, sitting on the whole-floor list belonging to
--      nobody. Those now land with the team's counsellor, and the ones
--      already sitting unowned are adopted by the backfill below.
--
--   3. The dashboard needs the exact floor-wide waiting count - served by
--      v_reenquired_summary next to the existing v_fresh_summary.

insert into crm.settings (key, value, description) values
  ('sla.stale_reassign_days', '15'::jsonb,
   'Days an open, overdue lead may go without a single dial before it moves to another caller on the team. 0 disables the mover.'),
  ('sla.stale_reassign_max', '2'::jsonb,
   'How many automatic moves one lead may accumulate before it is left alone for a counsellor to decide.')
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- 1. The stale mover.
--
-- Deliberately narrower than "old lead": it moves only a lead that is open,
-- overdue, held by a caller, and has not heard a single dial in
-- sla.stale_reassign_days. A lead with a future appointment (a callback the
-- client chose, a scheduled follow-up) is quiet ON PURPOSE and never moves.
-- The receiver is a different caller on the same team, on the floor,
-- preferring one who has never tried this number - a fresh voice and a fresh
-- caller ID, which is the point when spam-flagging is the suspected cause.
-- ---------------------------------------------------------------------------

create or replace function crm.reassign_stale_leads(p_limit int default 200)
  returns int
  language plpgsql
  -- SECURITY DEFINER like every scheduled engine (0014): as the ops invoker
  -- RLS would hide most of the floor and the sweep would silently under-run.
  security definer
  set search_path = crm, public
as $$
declare
  v_days   int := crm.setting_int('sla.stale_reassign_days', 0);
  v_max    int := crm.setting_int('sla.stale_reassign_max', 2);
  v_lead   record;
  v_target uuid;
  v_moved  int := 0;
begin
  if v_days <= 0 then
    return 0;
  end if;

  for v_lead in
    select l.id, l.team_id, l.caller_id, l.full_name, l.phone_e164,
           l.na_streak, l.attempt_count, l.first_touched_at
      from crm.leads l
     where l.caller_id is not null
       and l.escalation_stage is distinct from 'counsellor'
       and l.status in ('new', 'working', 'callback')
       and coalesce(l.pool, '') <> 'previous_month'
       -- Overdue: the promised action has come and gone unactioned.
       and l.next_action_at is not null
       and l.next_action_at < now()
       -- And not one dial in the window, from anyone.
       and coalesce(
             (select max(ca.started_at) from crm.call_attempts ca where ca.lead_id = l.id),
             l.assigned_at, l.created_at
           ) < now() - make_interval(days => v_days)
       -- A future callback the client booked means the silence is a plan.
       and not exists (
             select 1 from crm.callbacks cb
              where cb.lead_id = l.id and cb.status = 'pending'
                and cb.scheduled_at > now())
       and l.transfer_count < v_max
     order by l.next_action_at
     limit p_limit
     for update skip locked
  loop
    -- Another caller on the same team, on the floor now, preferring one who
    -- has never dialled this lead ("someone else who did not tap it"), then
    -- least loaded. The current holder is excluded - that is the point.
    select ec.user_id into v_target
      from crm.eligible_callers(v_lead.team_id) ec
     where ec.on_shift
       and ec.user_id <> v_lead.caller_id
     order by (not exists (select 1 from crm.call_attempts ca
                            where ca.lead_id = v_lead.id
                              and ca.user_id = ec.user_id)) desc,
              ec.load_today asc, ec.rotation_order asc
     limit 1;

    -- Nobody else on the floor: moving it to an empty chair helps no one.
    continue when v_target is null;

    insert into crm.lead_transfers
      (lead_id, from_caller_id, to_caller_id, transferred_by, reason, note,
       is_automatic, na_streak_at_transfer, attempts_at_transfer)
    values
      (v_lead.id, v_lead.caller_id, v_target, null, 'other',
       format('no dial in %s days - moved so a fresh number taps it', v_days),
       true, v_lead.na_streak, v_lead.attempt_count);

    update crm.leads
       set caller_id      = v_target,
           transfer_count = transfer_count + 1,
           next_action_at = now(),
           next_action_note = format('Re-tap: quiet for %s+ days', v_days),
           first_touch_due_at = case when first_touched_at is null
                                     then now() + make_interval(mins =>
                                       crm.setting_int('sla.normal_first_touch_minutes', 60))
                                     else first_touch_due_at end,
           updated_at = now()
     where id = v_lead.id;

    insert into crm.lead_events (lead_id, event_type, payload)
    values (v_lead.id, 'transferred',
            jsonb_build_object('automatic', true, 'reason', 'stale',
                               'from', v_lead.caller_id, 'to', v_target,
                               'after_days', v_days));

    insert into crm.notifications (user_id, kind, title, body, lead_id)
    values (v_target, 'lead_reassigned',
            coalesce(v_lead.full_name, v_lead.phone_e164) || ' moved to you',
            'Nobody has dialled this lead in ' || v_days || '+ days - it may be '
            || 'spam-flagged for the previous number. Your call may ring where theirs did not.',
            v_lead.id);

    v_moved := v_moved + 1;
  end loop;

  return v_moved;
end
$$;

comment on function crm.reassign_stale_leads(int) is
  'Owner decision (3 Sep): an open, overdue lead with no dial at all in
   sla.stale_reassign_days moves to a different on-floor caller on its team,
   preferring one who never tried it. Leads with a future booked callback,
   counsellor-stage leads, and previous-month history never move. Bounded by
   sla.stale_reassign_max so a dead number stops circulating.';

revoke all on function crm.reassign_stale_leads(int) from public;
grant execute on function crm.reassign_stale_leads(int) to crm_app;

-- ---------------------------------------------------------------------------
-- 2. Orphan re-enquiries get a counsellor.
--
-- The re-enquiry attach reopens a parked lead to live work but never gave it
-- an owner when it had none. Owner decision: those go to the counsellor -
-- the team lead decides who chases a revived old contact. The team's
-- on-floor counsellor is preferred (0056's spirit); if the team's counsellor
-- is off the floor the lead is still assigned to them - this is a revived
-- lead joining a queue for the morning, not fresh work being routed around
-- an empty chair - and a lead with no team at all goes to the least-loaded
-- active counsellor.
-- ---------------------------------------------------------------------------

create or replace function crm.adopt_orphan_reenquiries(p_limit int default 200)
  returns int
  language plpgsql
  security definer
  set search_path = crm, public
as $$
declare
  v_lead    record;
  v_target  uuid;
  v_adopted int := 0;
begin
  for v_lead in
    select l.id, l.team_id, l.full_name, l.phone_e164
      from crm.leads l
     where l.caller_id is null
       and l.counsellor_id is null
       and l.pool is null
       and l.status in ('new', 'working', 'callback', 'qualified', 'negotiation')
       and exists (select 1 from crm.lead_events e
                    where e.lead_id = l.id and e.event_type = 're_enquiry')
     order by l.next_action_at nulls first
     limit p_limit
     for update skip locked
  loop
    v_target := crm.team_counsellor_on_floor(v_lead.team_id);

    if v_target is null then
      select u.id into v_target
        from crm.users u
        left join crm.team_memberships tm
          on tm.user_id = u.id and now()::date <@ tm.period
       where u.role = 'counsellor' and u.is_active
       order by (tm.team_id = v_lead.team_id) desc nulls last,
                (select count(*) from crm.leads x
                  where x.counsellor_id = u.id
                    and x.status not in ('won','lost','invalid','handed_off')) asc,
                u.id
       limit 1;
    end if;

    continue when v_target is null;

    update crm.leads
       set counsellor_id    = v_target,
           escalation_stage = 'counsellor',
           updated_at       = now()
     where id = v_lead.id;

    insert into crm.lead_events (lead_id, event_type, payload)
    values (v_lead.id, 'escalated',
            jsonb_build_object('automatic', true, 'reason', 're_enquiry_unowned',
                               'to', v_target));

    insert into crm.notifications (user_id, kind, title, body, lead_id)
    values (v_target, 're_enquiry',
            coalesce(v_lead.full_name, v_lead.phone_e164) || ' enquired again - no caller held them',
            'This person asked again and their lead had no owner (it was parked when they re-enquired). It is on your list now.',
            v_lead.id);

    v_adopted := v_adopted + 1;
  end loop;

  return v_adopted;
end
$$;

comment on function crm.adopt_orphan_reenquiries(int) is
  'Owner decision (3 Sep): a re-enquiry that reopened a parked lead with no
   caller and no counsellor is assigned to the team''s counsellor, on-floor
   preferred. Runs after every ingest and on the scheduler; idempotent.';

revoke all on function crm.adopt_orphan_reenquiries(int) from public;
grant execute on function crm.adopt_orphan_reenquiries(int) to crm_app;

-- ---------------------------------------------------------------------------
-- 3. Floor-wide re-enquiry counts for the dashboard tile.
--
-- Definer rights like v_fresh_summary and for the same reason: the number on
-- the dashboard must be the floor's number, not the slice the viewer's RLS
-- happens to see.
-- ---------------------------------------------------------------------------

create or replace view crm.v_reenquired_summary as
select
  count(*)::int                                        as reenquired,
  count(*) filter (where user_id is null)::int         as unowned,
  count(*) filter (where flag <> 'waiting')::int       as late
from crm.v_reenquired_leads;

grant select on crm.v_reenquired_summary to crm_app;

comment on view crm.v_reenquired_summary is
  'Floor-wide counts over v_reenquired_leads for the dashboard and Fresh tab
   totals. Deliberately definer-rights (mirrors v_fresh_summary).';

-- ---------------------------------------------------------------------------
-- Backfill: adopt the orphans already sitting on the floor list ("why is
-- there no caller here?" - because they were reopened before this rule).
-- ---------------------------------------------------------------------------

select crm.adopt_orphan_reenquiries(1000);
