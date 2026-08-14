-- 0043_edit_covers_the_whole_entry.sql
--
-- The edit form let you correct what was typed - name, phone, product,
-- amount, converted-by, source - but not WHEN the payment happened, nor the
-- mode or reference. A hand-entered client whose payment was punched with
-- yesterday's date stuck with it. Every field the Add-a-client form captures
-- is now correctable, under the same rules:
--
--   - identity on any client;
--   - money facts (product, amount, paid date, mode, reference, converted-by,
--     source) only on hand-entered deals, and the payment facts only while
--     the deal holds its single original payment;
--   - every change written to the lead's history with old and new values.
--
-- The parameter list grows, which to Postgres is a new overload; the old one
-- must go or calls with defaults become ambiguous.
drop function if exists crm.edit_client(uuid, text, text, uuid, numeric, uuid, uuid);

create or replace function crm.edit_client(
  p_deal_id       uuid,
  p_full_name     text default null,
  p_phone         text default null,
  p_product_id    uuid default null,
  p_amount        numeric default null,
  p_counsellor_id uuid default null,
  p_source_id     uuid default null,
  p_paid_at       timestamptz default null,
  p_mode          text default null,
  p_reference     text default null
) returns void
  language plpgsql
  security definer
  set search_path = crm, public
as $$
declare
  v_role    text := crm.current_user_role();
  v_actor   uuid := crm.current_user_id();
  v_deal    record;
  v_pay     record;
  v_phone   text;
  v_dupe    record;
  v_changes jsonb := '{}'::jsonb;
  v_pay_count int;
