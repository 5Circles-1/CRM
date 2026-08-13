-- 0040_who_converted_and_where_from.sql
--
-- The punch-in met its first real payment and came up short. An admin typed a
-- client's name, no open deal matched, and the modal's answer was "go to
-- Advisory clients and use Add a client there". A dead end, at the exact
-- moment somebody is holding money.
--
-- Two changes:
--
--   1. Entering a client by hand must also say WHO CONVERTED them - which
--      counsellor, and therefore which team - and WHAT THE LEAD SOURCE was.
--      Until now the deal was silently credited to whoever happened to be
--      typing, and the lead carried no source at all. Both were wrong for the
--      common case: an admin doing the data entry for a counsellor's sale.
--
--   2. The advisory register exposes both, so "who converted this client,
--      from which team, and where did the lead come from" is a column, not
--      an investigation.
--
-- The Collections screen wires the same function into the punch-in as a
-- direct "new client" path, so both doors lead to the same audited objects:
-- a real lead, a real deal, a real payment.

-- The parameter list grows, which to Postgres is a NEW overload; the old one
-- must go or every call with defaults becomes ambiguous.
drop function if exists crm.add_manual_client(text, text, uuid, numeric, timestamptz, text, uuid, text);

create or replace function crm.add_manual_client(
  p_full_name     text,
  p_phone         text,
  p_product_id    uuid,
  p_amount        numeric,
  p_paid_at       timestamptz default now(),
  p_mode          text default 'other',
  p_mentor_id     uuid default null,
  p_note          text default null,
  p_counsellor_id uuid default null,   -- who converted them; null = the person typing
  p_source_id     uuid default null    -- where the lead came from; null = 'Manual entry'
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
begin
  if v_role not in ('admin', 'ops', 'counsellor') then
    raise exception 'only an admin, ops or counsellor may add a client by hand'
      using errcode = 'insufficient_privilege';
  end if;
  if p_amount is null or p_amount <= 0 then
    raise exception 'a client is someone who has paid - the amount must be positive'
      using errcode = 'check_violation';
  end if;

  -- Who gets the conversion. Defaults to the actor, which keeps the old
  -- behaviour for a counsellor entering their own sale; an admin punching in
  -- for the floor names the counsellor, and the deal (and its team) follow
  -- that person - conversion credit and collections accountability travel
  -- together, because the closer chases the instalments.
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

  -- Where the lead came from. Defaults to the Manual entry source rather than
  -- nothing, so source reporting never has an unexplained hole.
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
    -- An existing lead keeps its own history: its source stays what it was
    -- (filled in only if it never had one), and its caller is untouched.
    update crm.leads
       set status = 'won',
           closed_at = coalesce(closed_at, now()),
           full_name = coalesce(full_name, p_full_name),
           source_id = coalesce(source_id, v_source),
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

revoke execute on function crm.add_manual_client(text, text, uuid, numeric, timestamptz, text, uuid, text, uuid, uuid) from public;
grant execute on function crm.add_manual_client(text, text, uuid, numeric, timestamptz, text, uuid, text, uuid, uuid) to crm_app;

comment on function crm.add_manual_client is
  'Escape hatch for a paying client who arrived outside the normal flow. Creates
   a real lead, deal and payment so the client behaves like every other one,
   marked is_manual for honest reporting. Names who converted them (the deal and
   team follow that counsellor) and the lead source. Reuses an existing lead on
   the same phone rather than duplicating a person.';

-- ---------------------------------------------------------------------------
-- The register answers the questions instead of prompting them: who converted,
-- from which team, and where the lead came from.
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
  -- One number for "is this client's paperwork finished".
  ((ac.mitc_done_at is not null)::int
   + (ac.kyc_done_at is not null)::int
   + (ac.group_added_at is not null)::int)                       as checkpoints_done,
  case
    when d.status = 'refunded' then 'refunded'
    when ac.subscription_ends_at is not null and ac.subscription_ends_at < now() then 'expired'
    else 'active'
  end as client_status,
  t.name  as team_name,
  ls.name as source
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
  'Everyone who has actually paid, with the three advisory checkpoints, who
   converted them (counsellor and team) and where the lead came from.';
