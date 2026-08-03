-- 0008_deals_and_collections.sql
-- Deliberately lean. The sales CRM's job ends at money collected and a clean
-- handoff; everything about servicing a paying advisory client lives in the
-- existing advisory pipeline. What is here exists because the counsellor
-- dashboard and the breakeven thermometer cannot be built without it:
--   - what was booked, by whom, from which lead
--   - what was actually collected, and what is overdue
--   - who is accountable for chasing it (the closer, not finance)

create table crm.products (
  id         uuid primary key default gen_random_uuid(),
  name       text not null unique,
  code       text not null unique,
  list_price_inr numeric(12,2) not null check (list_price_inr >= 0),
  -- Advisory is SEBI-regulated; courses are an "other activity" that must be
  -- segregated. This flag drives which revenue head a sale books to and which
  -- disclaimer the quote carries.
  is_sebi_regulated boolean not null default true,
  is_active  boolean not null default true,
  created_at timestamptz not null default now()
);

create type crm.deal_status as enum ('booked', 'refunded', 'cancelled');

create table crm.deals (
  id            uuid primary key default gen_random_uuid(),
  lead_id       uuid not null references crm.leads(id) on delete restrict,
  product_id    uuid not null references crm.products(id) on delete restrict,
  -- Accountability: the closer owns collection, the setter shares credit.
  counsellor_id uuid not null references crm.users(id) on delete restrict,
  setter_id     uuid references crm.users(id) on delete set null,
  team_id       uuid references crm.teams(id) on delete set null,

  booked_amount   numeric(12,2) not null check (booked_amount >= 0),
  discount_amount numeric(12,2) not null default 0 check (discount_amount >= 0),
  status        crm.deal_status not null default 'booked',
  booked_at     timestamptz not null default now(),
  refunded_at   timestamptz,
  refund_reason text,

  -- Set when the advisory pipeline confirms onboarding.
  handed_off_at timestamptz,
  external_client_ref text,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  constraint deals_refund_consistent
    check ((status = 'refunded') = (refunded_at is not null))
);

create index deals_counsellor_idx on crm.deals (counsellor_id, booked_at desc);
create index deals_setter_idx     on crm.deals (setter_id, booked_at desc);
create index deals_booked_at_idx  on crm.deals (booked_at desc);
create unique index deals_one_open_per_lead_idx
  on crm.deals (lead_id) where status = 'booked';

create trigger deals_set_updated_at
  before update on crm.deals
  for each row execute function crm.tg_set_updated_at();

-- ---------------------------------------------------------------------------

create table crm.instalments (
  id          uuid primary key default gen_random_uuid(),
  deal_id     uuid not null references crm.deals(id) on delete cascade,
  seq         int  not null check (seq > 0),
  due_date    date not null,
  amount      numeric(12,2) not null check (amount > 0),
  paid_amount numeric(12,2) not null default 0 check (paid_amount >= 0),
  status      crm.instalment_status not null default 'due',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  unique (deal_id, seq)
);

create index instalments_due_idx on crm.instalments (due_date)
  where status in ('due', 'part_paid', 'overdue');

create trigger instalments_set_updated_at
  before update on crm.instalments
  for each row execute function crm.tg_set_updated_at();

create table crm.payments (
  id            uuid primary key default gen_random_uuid(),
  deal_id       uuid not null references crm.deals(id) on delete restrict,
  instalment_id uuid references crm.instalments(id) on delete set null,
  amount        numeric(12,2) not null check (amount > 0),
  paid_at       timestamptz not null default now(),
  mode          text not null check (mode in ('upi','card','netbanking','cash','cheque','neft','other')),
  reference     text,
  recorded_by   uuid references crm.users(id) on delete set null,
  created_at    timestamptz not null default now()
);

create index payments_deal_idx on crm.payments (deal_id, paid_at desc);
create index payments_paid_at_idx on crm.payments (paid_at desc);

