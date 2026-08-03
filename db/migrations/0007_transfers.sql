-- 0007_transfers.sql
-- Requirement 8: a lead that went Not Answered on one caller's SIM can be
-- transferred to another caller - by the counsellor, who is also the team lead.
--
-- DESIGN NOTE - why callers cannot transfer their own leads.
-- If a caller can push a lead off their own list, the difficult leads circulate
-- forever and nobody owns anything. Transfer is a supervisory act. Callers can
-- request one; only a counsellor or admin can execute it.

create table crm.lead_transfers (
  id            uuid primary key default gen_random_uuid(),
  lead_id       uuid not null references crm.leads(id) on delete cascade,
  from_caller_id uuid references crm.users(id) on delete set null,
  to_caller_id  uuid not null references crm.users(id) on delete restrict,
  transferred_by uuid not null references crm.users(id) on delete restrict,
  reason        crm.transfer_reason not null,
  note          text,
  -- Snapshot of why it qualified, for later review of whether transfers help.
  na_streak_at_transfer int not null default 0,
  attempts_at_transfer  int not null default 0,
  created_at    timestamptz not null default now()
);

create index lead_transfers_lead_idx on crm.lead_transfers (lead_id, created_at desc);
create index lead_transfers_to_idx   on crm.lead_transfers (to_caller_id, created_at desc);
create index lead_transfers_by_idx   on crm.lead_transfers (transferred_by, created_at desc);

-- ---------------------------------------------------------------------------
-- Leads a counsellor may reasonably transfer right now.
-- ---------------------------------------------------------------------------

create or replace view crm.v_transfer_candidates as
select
  l.id            as lead_id,
  l.full_name,
  l.phone_e164,
  l.team_id,
  l.caller_id,
  u.full_name     as caller_name,
  l.na_streak,
  l.attempt_count,
  l.transfer_count,
  l.last_contacted_at,
  l.created_at,
  crm.setting_int('lead.max_transfers', 2) - l.transfer_count as transfers_remaining
from crm.leads l
left join crm.users u on u.id = l.caller_id
where l.status in ('new', 'working', 'callback')
  and l.na_streak >= crm.setting_int('lead.not_answered_streak_for_transfer', 4)
  and l.transfer_count < crm.setting_int('lead.max_transfers', 2);

comment on view crm.v_transfer_candidates is
  'Requirement 8. Powers the counsellor "Not Answered - reassign" queue.';

-- ---------------------------------------------------------------------------
-- Execute a transfer. Enforces the authority rule and the transfer cap.
-- ---------------------------------------------------------------------------

create or replace function crm.transfer_lead(
    p_lead_id   uuid,
    p_to_caller uuid,
    p_reason    crm.transfer_reason,
    p_actor     uuid default crm.current_user_id(),
    p_note      text default null
  ) returns void
  language plpgsql
as $$
declare
  v_lead        crm.leads%rowtype;
  v_actor_role  crm.user_role;
  v_to_role     crm.user_role;
  v_to_active   boolean;
  v_max         int := crm.setting_int('lead.max_transfers', 2);
begin
  if p_actor is null then
    raise exception 'transfer_lead requires an acting user'
      using errcode = 'insufficient_privilege';
  end if;

  select role into v_actor_role from crm.users where id = p_actor and is_active;
  if v_actor_role is null or v_actor_role not in ('counsellor', 'admin') then
    raise exception 'only a counsellor or admin may transfer a lead (actor role: %)',
      coalesce(v_actor_role::text, 'unknown')
      using errcode = 'insufficient_privilege';
  end if;

  select * into v_lead from crm.leads where id = p_lead_id for update;
  if not found then
    raise exception 'lead % not found', p_lead_id;
  end if;

  if v_lead.caller_id = p_to_caller then
    raise exception 'lead % is already assigned to that caller', p_lead_id;
  end if;

  select role, is_active into v_to_role, v_to_active from crm.users where id = p_to_caller;
  if v_to_role is distinct from 'caller' or not coalesce(v_to_active, false) then
    raise exception 'transfer target must be an active caller';
  end if;

  if v_lead.transfer_count >= v_max then
    raise exception 'lead % has already been transferred % times; park it in nurture instead',
      p_lead_id, v_lead.transfer_count
      using errcode = 'check_violation';
  end if;

  insert into crm.lead_transfers (
    lead_id, from_caller_id, to_caller_id, transferred_by, reason, note,
    na_streak_at_transfer, attempts_at_transfer
  ) values (
    p_lead_id, v_lead.caller_id, p_to_caller, p_actor, p_reason, p_note,
    v_lead.na_streak, v_lead.attempt_count
  );

  update crm.leads
     set caller_id      = p_to_caller,
         team_id        = coalesce(crm.team_of(p_to_caller, current_date), team_id),
         transfer_count = transfer_count + 1,
         na_streak      = 0,
         -- The new caller gets a fresh, immediate action rather than inheriting
         -- a stale overdue one.
         next_action_at = greatest(now(), now() + interval '15 minutes'),
         next_action_note = 'Transferred in - first attempt',
         status = case when status = 'nurture' then 'working' else status end
   where id = p_lead_id;

  insert into crm.lead_events (lead_id, event_type, actor_id, payload)
  values (p_lead_id, 'transferred', p_actor,
          jsonb_build_object('from', v_lead.caller_id, 'to', p_to_caller,
                             'reason', p_reason, 'note', p_note));
end
$$;

comment on function crm.transfer_lead(uuid, uuid, crm.transfer_reason, uuid, text) is
  'Requirement 8. Counsellor/admin only, capped at lead.max_transfers, fully logged on the lead timeline.';

-- ---------------------------------------------------------------------------
-- Park leads that have exhausted transfers and attempts.
-- ---------------------------------------------------------------------------

create or replace function crm.park_exhausted_leads() returns int
  language plpgsql
as $$
declare v_count int;
begin
  with parked as (
    update crm.leads
       set status = 'nurture',
           next_action_at = null,
           next_action_note = 'Exhausted dial attempts - WhatsApp nurture'
     where status in ('working', 'callback')
       and connect_count = 0
       and attempt_count >= crm.setting_int('lead.max_attempts_before_nurture', 9)
       and transfer_count >= crm.setting_int('lead.max_transfers', 2)
    returning id, caller_id
  )
  insert into crm.lead_events (lead_id, event_type, actor_id, payload)
  select id, 'parked_nurture', caller_id, '{}'::jsonb from parked;

  get diagnostics v_count = row_count;
  return v_count;
end
$$;
