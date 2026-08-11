-- 0027_advisory_clients.sql
--
-- The Advisory Clients tab, to the owner's narrowed spec: every paying client
-- in one list - active or expired - with the two checkpoints that gate paid
-- advisory for a SEBI-registered firm: MITC done, KYC signed. This is a
-- checklist and a register, deliberately NOT service delivery: touchpoints,
-- research and grievances still live in the advisory pipeline.

create table crm.advisory_checkpoints (
  deal_id      uuid primary key references crm.deals(id) on delete cascade,
  mitc_done_at timestamptz,
  mitc_by      uuid references crm.users(id) on delete set null,
  kyc_done_at  timestamptz,
  kyc_by       uuid references crm.users(id) on delete set null,
  subscription_ends_at timestamptz,
  updated_at   timestamptz not null default now()
);

alter table crm.advisory_checkpoints enable row level security;
create policy advisory_read on crm.advisory_checkpoints
  for select using (crm.current_user_role() in ('admin','ops','counsellor','viewer'));
create policy advisory_write on crm.advisory_checkpoints
  for all using (crm.current_user_role() in ('admin','counsellor'))
  with check (crm.current_user_role() in ('admin','counsellor'));
grant select, insert, update on crm.advisory_checkpoints to crm_app;

create trigger advisory_checkpoints_audit
  after insert or update or delete on crm.advisory_checkpoints
  for each row execute function crm.tg_audit();

-- One row per paying client: paid = money actually received, not booked.
create or replace view crm.v_advisory_clients as
select
  d.id as deal_id, l.id as lead_id, l.full_name, l.phone_e164,
  p.name as product, d.booked_amount, d.booked_at,
  coalesce(pay.paid, 0) as paid_amount, pay.last_paid_at,
  u.full_name as counsellor_name,
  ac.mitc_done_at, ac.kyc_done_at, ac.subscription_ends_at,
  case
    when d.status = 'refunded' then 'refunded'
    when ac.subscription_ends_at is not null and ac.subscription_ends_at < now() then 'expired'
    else 'active'
  end as client_status
from crm.deals d
join crm.leads l on l.id = d.lead_id
join crm.products p on p.id = d.product_id
left join crm.users u on u.id = d.counsellor_id
left join crm.advisory_checkpoints ac on ac.deal_id = d.id
join lateral (
  select sum(amount) as paid, max(paid_at) as last_paid_at
    from crm.payments where deal_id = d.id
) pay on true
where coalesce(pay.paid, 0) > 0;

alter view crm.v_advisory_clients set (security_invoker = true);
grant select on crm.v_advisory_clients to crm_app;
