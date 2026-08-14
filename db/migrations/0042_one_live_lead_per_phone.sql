-- 0042_one_live_lead_per_phone.sql
--
-- The floor found the same person in both teams' books. They were right, and
-- it was not the display lying - the database genuinely held two live leads
-- on one phone number. Two holes let that happen:
--
--   1. The ingest dedupe window (lead.dedupe_window_days, 90) was measured
--      against created_at ONLY. A lead parked in the re-tap pool or nurture
--      for four months is still a live lead - but when that person filled the
--      Meta form again, their old row was outside the window, so the worker
--      created a brand-new lead. Distribution alternates teams, so the copy
--      landed on the OTHER team about half the time. (Fixed in the worker:
--      a still-live lead now matches at ANY age; the window only applies to
--      closed ones, where a fresh enquiry genuinely is a fresh lead.)
--
--   2. Nothing in the schema forbade it. leads.phone_e164 carried a plain,
--      NON-unique index, and the worker's dedupe was a SELECT followed by an
--      INSERT in separate row-transactions - two overlapping syncs could both
--      look, both find nothing, and both insert. The API error table even
--      translates a constraint named leads_phone_e164_key that never existed.
--
-- This migration first merges the duplicates production may already hold,
-- then adds the guarantee that was always meant to be there: at most ONE
-- live lead per phone number. Terminal rows (won, lost, invalid, handed_off)
-- are history and never blocked - a person who was lost last year and
-- enquires again deserves a fresh lead.

-- ---------------------------------------------------------------------------
-- 1. Merge the duplicates that already exist.
--
-- Keep the row the floor has actually worked: most call attempts, then the
-- one that has an owner, then the oldest. The others are closed as invalid
-- with a note and a pair of events tying both rows together - history is
-- never deleted here, so every dial on the closed copy stays readable, and
-- the kept lead absorbs the re-enquiry signal.
-- ---------------------------------------------------------------------------
do $$
declare
  v_phone  text;
  v_keep   uuid;
  v_dup    record;
  v_closed int := 0;
begin
  for v_phone in
    select phone_e164
      from crm.leads
     where status in ('new', 'working', 'callback', 'qualified', 'negotiation', 'nurture')
     group by phone_e164
    having count(*) > 1
  loop
    select l.id
      into v_keep
      from crm.leads l
      left join lateral (
        select count(*) as n from crm.call_attempts ca where ca.lead_id = l.id
      ) ca on true
     where l.phone_e164 = v_phone
       and l.status in ('new', 'working', 'callback', 'qualified', 'negotiation', 'nurture')
     order by ca.n desc, (l.caller_id is not null) desc, l.created_at asc
     limit 1;

    for v_dup in
      select id, reenquiry_count
        from crm.leads
       where phone_e164 = v_phone and id <> v_keep
         and status in ('new', 'working', 'callback', 'qualified', 'negotiation', 'nurture')
    loop
      update crm.leads
         set status = 'invalid',
             closed_at = coalesce(closed_at, now()),
             next_action_at = null,
             next_action_note = 'Duplicate of another lead record - closed by the de-duplication migration',
             pool = null,
             updated_at = now()
       where id = v_dup.id;

      -- The kept row inherits the signal: every duplicate row existed because
      -- this person enquired again.
      update crm.leads
         set reenquiry_count = reenquiry_count + v_dup.reenquiry_count + 1,
             updated_at = now()
       where id = v_keep;

      insert into crm.lead_events (lead_id, event_type, payload)
      values (v_dup.id, 'duplicate_closed',
              jsonb_build_object('kept_lead', v_keep, 'phone', v_phone)),
             (v_keep, 'duplicate_absorbed',
              jsonb_build_object('closed_lead', v_dup.id, 'phone', v_phone));

      v_closed := v_closed + 1;
    end loop;
  end loop;

  raise notice 'duplicate live leads closed: %', v_closed;
end $$;

-- ---------------------------------------------------------------------------
-- 2. The guarantee: one live lead per phone number, enforced by the schema,
--    not by application code that can race with itself.
-- ---------------------------------------------------------------------------
create unique index leads_one_live_per_phone_idx
  on crm.leads (phone_e164)
  where status in ('new', 'working', 'callback', 'qualified', 'negotiation', 'nurture');

comment on index crm.leads_one_live_per_phone_idx is
  'One human, one live lead. Re-enquiries attach to the existing live row
   (any age - parked pools hold leads far past the dedupe window); a fresh
   lead on the same number is only possible once every earlier one is
   terminal (won, lost, invalid, handed_off). This is what keeps one person
   out of both teams'' books at once.';

-- ---------------------------------------------------------------------------
-- 3. add_manual_client picks the LIVE lead when one exists.
--
-- It reused the OLDEST lead on the phone, which could be a long-dead row -
-- marking that one won while a newer live lead kept sitting in a caller's
-- pipeline would leave the floor chasing a person who already paid. One line
-- changes: prefer the live row, then the newest. Everything else is 0041's
-- body verbatim.
-- ---------------------------------------------------------------------------
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

  -- Reuse the person's LIVE lead if they have one - that is the row a caller
  -- is actively working, and paying must take it out of the pipeline. Only
  -- when every lead is terminal fall back to the newest of those.
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
