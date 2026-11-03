-- 0003_leads.sql
-- Lead sources, ingestion bookkeeping, leads, activities, and the business
-- rules: round-robin assignment, the five call outcomes, the qualified ->
-- follow-up handover, checkpoints, re-enquiries.
--
-- Every rule lives here, not in route handlers, and every refusal carries a
-- SQLSTATE the API maps to a status code - a bare RAISE is P0001, which
-- reaches the floor as "something went wrong".

-- ---------------------------------------------------------------------------
-- Sources. One row per feed: the Meta sheet, the ChatGPT sheet, Manual.
-- ---------------------------------------------------------------------------

create table crm.lead_sources (
  id              uuid primary key default gen_random_uuid(),
  name            text not null unique check (length(trim(name)) > 0),
  -- Google Sheet the ingestion worker polls; both null for manual sources.
  spreadsheet_id  text,
  worksheet_name  text,
  -- field -> column header. Unmapped fields fall back to common aliases.
  column_map      jsonb not null default '{}'::jsonb,
  is_active       boolean not null default true,
  last_synced_at  timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create trigger lead_sources_set_updated_at
  before update on crm.lead_sources
  for each row execute function crm.tg_set_updated_at();

create table crm.ingestion_runs (
  id               uuid primary key default gen_random_uuid(),
  source_id        uuid not null references crm.lead_sources(id),
  started_at       timestamptz not null default now(),
  finished_at      timestamptz,
  rows_seen        int not null default 0,
  rows_created     int not null default 0,
  rows_duplicate   int not null default 0,
  rows_quarantined int not null default 0,
  error_text       text
);

create index ingestion_runs_source_idx on crm.ingestion_runs (source_id, started_at desc);

-- Raw rows as read from the sheet. Nothing is ever dropped: a row with an
-- undialable phone is quarantined with a reason, because a mistyped number is
-- still a lead someone paid for.
create table crm.ingested_rows (
  id             uuid primary key default gen_random_uuid(),
  run_id         uuid references crm.ingestion_runs(id),
  source_id      uuid not null references crm.lead_sources(id),
  source_row_key text not null,
  payload_hash   text not null,
  payload        jsonb not null,
  status         text not null check (status in ('accepted', 'duplicate', 'quarantined')),
  reject_reason  text,
  lead_id        uuid,
  created_at     timestamptz not null default now(),

  -- The idempotency key: re-reading the whole sheet can never duplicate a lead.
  constraint ingested_rows_idempotent unique (source_id, source_row_key, payload_hash)
);

create index ingested_rows_quarantine_idx on crm.ingested_rows (source_id)
  where status = 'quarantined';

-- ---------------------------------------------------------------------------
-- Leads.
-- ---------------------------------------------------------------------------

create table crm.leads (
  id            uuid primary key default gen_random_uuid(),
  source_id     uuid not null references crm.lead_sources(id),

  full_name     text,
  phone_e164    text not null,
  phone_raw     text,
  email         citext,
  city          text,
  campaign      text,
  -- Sheet columns nobody mapped yet - kept, never thrown away.
  extra         jsonb not null default '{}'::jsonb,

  stage         crm.lead_stage not null default 'new',
  assigned_to   uuid references crm.users(id),

  -- The anti-leakage rule: an open lead always says when it is next touched.
  -- The Reminders screen, the "due today" buckets and the popup all read this
  -- one column - there is no separate alerts engine.
  next_follow_up_at timestamptz,
  follow_up_note    text,

  last_outcome     crm.call_outcome,
  last_outcome_at  timestamptz,
  call_count       int not null default 0,
  -- Consecutive not-answered/switched-off, shown as "not answered ×3".
  na_streak        int not null default 0,
  -- How many times this phone number has enquired (1 = the original).
  enquiry_count    int not null default 1,

  -- Webinar-funnel checkpoints. Generic names: any invite/confirmation flow.
  template_sent_at timestamptz,
  confirmed_at     timestamptz,

  qualified_at  timestamptz,
  converted_at  timestamptz,
  closed_at     timestamptz,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  constraint leads_open_requires_next_action check (
    stage in ('converted', 'not_qualified') or next_follow_up_at is not null
  )
);

-- One live lead per phone number. A second enquiry from the same phone
-- attaches to the live lead; the index makes a race error loudly instead of
-- duplicating quietly.
create unique index leads_one_live_per_phone_idx on crm.leads (phone_e164)
  where stage in ('new', 'calling', 'qualified');

create index leads_assigned_stage_idx on crm.leads (assigned_to, stage);
create index leads_stage_idx          on crm.leads (stage);
create index leads_due_idx            on crm.leads (next_follow_up_at)
  where stage in ('new', 'calling', 'qualified');
create index leads_received_idx       on crm.leads (crm.ist_date(created_at));
create index leads_phone_idx          on crm.leads (phone_e164);
create index leads_name_trgm_idx      on crm.leads using gin (full_name gin_trgm_ops);

create trigger leads_set_updated_at
  before update on crm.leads
  for each row execute function crm.tg_set_updated_at();

-- ---------------------------------------------------------------------------
-- Activities: one append-only timeline per lead. "Who has done what follow-ups
-- and in what way" is answered here and nowhere else.
-- ---------------------------------------------------------------------------

create table crm.activities (
  id          uuid primary key default gen_random_uuid(),
  lead_id     uuid not null references crm.leads(id),
  -- NULL for the system (ingestion, automatic handover bookkeeping).
  user_id     uuid references crm.users(id),
  kind        crm.activity_kind not null,
  outcome     crm.call_outcome,
  note        text,
  meta        jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

create index activities_lead_idx on crm.activities (lead_id, created_at desc);
create index activities_user_idx on crm.activities (user_id, created_at desc);
create index activities_day_idx  on crm.activities (crm.ist_date(created_at), kind);

create or replace function crm.tg_append_only() returns trigger
  language plpgsql
as $$
begin
  raise exception 'crm.% is append-only', tg_table_name using errcode = '38000';
end
$$;

create trigger activities_append_only
  before update or delete on crm.activities
  for each row execute function crm.tg_append_only();

-- ---------------------------------------------------------------------------
-- Assignment: least-loaded-today among active callers, rotation order breaking
-- ties - which is exactly A-B-A-B while everyone is present and level, and
-- never starves someone who took a day off. No callers on the books -> the
-- follow-up person; nobody at all -> NULL, and the lead shows loudly as
-- "Unassigned" until the admin picks someone. Admins never receive leads
-- automatically.
-- ---------------------------------------------------------------------------

-- VOLATILE on purpose: a stable function reads the statement snapshot, so a
-- multi-row INSERT would count none of its own earlier rows and pile the whole
-- batch on one caller.
create or replace function crm.assign_next_caller() returns uuid
  language sql volatile
as $$
  select u.id
    from crm.users u
    left join lateral (
      select count(*) as today
        from crm.leads l
       where l.assigned_to = u.id
         and crm.ist_date(l.created_at) = crm.ist_date(now())
    ) c on true
   where u.is_active and u.role in ('caller', 'followup')
   order by (u.role = 'caller') desc, c.today asc, u.rotation_order asc, u.full_name asc
   limit 1
$$;

create or replace function crm.tg_lead_defaults() returns trigger
  language plpgsql
as $$
begin
  if new.phone_e164 is null and new.phone_raw is not null then
    new.phone_e164 := crm.normalise_phone(new.phone_raw);
  end if;
  if new.assigned_to is null then
    new.assigned_to := crm.assign_next_caller();
  end if;
  -- A fresh lead is due now: it appears at the top of its owner's list
  -- immediately, with no separate "immediate priority" machinery.
  if new.next_follow_up_at is null and new.stage in ('new', 'calling', 'qualified') then
    new.next_follow_up_at := now();
  end if;
  return new;
end
$$;

create trigger leads_defaults
  before insert on crm.leads
  for each row execute function crm.tg_lead_defaults();

create or replace function crm.tg_lead_created() returns trigger
  language plpgsql
as $$
begin
  insert into crm.activities (lead_id, user_id, kind, note, meta)
  values (
    new.id,
    crm.current_user_id(),
    'system',
    'Lead received',
    jsonb_build_object('source_id', new.source_id, 'assigned_to', new.assigned_to)
  );
  return new;
end
$$;

create trigger leads_created
  after insert on crm.leads
  for each row execute function crm.tg_lead_created();

-- ---------------------------------------------------------------------------
-- The write paths. Routes call these and map SQLSTATEs; they never
-- re-implement the rules.
-- ---------------------------------------------------------------------------

-- Who is working qualified leads: the active follow-up person carrying the
-- fewest open qualified leads (rotation order breaks ties). NULL when nobody
-- holds the follow-up role - the lead then stays where it is.
create or replace function crm.next_followup_user() returns uuid
  language sql volatile
as $$
  select u.id
    from crm.users u
    left join lateral (
      select count(*) as open_q
        from crm.leads l
       where l.assigned_to = u.id and l.stage = 'qualified'
    ) c on true
   where u.is_active and u.role = 'followup'
   order by c.open_q asc, u.rotation_order asc, u.full_name asc
   limit 1
$$;

/*
 * Log a call and apply its outcome. The one way a response enters the system.
 *
 * Anyone active on the floor may log a call on any lead - on a two-to-four
 * person floor people cover each other, and the activity row records exactly
 * who did what. Ownership only moves through the qualified handover or an
 * explicit assignment, never as a side effect of helping out.
 */
create or replace function crm.log_call(
  p_lead_id uuid,
  p_outcome crm.call_outcome,
  p_note    text default null,
  p_next_at timestamptz default null
) returns uuid
  language plpgsql
as $$
declare
  v_lead    crm.leads%rowtype;
  v_me      uuid := crm.current_user_id();
  v_next    timestamptz;
  v_retry   interval := make_interval(hours => crm.setting_int('follow_up.retry_hours', 24));
  v_fu      uuid;
  v_fu_name text;
  v_act     uuid;
begin
  if not crm.is_active_user() then
    raise exception 'not signed in as an active user' using errcode = '42501';
  end if;

  select * into v_lead from crm.leads where id = p_lead_id for update;
  if not found then
    raise exception 'lead not found' using errcode = 'P0002';
  end if;

  if p_outcome = 'call_back' and p_next_at is null then
    raise exception 'a call-back needs the date and time the client asked for'
      using errcode = '23514';
  end if;

  if v_lead.stage = 'converted' and p_outcome = 'not_qualified' then
    raise exception 'this client is already converted - undo the conversion first (admin) if that was a mistake'
      using errcode = '23514';
  end if;

  v_next := coalesce(p_next_at, now() + v_retry);

  update crm.leads
     set last_outcome    = p_outcome,
         last_outcome_at = now(),
         call_count      = call_count + 1,
         na_streak       = case when p_outcome in ('not_answered', 'switched_off')
                                then na_streak + 1 else 0 end,
         follow_up_note  = coalesce(nullif(trim(p_note), ''), follow_up_note)
   where id = p_lead_id;

  if p_outcome = 'not_qualified' then
    update crm.leads
       set stage = 'not_qualified',
           closed_at = now(),
           next_follow_up_at = null
     where id = p_lead_id;

  elsif p_outcome = 'qualified' then
    update crm.leads
       set stage = case when stage = 'converted' then stage else 'qualified' end,
           qualified_at = coalesce(qualified_at, now()),
           next_follow_up_at = v_next
     where id = p_lead_id;

    -- The handover: a caller's qualified lead passes to the follow-up person.
    -- A follow-up user's (or admin's) own qualified call keeps the lead.
    if v_lead.stage in ('new', 'calling') then
      select u.id, u.full_name into v_fu, v_fu_name
        from crm.users u where u.id = crm.next_followup_user();
      if v_fu is not null and v_fu is distinct from v_lead.assigned_to then
        update crm.leads set assigned_to = v_fu where id = p_lead_id;
        insert into crm.activities (lead_id, user_id, kind, note, meta)
        values (p_lead_id, v_me, 'assign',
                'Qualified - passed to ' || v_fu_name || ' for follow-up',
                jsonb_build_object('from', v_lead.assigned_to, 'to', v_fu, 'auto', true));
      end if;
    end if;

  else
    -- call_back / not_answered / switched_off keep the lead live.
    update crm.leads
       set stage = case when stage = 'new' then 'calling' else stage end,
           next_follow_up_at = v_next,
           closed_at = null
     where id = p_lead_id;
  end if;

  insert into crm.activities (lead_id, user_id, kind, outcome, note, meta)
  values (p_lead_id, v_me, 'call', p_outcome, nullif(trim(p_note), ''),
          jsonb_build_object('next_follow_up_at', case when p_outcome = 'not_qualified' then null else v_next end))
  returning id into v_act;

  return v_act;
end
$$;

/*
 * Checkpoints: invite/template sent, attendance confirmed, converted.
 * Converting is a checkpoint, never a call outcome, so the money is recorded
 * exactly once. Undoing a conversion is admin-only.
 */
create or replace function crm.set_checkpoint(
  p_lead_id uuid,
  p_kind    text,
  p_on      boolean
) returns void
  language plpgsql
as $$
declare
  v_lead crm.leads%rowtype;
  v_me   uuid := crm.current_user_id();
  v_label text;
begin
  if not crm.is_active_user() then
    raise exception 'not signed in as an active user' using errcode = '42501';
  end if;
  if p_kind not in ('template_sent', 'confirmed', 'converted') then
    raise exception 'unknown checkpoint "%"', p_kind using errcode = '23514';
  end if;

  select * into v_lead from crm.leads where id = p_lead_id for update;
  if not found then
    raise exception 'lead not found' using errcode = 'P0002';
  end if;

  if p_kind = 'template_sent' then
    update crm.leads set template_sent_at = case when p_on then coalesce(template_sent_at, now()) end
     where id = p_lead_id;
    v_label := case when p_on then 'Invite sent' else 'Invite-sent unmarked' end;

  elsif p_kind = 'confirmed' then
    update crm.leads set confirmed_at = case when p_on then coalesce(confirmed_at, now()) end
     where id = p_lead_id;
    v_label := case when p_on then 'Confirmed' else 'Confirmation unmarked' end;

  elsif p_on then
    if v_lead.stage = 'not_qualified' then
      raise exception 'this lead is closed as not qualified - reopen it before converting'
        using errcode = '23514';
    end if;
    update crm.leads
       set stage = 'converted',
           converted_at = coalesce(converted_at, now()),
           qualified_at = coalesce(qualified_at, now()),
           next_follow_up_at = null,
           closed_at = null
     where id = p_lead_id;
    v_label := 'Converted';

  else
    if not crm.is_admin() then
      raise exception 'only an admin can undo a conversion' using errcode = '42501';
    end if;
    update crm.leads
       set stage = 'qualified',
           converted_at = null,
           next_follow_up_at = now() + interval '1 day'
     where id = p_lead_id;
    v_label := 'Conversion undone';
  end if;

  insert into crm.activities (lead_id, user_id, kind, note, meta)
  values (p_lead_id, v_me, 'checkpoint', v_label,
          jsonb_build_object('checkpoint', p_kind, 'on', p_on));
end
$$;

/*
 * Move a lead to someone by name. An admin may give any lead to any active
 * user; anyone else may only take an UNASSIGNED lead for themselves - leads
 * never get pushed onto a colleague.
 */
create or replace function crm.assign_lead(p_lead_id uuid, p_user_id uuid)
  returns void
  language plpgsql
as $$
declare
  v_lead crm.leads%rowtype;
  v_me   uuid := crm.current_user_id();
  v_from text;
  v_to   text;
begin
  if not crm.is_active_user() then
    raise exception 'not signed in as an active user' using errcode = '42501';
  end if;

  select * into v_lead from crm.leads where id = p_lead_id for update;
  if not found then
    raise exception 'lead not found' using errcode = 'P0002';
  end if;

  if not exists (select 1 from crm.users u where u.id = p_user_id and u.is_active) then
    raise exception 'that person is not an active user' using errcode = '23514';
  end if;

  if not crm.is_admin() then
    if v_lead.assigned_to is not null then
      raise exception 'only an admin can move a lead that already has an owner'
        using errcode = '42501';
    end if;
    if p_user_id <> v_me then
      raise exception 'you can only take an unassigned lead for yourself'
        using errcode = '42501';
    end if;
  end if;

  if v_lead.assigned_to = p_user_id then
    return; -- nothing to do
  end if;

  select full_name into v_from from crm.users where id = v_lead.assigned_to;
  select full_name into v_to   from crm.users where id = p_user_id;

  update crm.leads set assigned_to = p_user_id where id = p_lead_id;

  insert into crm.activities (lead_id, user_id, kind, note, meta)
  values (p_lead_id, v_me, 'assign',
          case when v_from is null then 'Assigned to ' || v_to
               else 'Moved from ' || v_from || ' to ' || v_to end,
          jsonb_build_object('from', v_lead.assigned_to, 'to', p_user_id));
end
$$;

/* Reopen a lead closed as not qualified. Logged, visible, allowed to anyone
 * active - the common case is undoing one's own misclick within the minute. */
create or replace function crm.reopen_lead(p_lead_id uuid)
  returns void
  language plpgsql
as $$
declare
  v_lead crm.leads%rowtype;
begin
  if not crm.is_active_user() then
    raise exception 'not signed in as an active user' using errcode = '42501';
  end if;

  select * into v_lead from crm.leads where id = p_lead_id for update;
  if not found then
    raise exception 'lead not found' using errcode = 'P0002';
  end if;
  if v_lead.stage <> 'not_qualified' then
    raise exception 'only a not-qualified lead can be reopened' using errcode = '23514';
  end if;

  update crm.leads
     set stage = case when qualified_at is not null then 'qualified'::crm.lead_stage
                      else 'calling'::crm.lead_stage end,
         closed_at = null,
         next_follow_up_at = now()
   where id = p_lead_id;

  insert into crm.activities (lead_id, user_id, kind, note)
  values (p_lead_id, crm.current_user_id(), 'system', 'Reopened');
end
$$;

/*
 * A repeat enquiry from a phone number we already have. Never a second lead:
 * the enquiry attaches to the existing one, pulls its follow-up to NOW, and
 * reopens it if it was closed. The ingestion worker calls this.
 */
create or replace function crm.attach_enquiry(
  p_lead_id   uuid,
  p_source_id uuid,
  p_payload   jsonb default '{}'::jsonb
) returns void
  language plpgsql
as $$
declare
  v_lead crm.leads%rowtype;
  v_src  text;
begin
  select * into v_lead from crm.leads where id = p_lead_id for update;
  if not found then
    raise exception 'lead not found' using errcode = 'P0002';
  end if;

  select name into v_src from crm.lead_sources where id = p_source_id;

  update crm.leads
     set enquiry_count = enquiry_count + 1,
         stage = case
           when stage = 'not_qualified' and qualified_at is not null then 'qualified'::crm.lead_stage
           when stage = 'not_qualified' then 'calling'::crm.lead_stage
           else stage
         end,
         closed_at = case when stage = 'not_qualified' then null else closed_at end,
         next_follow_up_at = case when stage = 'converted' then next_follow_up_at
                                  else least(coalesce(next_follow_up_at, now()), now()) end
   where id = p_lead_id;

  insert into crm.activities (lead_id, user_id, kind, note, meta)
  values (p_lead_id, crm.current_user_id(), 'enquiry',
          'Enquired again' || coalesce(' via ' || v_src, ''),
          jsonb_build_object('source_id', p_source_id) || coalesce(p_payload, '{}'::jsonb));
end
$$;
