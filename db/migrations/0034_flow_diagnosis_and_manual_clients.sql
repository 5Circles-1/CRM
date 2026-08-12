-- 0034_flow_diagnosis_and_manual_clients.sql
--
-- Three things the floor asked for after using the last release:
--
--   1. "83 leads waiting with no caller" is a number, not an answer. The
--      screen said leads were held and would hand out "as soon as an eligible
--      caller is on the floor" - while two callers were plainly on the floor.
--      Both statements were true, because the waiting leads belonged to a
--      DIFFERENT team from the two who were working. Nothing showed that.
--      v_lead_flow_waiting names the blocked team and the exact reason.
--
--   2. The advisory register needs a third checkpoint - added to the client
--      group - alongside MITC and KYC.
--
--   3. Both the advisory register and the mentor book are fed automatically
--      from payments. That is right, and it must stay right - but there has
--      to be a way to enter a client who exists outside that flow.

-- ---------------------------------------------------------------------------
-- 1. Why are leads waiting? Per team, with the first rule that stops them.
-- ---------------------------------------------------------------------------
create or replace view crm.v_lead_flow_waiting as
with waiting as (
  select coalesce(team_id, '00000000-0000-0000-0000-000000000000'::uuid) as team_key,
         team_id,
         count(*)::int      as waiting,
         min(created_at)    as oldest_at
    from crm.leads
   where caller_id is null and status in ('new', 'working')
   group by team_id
),
staff as (
  select tm.team_id,
         count(*) filter (where u.is_active)::int                              as callers,
         count(*) filter (where u.is_active and crm.is_on_shift(u.id))::int    as on_floor,
         count(*) filter (where u.is_active and crm.is_on_shift(u.id)
                            and crm.tier_of(u.id) <> 'restricted')::int        as eligible_now
    from crm.team_memberships tm
    join crm.users u on u.id = tm.user_id
   where tm.period @> current_date and u.role = 'caller'
   group by tm.team_id
)
select
  w.team_id,
  coalesce(t.name, 'No team')            as team_name,
  w.waiting,
  w.oldest_at,
  coalesce(s.callers, 0)                 as callers,
  coalesce(s.on_floor, 0)                as on_floor,
  coalesce(s.eligible_now, 0)            as eligible_now,
  -- The first rule that stops these leads moving. Ordered most-specific first
  -- so the reason names something the reader can actually go and change.
  case
    when w.team_id is null              then 'no_team'
    when coalesce(s.callers, 0) = 0     then 'team_has_no_callers'
    when coalesce(s.on_floor, 0) = 0    then 'nobody_on_shift'
    when coalesce(s.eligible_now, 0) = 0 then 'all_on_floor_restricted'
    else 'engine_should_be_assigning'
  end                                    as reason
from waiting w
left join crm.teams t on t.id = w.team_id
left join staff s on s.team_id = w.team_id
order by w.waiting desc;

-- Definer rights, deliberately, for exactly the reason v_lead_flow_summary
-- already carries: a counsellor's RLS cannot see UNASSIGNED leads, so under
-- invoker rights this view would report "nothing waiting" to precisely the
-- person trying to find out where the leads went. It exposes per-team counts
-- and a reason code - no lead data crosses a team boundary.
grant select on crm.v_lead_flow_waiting to crm_app;

comment on view crm.v_lead_flow_waiting is
  'Unassigned leads grouped by team, with the first rule stopping each group.
   "nobody_on_shift" on one team while another team works is the case that
   made the old floor-wide total actively misleading.';

-- The sweep is normally run by the scheduler. An admin needs to be able to
-- press it by hand when they have just fixed the cause - waiting up to a
-- minute to find out whether the fix worked is how people conclude the
-- feature is broken.
create or replace function crm.assign_pending_leads_now(p_limit int default 500)
  returns int
  language plpgsql
  security definer
  set search_path = crm, public
as $$
declare
  v_role text := crm.current_user_role();
begin
  if v_role not in ('admin', 'ops') then
    raise exception 'only an admin may force distribution'
      using errcode = 'insufficient_privilege';
  end if;
  return crm.assign_pending_leads(p_limit);
end
$$;

revoke execute on function crm.assign_pending_leads_now(int) from public;
grant execute on function crm.assign_pending_leads_now(int) to crm_app;

-- ---------------------------------------------------------------------------
-- 2. The third advisory checkpoint, and how a client arrived.
-- ---------------------------------------------------------------------------
alter table crm.advisory_checkpoints
  add column if not exists group_added_at timestamptz,
  add column if not exists group_added_by uuid references crm.users(id) on delete set null;

