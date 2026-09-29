-- 0079_admin_assigns_an_unowned_lead.sql
-- A fresh lead with no caller can be handed to a named caller by an admin.
--
-- WHY. Fresh leads marked "no caller" are held at team level: the fairness
-- engine found nobody on the floor for that team, no counsellor was there to
-- cover (0056), so the lead parked, visibly, and waits for the next sweep to
-- find somebody. That is the right default - absence is covered forward, never
-- sideways - but it can wait a long time, and the admin looking at the Fresh
-- tab had no button for it. The owner's rule (29 Sep): the admin may pick a
-- caller for it, ONLY when the admin chooses to. Nothing automatic changes:
-- the engine, the sweeps and the escalation ladder behave exactly as before.
--
-- WHY NOT crm.transfer_lead. A transfer moves a lead between two owners and
-- spends one of lead.max_transfers (2). A lead nobody has ever owned is being
-- assigned, not transferred: burning a transfer on it would leave its first
-- real owner with one hand-off instead of two, and it would put a row in
-- lead_transfers - the table that measures whether transfers help - for a
-- lead that never went unanswered for anybody.
--
-- Authority-checking, so invoker rights, like transfer_lead. Every refusal
-- carries a SQLSTATE (0073) so the API reads it as a sentence, not a crash.

create or replace function crm.assign_unowned_lead(
    p_lead_id   uuid,
    p_to_caller uuid,
    p_actor     uuid default crm.current_user_id(),
    p_note      text default null
  ) returns void
  language plpgsql
as $$
declare
  v_lead       crm.leads%rowtype;
  v_actor_role crm.user_role;
  v_owner      uuid;
  v_owner_name text;
  v_to_role    crm.user_role;
  v_to_active  boolean;
  v_to_name    text;
begin
  select role into v_actor_role from crm.users where id = p_actor and is_active;
  if v_actor_role is distinct from 'admin' then
    raise exception 'only an admin may assign a lead that has no caller (actor role: %)',
      coalesce(v_actor_role::text, 'unknown')
      using errcode = 'insufficient_privilege';
  end if;

  select * into v_lead from crm.leads where id = p_lead_id for update;
  if not found then
    raise exception 'that lead no longer exists'
      using errcode = 'no_data_found';
  end if;

  -- The same owner v_fresh_leads shows: the counsellor while the lead sits at
  -- counsellor stage, the caller otherwise.
  v_owner := case when v_lead.escalation_stage = 'counsellor'
                  then v_lead.counsellor_id else v_lead.caller_id end;
  if v_owner is not null then
    -- Usually the sweep got there first: the list on screen is older than the
    -- database. An owned lead moves by Transfer, under its own rules.
    select full_name into v_owner_name from crm.users where id = v_owner;
    raise exception 'this lead is already with %; refresh the list',
      coalesce(v_owner_name, 'someone')
      using errcode = 'check_violation';
  end if;

  if v_lead.status not in ('new', 'working') then
    raise exception 'this lead is % and is no longer waiting for a caller', v_lead.status
      using errcode = 'check_violation';
  end if;

  select full_name, role, is_active into v_to_name, v_to_role, v_to_active
    from crm.users where id = p_to_caller;
  if v_to_role is distinct from 'caller' or not coalesce(v_to_active, false) then
    raise exception '% cannot receive leads - pick an active caller',
      coalesce(v_to_name, 'that person')
      using errcode = 'check_violation';
  end if;

  update crm.leads
     set caller_id        = p_to_caller,
         team_id          = coalesce(crm.team_of(p_to_caller, current_date), team_id),
         escalation_stage = 'caller',
         -- It has waited long enough: first call within 15 minutes of landing.
         -- The original first-touch deadline is kept, so the Fresh tab still
         -- tells the truth about how late the client's first call is.
         next_action_at   = now() + interval '15 minutes',
         next_action_note = 'Assigned by admin - first contact',
         status           = 'working'
   where id = p_lead_id;

  -- Counted with the engine's decisions so the floor's "last lead at" and the
  -- per-caller intake stay whole - but under its own strategy name, so a
  -- manual pick is never mistaken for the fairness engine's.
  insert into crm.distribution_events (lead_id, team_id, caller_id, strategy)
  values (p_lead_id, crm.team_of(p_to_caller, current_date), p_to_caller, 'assigned_by_admin');

  insert into crm.lead_events (lead_id, event_type, actor_id, payload)
  values (p_lead_id, 'assigned', p_actor,
          jsonb_build_object('caller_id', p_to_caller, 'team_id', crm.team_of(p_to_caller, current_date),
                             'by_admin', true, 'note', p_note));
end
$$;

comment on function crm.assign_unowned_lead(uuid, uuid, uuid, text) is
  'Admin-only, by choice: hands a waiting lead that has no owner to a named
   active caller. Does not spend a transfer (the lead never had an owner), keeps
   the original first-touch deadline, and records an "assigned_by_admin"
   distribution event. Owned leads are refused - they move by transfer_lead.';

grant execute on function crm.assign_unowned_lead(uuid, uuid, uuid, text) to crm_app;
