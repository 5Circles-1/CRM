-- 0030_mentor_touchpoints.sql
--
-- The Mentors module, built on the owner's recorded override of the scope
-- boundary (11 Aug 2026): paying clients are kept warm from HERE, by mentors.
-- What stays out, still: research delivery, consent artefacts, grievance
-- registers - the advisory pipeline's job. What lives here is the relationship
-- log: who talked to which paying client, when, how it went, what to sell
-- next, and a health colour nobody maintains by hand.
--
-- Every client in the book is a paying client by construction: the book view
-- starts from payments, and the mentor's row-level access is derived from
-- "this lead has real money against it" - so a mentor can never browse the
-- live sales pipeline, which keeps the tab inside the narrowed boundary.

-- ---------------------------------------------------------------------------
-- Tunables. Health thresholds are ops decisions, so they live in settings.
-- ---------------------------------------------------------------------------
insert into crm.settings (key, value, description) values
  ('mentor.health_amber_days', '10'::jsonb,
   'A client goes AMBER when their last touchpoint is older than this many days.'),
  ('mentor.health_red_days', '21'::jsonb,
   'A client goes RED when their last touchpoint is older than this many days.'),
  ('mentor.untouched_red_days', '7'::jsonb,
   'A client with NO touchpoint at all goes RED this many days after their first payment.'),
  ('mentor.followup_grace_days', '3'::jsonb,
   'A promised follow-up may run this many days late (AMBER) before the client goes RED.')
on conflict (key) do nothing;

-- Which mentor owns the relationship. One row per paid deal already exists
-- for MITC/KYC, so the assignment belongs on the same register row.
alter table crm.advisory_checkpoints
  add column mentor_id uuid references crm.users(id) on delete set null;

-- ---------------------------------------------------------------------------
-- The touchpoint log. Append-only: a relationship history that can be edited
-- after the fact is worthless in a dispute, so corrections are new entries.
-- ---------------------------------------------------------------------------
create table crm.mentor_touchpoints (
  id            bigint generated always as identity primary key,
  deal_id       uuid not null references crm.deals(id) on delete cascade,
  mentor_id     uuid not null references crm.users(id) on delete restrict,
  touched_on    date not null,
  channel       text not null
                check (channel in ('call', 'whatsapp', 'email', 'in_person', 'video')),
  outcome       text not null
                check (outcome in ('reached_positive', 'reached_neutral',
                                   'reached_concern', 'no_answer', 'rescheduled')),
  note          text,
  upsell        text not null default 'none'
                check (upsell in ('high', 'medium', 'low', 'none')),
  upsell_note   text,
  next_touch_on date,
  created_at    timestamptz not null default now(),
  -- A follow-up promised for before the conversation happened is a typo.
  constraint touchpoint_followup_after_touch
    check (next_touch_on is null or next_touch_on >= touched_on)
);

create index mentor_touchpoints_deal_idx
  on crm.mentor_touchpoints (deal_id, touched_on desc, id desc);
create index mentor_touchpoints_mentor_idx
  on crm.mentor_touchpoints (mentor_id, touched_on desc);
create index mentor_touchpoints_upsell_idx
  on crm.mentor_touchpoints (deal_id) where upsell <> 'none';

-- Append-only at the privilege level, matching the house rule: RLS filters
-- before triggers fire, so a merely-trigger-blocked UPDATE would read as
-- success while doing nothing.
revoke update on crm.mentor_touchpoints from crm_app;

create trigger mentor_touchpoints_audit
  after insert or update or delete on crm.mentor_touchpoints
  for each row execute function crm.tg_audit();