begin
  if v_role not in ('admin', 'ops', 'counsellor') then
    raise exception 'only an admin, ops or counsellor may edit a client'
      using errcode = 'insufficient_privilege';
  end if;

  select d.id, d.lead_id, d.product_id, d.booked_amount, d.counsellor_id,
         d.team_id, d.is_manual, d.status, d.booked_at,
         l.full_name, l.phone_e164, l.source_id
    into v_deal
    from crm.deals d
    join crm.leads l on l.id = d.lead_id
   where d.id = p_deal_id;

  -- Definer rights see everything, so the team fence is re-applied by hand:
  -- to a counsellor, another team's client reads as absent, exactly as the
  -- RLS view of the register does.
  if not found
     or (v_role = 'counsellor'
         and v_deal.team_id is distinct from crm.team_of(v_actor, current_date)) then
    raise exception 'no such client - or not yours to see'
      using errcode = 'no_data_found';
  end if;

  -- Identity: any client.
  if p_full_name is not null and nullif(trim(p_full_name), '') is not null
     and trim(p_full_name) is distinct from v_deal.full_name then
    v_changes := v_changes || jsonb_build_object('name',
      jsonb_build_object('from', v_deal.full_name, 'to', trim(p_full_name)));
    update crm.leads set full_name = trim(p_full_name), updated_at = now()
     where id = v_deal.lead_id;
  end if;

  if p_phone is not null then
    v_phone := crm.normalise_phone(p_phone);
    if v_phone is null then
      raise exception 'that phone number is not dialable' using errcode = 'check_violation';
    end if;
    if v_phone is distinct from v_deal.phone_e164 then
      select l.full_name into v_dupe from crm.leads l
       where l.phone_e164 = v_phone and l.id <> v_deal.lead_id limit 1;
      if found then
        raise exception 'that number already belongs to % - two people cannot share one number',
          coalesce(v_dupe.full_name, 'another lead')
          using errcode = 'unique_violation';
      end if;
      v_changes := v_changes || jsonb_build_object('phone',
        jsonb_build_object('from', v_deal.phone_e164, 'to', v_phone));
      update crm.leads set phone_e164 = v_phone, updated_at = now()
       where id = v_deal.lead_id;
    end if;
  end if;

  -- Money and credit: hand-entered deals only.
  if (p_product_id is not null or p_amount is not null
      or p_counsellor_id is not null or p_source_id is not null
      or p_paid_at is not null or p_mode is not null or p_reference is not null)
     and not v_deal.is_manual then
    raise exception
      'this sale was recorded through the CRM, so its money and credit are audit records - the name and phone can be corrected here, anything else needs the admin'
      using errcode = 'check_violation';
  end if;

  -- The payment facts (amount, date, mode, reference) describe the single
  -- original hand-entered payment. Once more payments exist, "the" payment
  -- is ambiguous and a correction would be a rewrite of real history.
  if p_amount is not null or p_paid_at is not null
     or p_mode is not null or p_reference is not null then
    select count(*) into v_pay_count from crm.payments where deal_id = v_deal.id;
    if v_pay_count > 1 then
      raise exception
        'this client has % payments recorded, so the original entry cannot honestly be "corrected" - punch in a correction as a payment, or ask the admin',
        v_pay_count
        using errcode = 'check_violation';
    end if;
    select id, amount, paid_at, mode, reference into v_pay
      from crm.payments where deal_id = v_deal.id;
  end if;

  if p_product_id is not null and p_product_id is distinct from v_deal.product_id then
    if not exists (select 1 from crm.products where id = p_product_id and is_active) then
      raise exception 'that product does not exist' using errcode = 'check_violation';
    end if;
    if exists (select 1 from crm.deals d
                where d.lead_id = v_deal.lead_id and d.status = 'booked'
                  and d.product_id = p_product_id and d.id <> v_deal.id) then
      raise exception 'this person already has an open deal for that product'
        using errcode = 'unique_violation';
    end if;
    v_changes := v_changes || jsonb_build_object('product',
      jsonb_build_object(
        'from', (select name from crm.products where id = v_deal.product_id),
        'to',   (select name from crm.products where id = p_product_id)));
    update crm.deals set product_id = p_product_id, updated_at = now()
     where id = v_deal.id;
  end if;

  if p_amount is not null and p_amount is distinct from v_deal.booked_amount then
    if p_amount <= 0 then
      raise exception 'the amount must be a positive number of rupees'
        using errcode = 'check_violation';
    end if;
    v_changes := v_changes || jsonb_build_object('amount',
      jsonb_build_object('from', v_deal.booked_amount, 'to', round(p_amount, 2)));
    update crm.deals set booked_amount = round(p_amount, 2), updated_at = now()
     where id = v_deal.id;
    update crm.payments set amount = round(p_amount, 2) where deal_id = v_deal.id;
  end if;

  if p_paid_at is not null and p_paid_at is distinct from v_pay.paid_at then
    if p_paid_at > now() + interval '5 minutes' then
      raise exception 'a payment cannot be dated in the future'
        using errcode = 'check_violation';
    end if;
    v_changes := v_changes || jsonb_build_object('paid_on',
      jsonb_build_object('from', crm.ist_date(v_pay.paid_at), 'to', crm.ist_date(p_paid_at)));
    update crm.deals set booked_at = p_paid_at, updated_at = now()
     where id = v_deal.id;
    update crm.payments set paid_at = p_paid_at where deal_id = v_deal.id;
  end if;

  if p_mode is not null and p_mode is distinct from v_pay.mode then
    if p_mode not in ('upi', 'card', 'netbanking', 'cash', 'cheque', 'neft', 'other') then
      raise exception 'that payment mode is not one the CRM knows'
        using errcode = 'check_violation';
    end if;
    v_changes := v_changes || jsonb_build_object('mode',
      jsonb_build_object('from', v_pay.mode, 'to', p_mode));
    update crm.payments set mode = p_mode where deal_id = v_deal.id;
  end if;

  if p_reference is not null and nullif(trim(p_reference), '') is distinct from v_pay.reference then
    v_changes := v_changes || jsonb_build_object('reference',
      jsonb_build_object('from', v_pay.reference, 'to', nullif(trim(p_reference), '')));
    update crm.payments set reference = nullif(trim(p_reference), '') where deal_id = v_deal.id;
  end if;

  if p_counsellor_id is not null and p_counsellor_id is distinct from v_deal.counsellor_id then
    if not exists (select 1 from crm.users u
                    where u.id = p_counsellor_id and u.is_active
                      and u.role in ('counsellor', 'admin')) then
      raise exception '"converted by" must name an active counsellor'
        using errcode = 'check_violation';
    end if;
    v_changes := v_changes || jsonb_build_object('converted_by',
      jsonb_build_object(
        'from', (select full_name from crm.users where id = v_deal.counsellor_id),
        'to',   (select full_name from crm.users where id = p_counsellor_id)));
    update crm.deals
       set counsellor_id = p_counsellor_id,
           team_id = crm.team_of(p_counsellor_id, current_date),
           updated_at = now()
     where id = v_deal.id;
    update crm.leads set counsellor_id = p_counsellor_id, updated_at = now()
     where id = v_deal.lead_id and counsellor_id = v_deal.counsellor_id;
  end if;

  if p_source_id is not null and p_source_id is distinct from v_deal.source_id then
    if not exists (select 1 from crm.lead_sources where id = p_source_id) then
      raise exception 'that lead source does not exist' using errcode = 'check_violation';
    end if;
    v_changes := v_changes || jsonb_build_object('source',
      jsonb_build_object(
        'from', (select name from crm.lead_sources where id = v_deal.source_id),
        'to',   (select name from crm.lead_sources where id = p_source_id)));
    update crm.leads set source_id = p_source_id, updated_at = now()
     where id = v_deal.lead_id;
  end if;

  if v_changes = '{}'::jsonb then
    return; -- nothing actually changed; no event, no noise
  end if;

  insert into crm.lead_events (lead_id, event_type, actor_id, payload)
  values (v_deal.lead_id, 'client_edited', v_actor,
          jsonb_build_object('deal_id', v_deal.id, 'changes', v_changes));
