-- 0073_a_refused_transfer_says_why.sql
--
-- "something went wrong" is what the floor saw when a transfer was refused.
--
-- crm.transfer_lead makes six checks. Three of them raise with an explicit
-- SQLSTATE and arrive at the browser as a sentence somebody can act on:
--
--   no acting user            -> insufficient_privilege -> 403
--   actor is not a supervisor -> insufficient_privilege -> 403
--   transfer cap reached      -> check_violation        -> 409
--
-- The other three raised bare. A bare `raise exception` is P0001, which is in
-- no map in api/src/http/errors.ts, so it fell through to the catch-all 500
-- and the UI printed "something went wrong" - for a lead already sitting with
-- that caller, for a target who is not an active caller, and for a lead id
-- that does not resolve. Three different, entirely ordinary refusals, all
-- wearing the mask of a server crash, and no way for the person clicking
-- Transfer to tell which had happened or what to do about it.
--
-- The rules are unchanged. Only their SQLSTATE and their wording change, so
-- the mapping the API already performs can do its job. Named callers rather
-- than uuids in the text, because the message is read on the floor.

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
  v_to_name     text;
  v_from_name   text;
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
    -- Absent, or fenced off by RLS - indistinguishable on purpose, and 404 is
    -- the honest answer to both.
    raise exception 'that lead no longer exists, or is not yours to move'
      using errcode = 'no_data_found';
  end if;

  select full_name, role, is_active into v_to_name, v_to_role, v_to_active
    from crm.users where id = p_to_caller;

  if v_lead.caller_id = p_to_caller then
    -- Reached when the list on screen is older than the database - somebody
    -- else moved this lead first. Naming the caller says so without jargon.
    raise exception 'this lead is already with %; refresh the list',
      coalesce(v_to_name, 'that caller')
      using errcode = 'check_violation';
  end if;

  if v_to_role is distinct from 'caller' or not coalesce(v_to_active, false) then
    raise exception '% cannot receive leads - a transfer target must be an active caller',
      coalesce(v_to_name, 'that person')
      using errcode = 'check_violation';
  end if;

  if v_lead.transfer_count >= v_max then
    select full_name into v_from_name from crm.users where id = v_lead.caller_id;
    raise exception 'this lead has already been transferred % times (the cap is %); it stays with % or goes to nurture',
      v_lead.transfer_count, v_max, coalesce(v_from_name, 'its caller')
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
     set caller_id        = p_to_caller,
         team_id          = coalesce(crm.team_of(p_to_caller, current_date), team_id),
         -- Handed to a specific caller: it belongs on the caller ladder again.
         escalation_stage = 'caller',
         transfer_count   = transfer_count + 1,
         na_streak        = 0,
         next_action_at   = greatest(now(), now() + interval '15 minutes'),
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
  'Requirement 8. Moves a lead to another caller. Authority (counsellor or admin)
   and the lead.max_transfers cap are enforced here, not in the API. Every
   refusal carries an explicit SQLSTATE so api/src/http/errors.ts can turn it
   into a sentence the floor can act on rather than a 500.';
