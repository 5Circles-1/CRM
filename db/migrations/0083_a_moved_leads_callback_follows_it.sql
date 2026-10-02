-- 0083_a_moved_leads_callback_follows_it.sql
-- A lead that changes hands takes its pending callback with it, and whoever
-- may work a lead may update its callback.
--
-- WHAT BROKE (floor report, 2 Oct). A lead with a booked follow-up was
-- transferred to a new caller. The lead moved; its pending callback did not —
-- crm.transfer_lead re-stamps caller_id and team_id and never touches
-- crm.callbacks, so the client's booked time stayed assigned to the old
-- caller. Two failures follow:
--
--   * The callback alert rings callbacks.assigned_to (0052), so the booked
--     time kept interrupting the OLD caller — for a lead RLS no longer lets
--     them open — and never the person now responsible for keeping it.
--
--   * The new caller could not save a call outcome that carried a follow-up
--     date. A save runs two statements against that stale pending row. First
--     the call-attempt trigger tries to complete it — an UPDATE, which RLS
--     silently filters to zero rows, because callbacks_update admitted only
--     the row's assignee, admins and counsellors. The row stays pending. Then
--     the API's INSERT ... ON CONFLICT (one live callback per lead, 0006)
--     collides with it, and on the conflict path Postgres checks the EXISTING
--     row against the update policy's USING expression — which fails loudly:
--     "new row violates row-level security policy (USING expression) for
--     table callbacks". An ordinary save, answered with the words of a server
--     bug, on the lead page and the Power dial screen alike — and the dialler
--     cannot advance past a lead whose outcome will not save.
--
-- THE RULE, in two halves, each enforced where it belongs:
--
--   1. Ownership moves move the pending callback. transfer_lead and
--      assign_unowned_lead now re-point it at the new owner, exactly as
--      hand_over_leads (0081) always did. The scheduled time and the note are
--      the client's and do not change. The engines need no change: the stale
--      mover refuses leads with a future booked callback, and parking cancels
--      callbacks — neither can strand one.
--
--   2. Whoever may work the lead may update its callbacks. callbacks_update
--      also admits anyone who passes the leads_update rule for the row's lead
--      (crm.can_work_lead): the caller who owns it, its counsellor, the
--      team's counsellor, admin, ops. A caller still cannot touch a callback
--      on a lead that is not theirs — can_work_lead for a caller is exactly
--      "caller_id = me" — and viewer visibility is deliberately not enough.
--
-- Rows already stranded by past transfers are repaired at the end, so a floor
-- already bitten does not need every lead transferred again.

-- ---------------------------------------------------------------------------
-- 1. The leads_update rule as a predicate child tables can borrow.
-- ---------------------------------------------------------------------------

create or replace function crm.can_work_lead(p_lead_id uuid) returns boolean
  language sql stable
as $$
  select exists (
    select 1 from crm.leads l
     where l.id = p_lead_id
       and (crm.current_user_role() in ('admin', 'ops')
            or l.caller_id = crm.current_user_id()
            or l.counsellor_id = crm.current_user_id()
            or (crm.current_user_role() = 'counsellor'
                and l.team_id = crm.current_user_team()))
  )
$$;

comment on function crm.can_work_lead(uuid) is
  'The leads_update rule (0012) as a predicate: true when the current user may
   CHANGE this lead - its caller, its counsellor, the team''s counsellor,
   admin or ops. Stricter than crm.can_see_lead, which also admits viewers.';

alter policy callbacks_update on crm.callbacks
  using (
    assigned_to = crm.current_user_id()
    or crm.current_user_role() in ('admin', 'counsellor')
    or crm.can_work_lead(lead_id)
  )
  with check (
    assigned_to = crm.current_user_id()
    or crm.current_user_role() in ('admin', 'counsellor')
    or crm.can_work_lead(lead_id)
  );

-- ---------------------------------------------------------------------------
-- 2. transfer_lead: the pending callback follows the lead.
--    Body unchanged from 0073 except the one re-point UPDATE.
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

  -- The booked time is the client's; who it rings must be whoever now owns
  -- the lead. callbacks.assigned_to is what rings (0052) - hand-overs got
  -- this right from the start (0081), transfers never did.
  update crm.callbacks
     set assigned_to = p_to_caller,
         updated_at  = now()
   where lead_id = p_lead_id
     and status = 'pending';

  insert into crm.lead_events (lead_id, event_type, actor_id, payload)
  values (p_lead_id, 'transferred', p_actor,
          jsonb_build_object('from', v_lead.caller_id, 'to', p_to_caller,
                             'reason', p_reason, 'note', p_note));
end
$$;

comment on function crm.transfer_lead(uuid, uuid, crm.transfer_reason, uuid, text) is
  'Requirement 8. Moves a lead to another caller. Authority (counsellor or admin)
   and the lead.max_transfers cap are enforced here, not in the API. The pending
   callback follows the lead (0083): assigned_to is what rings. Every refusal
   carries an explicit SQLSTATE so api/src/http/errors.ts can turn it into a
   sentence the floor can act on rather than a 500.';

-- ---------------------------------------------------------------------------
-- 3. assign_unowned_lead: same rule. A lead parked long enough to be
--    hand-assigned can still carry a pending callback pointing at whoever
--    once held it; the ring follows the lead.
--    Body unchanged from 0080 except the one re-point UPDATE.
-- ---------------------------------------------------------------------------

