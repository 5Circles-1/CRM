-- 0081_a_departed_callers_leads_are_handed_over.sql
-- An admin hands a deactivated caller's whole lead book to one active caller,
-- with every response the client already gave travelling with it.
--
-- WHAT BROKE. Deactivating someone logs them out and stops fresh leads
-- reaching them - and nothing else. Every lead they owned stayed in their
-- name: absence is covered forward, never sideways (0056), and ownership is
-- sacred at every timescale short of the 15-day stale mover (0066). Right for
-- a day off; wrong for someone who has left. Their pipeline went dark, the
-- callbacks clients had booked kept ringing a person who would never log in,
-- and a re-enquiry reopening one of their lost or parked leads (0064, 0078)
-- was announced to them and nobody else. The only way out was Transfer, one
-- lead at a time, refused outright on any lead already moved twice
-- (lead.max_transfers) - so a departed caller's hardest leads could not be
-- moved by anybody.
--
-- THE RULE (owner request, 30 Sep). Admin only, and only once the person is
-- deactivated. The admin names one active caller, and every lead in the
-- leaver's name moves to them, EXCEPT a paying client (won / handed_off):
-- leads.caller_id is who gets credit for a win (0080), and handing it over
-- would quietly move a past sale onto the new joinee. Lost, invalid and
-- nurture leads DO move, because a re-enquiry reopens them with their owner
-- and a reopened lead must land on somebody who is still here.
--
-- WHAT TRAVELS. Nothing is copied, because nothing has to be: every call
-- attempt (disposition, talk time, the caller's notes), every timeline event
-- and every callback hangs off the lead, and RLS shows a lead's children to
-- whoever can see the lead. So the new caller opens the lead and reads the
-- whole conversation, marked "by <leaver>". The follow-up date and its note -
-- what the leaver agreed with the client - are left exactly as they were;
-- resetting them would pile hundreds of leads onto "due now" and throw away
-- dates clients chose. PENDING callbacks are re-pointed at the new caller:
-- the callback alert rings callbacks.assigned_to, so without this the
-- client's booked time would ring nobody.
--
-- WHY NOT crm.transfer_lead IN A LOOP. A transfer is a judgement about one
-- lead - "this caller cannot reach this client" - and spends one of
-- lead.max_transfers (2). A departure is not a judgement about any lead:
-- charging it to the lead would leave the new caller with no transfers left
-- on leads the old one never gave up on, and would refuse outright every lead
-- already moved twice. The hand-over does write a lead_transfers row per lead
-- (reason caller_unavailable), so the lead page says who it came from, when,
-- and who moved it; it just does not count against the cap, nor reset the
-- not-answered streak - the attempt history is the leaver's and stays true.
--
-- An active caller's leads cannot be bulk-moved: that would be a way round
-- the transfer rules for a caller who is still on the floor. Deactivate first.
--
-- Authority-checking, so invoker rights, like transfer_lead. Every refusal
-- carries a SQLSTATE (0073) so the API reads it as a sentence, not a crash.

create or replace function crm.hand_over_leads(
    p_from_user uuid,
    p_to_caller uuid,
    p_actor     uuid default crm.current_user_id(),
    p_note      text default null
  ) returns table (leads_moved int, callbacks_moved int, sales_kept int, to_name text)
  language plpgsql
as $$
declare
  v_actor_role  crm.user_role;
  v_from_name   text;
  v_from_role   crm.user_role;
  v_from_active boolean;
  v_to_role     crm.user_role;
  v_to_active   boolean;
  v_to_name     text;
  v_to_team     uuid := crm.team_of(p_to_caller, current_date);
  v_note        text;
  v_moved       int;
  v_callbacks   int;
  v_kept        int;
begin
  select role into v_actor_role from crm.users where id = p_actor and is_active;
  if v_actor_role is distinct from 'admin' then
    raise exception 'only an admin may hand over a person''s leads (actor role: %)',
      coalesce(v_actor_role::text, 'unknown')
      using errcode = 'insufficient_privilege';
  end if;

  select full_name, role, is_active into v_from_name, v_from_role, v_from_active
    from crm.users where id = p_from_user;
  if not found then
    raise exception 'no such person'
      using errcode = 'no_data_found';
  end if;

  if v_from_role is distinct from 'caller' then
    raise exception '% is a %, not a caller - only a caller''s leads are handed over here',
      v_from_name, v_from_role
      using errcode = 'check_violation';
  end if;

  if v_from_active then
    raise exception '% is still active - deactivate them first; an active caller''s leads move one at a time by Transfer',
      v_from_name
      using errcode = 'check_violation';
  end if;

  select full_name, role, is_active into v_to_name, v_to_role, v_to_active
    from crm.users where id = p_to_caller;
  if v_to_role is distinct from 'caller' or not coalesce(v_to_active, false) then
    raise exception '% cannot receive leads - pick an active caller',
      coalesce(v_to_name, 'that person')
      using errcode = 'check_violation';
  end if;

  v_note := format('Handed over from %s (left)', v_from_name)
            || coalesce(' - ' || nullif(btrim(p_note), ''), '');

  -- Lock the book first so a concurrent transfer cannot slip a lead in or out
  -- between the statements below. Every statement before the final UPDATE
  -- reads the set by its old owner.
  perform 1 from crm.leads
   where caller_id = p_from_user and status not in ('won', 'handed_off')
     for update;

  select count(*)::int into v_kept
    from crm.leads where caller_id = p_from_user and status in ('won', 'handed_off');

  insert into crm.lead_transfers (
    lead_id, from_caller_id, to_caller_id, transferred_by, reason, note,
    na_streak_at_transfer, attempts_at_transfer
  )
  select l.id, p_from_user, p_to_caller, p_actor, 'caller_unavailable', v_note,
         l.na_streak, l.attempt_count
    from crm.leads l
   where l.caller_id = p_from_user and l.status not in ('won', 'handed_off');

  insert into crm.lead_events (lead_id, event_type, actor_id, payload)
  select l.id, 'transferred', p_actor,
         jsonb_build_object('from', p_from_user, 'to', p_to_caller,
                            'reason', 'caller_unavailable', 'note', v_note,
                            'hand_over', true)
    from crm.leads l
   where l.caller_id = p_from_user and l.status not in ('won', 'handed_off');

  update crm.callbacks c
     set assigned_to = p_to_caller,
         updated_at  = now()
    from crm.leads l
   where c.lead_id = l.id
     and c.status = 'pending'
     and l.caller_id = p_from_user and l.status not in ('won', 'handed_off');
  get diagnostics v_callbacks = row_count;

  -- Owner and team only. The follow-up date and note are what the leaver
  -- agreed with the client, the streak and attempts are their true history,
  -- and transfer_count is not spent - see the header.
  update crm.leads
     set caller_id = p_to_caller,
         team_id   = coalesce(v_to_team, team_id)
   where caller_id = p_from_user and status not in ('won', 'handed_off');
  get diagnostics v_moved = row_count;

  return query select v_moved, v_callbacks, v_kept, v_to_name;
end
$$;

comment on function crm.hand_over_leads(uuid, uuid, uuid, text) is
  'Admin-only: moves every lead of a DEACTIVATED caller to one active caller,
   except paying clients (won / handed_off), whose caller_id is the win''s
   credit. Call history stays on each lead, so the new caller reads every past
   response. Pending callbacks follow the lead; follow-up dates are kept; no
   transfer is spent. Writes a lead_transfers row and a timeline event per lead.';

grant execute on function crm.hand_over_leads(uuid, uuid, uuid, text) to crm_app;
