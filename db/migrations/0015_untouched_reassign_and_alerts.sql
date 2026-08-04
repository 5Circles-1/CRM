-- 0015_untouched_reassign_and_alerts.sql
--
-- Two things the floor asked for after the first day of real use.
--
-- 1. A lead nobody touches within ten minutes moves to another caller.
--
--    The existing transfer rule is supervisory and deliberate: only a
--    counsellor may move a lead, because a caller who can push work off their
--    own list will push the difficult ones. That rule is about ACTIVE leads and
--    it stays exactly as it was.
--
--    This is a different case - a lead that has not been touched at all. Nobody
--    is choosing to keep it, so nothing is being pushed away. Leaving it sitting
--    on someone who is not working it is the pipeline leak the whole schema
--    exists to prevent, and the counsellor is not watching a stopwatch.
--
-- 2. Alerts a caller can see without hunting: breached SLAs, callbacks now due,
--    overdue next actions, and leads that arrived from or left via an automatic
--    reassignment.

-- ---------------------------------------------------------------------------
-- When was this lead put on its current caller?
--
-- Nothing recorded it. created_at is when the lead arrived, which is not the
-- same thing once a lead has moved, and using it would restart the ten minutes
-- from the wrong moment - or never start it at all.
-- ---------------------------------------------------------------------------

alter table crm.leads add column if not exists assigned_at timestamptz;

update crm.leads set assigned_at = created_at
 where assigned_at is null and caller_id is not null;

create index if not exists leads_untouched_idx
  on crm.leads (assigned_at)
  where caller_id is not null and first_touched_at is null;

-- A trigger rather than a line inside crm.assign_lead: a lead's caller changes
-- through assignment, supervisory transfer and automatic reassignment, and a
-- clock that is only correct on one of those paths is worse than no clock.
create or replace function crm.tg_lead_assigned_at() returns trigger
  language plpgsql
as $$
begin
  if tg_op = 'INSERT' then
    -- Only fill it in. Overwriting a value the caller supplied would make the
    -- column impossible to set deliberately - which a backfill, an import of
    -- historical data, or a test of the ten-minute rule all need to do.
    if new.caller_id is not null and new.assigned_at is null then
      new.assigned_at := now();
    end if;
  elsif new.caller_id is distinct from old.caller_id then
    new.assigned_at := case when new.caller_id is null then null else now() end;
  end if;
  return new;
end
$$;

drop trigger if exists lead_assigned_at on crm.leads;
create trigger lead_assigned_at
  before insert or update of caller_id on crm.leads
  for each row execute function crm.tg_lead_assigned_at();

comment on column crm.leads.assigned_at is
  'When the lead landed on its current caller. Resets on every reassignment, so
   the untouched clock measures this caller''s inaction and not the last one''s.';

-- ---------------------------------------------------------------------------
-- An automatic transfer has no human behind it.
-- ---------------------------------------------------------------------------

alter table crm.lead_transfers alter column transferred_by drop not null;
alter table crm.lead_transfers
  add column if not exists is_automatic boolean not null default false;

-- Recording who did it stays mandatory for a human transfer. Blaming the
-- scheduler on a supervisory decision would corrupt the record of who moved
-- what, which is the question asked the day after a payout dispute.
alter table crm.lead_transfers drop constraint if exists lead_transfers_actor_present;
alter table crm.lead_transfers add constraint lead_transfers_actor_present
  check (is_automatic or transferred_by is not null);

comment on column crm.lead_transfers.is_automatic is
  'True when the untouched-lead sweeper moved it, not a counsellor.';

insert into crm.settings (key, value, description) values
  ('sla.untouched_reassign_minutes', '10'::jsonb,
   'Minutes a newly assigned lead may sit untouched before it moves to another caller. 0 disables it.'),
  ('sla.untouched_reassign_max', '2'::jsonb,
   'How many times one lead may be moved automatically before it is left alone for a counsellor to look at.')
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- The sweeper.
-- ---------------------------------------------------------------------------

create or replace function crm.reassign_untouched_leads(p_limit int default 200)
  returns int
  language plpgsql
  -- SECURITY DEFINER for the same reason as every other scheduled engine in
  -- 0014: run as the ops account this reads through RLS and sees almost
  -- nothing, so it would silently sweep a fraction of the floor.
  security definer
  set search_path = crm, public
as $$
declare
  v_minutes  int := crm.setting_int('sla.untouched_reassign_minutes', 10);
  v_max      int := crm.setting_int('sla.untouched_reassign_max', 2);
  v_lead     record;
  v_target   uuid;
  v_moved    int := 0;