create or replace function crm.assign_unowned_lead(
    p_lead_id uuid,
    p_to_user uuid,
    p_actor   uuid default crm.current_user_id(),
    p_note    text default null
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
  v_needs      crm.user_role;
  v_paying     boolean;
begin
  select role into v_actor_role from crm.users where id = p_actor and is_active;
  if v_actor_role is distinct from 'admin' then
    raise exception 'only an admin may assign a lead that has no owner (actor role: %)',
      coalesce(v_actor_role::text, 'unknown')
      using errcode = 'insufficient_privilege';
  end if;

  select * into v_lead from crm.leads where id = p_lead_id for update;
  if not found then
    raise exception 'that lead no longer exists'
      using errcode = 'no_data_found';
  end if;

  -- The same owner v_fresh_leads and v_reenquired_leads show.
  v_owner := case when v_lead.escalation_stage = 'counsellor'
                  then v_lead.counsellor_id else v_lead.caller_id end;
  if v_owner is not null then
    select full_name into v_owner_name from crm.users where id = v_owner;
    raise exception 'this lead is already with %; refresh the list',
      coalesce(v_owner_name, 'someone')
      using errcode = 'check_violation';
  end if;

  v_paying := v_lead.status in ('won', 'handed_off');
  v_needs := case
               when v_lead.status in ('new', 'working', 'callback') then 'caller'
               when v_lead.status in ('qualified', 'negotiation', 'won', 'handed_off') then 'counsellor'
             end::crm.user_role;
  if v_needs is null then
    raise exception 'this lead is % - reopen it before assigning it', v_lead.status
      using errcode = 'check_violation';
  end if;

  select full_name, role, is_active into v_to_name, v_to_role, v_to_active
    from crm.users where id = p_to_user;
  if v_to_role is distinct from v_needs or not coalesce(v_to_active, false) then
    raise exception '% cannot take this lead - %',
      coalesce(v_to_name, 'that person'),
      case when v_paying then 'a paying client who enquired again goes to an active counsellor'
           when v_needs = 'counsellor' then 'a lead at counsellor stage goes to an active counsellor'
           else 'pick an active caller' end
      using errcode = 'check_violation';
  end if;

  if v_needs = 'caller' then
    update crm.leads
       set caller_id        = p_to_user,
           team_id          = coalesce(crm.team_of(p_to_user, current_date), team_id),
           escalation_stage = 'caller',
           -- The original first-touch deadline is kept, so the Fresh tab still
           -- tells the truth about how late the client's first call is.
           next_action_at   = now() + interval '15 minutes',
           next_action_note = 'Assigned by admin - first contact',
           status           = case when status = 'new' then 'working' else status end
     where id = p_lead_id;
  else
    -- Counsellor stage. For a paying client nothing about the sale moves:
    -- status, closed_at and caller_id (the win's credit) stay as they are.
    update crm.leads
       set counsellor_id    = p_to_user,
           escalation_stage = 'counsellor',
           next_action_at   = now() + interval '15 minutes',
           next_action_note = case when v_paying
                                   then 'Paying client enquired again - call them back'
                                   else 'Assigned by admin - call them' end
     where id = p_lead_id;
  end if;

  -- The ring follows the lead (0083), exactly as in transfer_lead and
  -- hand_over_leads.
  update crm.callbacks
     set assigned_to = p_to_user,
         updated_at  = now()
   where lead_id = p_lead_id
     and status = 'pending';

  insert into crm.distribution_events (lead_id, team_id, caller_id, strategy)
  values (p_lead_id, crm.team_of(p_to_user, current_date), p_to_user, 'assigned_by_admin');

  insert into crm.lead_events (lead_id, event_type, actor_id, payload)
  values (p_lead_id, 'assigned', p_actor,
          jsonb_build_object(case when v_needs = 'caller' then 'caller_id' else 'counsellor_id' end,
                             p_to_user,
                             'team_id', crm.team_of(p_to_user, current_date),
                             'by_admin', true, 'paying_client', v_paying, 'note', p_note));
end
$$;

comment on function crm.assign_unowned_lead(uuid, uuid, uuid, text) is
  'Admin-only, by choice: hands a lead with no owner to a named person. The
   stage decides who: new/working/callback to an active caller;
   qualified/negotiation and paying clients (won/handed_off) who enquired again
   to an active counsellor, leaving the sale and its credit untouched.
   Spends no transfer. A pending callback follows the lead (0083). Owned leads
   are refused - they move by transfer_lead.';

-- ---------------------------------------------------------------------------
-- 4. Repair the rows past transfers already stranded: a pending callback on a
--    live lead, assigned to somebody who is neither its caller nor its
--    counsellor, is re-pointed at whoever owns the next action - the
--    counsellor where the lead sits at counsellor stage, the caller
--    otherwise. Closed leads are left alone: parking and archiving already
--    cancel their callbacks, and a lost lead's stray row is not ringing
--    anybody into a mistake worth a bulk edit here.
-- ---------------------------------------------------------------------------

update crm.callbacks c
   set assigned_to = case when l.escalation_stage = 'counsellor'
                               and l.counsellor_id is not null
                          then l.counsellor_id
                          else coalesce(l.caller_id, l.counsellor_id) end,
       updated_at  = now()
  from crm.leads l
 where c.lead_id = l.id
   and c.status = 'pending'
   and l.status not in ('lost', 'invalid')
   and c.assigned_to is distinct from l.caller_id
   and c.assigned_to is distinct from l.counsellor_id
   and coalesce(l.caller_id, l.counsellor_id) is not null;
