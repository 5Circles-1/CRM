-- 0041_second_products_and_client_edits.sql
--
-- Floor feedback on the client book (the tab is being renamed Collections in
-- the UI; the old Collections dues queue becomes Outstanding payments):
--
--   1. "The same person can buy one or more product." True on this floor -
--      a Traders Discovery client upgrades to Advisory. The schema said one
--      open deal per lead, full stop, so the second sale was unrecordable.
--      The rule's real purpose was to stop double-booking the SAME sale, so
--      it narrows to one open deal per lead PER PRODUCT.
--
--   2. Typos happen at the desk: a misspelt name, a wrong amount. There was
--      no way to correct a hand-entered client short of asking a developer.
--      crm.edit_client fixes what is honest to fix - identity fields on any
--      client, money and credit only on hand-entered (is_manual) deals, and
--      every change is written to the lead's history with old and new values.
--      Money recorded through the CRM's own flow stays an audit record.

-- ---------------------------------------------------------------------------
-- 1. One open deal per lead PER PRODUCT.
-- ---------------------------------------------------------------------------
drop index if exists crm.deals_one_open_per_lead_idx;
create unique index deals_one_open_per_lead_product_idx
  on crm.deals (lead_id, product_id) where status = 'booked';

comment on index crm.deals_one_open_per_lead_product_idx is
  'A person can hold open deals for different products (an upgrade, a second
   programme) but never two open deals for the same product - that is a
   double-entry, not a purchase.';

-- The manual-entry door refuses only a same-product duplicate now, and says
-- which product is the problem.
create or replace function crm.add_manual_client(
  p_full_name     text,
  p_phone         text,
  p_product_id    uuid,
  p_amount        numeric,
  p_paid_at       timestamptz default now(),
  p_mode          text default 'other',
  p_mentor_id     uuid default null,
  p_note          text default null,
  p_counsellor_id uuid default null,
  p_source_id     uuid default null
) returns uuid
  language plpgsql
  security definer
  set search_path = crm, public
as $$
declare
  v_role       text := crm.current_user_role();
  v_actor      uuid := crm.current_user_id();
  v_phone      text;
  v_lead       uuid;
  v_deal       uuid;
  v_counsellor uuid;
  v_team       uuid;
  v_source     uuid;
  v_product    text;
begin
  if v_role not in ('admin', 'ops', 'counsellor') then
    raise exception 'only an admin, ops or counsellor may add a client by hand'
      using errcode = 'insufficient_privilege';
  end if;
  if p_amount is null or p_amount <= 0 then
    raise exception 'a client is someone who has paid - the amount must be positive'
      using errcode = 'check_violation';
  end if;

  v_counsellor := coalesce(p_counsellor_id, v_actor);
  if p_counsellor_id is not null and not exists (
    select 1 from crm.users u
     where u.id = p_counsellor_id and u.is_active
       and u.role in ('counsellor', 'admin')
  ) then
    raise exception '"converted by" must name an active counsellor'
      using errcode = 'check_violation';
  end if;
  v_team := crm.team_of(v_counsellor, current_date);

  v_source := coalesce(p_source_id, '33333333-0000-0000-0000-000000000003');
  if not exists (select 1 from crm.lead_sources s where s.id = v_source) then
    raise exception 'that lead source does not exist' using errcode = 'check_violation';
  end if;

  v_phone := crm.normalise_phone(p_phone);
  if v_phone is null then
    raise exception 'that phone number is not dialable' using errcode = 'check_violation';
  end if;

  -- Reuse the existing lead if this person is already in the book; a manual
  -- entry must never create a second record for someone we already know.
  select id into v_lead from crm.leads where phone_e164 = v_phone
   order by created_at limit 1;

  if v_lead is null then
    insert into crm.leads (source_id, full_name, phone_e164, status, closed_at,
                           counsellor_id, team_id)
    values (v_source, p_full_name, v_phone, 'won', now(), v_counsellor, v_team)
    returning id into v_lead;
  else
    update crm.leads
       set status = 'won',
           closed_at = coalesce(closed_at, now()),
           full_name = coalesce(full_name, p_full_name),
           source_id = coalesce(source_id, v_source),
           next_action_at = null,
           updated_at = now()
     where id = v_lead;
  end if;

  -- A second product is a purchase; the same product twice is a double-entry.
  select p.name into v_product
    from crm.deals d join crm.products p on p.id = d.product_id
   where d.lead_id = v_lead and d.status = 'booked' and d.product_id = p_product_id;
  if found then
    raise exception
      'this person already has an open % deal - record the payment against it instead. A DIFFERENT product is fine to add.',
      v_product
      using errcode = 'unique_violation';
  end if;

  insert into crm.deals (lead_id, product_id, counsellor_id, team_id,
                         booked_amount, booked_at, is_manual)
  values (v_lead, p_product_id, v_counsellor, v_team,
          p_amount, p_paid_at, true)
  returning id into v_deal;

  insert into crm.payments (deal_id, amount, paid_at, mode, reference, recorded_by)
  values (v_deal, p_amount, p_paid_at, p_mode,
          coalesce(p_note, 'added by hand'), v_actor);

  if p_mentor_id is not null then
    insert into crm.advisory_checkpoints (deal_id, mentor_id)
    values (v_deal, p_mentor_id)
    on conflict (deal_id) do update set mentor_id = excluded.mentor_id;
  end if;

  insert into crm.lead_events (lead_id, event_type, actor_id, payload)
  values (v_lead, 'manual_client_added', v_actor,
          jsonb_build_object('deal_id', v_deal, 'amount', p_amount, 'note', p_note,
                             'converted_by', v_counsellor, 'source_id', v_source));

  return v_deal;
