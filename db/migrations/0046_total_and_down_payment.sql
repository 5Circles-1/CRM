-- 0046_total_and_down_payment.sql
--
-- "Only one column shows for Amount paid. We need Total payment and Down
-- payment, so the remaining amount is visible at a glance."
--
-- The floor is describing a real hole, not a layout preference. A client
-- entered by hand recorded ONE number as both the deal value and the money
-- received, so a man who paid 3,000 of a 30,000 programme was written down as
-- a 3,000 client, fully paid. The 27,000 still owed existed nowhere: not on
-- the client book, not in the dues queue, not in anybody's collections
-- target. It could only ever be chased from memory.
--
-- So a hand entry now records what was SOLD and what was RECEIVED, and when
-- those differ the balance becomes a real instalment - which is what puts it
-- on Outstanding payments, into the overdue sweep, and into the counsellor's
-- collection figure, exactly like a deal booked through the CRM.

insert into crm.settings (key, value, description) values
  ('deal.default_balance_days', '30'::jsonb,
   'When a hand-entered client pays only part of the fee, how many days ahead the balance falls due if nobody picks a date.')
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- One owner for the schedule of a hand-entered deal, so the add and edit
-- paths can never drift apart.
--
-- Two instalments describe it honestly: what they put down (settled), and
-- what is left (due, chaseable). The rows are written to their finished state
-- rather than leaned on the payment trigger, so the helper is idempotent -
-- calling it twice with the same numbers changes nothing.
-- ---------------------------------------------------------------------------
create or replace function crm.sync_manual_schedule(
  p_deal_id uuid,
  p_total   numeric,
  p_paid    numeric,
  p_due_on  date default null
) returns void
  language plpgsql
  security definer
  set search_path = crm, public
as $$
declare
  v_balance numeric := round(p_total, 2) - round(p_paid, 2);
  v_due     date := coalesce(p_due_on,
                             crm.ist_date(now())
                               + crm.setting_int('deal.default_balance_days', 30));
  v_down_id uuid;
  v_bal_id  uuid;
begin
  select id into v_down_id from crm.instalments where deal_id = p_deal_id and seq = 1;
  select id into v_bal_id  from crm.instalments where deal_id = p_deal_id and seq = 2;

  if v_balance <= 0 then
    -- Nothing left to chase. An existing balance row is written off rather
    -- than deleted: the schedule is corrected, and the record of what was
    -- once expected stays readable.
    if v_bal_id is not null then
      update crm.instalments
         set amount = greatest(amount, 0.01), status = 'written_off', updated_at = now()
       where id = v_bal_id and status <> 'paid';
    end if;
    if v_down_id is not null then
      update crm.instalments
         set amount = round(p_total, 2), paid_amount = round(p_paid, 2),
             status = 'paid', updated_at = now()
       where id = v_down_id;
    end if;
    return;
  end if;

  -- What they put down, settled.
  if v_down_id is null then
    insert into crm.instalments (deal_id, seq, due_date, amount, paid_amount, status)
    values (p_deal_id, 1, crm.ist_date(now()), round(p_paid, 2), round(p_paid, 2), 'paid');
  else
    update crm.instalments
       set amount = round(p_paid, 2), paid_amount = round(p_paid, 2),
           status = 'paid', updated_at = now()
     where id = v_down_id;
  end if;

  -- What is left, due and chaseable.
  if v_bal_id is null then
    insert into crm.instalments (deal_id, seq, due_date, amount, paid_amount, status)
    values (p_deal_id, 2, v_due, v_balance, 0, 'due');
  else
    update crm.instalments
       set amount = v_balance, due_date = v_due, paid_amount = 0,
           status = (case when v_due < crm.ist_date(now()) then 'overdue' else 'due' end)::crm.instalment_status,
           updated_at = now()
     where id = v_bal_id;
  end if;
end
$$;

revoke all on function crm.sync_manual_schedule(uuid, numeric, numeric, date) from public;
grant execute on function crm.sync_manual_schedule(uuid, numeric, numeric, date) to crm_app;

comment on function crm.sync_manual_schedule is
  'The instalment schedule of a hand-entered deal: seq 1 is what was put
   down (settled), seq 2 is the balance (due, and therefore chased on
   Outstanding payments). Idempotent, so the add and edit paths share it.';

-- ---------------------------------------------------------------------------
-- Adding a client: what was sold, and what was received.
--
-- p_amount keeps its name and becomes the TOTAL; p_paid_amount defaults to it,
-- so every existing caller records a fully-paid client exactly as before.
--
-- The two new parameters make this a fresh overload as far as Postgres is
-- concerned, and two overloads that both accept ten arguments make every
-- defaulted call ambiguous. The old one goes.
-- ---------------------------------------------------------------------------
drop function if exists crm.add_manual_client(text, text, uuid, numeric, timestamptz, text, uuid, text, uuid, uuid);