-- ---------------------------------------------------------------------------
-- Access. "Is this a paying client?" must be answerable from inside the
-- leads/deals policies themselves, and those policies cannot query payments
-- under RLS without recursing (payments' own policy looks back at deals). The
-- two helpers below run as their definer - the schema owner - so they read
-- payments directly, answer a single boolean, and break the cycle.
-- ---------------------------------------------------------------------------
create or replace function crm.deal_is_paid(p_deal_id uuid) returns boolean
  language sql stable
  security definer
  set search_path = crm, public
as $$
  select exists (select 1 from crm.payments p where p.deal_id = p_deal_id)
$$;

create or replace function crm.is_paying_client(p_lead_id uuid) returns boolean
  language sql stable
  security definer
  set search_path = crm, public
as $$
  select exists (
    select 1
      from crm.deals d
      join crm.payments p on p.deal_id = d.id
     where d.lead_id = p_lead_id)
$$;

-- A mentor sees exactly the deals with money against them...
drop policy deals_select on crm.deals;
create policy deals_select on crm.deals
  for select using (
    crm.current_user_role() in ('admin', 'ops', 'viewer')
    or counsellor_id = crm.current_user_id()
    or setter_id = crm.current_user_id()
    or (crm.current_user_role() = 'counsellor' and team_id = crm.current_user_team())
    or (crm.current_user_role() = 'mentor' and crm.deal_is_paid(id))
  );

-- ...and exactly the leads behind those deals: name and phone of paying
-- clients, never the live pipeline.
drop policy leads_select on crm.leads;
create policy leads_select on crm.leads
  for select using (
    crm.current_user_role() in ('admin', 'ops', 'viewer')
    or caller_id = crm.current_user_id()
    or counsellor_id = crm.current_user_id()
    or (crm.current_user_role() = 'counsellor' and team_id = crm.current_user_team())
    or (crm.current_user_role() = 'mentor' and crm.is_paying_client(id))
  );

-- Mentors read the register (assignment, subscription end); writing MITC/KYC
-- stays a counsellor/admin act.
drop policy advisory_read on crm.advisory_checkpoints;
create policy advisory_read on crm.advisory_checkpoints
  for select using (
    crm.current_user_role() in ('admin', 'ops', 'counsellor', 'viewer', 'mentor'));

alter table crm.mentor_touchpoints enable row level security;

-- Deal visibility carries the fence: mentors reach paid deals only, a
-- counsellor their team, admin/ops/viewer everything. Callers are excluded
-- outright - post-sale relationship notes are not floor reading.
create policy mentor_touchpoints_select on crm.mentor_touchpoints
  for select using (
    crm.current_user_role() <> 'caller' and crm.can_see_deal(deal_id)
  );

-- A touchpoint is signed work: you log it as yourself or not at all.
create policy mentor_touchpoints_insert on crm.mentor_touchpoints
  for insert with check (
    mentor_id = crm.current_user_id()
    and crm.current_user_role() in ('mentor', 'admin', 'ops')
    and crm.can_see_deal(deal_id)
  );

-- ---------------------------------------------------------------------------
-- The book: one row per paying client with everything the tab shows.
-- Health is DERIVED, never stored - the rules live here and are documented
-- word-for-word in the training module:
--
--   RED    last outcome was "concern raised"; or never touched and first
--          payment is over `mentor.untouched_red_days` old; or last touch is
--          over `mentor.health_red_days` old; or a promised follow-up is more
--          than `mentor.followup_grace_days` overdue.
--   AMBER  never touched (still inside the untouched window); or last touch
--          is over `mentor.health_amber_days` old; or last outcome was
--          "no answer" / "rescheduled"; or a follow-up is due or slightly
--          overdue.
--   GREEN  everything else: touched recently, went fine, nothing overdue.
-- ---------------------------------------------------------------------------
create or replace view crm.v_mentor_book as
with paid as (
  select d.id as deal_id, d.lead_id, d.product_id, d.counsellor_id,
         d.status as deal_status, d.booked_at,
         sum(p.amount)  as paid_amount,
         min(p.paid_at) as first_paid_at,
         max(p.paid_at) as last_paid_at
    from crm.deals d
    join crm.payments p on p.deal_id = d.id
   group by d.id
),
last_tp as (
  select distinct on (t.deal_id)
         t.deal_id, t.touched_on, t.channel, t.outcome, t.next_touch_on
    from crm.mentor_touchpoints t
   order by t.deal_id, t.touched_on desc, t.id desc
),
last_upsell as (
  select distinct on (t.deal_id)
         t.deal_id, t.upsell, t.upsell_note, t.touched_on as upsell_on
    from crm.mentor_touchpoints t
   where t.upsell <> 'none'
   order by t.deal_id, t.touched_on desc, t.id desc
),
tp_counts as (
  select deal_id, count(*)::int as touch_count
    from crm.mentor_touchpoints group by deal_id
)
select
  pd.deal_id, l.id as lead_id, l.full_name, l.phone_e164,
  pr.name as product, pd.paid_amount, pd.first_paid_at, pd.last_paid_at,
  ac.mentor_id, mu.full_name as mentor_name,
  cu.full_name as counsellor_name,
  ac.subscription_ends_at,
  case
    when pd.deal_status = 'refunded' then 'refunded'
    when ac.subscription_ends_at is not null and ac.subscription_ends_at < now()
      then 'expired'
    else 'active'
  end as client_status,
  lt.touched_on as last_touch_on, lt.channel as last_channel,
  lt.outcome as last_outcome, lt.next_touch_on,
  coalesce(tc.touch_count, 0) as touch_count,
  -- Days since the relationship was last worked; a virgin client counts from
  -- the day their money arrived, so "not touched in N days" means one thing.
  coalesce(crm.ist_date(now()) - lt.touched_on,
           crm.ist_date(now()) - crm.ist_date(pd.first_paid_at)) as days_since_touch,
  us.upsell as upsell_potential, us.upsell_note, us.upsell_on,
  case
    when lt.outcome = 'reached_concern' then 'red'
    when lt.touched_on is null
         and crm.ist_date(pd.first_paid_at)
             <= crm.ist_date(now()) - crm.setting_int('mentor.untouched_red_days', 7)
      then 'red'
    when lt.touched_on is not null
         and lt.touched_on
             <= crm.ist_date(now()) - crm.setting_int('mentor.health_red_days', 21)
      then 'red'
    when lt.next_touch_on is not null
         and lt.next_touch_on
             < crm.ist_date(now()) - crm.setting_int('mentor.followup_grace_days', 3)
      then 'red'
    when lt.touched_on is null then 'amber'
    when lt.touched_on
         <= crm.ist_date(now()) - crm.setting_int('mentor.health_amber_days', 10)
      then 'amber'
    when lt.outcome in ('no_answer', 'rescheduled') then 'amber'
    when lt.next_touch_on is not null and lt.next_touch_on <= crm.ist_date(now())
      then 'amber'
    else 'green'
  end as health
from paid pd
join crm.leads l on l.id = pd.lead_id
join crm.products pr on pr.id = pd.product_id
left join crm.advisory_checkpoints ac on ac.deal_id = pd.deal_id
left join crm.users mu on mu.id = ac.mentor_id
left join crm.users cu on cu.id = pd.counsellor_id
left join last_tp lt on lt.deal_id = pd.deal_id
left join last_upsell us on us.deal_id = pd.deal_id
left join tp_counts tc on tc.deal_id = pd.deal_id;

alter view crm.v_mentor_book set (security_invoker = true);
grant select on crm.v_mentor_book to crm_app;
