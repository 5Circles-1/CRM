-- 0044_lookup_before_you_retype.sql
--
-- A counsellor typed a whole Add-a-client form for a man who was already in
-- the book, and only learned it from a refusal at the end - which then told
-- them to go record the payment on a different tab. Correct, and infuriating.
--
-- The form now looks the person up while the phone number is being typed and
-- says what is already true: who they are, which deals are open, with whom,
-- and what is outstanding - with a one-click path to record the payment
-- against the existing deal instead of a dead-end error.
--
-- Definer rights, deliberately, with the role gate add_manual_client uses.
-- The person at the desk needs the truth even when the existing deal sits
-- with the OTHER team - that is precisely the case that creates duplicate
-- entries. It reveals only what the refusal message already named: the
-- client's name, status, products, owner and team, and money on the deal.
-- Callers and viewers are refused; lead notes and history stay fenced.
create or replace function crm.lookup_client_by_phone(p_phone text)
  returns jsonb
  language plpgsql
  security definer
  set search_path = crm, public
as $$
declare
  v_role    text := crm.current_user_role();
  v_actor   uuid := crm.current_user_id();
  v_my_team uuid;
  v_phone   text;
  v_lead    record;
  v_deals   jsonb;
begin
  if v_role not in ('admin', 'ops', 'counsellor') then
    raise exception 'only an admin, ops or counsellor may look up clients by phone'
      using errcode = 'insufficient_privilege';
  end if;

  v_phone := crm.normalise_phone(p_phone);
  if v_phone is null then
    return null;
  end if;

  v_my_team := crm.team_of(v_actor, current_date);

  select l.id, l.full_name, l.status
    into v_lead
    from crm.leads l
   where l.phone_e164 = v_phone
   order by (l.status in ('new', 'working', 'callback', 'qualified', 'negotiation', 'nurture')) desc,
            l.created_at desc
   limit 1;
  if not found then
    return null;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'deal_id',         d.id,
           'product',         p.name,
           'booked_amount',   d.booked_amount,
           'paid_amount',     coalesce(pay.paid, 0),
           'outstanding',     d.booked_amount - coalesce(pay.paid, 0),
           'counsellor_name', u.full_name,
           'team_name',       t.name,
           -- Whether the punch-in fence lets THIS user record money on it.
           'mine', (v_role in ('admin', 'ops') or d.team_id is not distinct from v_my_team)
         ) order by d.booked_at desc), '[]'::jsonb)
    into v_deals
    from crm.deals d
    join crm.products p on p.id = d.product_id
    left join crm.users u on u.id = d.counsellor_id
    left join crm.teams t on t.id = d.team_id
    left join lateral (
      select sum(amount) as paid from crm.payments where deal_id = d.id
    ) pay on true
   where d.lead_id = v_lead.id and d.status = 'booked';

  return jsonb_build_object(
    'lead_id',    v_lead.id,
    'full_name',  v_lead.full_name,
    'status',     v_lead.status,
    'open_deals', v_deals
  );
end
$$;

revoke execute on function crm.lookup_client_by_phone(text) from public;
grant execute on function crm.lookup_client_by_phone(text) to crm_app;

comment on function crm.lookup_client_by_phone is
  'What the Add-a-client form shows while a phone number is typed: is this
   person already in the book, which deals are open, with whom, and what is
   outstanding. Definer rights so the answer is true across the team fence -
   the cross-team case is exactly where duplicate entries come from. Reveals
   only what the duplicate refusal already named.';
