-- 0080_a_paying_client_who_enquires_again_goes_to_a_counsellor.sql
-- The admin's Assign (0079) now covers every "no caller" row the Fresh tab
-- shows, not only never-contacted ones.
--
-- WHAT BROKE. Fresh lists re-enquiries (0064) whatever the lead's status, and a
-- repeat enquiry leaves a WON lead won - only lost and nurture are reopened. So
-- a paying client who filled the form again appeared as "no caller" with an
-- Assign button, and 0079 refused it: "this lead is won and is no longer
-- waiting for a caller". Right to refuse, wrong to offer - and nobody was made
-- responsible for calling that client back.
--
-- WHY NOT A CALLER. A won lead's caller_id is who gets credit for the win: the
-- daily brief's won_today and the win counts read leads.caller_id. Handing
-- the lead to a new caller would quietly move a past sale onto them.
--
-- THE RULE (owner decision, 29 Sep). The lead's stage decides who may take it:
--   new / working / callback           -> an active CALLER (as in 0079)
--   qualified / negotiation            -> an active COUNSELLOR - already past
--                                         the caller
--   won / handed_off (a paying client) -> an active COUNSELLOR, by default the
--                                         one who closed their latest deal.
--                                         Status, closed_at and caller_id stay
--                                         exactly as they are: the win is
--                                         untouched, the counsellor simply
--                                         owns the call-back.
--   lost / invalid / nurture           -> refused. A re-enquiry reopens lost
--                                         and nurture itself, so one showing
--                                         here was closed by a person since.
--
-- Parameter renamed p_to_caller -> p_to_user (the target is not always a
-- caller), which Postgres only allows by dropping the function first.

drop function crm.assign_unowned_lead(uuid, uuid, uuid, text);

create function crm.assign_unowned_lead(
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
   Spends no transfer. Owned leads are refused - they move by transfer_lead.';

grant execute on function crm.assign_unowned_lead(uuid, uuid, uuid, text) to crm_app;

-- Who closed this client's latest deal: the counsellor the Assign picker
-- preselects for a paying client who enquired again. Invoker rights - it
-- reads only what the admin can already see.
create function crm.last_deal_counsellor(p_lead_id uuid) returns uuid
  language sql stable
as $$
  select d.counsellor_id
    from crm.deals d
    join crm.users u on u.id = d.counsellor_id and u.is_active
   where d.lead_id = p_lead_id
   order by d.booked_at desc
   limit 1
$$;

grant execute on function crm.last_deal_counsellor(uuid) to crm_app;
