-- 0039_manual_leads_and_payment_punch_in.sql
--
-- Two ways real work arrives that the CRM had no door for:
--
--   1. A lead that never came through the sheet - somebody rang the office,
--      walked past, was referred by a client. Until now only admin/ops could
--      insert a lead, and only over the API with no screen for it.
--
--   2. Money that needs punching in directly. Recording a payment required
--      finding the deal's row on Collections and picking an instalment. A
--      counsellor holding a UPI screenshot wants to type a name, an amount
--      and a mode, and be done - the CRM should do the instalment arithmetic.

-- ---------------------------------------------------------------------------
-- Manual leads.
-- ---------------------------------------------------------------------------

-- A real source, so reporting can always answer "where did this lead come
-- from" the same way it does for the sheet and the website.
insert into crm.lead_sources (id, name, default_priority)
values ('33333333-0000-0000-0000-000000000003', 'Manual entry', 'normal')
on conflict (id) do nothing;

-- Counsellors may now create leads too: a walk-in enquiry lands with the team
-- lead, and sending them to an admin to type a name in is how the name ends
-- up on a sticky note instead. What does NOT change: callers still cannot
-- create leads (a tested guarantee - self-created leads would corrupt
-- distribution fairness and scoring).
drop policy leads_insert on crm.leads;
create policy leads_insert on crm.leads
  for insert with check (crm.current_user_role() in ('admin', 'ops', 'counsellor'));

/**
 * Add one lead by hand.
 *
 * SECURITY DEFINER with an explicit role gate, not invoker rights - tried the
 * other way first. The fair-distribution path calls crm.assign_lead, which
 * may hand the lead to the OTHER team and must then update the lead and write
 * distribution records the creating counsellor's own RLS rightly cannot
 * touch. The engine needs engine authority; who may pull the lever is checked
 * here, first thing, and a caller is refused with the same error the RLS
 * policy would give.
 *
 * Duplicate handling is a refusal with directions, not a silent merge: the
 * person typing the name needs to know the lead exists and who has it, and
 * the existing lead must not be touched by someone re-entering it.
 */
create or replace function crm.add_manual_lead(
  p_full_name text,
  p_phone     text,
  p_city      text default null,
  p_priority  crm.lead_priority default 'normal',
  p_assign_to uuid default null,   -- a specific caller; null = fair distribution
  p_note      text default null
) returns uuid
  language plpgsql
  security definer
  set search_path = crm, public
as $$
declare
  v_phone text;
  v_dupe  record;
  v_lead  uuid;
  v_team  uuid;
begin
  if crm.current_user_role() not in ('admin', 'ops', 'counsellor') then
    raise exception 'only an admin, ops or counsellor may add a lead by hand'
      using errcode = 'insufficient_privilege';
  end if;

  v_phone := crm.normalise_phone(p_phone);
  if v_phone is null then
    raise exception 'that phone number is not dialable' using errcode = 'check_violation';
  end if;

  select l.id, l.status, u.full_name as owner
    into v_dupe
    from crm.leads l
    left join crm.users u on u.id = coalesce(l.caller_id, l.counsellor_id)
   where l.phone_e164 = v_phone
   order by l.created_at desc
   limit 1;

  if found then
    raise exception 'this number is already in the book (status: %, with %) - open it from Find lead instead of re-entering it',
      v_dupe.status, coalesce(v_dupe.owner, 'no owner yet')
      using errcode = 'unique_violation';
  end if;

  if p_assign_to is not null then
    select tm.team_id into v_team
      from crm.team_memberships tm
      join crm.users u on u.id = tm.user_id
     where tm.user_id = p_assign_to and tm.period @> current_date
       and u.role = 'caller' and u.is_active
     limit 1;
    if v_team is null then
      raise exception 'leads can only be assigned to an active caller on a team'
        using errcode = 'check_violation';
    end if;
  end if;

  -- The defaults trigger stamps first-touch SLA and the mandatory next action;
  -- an immediate manual lead gets the same clock as an immediate sheet lead.
  insert into crm.leads (source_id, full_name, phone_e164, city, priority,
                         team_id, caller_id, status,
                         next_action_note)
  values ('33333333-0000-0000-0000-000000000003',
          nullif(trim(p_full_name), ''), v_phone, nullif(trim(p_city), ''),
          p_priority, v_team, p_assign_to,
          (case when p_assign_to is null then 'new' else 'working' end)::crm.lead_status,
          coalesce(p_note, 'First contact'))
  returning id into v_lead;

  insert into crm.lead_events (lead_id, event_type, actor_id, payload)
  values (v_lead, 'manual_lead_added', crm.current_user_id(),
          jsonb_build_object('assigned_to', p_assign_to, 'priority', p_priority,
                             'note', p_note));

  -- No specific caller named: hand it to the same engine every sheet lead
  -- goes through, so manual leads cannot be used to jump the fairness queue.
  if p_assign_to is null then
    perform crm.assign_lead(v_lead);
  end if;

  return v_lead;
