-- 0003_settings_sources_leads.sql
-- Tunable settings, lead sources, the sheet ingestion pipeline, and leads.

-- ---------------------------------------------------------------------------
-- Settings.
-- Every number the floor argues about lives here, not in code: SLA minutes,
-- daily dial target, breakeven, collection assumption. Changing a target is
-- an ops action, not a deploy.
-- ---------------------------------------------------------------------------

create table crm.settings (
  key         text primary key,
  value       jsonb not null,
  description text  not null,
  updated_by  uuid references crm.users(id),
  updated_at  timestamptz not null default now()
);

create or replace function crm.setting_int(p_key text, p_default int default null)
  returns int
  language sql stable
as $$
  select coalesce((select (value #>> '{}')::int from crm.settings where key = p_key), p_default)
$$;

create or replace function crm.setting_num(p_key text, p_default numeric default null)
  returns numeric
  language sql stable
as $$
  select coalesce((select (value #>> '{}')::numeric from crm.settings where key = p_key), p_default)
$$;

insert into crm.settings (key, value, description) values
  ('sla.immediate_first_touch_minutes', '5'::jsonb,
   'Minutes to first dial for an immediate/hot lead. Breach turns the row red on the caller queue.'),
  ('sla.normal_first_touch_minutes', '60'::jsonb,
   'Minutes to first dial for a normal lead, counted only during shift hours.'),
  ('sla.callback_grace_minutes', '15'::jsonb,
   'Grace after a scheduled callback time before it counts as missed.'),
  ('dial.daily_target_per_caller', '80'::jsonb,
   'Dials per caller per day used as the scoring denominator. PLACEHOLDER - confirm with floor.'),
  ('dial.min_talk_seconds_for_connect', '30'::jsonb,
   'A call shorter than this is not counted as a genuine connect, regardless of disposition logged.'),
  ('lead.dedupe_window_days', '90'::jsonb,
   'A same-phone lead inside this window is attached to the existing lead as a re-enquiry rather than created fresh.'),
  ('lead.max_transfers', '2'::jsonb,
   'Hard cap on how many times one lead may be transferred between callers before it goes to nurture.'),
  ('lead.not_answered_streak_for_transfer', '4'::jsonb,
   'Consecutive not-answered attempts after which the lead is eligible for counsellor transfer.'),
  ('lead.max_attempts_before_nurture', '9'::jsonb,
   'Total dial attempts after which an uncontacted lead is parked in nurture.'),
  ('finance.monthly_breakeven_inr', '700000'::jsonb,
   'Monthly fixed cost to run the office. Drives the collection thermometer.'),
  ('finance.collection_efficiency_pct', '85'::jsonb,
   'Assumed share of booked revenue actually collected. Required booking = breakeven / this.'),
  ('finance.working_days_per_month', '25'::jsonb,
   'Working days used to derive the daily collection floor.'),
  ('attendance.expected_minutes', '540'::jsonb,
   'Expected logged-in minutes per day (09:30-18:30 IST).'),
  ('security.bulk_view_alert_threshold', '300'::jsonb,
   'Distinct lead records opened by one user in a rolling hour before a security alert fires.');

-- ---------------------------------------------------------------------------
-- Lead sources: one row per Google Sheet tab / Meta lead form.
-- ---------------------------------------------------------------------------

create table crm.lead_sources (
  id                uuid primary key default gen_random_uuid(),
  name              text not null unique,
  -- Google Sheet identifiers. The sheet is the Meta Lead Ads integration target.
  spreadsheet_id    text,
  worksheet_name    text,
  -- Column header -> canonical lead field. Sheets change shape without warning,
  -- so the mapping is data, not code.
  column_map        jsonb not null default '{}'::jsonb,
  -- NULL = alternate across all active teams. Set = pin this source to one team.
  pinned_team_id    uuid references crm.teams(id) on delete set null,
  default_priority  crm.lead_priority not null default 'normal',
  is_active         boolean not null default true,
  last_synced_at    timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  constraint lead_sources_sheet_identified
    check (spreadsheet_id is null or worksheet_name is not null)
);

create trigger lead_sources_set_updated_at
  before update on crm.lead_sources
  for each row execute function crm.tg_set_updated_at();

comment on column crm.lead_sources.column_map is
  'Maps sheet header text to canonical field, e.g. {"full_name":"Full Name","phone":"Phone Number"}. Editable by ops when Meta changes the form.';

-- ---------------------------------------------------------------------------
-- Ingestion runs and raw rows.
-- Raw rows are kept forever. If distribution or parsing is ever wrong, the
-- sheet is replayable without re-reading Google.
-- ---------------------------------------------------------------------------

create table crm.ingestion_runs (
  id             uuid primary key default gen_random_uuid(),
  source_id      uuid not null references crm.lead_sources(id) on delete cascade,
  started_at     timestamptz not null default now(),
  finished_at    timestamptz,
  rows_seen      int not null default 0,
  rows_created   int not null default 0,
  rows_duplicate int not null default 0,
  rows_quarantined int not null default 0,
  error_text     text
);

create index ingestion_runs_source_idx on crm.ingestion_runs (source_id, started_at desc);

create type crm.ingest_row_status as enum ('accepted', 'duplicate', 'quarantined');

create table crm.ingested_rows (
  id           uuid primary key default gen_random_uuid(),
  run_id       uuid not null references crm.ingestion_runs(id) on delete cascade,
  source_id    uuid not null references crm.lead_sources(id) on delete cascade,
  -- Stable identity of the row in the sheet (row number or Meta lead id).
  source_row_key text not null,
  -- Hash of the payload. Same key + same hash = already ingested, skip silently.
  payload_hash text not null,
  payload      jsonb not null,
  status       crm.ingest_row_status not null,
  reject_reason text,
  lead_id      uuid,
  created_at   timestamptz not null default now(),

  constraint ingested_rows_reason_present
    check (status <> 'quarantined' or reject_reason is not null)
);

-- Idempotency: the same sheet row, unchanged, can never create a second lead.
create unique index ingested_rows_identity_idx
  on crm.ingested_rows (source_id, source_row_key, payload_hash);

create index ingested_rows_run_idx on crm.ingested_rows (run_id);
create index ingested_rows_quarantine_idx on crm.ingested_rows (source_id, created_at desc)
  where status = 'quarantined';

comment on index crm.ingested_rows_identity_idx is
  'The idempotency guarantee. Re-running a sync over the whole sheet is always safe.';

-- ---------------------------------------------------------------------------
-- Leads
-- ---------------------------------------------------------------------------

create table crm.leads (
  id                uuid primary key default gen_random_uuid(),
  source_id         uuid references crm.lead_sources(id) on delete set null,

  full_name         text,
  phone_e164        text not null,
  phone_raw         text,
  email             citext,
  city              text,

  -- Meta attribution, carried through from the sheet.
  campaign_name     text,
  adset_name        text,
  ad_name           text,
  form_name         text,
  -- Anything else the sheet carried. Never discard a column.
  extra             jsonb not null default '{}'::jsonb,

  priority          crm.lead_priority not null default 'normal',
  status            crm.lead_status   not null default 'new',

  team_id           uuid references crm.teams(id) on delete set null,
  caller_id         uuid references crm.users(id) on delete set null,
  counsellor_id     uuid references crm.users(id) on delete set null,

  -- Requirement 5: an immediate lead must be dialled as soon as possible.
  first_touch_due_at timestamptz,
  first_touched_at   timestamptz,

  -- Requirement 3 + 4: an open lead ALWAYS has a scheduled next action.
  -- This is the mechanical guarantee against pipeline leakage.
  next_action_at    timestamptz,
  next_action_note  text,

  last_contacted_at timestamptz,
  attempt_count     int not null default 0 check (attempt_count >= 0),
  connect_count     int not null default 0 check (connect_count >= 0),
  na_streak         int not null default 0 check (na_streak >= 0),
  transfer_count    int not null default 0 check (transfer_count >= 0),
  reenquiry_count   int not null default 0 check (reenquiry_count >= 0),

  lost_reason       text,
  closed_at         timestamptz,

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  -- THE anti-leakage constraint. A lead in an open state cannot exist without
  -- a scheduled next action. Nothing can fall silently out of the pipeline.
  constraint leads_open_requires_next_action
    check (
      status in ('won', 'lost', 'invalid', 'nurture', 'handed_off')
      or next_action_at is not null
    ),

  constraint leads_closed_at_consistent
    check (
      (status in ('won', 'lost', 'invalid', 'handed_off') and closed_at is not null)
      or (status not in ('won', 'lost', 'invalid', 'handed_off') and closed_at is null)
    )
);

comment on constraint leads_open_requires_next_action on crm.leads is
  'Requirement 9 (no leakage), enforced in the database rather than the UI: an open lead must always carry a scheduled next action.';

create index leads_caller_queue_idx  on crm.leads (caller_id, next_action_at)
  where status not in ('won', 'lost', 'invalid', 'nurture', 'handed_off');
create index leads_counsellor_idx    on crm.leads (counsellor_id, next_action_at)
  where status not in ('won', 'lost', 'invalid', 'nurture', 'handed_off');
create index leads_team_status_idx   on crm.leads (team_id, status);
create index leads_phone_idx         on crm.leads (phone_e164);
create index leads_immediate_idx     on crm.leads (first_touch_due_at)
  where priority = 'immediate' and first_touched_at is null;
create index leads_untouched_idx     on crm.leads (created_at)
  where first_touched_at is null;
create index leads_name_trgm_idx     on crm.leads using gin (full_name gin_trgm_ops);

create trigger leads_set_updated_at
  before update on crm.leads
  for each row execute function crm.tg_set_updated_at();

-- A new lead must satisfy leads_open_requires_next_action from the moment it
-- is inserted. Rather than making every ingestion path remember that, the
-- first-touch SLA is stamped here from the lead's priority.
create or replace function crm.tg_lead_defaults() returns trigger
  language plpgsql
as $$
declare
  v_sla int;
begin
  if new.first_touch_due_at is null then
    v_sla := case new.priority
               when 'immediate' then crm.setting_int('sla.immediate_first_touch_minutes', 5)
               else crm.setting_int('sla.normal_first_touch_minutes', 60)
             end;
    new.first_touch_due_at := now() + make_interval(mins => v_sla);
  end if;

  if new.next_action_at is null
     and new.status not in ('won', 'lost', 'invalid', 'nurture', 'handed_off') then
    new.next_action_at   := new.first_touch_due_at;
    new.next_action_note := coalesce(new.next_action_note, 'First contact');
  end if;

  new.phone_e164 := coalesce(crm.normalise_phone(new.phone_e164), new.phone_e164);
  return new;
end
$$;

create trigger leads_set_defaults
  before insert on crm.leads
  for each row execute function crm.tg_lead_defaults();

-- ---------------------------------------------------------------------------
-- Lead timeline. Append-only. Everything that happens to a lead lands here,
-- and this is what the lead detail screen renders.
-- ---------------------------------------------------------------------------

create table crm.lead_events (
  id         bigserial primary key,
  lead_id    uuid not null references crm.leads(id) on delete cascade,
  event_type text not null,
  actor_id   uuid references crm.users(id) on delete set null,
  payload    jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now()
);

create index lead_events_lead_idx on crm.lead_events (lead_id, occurred_at desc);
create index lead_events_type_idx on crm.lead_events (event_type, occurred_at desc);

-- Timeline rows are never edited or deleted, including by the application role.
create or replace function crm.tg_append_only() returns trigger
  language plpgsql
as $$
begin
  raise exception 'crm.% is append-only (attempted %)', tg_table_name, tg_op
    using errcode = 'restrict_violation';
end
$$;

create trigger lead_events_append_only
  before update or delete on crm.lead_events
  for each row execute function crm.tg_append_only();