create or replace function crm.add_manual_client(
  p_full_name     text,
  p_phone         text,
  p_product_id    uuid,
  p_amount        numeric,                 -- total value of the sale
  p_paid_at       timestamptz default now(),
  p_mode          text default 'other',
  p_mentor_id     uuid default null,
  p_note          text default null,
  p_counsellor_id uuid default null,
  p_source_id     uuid default null,
  p_paid_amount   numeric default null,    -- received now; null = paid in full
  p_balance_due_on date default null
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
  v_total      numeric := round(p_amount, 2);
  v_paid       numeric := round(coalesce(p_paid_amount, p_amount), 2);
begin
  if v_role not in ('admin', 'ops', 'counsellor') then
    raise exception 'only an admin, ops or counsellor may add a client by hand'
      using errcode = 'insufficient_privilege';
  end if;
  if v_total is null or v_total <= 0 then
    raise exception 'the total must be a positive number of rupees'
      using errcode = 'check_violation';
  end if;
  if v_paid <= 0 then
    raise exception 'a client is someone who has paid - the down payment must be positive'
      using errcode = 'check_violation';
  end if;
  if v_paid > v_total + 0.005 then
    raise exception 'the down payment (%) cannot be more than the total (%)',
      crm.fmt_inr(v_paid), crm.fmt_inr(v_total)
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

  -- Reuse the person's LIVE lead if they have one - that is the row a caller
  -- is actively working, and paying must take it out of the pipeline.
  select id into v_lead from crm.leads where phone_e164 = v_phone
   order by (status in ('new', 'working', 'callback', 'qualified', 'negotiation', 'nurture')) desc,
            created_at desc
   limit 1;

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
           pool = null,
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
          v_total, p_paid_at, true)
  returning id into v_deal;

  -- No instalment_id: the schedule below owns the instalment rows outright,
  -- so the rollup trigger must not also add this amount to them.
  insert into crm.payments (deal_id, amount, paid_at, mode, reference, recorded_by)
  values (v_deal, v_paid, p_paid_at, p_mode,
          coalesce(p_note, 'added by hand'), v_actor);

  if v_paid < v_total then
    perform crm.sync_manual_schedule(v_deal, v_total, v_paid, p_balance_due_on);
  end if;

  if p_mentor_id is not null then
    insert into crm.advisory_checkpoints (deal_id, mentor_id)
    values (v_deal, p_mentor_id)
    on conflict (deal_id) do update set mentor_id = excluded.mentor_id;
  end if;

  insert into crm.lead_events (lead_id, event_type, actor_id, payload)
  values (v_lead, 'manual_client_added', v_actor,
          jsonb_build_object('deal_id', v_deal, 'total', v_total, 'paid', v_paid,
                             'balance', v_total - v_paid, 'note', p_note,
                             'converted_by', v_counsellor, 'source_id', v_source));

  return v_deal;
end
$$;

comment on function crm.add_manual_client is
  'A paying client entered by hand: p_amount is what was SOLD, p_paid_amount
   what was RECEIVED (defaulting to the total). Any balance becomes a real
   instalment, so it is chased on Outstanding payments like every other deal.';

-- ---------------------------------------------------------------------------
-- Editing: the same two numbers, and the schedule follows them.
-- ---------------------------------------------------------------------------
drop function if exists crm.edit_client(uuid, text, text, uuid, numeric, uuid, uuid, timestamptz, text, text);

create or replace function crm.edit_client(
  p_deal_id       uuid,
  p_full_name     text default null,
  p_phone         text default null,
  p_product_id    uuid default null,
  p_amount        numeric default null,   -- total value of the sale
  p_counsellor_id uuid default null,
  p_source_id     uuid default null,
  p_paid_at       timestamptz default null,
  p_mode          text default null,
  p_reference     text default null,
  p_paid_amount   numeric default null,   -- what was actually received
  p_balance_due_on date default null
) returns void
  language plpgsql
  security definer
  set search_path = crm, public