end
$$;

revoke execute on function crm.add_manual_lead(text, text, text, crm.lead_priority, uuid, text) from public;
grant execute on function crm.add_manual_lead(text, text, text, crm.lead_priority, uuid, text) to crm_app;

comment on function crm.add_manual_lead is
  'One lead entered by hand: walk-past, phone-in, referral. Definer rights
   because fair distribution may assign across teams; the role gate at the top
   is the authority check, and callers are refused. Duplicates are refused
   with the existing lead''s status and owner named.';

-- ---------------------------------------------------------------------------
-- The payment punch-in.
--
-- One amount, applied the way a person with a calculator would: oldest open
-- instalment first, then the next, remainder recorded against the deal
-- unallocated. Each slice is its own payment row sharing the reference, so
-- the instalment arithmetic in the rollup trigger stays exact and auditable.
-- ---------------------------------------------------------------------------
create or replace function crm.punch_in_payment(
  p_deal_id   uuid,
  p_amount    numeric,
  p_mode      text,
  p_reference text default null,
  p_paid_at   timestamptz default now()
) returns int
  language plpgsql
as $$
declare
  v_deal        record;
  v_outstanding numeric;
  v_left        numeric := round(p_amount, 2);
  v_inst        record;
  v_slice       numeric;
  v_rows        int := 0;
begin
  if v_left is null or v_left <= 0 then
    raise exception 'the amount must be a positive number of rupees'
      using errcode = 'check_violation';
  end if;
  if p_paid_at > now() + interval '5 minutes' then
    raise exception 'a payment cannot be dated in the future'
      using errcode = 'check_violation';
  end if;

  -- Under invoker RLS: a deal outside your fence simply is not found.
  select d.id, d.booked_amount,
         coalesce((select sum(amount) from crm.payments where deal_id = d.id), 0) as paid
    into v_deal
    from crm.deals d
   where d.id = p_deal_id and d.status = 'booked';
  if not found then
    raise exception 'no open deal found - it may be closed, refunded, or not yours to see'
      using errcode = 'no_data_found';
  end if;

  v_outstanding := v_deal.booked_amount - v_deal.paid;
  if v_left > v_outstanding + 0.005 then
    raise exception 'payment of % exceeds the % still outstanding on this deal - check the amount, or the client',
      crm.fmt_inr(v_left), crm.fmt_inr(v_outstanding)
      using errcode = 'check_violation';
  end if;

  -- Waterfall: oldest open instalment first, exactly as a ledger clerk would.
  for v_inst in
    select id, amount, paid_amount
      from crm.instalments
     where deal_id = p_deal_id and status in ('due', 'part_paid', 'overdue')
     order by seq
  loop
    exit when v_left <= 0;
    v_slice := least(v_left, v_inst.amount - v_inst.paid_amount);
    continue when v_slice <= 0;

    insert into crm.payments (deal_id, instalment_id, amount, mode, reference,
                              recorded_by, paid_at)
    values (p_deal_id, v_inst.id, v_slice, p_mode, p_reference,
            crm.current_user_id(), p_paid_at);
    v_left := round(v_left - v_slice, 2);
    v_rows := v_rows + 1;
  end loop;

  -- Anything beyond the instalment schedule is still real money received.
  if v_left > 0 then
    insert into crm.payments (deal_id, amount, mode, reference, recorded_by, paid_at)
    values (p_deal_id, v_left, p_mode, p_reference, crm.current_user_id(), p_paid_at);
    v_rows := v_rows + 1;
  end if;

  return v_rows;
end
$$;

comment on function crm.punch_in_payment is
  'One amount typed in, spread oldest-instalment-first with any remainder
   recorded unallocated against the deal. Invoker rights: RLS decides whose
   deals you can punch money into, and refusing an overpayment protects the
   collections numbers from a mistyped zero.';

-- What the punch-in searches: open deals with money still owed, by client.
create or replace view crm.v_open_deals as
select
  d.id as deal_id, l.id as lead_id, l.full_name, l.phone_e164,
  p.name as product, d.booked_amount, d.booked_at,
  u.full_name as counsellor_name,
  coalesce(pay.paid, 0)                     as paid_amount,
  d.booked_amount - coalesce(pay.paid, 0)   as outstanding
from crm.deals d
join crm.leads l on l.id = d.lead_id
join crm.products p on p.id = d.product_id
left join crm.users u on u.id = d.counsellor_id
left join lateral (
  select sum(amount) as paid from crm.payments where deal_id = d.id
) pay on true
where d.status = 'booked';

alter view crm.v_open_deals set (security_invoker = true);
grant select on crm.v_open_deals to crm_app;