end
$$;

comment on function crm.add_manual_client is
  'Escape hatch for a paying client who arrived outside the normal flow. Creates
   a real lead, deal and payment, marked is_manual, credited to the named
   converting counsellor and their team, with the lead source recorded. Reuses
   an existing lead on the same phone; a second product for the same person is
   a new deal, the same product twice is refused.';

-- ---------------------------------------------------------------------------
-- 2. Editing a client, honestly.
--
-- Identity (name, phone) is lead data and can be corrected on any client.
-- Money and credit (product, amount, who converted, source) can be corrected
-- only on hand-entered deals - they were typed by a person and typos are
-- typos. Money that came through the CRM's own recorded flow is an audit
-- trail and stays one. Every change lands in the lead's history with the
-- old and the new value and who made it.
-- ---------------------------------------------------------------------------
create or replace function crm.edit_client(
  p_deal_id       uuid,
  p_full_name     text default null,
  p_phone         text default null,
  p_product_id    uuid default null,
  p_amount        numeric default null,
  p_counsellor_id uuid default null,
  p_source_id     uuid default null
) returns void
  language plpgsql
  security definer
  set search_path = crm, public
as $$
declare
  v_role    text := crm.current_user_role();
  v_actor   uuid := crm.current_user_id();
  v_deal    record;
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
         d.team_id, d.is_manual, d.status,
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
      or p_counsellor_id is not null or p_source_id is not null)
     and not v_deal.is_manual then
    raise exception
      'this sale was recorded through the CRM, so its money and credit are audit records - the name and phone can be corrected here, anything else needs the admin'
      using errcode = 'check_violation';
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
    select count(*) into v_pay_count from crm.payments where deal_id = v_deal.id;
    if v_pay_count > 1 then
      raise exception
        'this client has % payments recorded, so one amount cannot honestly be "corrected" - punch in the difference as a payment, or ask the admin',
        v_pay_count
        using errcode = 'check_violation';
    end if;
    v_changes := v_changes || jsonb_build_object('amount',
      jsonb_build_object('from', v_deal.booked_amount, 'to', round(p_amount, 2)));
    update crm.deals set booked_amount = round(p_amount, 2), updated_at = now()
     where id = v_deal.id;
    update crm.payments set amount = round(p_amount, 2) where deal_id = v_deal.id;
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
    -- Keep the lead pointing at the same closer, but never steal a lead that
    -- already belongs to somebody else.
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

revoke execute on function crm.edit_client(uuid, text, text, uuid, numeric, uuid, uuid) from public;
grant execute on function crm.edit_client(uuid, text, text, uuid, numeric, uuid, uuid) to crm_app;

comment on function crm.edit_client is
  'Correct a client record. Name and phone on any client; product, amount,
   converted-by and source only on hand-entered (is_manual) deals, and the
   amount only while a single payment exists. Every change is appended to the
   lead''s history with old and new values. Counsellors are fenced to their
   own team, exactly as the register view fences them.';

-- ---------------------------------------------------------------------------
-- The register carries the ids alongside the names, so the edit form can
-- preselect what is already true instead of matching on display strings.
-- ---------------------------------------------------------------------------
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
  (select count(*) from crm.payments pc where pc.deal_id = d.id)::int as payment_count
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
where coalesce(pay.paid, 0) > 0;

alter view crm.v_advisory_clients set (security_invoker = true);
grant select on crm.v_advisory_clients to crm_app;

comment on view crm.v_advisory_clients is
  'Everyone who has actually paid - one row per deal, so a client with two
   products appears twice, which is the truth. Carries who converted them
   (counsellor and team), the lead source, and the ids the edit form needs.';