-- Declared here because both views below read it; the function that sets it
-- follows in section 3.
alter table crm.deals
  add column if not exists is_manual boolean not null default false;

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
  -- One number for "is this client's paperwork finished".
  ((ac.mitc_done_at is not null)::int
   + (ac.kyc_done_at is not null)::int
   + (ac.group_added_at is not null)::int)                       as checkpoints_done,
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
left join crm.users mu on mu.id = ac.mentor_id
join lateral (
  select sum(amount) as paid, max(paid_at) as last_paid_at
    from crm.payments where deal_id = d.id
) pay on true
where coalesce(pay.paid, 0) > 0;

alter view crm.v_advisory_clients set (security_invoker = true);
grant select on crm.v_advisory_clients to crm_app;

-- ---------------------------------------------------------------------------
-- 3. Adding a client by hand.
--
-- The automatic path stays exactly as it is: money recorded against a deal
-- puts the client in both books, and that is what guarantees nobody is
-- forgotten. This is the escape hatch for a client who exists outside it -
-- an offline sale, a migrated record, a payment taken before the CRM.
--
-- It is deliberately not a free-text row. It creates the same real objects
-- the normal path creates - a lead, a deal, a payment - so the client appears
-- everywhere with the same shape, counts in the same totals, and carries the
-- same audit trail. `is_manual` marks how they arrived, for honesty in
-- reporting, not to give them a separate life.
-- ---------------------------------------------------------------------------
create or replace function crm.add_manual_client(
  p_full_name  text,
  p_phone      text,
  p_product_id uuid,
  p_amount     numeric,
  p_paid_at    timestamptz default now(),
  p_mode       text default 'other',
  p_mentor_id  uuid default null,
  p_note       text default null
) returns uuid
  language plpgsql
  security definer
  set search_path = crm, public
as $$
declare
  v_role  text := crm.current_user_role();
  v_actor uuid := crm.current_user_id();
  v_phone text;
  v_lead  uuid;
  v_deal  uuid;
begin
  if v_role not in ('admin', 'ops', 'counsellor') then
    raise exception 'only an admin, ops or counsellor may add a client by hand'
      using errcode = 'insufficient_privilege';
  end if;
  if p_amount is null or p_amount <= 0 then
    raise exception 'a client is someone who has paid - the amount must be positive'
      using errcode = 'check_violation';
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
    values (null, p_full_name, v_phone, 'won', now(), v_actor,
            crm.team_of(v_actor, current_date))
    returning id into v_lead;
  else
    update crm.leads
       set status = 'won',
           closed_at = coalesce(closed_at, now()),
           full_name = coalesce(full_name, p_full_name),
           next_action_at = null,
           updated_at = now()
     where id = v_lead;
  end if;

  -- One open deal per lead is a schema rule (deals_one_open_per_lead_idx).
  -- Hitting it raw produces "duplicate key value violates unique constraint",
  -- which tells the person at the desk nothing. Say what is actually true and
  -- what to do about it.
  if exists (select 1 from crm.deals d where d.lead_id = v_lead and d.status = 'booked') then
    raise exception
      'this person already has an open deal - record the payment against that deal instead, or close it first'
      using errcode = 'unique_violation';
  end if;

  insert into crm.deals (lead_id, product_id, counsellor_id, team_id,
                         booked_amount, booked_at, is_manual)
  values (v_lead, p_product_id, v_actor, crm.team_of(v_actor, current_date),
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
          jsonb_build_object('deal_id', v_deal, 'amount', p_amount, 'note', p_note));

  return v_deal;
end
$$;

revoke execute on function crm.add_manual_client(text, text, uuid, numeric, timestamptz, text, uuid, text) from public;
grant execute on function crm.add_manual_client(text, text, uuid, numeric, timestamptz, text, uuid, text) to crm_app;

comment on function crm.add_manual_client is
  'Escape hatch for a paying client who arrived outside the normal flow. Creates
   a real lead, deal and payment so the client behaves like every other one,
   marked is_manual for honest reporting. Reuses an existing lead on the same
   phone rather than duplicating a person.';

-- The mentor book gains the same two columns so the Mentors tab can show how a
-- client arrived and which product they actually bought.
drop view if exists crm.v_mentor_book;
create view crm.v_mentor_book as
with paid as (
  select d.id as deal_id, d.lead_id, d.product_id, d.counsellor_id,
         d.status as deal_status, d.booked_at, d.is_manual,
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
  pd.is_manual,
  ac.mentor_id, mu.full_name as mentor_name,
  cu.full_name as counsellor_name,
  ac.subscription_ends_at,
  ac.mitc_done_at, ac.kyc_done_at, ac.group_added_at,
  case
    when pd.deal_status = 'refunded' then 'refunded'
    when ac.subscription_ends_at is not null and ac.subscription_ends_at < now()
      then 'expired'
    else 'active'
  end as client_status,
  lt.touched_on as last_touch_on, lt.channel as last_channel,
  lt.outcome as last_outcome, lt.next_touch_on,
  coalesce(tc.touch_count, 0) as touch_count,
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