begin
  if v_minutes <= 0 then
    return 0;
  end if;

  for v_lead in
    select l.id, l.team_id, l.caller_id, l.na_streak, l.attempt_count
      from crm.leads l
     where l.caller_id is not null
       and l.first_touched_at is null      -- never tapped
       and l.attempt_count = 0             -- and not even a failed dial
       and l.status in ('new', 'working')
       and l.assigned_at < now() - make_interval(mins => v_minutes)
       and l.transfer_count < v_max
     order by l.assigned_at
     limit p_limit
    for update skip locked
  loop
    -- Next caller on the same team who is actually on the floor, least loaded
    -- first. Excluding the current holder is the whole point; handing it back
    -- to them would be a no-op that still burned a transfer.
    select ec.user_id into v_target
      from crm.eligible_callers(v_lead.team_id) ec
     where ec.on_shift
       and ec.user_id <> v_lead.caller_id
     order by ec.load_today asc, ec.rotation_order asc
     limit 1;

    -- Nobody else on the floor: leave it where it is. Moving it to someone who
    -- is not working either would look like progress and achieve nothing.
    continue when v_target is null;

    insert into crm.lead_transfers
      (lead_id, from_caller_id, to_caller_id, transferred_by, reason, note,
       is_automatic, na_streak_at_transfer, attempts_at_transfer)
    values
      (v_lead.id, v_lead.caller_id, v_target, null, 'caller_unavailable',
       format('untouched for %s minutes', v_minutes),
       true, v_lead.na_streak, v_lead.attempt_count);

    update crm.leads
       set caller_id      = v_target,
           transfer_count = transfer_count + 1,
           -- Give the new caller a fresh, immediate window rather than handing
           -- over an already-breached deadline they had no chance to meet.
           first_touch_due_at = now() + make_interval(mins => v_minutes),
           next_action_at = least(coalesce(next_action_at, now()), now()),
           next_action_note = 'Reassigned - first contact still owed',
           updated_at = now()
     where id = v_lead.id;

    insert into crm.lead_events (lead_id, event_type, payload)
    values (v_lead.id, 'transferred',
            jsonb_build_object('automatic', true, 'from', v_lead.caller_id,
                               'to', v_target, 'after_minutes', v_minutes));

    v_moved := v_moved + 1;
  end loop;

  return v_moved;
end
$$;

comment on function crm.reassign_untouched_leads(int) is
  'Moves never-touched leads off a caller who has not started them. Bounded by
   sla.untouched_reassign_max so a lead nobody wants stops circulating and
   becomes a counsellor problem instead of a hot potato.';

revoke all on function crm.reassign_untouched_leads(int) from public;
grant execute on function crm.reassign_untouched_leads(int) to crm_app;

-- ---------------------------------------------------------------------------
-- Alerts: what needs this person's attention, right now, in one list.
-- ---------------------------------------------------------------------------

create or replace view crm.v_my_alerts as
-- First contact owed and past its deadline.
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

-- A callback the client asked for, now due.
select
  'callback_due', 'critical', c.lead_id, c.assigned_to, l.full_name, l.phone_e164,
  c.scheduled_at, 'Callback due', c.id
  from crm.callbacks c
  join crm.leads l on l.id = c.lead_id
 where c.status = 'pending'
   and c.scheduled_at <= now()

union all

-- A callback coming up shortly, so it can be prepared for rather than missed.
select
  'callback_soon', 'warning', c.lead_id, c.assigned_to, l.full_name, l.phone_e164,
  c.scheduled_at, 'Callback due shortly', c.id
  from crm.callbacks c
  join crm.leads l on l.id = c.lead_id
 where c.status = 'pending'
   and c.scheduled_at > now()
   and c.scheduled_at <= now() + interval '15 minutes'

union all

-- Any other promised action that has come and gone.
select
  'action_overdue', 'warning', l.id, l.caller_id, l.full_name, l.phone_e164,
  l.next_action_at, coalesce(l.next_action_note, 'Follow-up due'), null
  from crm.leads l
 where l.next_action_at is not null
   and l.next_action_at < now()
   and l.status in ('new', 'working', 'callback')
   and l.first_touched_at is not null

union all

-- A lead that has just arrived from someone else, so it is not a surprise.
select
  'reassigned_in', 'info', t.lead_id, t.to_caller_id, l.full_name, l.phone_e164,
  t.created_at, 'Reassigned to you - first contact still owed', null
  from crm.lead_transfers t
  join crm.leads l on l.id = t.lead_id
 where t.is_automatic
   and t.created_at > now() - interval '2 hours'
   and l.first_touched_at is null;

alter view crm.v_my_alerts set (security_invoker = true);

comment on view crm.v_my_alerts is
  'Everything demanding attention, per user. RLS on the underlying tables does
   the filtering, so a caller sees only their own and a counsellor sees the
   team - no WHERE clause in the API decides who sees what.';

grant select on crm.v_my_alerts to crm_app;
