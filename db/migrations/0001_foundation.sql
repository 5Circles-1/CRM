-- 0001_foundation.sql
-- Schema, extensions, enums, shared helpers, settings.
--
-- This is the v2 ("pan-India program") schema: a deliberately small CRM for a
-- floor of two to four people. Leads arrive from ChatGPT and Meta, Sanya and
-- Harsh make the first call, qualified leads pass to Aisha for follow-up, and
-- the whole pipeline is visible to everyone on one spreadsheet-like screen.

create extension if not exists pgcrypto;
create extension if not exists citext;
create extension if not exists pg_trgm;

create schema if not exists crm;

-- The application role. No login of its own; the server connects as a role
-- that inherits crm_app. It never bypasses RLS and never owns a table.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'crm_app') then
    create role crm_app nologin;
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------

-- caller   = first call on a fresh lead (Sanya, Harsh)
-- followup = works qualified leads to conversion (Aisha)
-- admin    = sees and can do everything
create type crm.user_role as enum ('admin', 'caller', 'followup');

-- Where a lead stands in the pipeline. "calling" covers every live lead that
-- has been tried at least once but is not yet qualified - the detail of WHY it
-- is still in calling (not answered, switched off, call back later) is the
-- last call outcome, shown beside the stage, never a stage of its own.
create type crm.lead_stage as enum (
  'new',            -- arrived, nobody has called yet
  'calling',        -- first-call loop (not answered / switched off / call back)
  'qualified',      -- interested; with the follow-up person
  'converted',      -- paid / registered - the win
  'not_qualified'   -- an explicit "no, don't call me" - the only closed loss
);

-- The five answers a call can have. Deliberately no more than five: this list
-- IS the outcome dropdown, and a dropdown with twenty entries is how responses
-- stop being recorded at all.
create type crm.call_outcome as enum (
  'qualified',      -- interested: passes to follow-up
  'call_back',      -- asked to be called at a specific time
  'not_answered',
  'switched_off',
  'not_qualified'   -- said no / do not call
);

create type crm.activity_kind as enum (
  'call',        -- a dial with an outcome
  'note',        -- free text
  'assign',      -- lead changed hands
  'checkpoint',  -- invite sent / confirmed / converted toggled
  'enquiry',     -- the same phone number enquired again
  'system'       -- created, reopened, imported...
);

-- ---------------------------------------------------------------------------
-- Session context. The app sets app.user_id per request; RLS reads it here.
-- ---------------------------------------------------------------------------

create or replace function crm.current_user_id() returns uuid
  language sql stable
as $$
  select nullif(current_setting('app.user_id', true), '')::uuid
$$;

comment on function crm.current_user_id() is
  'UUID of the acting user, set by the application per request. NULL for maintenance connections.';

-- ---------------------------------------------------------------------------
-- Time. Storage is timestamptz; the business day is IST.
-- ---------------------------------------------------------------------------

create or replace function crm.ist_date(ts timestamptz default now()) returns date
  language sql immutable
as $$ select (ts at time zone 'Asia/Kolkata')::date $$;

comment on function crm.ist_date(timestamptz) is
  'Business date in Asia/Kolkata. Daily rollups key off this, never the UTC date.';

create or replace function crm.tg_set_updated_at() returns trigger
  language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end
$$;

-- ---------------------------------------------------------------------------
-- Phone normalisation. Numbers arrive from Meta/ChatGPT sheets in a dozen
-- shapes; dedupe is only as good as this function.
-- ---------------------------------------------------------------------------

create or replace function crm.normalise_phone(raw text) returns text
  language plpgsql immutable
as $$
declare
  digits text;
begin
  if raw is null then
    return null;
  end if;

  digits := regexp_replace(raw, '[^0-9]', '', 'g');

  -- strip international access prefixes
  if left(digits, 4) = '0091' then
    digits := substring(digits from 5);
  elsif left(digits, 2) = '91' and length(digits) = 12 then
    digits := substring(digits from 3);
  elsif left(digits, 1) = '0' and length(digits) = 11 then
    digits := substring(digits from 2);
  end if;

  -- a valid Indian mobile is 10 digits starting 6-9
  if length(digits) = 10 and left(digits, 1) ~ '[6-9]' then
    return '+91' || digits;
  end if;

  -- anything else is kept verbatim (digits only) so it can be quarantined
  -- rather than silently dropped
  if length(digits) between 8 and 15 then
    return '+' || digits;
  end if;

  return null;
end
$$;

comment on function crm.normalise_phone(text) is
  'Canonicalises a raw phone string to E.164. Returns NULL when the input cannot be a dialable number - quarantine those rows, never discard them.';

-- ---------------------------------------------------------------------------
-- Settings. Every tunable number lives here, not in code.
-- ---------------------------------------------------------------------------

create table crm.settings (
  key         text primary key,
  value       jsonb not null,
  description text  not null,
  updated_by  uuid,
  updated_at  timestamptz not null default now()
);

create or replace function crm.setting_int(p_key text, p_default int default null)
  returns int
  language sql stable
as $$
  select coalesce((select (value #>> '{}')::int from crm.settings where key = p_key), p_default)
$$;

create or replace function crm.setting_text(p_key text, p_default text default null)
  returns text
  language sql stable
as $$
  select coalesce((select value #>> '{}' from crm.settings where key = p_key), p_default)
$$;

insert into crm.settings (key, value, description) values
  ('follow_up.retry_hours', '24'::jsonb,
   'When a call ends not-answered or switched-off and no date is chosen, the next follow-up lands this many hours later.'),
  ('lead.dedupe_window_days', '90'::jsonb,
   'A new enquiry whose phone matches a lead created within this window attaches to that lead instead of creating a duplicate. Live leads match at any age.');