as $$
declare
  v_role      text := crm.current_user_role();
  v_actor     uuid := crm.current_user_id();
  v_deal      record;
  v_pay       record;
  v_phone     text;
  v_dupe      record;
  v_changes   jsonb := '{}'::jsonb;
  v_pay_count int;
  v_total     numeric;
  v_paid      numeric;
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
  if (p_product_id is not null or p_amount is not null or p_paid_amount is not null
      or p_counsellor_id is not null or p_source_id is not null
      or p_paid_at is not null or p_mode is not null or p_reference is not null
      or p_balance_due_on is not null)
     and not v_deal.is_manual then
    raise exception
      'this sale was recorded through the CRM, so its money and credit are audit records - the name and phone can be corrected here, anything else needs the admin'
      using errcode = 'check_violation';
  end if;

  -- The payment facts describe the single original hand-entered payment.
  -- Once instalments have been collected against, "the" payment is no longer
  -- one thing and a correction would be a rewrite of real history.
  if p_amount is not null or p_paid_amount is not null or p_paid_at is not null
     or p_mode is not null or p_reference is not null or p_balance_due_on is not null then
    select count(*) into v_pay_count from crm.payments where deal_id = v_deal.id;
    if v_pay_count > 1 then
      raise exception
        'this client has % payments recorded, so the original entry cannot honestly be "corrected" - punch in the difference as a payment, or ask the admin',
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

  -- Total and down payment move together: either one alone still has to make
  -- sense against the other, so both are resolved before anything is written.
  if p_amount is not null or p_paid_amount is not null or p_balance_due_on is not null then
    v_total := round(coalesce(p_amount, v_deal.booked_amount), 2);
    v_paid  := round(coalesce(p_paid_amount, v_pay.amount), 2);
    if v_total <= 0 or v_paid <= 0 then
      raise exception 'the total and the down payment must both be positive amounts'
        using errcode = 'check_violation';
    end if;
    if v_paid > v_total + 0.005 then
      raise exception 'the down payment (%) cannot be more than the total (%)',
        crm.fmt_inr(v_paid), crm.fmt_inr(v_total)
        using errcode = 'check_violation';
    end if;

    if v_total is distinct from v_deal.booked_amount then
      v_changes := v_changes || jsonb_build_object('total',
        jsonb_build_object('from', v_deal.booked_amount, 'to', v_total));
      update crm.deals set booked_amount = v_total, updated_at = now() where id = v_deal.id;
    end if;
    if v_paid is distinct from v_pay.amount then
      v_changes := v_changes || jsonb_build_object('amount',
        jsonb_build_object('from', v_pay.amount, 'to', v_paid));
      update crm.payments set amount = v_paid where id = v_pay.id;
    end if;
    perform crm.sync_manual_schedule(v_deal.id, v_total, v_paid, p_balance_due_on);
  end if;

  if p_paid_at is not null and p_paid_at is distinct from v_pay.paid_at then
    if p_paid_at > now() + interval '5 minutes' then
      raise exception 'a payment cannot be dated in the future'
        using errcode = 'check_violation';
    end if;
    v_changes := v_changes || jsonb_build_object('paid_on',
      jsonb_build_object('from', crm.ist_date(v_pay.paid_at), 'to', crm.ist_date(p_paid_at)));
    update crm.deals set booked_at = p_paid_at, updated_at = now() where id = v_deal.id;
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
    return;
  end if;

  insert into crm.lead_events (lead_id, event_type, actor_id, payload)
  values (v_deal.lead_id, 'client_edited', v_actor,
          jsonb_build_object('deal_id', v_deal.id, 'changes', v_changes));
end
$$;

revoke execute on function crm.edit_client(uuid, text, text, uuid, numeric, uuid, uuid, timestamptz, text, text, numeric, date) from public;
grant execute on function crm.edit_client(uuid, text, text, uuid, numeric, uuid, uuid, timestamptz, text, text, numeric, date) to crm_app;

comment on function crm.edit_client is
  'Correct a client record. Name and phone on any client; total, down payment,
   paid date, mode, reference, product, converted-by and source only on
   hand-entered deals while the single original payment stands. Changing the
   money re-syncs the instalment schedule, so the balance chased on
   Outstanding payments always matches the corrected numbers.';

-- ---------------------------------------------------------------------------
-- The client book answers "how much is still owed" without arithmetic.
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
  (select count(*) from crm.payments pc where pc.deal_id = d.id)::int as payment_count,
  first_pay.mode      as first_payment_mode,
  first_pay.reference as first_payment_reference,
  crm.ist_date(first_pay.paid_at) as first_paid_on,
  -- What is still owed, and when it falls due.
  greatest(d.booked_amount - coalesce(pay.paid, 0), 0)            as outstanding,
  bal.due_date                                                    as balance_due_on,
  (bal.due_date is not null and bal.due_date < crm.ist_date(now())) as balance_overdue
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
left join lateral (
  select min(due_date) as due_date
    from crm.instalments
   where deal_id = d.id and status in ('due', 'part_paid', 'overdue')
) bal on true
where coalesce(pay.paid, 0) > 0;

alter view crm.v_advisory_clients set (security_invoker = true);
grant select on crm.v_advisory_clients to crm_app;

comment on view crm.v_advisory_clients is
  'Everyone who has actually paid - one row per deal. Carries the total, what
   has been received, what is still outstanding and when it falls due, who
   converted them, the lead source, and the payment facts the edit form needs.';