-- Promise to pay: structured, not a free-text note. This is what turns
-- collections from chasing into forecasting.
create table crm.promises_to_pay (
  id            uuid primary key default gen_random_uuid(),
  instalment_id uuid not null references crm.instalments(id) on delete cascade,
  promised_date date not null,
  promised_amount numeric(12,2) not null check (promised_amount > 0),
  confidence    text not null check (confidence in ('high','medium','low')),
  captured_by   uuid not null references crm.users(id) on delete restrict,
  outcome       text check (outcome in ('kept','broken','partial')),
  created_at    timestamptz not null default now()
);

create index promises_open_idx on crm.promises_to_pay (promised_date)
  where outcome is null;

-- ---------------------------------------------------------------------------
-- A booked deal closes the lead and stops it appearing in the calling pipeline.
-- ---------------------------------------------------------------------------

create or replace function crm.tg_deal_close_lead() returns trigger
  language plpgsql
as $$
begin
  update crm.leads
     set status = 'won',
         closed_at = coalesce(closed_at, new.booked_at),
         next_action_at = null,
         next_action_note = 'Won - collection tracked on the deal',
         counsellor_id = coalesce(counsellor_id, new.counsellor_id)
   where id = new.lead_id;

  insert into crm.lead_events (lead_id, event_type, actor_id, payload)
  values (new.lead_id, 'deal_booked', new.counsellor_id,
          jsonb_build_object('deal_id', new.id, 'amount', new.booked_amount));
  return new;
end
$$;

create trigger deals_close_lead
  after insert on crm.deals
  for each row when (new.status = 'booked')
  execute function crm.tg_deal_close_lead();

-- ---------------------------------------------------------------------------
-- Applying a payment rolls up onto the instalment.
-- ---------------------------------------------------------------------------

create or replace function crm.tg_payment_apply() returns trigger
  language plpgsql
as $$
begin
  if new.instalment_id is not null then
    update crm.instalments i
       set paid_amount = i.paid_amount + new.amount,
           status = case
             when i.paid_amount + new.amount >= i.amount then 'paid'::crm.instalment_status
             else 'part_paid'::crm.instalment_status
           end
     where i.id = new.instalment_id;

    -- A payment settles any open promise on that instalment.
    update crm.promises_to_pay p
       set outcome = case
             when new.amount >= p.promised_amount then 'kept' else 'partial' end
     where p.instalment_id = new.instalment_id and p.outcome is null;
  end if;
  return new;
end
$$;

create trigger payments_apply
  after insert on crm.payments
  for each row execute function crm.tg_payment_apply();

-- Nightly: flag what has slipped, and mark broken promises.
create or replace function crm.mark_overdue_instalments() returns int
  language plpgsql
as $$
declare v_count int;
begin
  update crm.instalments
     set status = 'overdue'
   where status in ('due', 'part_paid')
     and due_date < crm.ist_date(now());
  get diagnostics v_count = row_count;

  update crm.promises_to_pay
     set outcome = 'broken'
   where outcome is null
     and promised_date < crm.ist_date(now());

  return v_count;
end
$$;

-- ---------------------------------------------------------------------------
-- Handoff to the advisory pipeline. Outbox pattern: the CRM writes intent,
-- a worker delivers it, and the advisory side writes back onboarding, refund
-- and renewal events. Without the return leg, incentive clawback silently
-- fails and renewals are never created.
-- ---------------------------------------------------------------------------

create table crm.handoff_outbox (
  id           bigserial primary key,
  deal_id      uuid not null references crm.deals(id) on delete cascade,
  event_type   text not null,
  payload      jsonb not null,
  created_at   timestamptz not null default now(),
  delivered_at timestamptz,
  attempts     int not null default 0,
  last_error   text
);

create index handoff_outbox_pending_idx on crm.handoff_outbox (created_at)
  where delivered_at is null;

create table crm.handoff_inbound (
  id           bigserial primary key,
  -- Idempotency key from the advisory side.
  external_id  text not null unique,
  deal_id      uuid references crm.deals(id) on delete set null,
  event_type   text not null check (event_type in
                 ('onboarded','refunded','cancelled','renewal_due')),
  payload      jsonb not null,
  received_at  timestamptz not null default now(),
  processed_at timestamptz
);

create index handoff_inbound_unprocessed_idx on crm.handoff_inbound (received_at)
  where processed_at is null;