end
$$;

revoke execute on function crm.edit_client(uuid, text, text, uuid, numeric, uuid, uuid, timestamptz, text, text) from public;
grant execute on function crm.edit_client(uuid, text, text, uuid, numeric, uuid, uuid, timestamptz, text, text) to crm_app;

comment on function crm.edit_client is
  'Correct a client record. Name and phone on any client; product, amount,
   paid date, mode, reference, converted-by and source only on hand-entered
   (is_manual) deals, and the payment facts only while the single original
   payment exists. Every change is appended to the lead''s history with old
   and new values. Counsellors are fenced to their own team.';

-- The register needs the payment facts for the edit form to preselect them.
drop view if exists crm.v_advisory_clients;
create view crm.v_advisory_clients as
select
  d.id as deal_id, l.id as lead_id, l.full_name, l.phone_e164,
  p.name as product, d.booked_amount, d.booked_at,
  coalesce(pay.paid, 0) as paid_amount, pay.last_paid_at,
  u.full_name as counsellor_name,
  ac.mitc_done_at, ac.kyc_done_at, ac.group_added_at, ac.subscription_ends_at,
  ac.mentor_id, mu.full_name as mentor_name,
  d.is_manual,
  ((ac.mitc_done_at is not null)::int
   + (ac.kyc_done_at is not null)::int
   + (ac.group_added_at is not null)::int)                       as checkpoints_done,
  case
    when d.status = 'refunded' then 'refunded'
    when ac.subscription_ends_at is not null and ac.subscription_ends_at < now() then 'expired'
    else 'active'
  end as client_status,
  t.name  as team_name,
  ls.name as source,
  d.product_id, d.counsellor_id, l.source_id,
  (select count(*) from crm.payments pc where pc.deal_id = d.id)::int as payment_count,
  first_pay.mode      as first_payment_mode,
  first_pay.reference as first_payment_reference,
  crm.ist_date(first_pay.paid_at) as first_paid_on
from crm.deals d
join crm.leads l on l.id = d.lead_id
join crm.products p on p.id = d.product_id
left join crm.users u on u.id = d.counsellor_id
left join crm.teams t on t.id = d.team_id
left join crm.lead_sources ls on ls.id = l.source_id
left join crm.advisory_checkpoints ac on ac.deal_id = d.id
left join crm.users mu on mu.id = ac.mentor_id
join lateral (
  select sum(amount) as paid, max(paid_at) as last_paid_at
    from crm.payments where deal_id = d.id
) pay on true
left join lateral (
  select mode, reference, paid_at
    from crm.payments where deal_id = d.id
   order by paid_at asc, created_at asc limit 1
) first_pay on true
where coalesce(pay.paid, 0) > 0;

alter view crm.v_advisory_clients set (security_invoker = true);
grant select on crm.v_advisory_clients to crm_app;

comment on view crm.v_advisory_clients is
  'Everyone who has actually paid - one row per deal, so a client with two
   products appears twice, which is the truth. Carries who converted them
   (counsellor and team), the lead source, and the payment facts the edit
   form needs to preselect reality.';
