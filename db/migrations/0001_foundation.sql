-- 0001_foundation.sql
-- Schemas, extensions, enums and shared helper functions.
-- Everything in this build lives in the `crm` schema.

create extension if not exists pgcrypto;
create extension if not exists citext;
create extension if not exists btree_gist;
create extension if not exists pg_trgm;

create schema if not exists crm;

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------

-- caller   = setter, first-touch dialling
-- counsellor = closer AND team lead (per 5C org: same person)
-- ops      = uploads sheets, manages sources/rules, no lead-level access
-- admin    = full access, small number of people
-- viewer   = founder/management, aggregate dashboards only
create type crm.user_role as enum ('caller', 'counsellor', 'ops', 'admin', 'viewer');

create type crm.lead_priority as enum ('immediate', 'normal');

create type crm.lead_status as enum (
  'new',            -- ingested, never dialled
  'working',        -- in the calling loop
  'callback',       -- caller scheduled a callback at client's request
  'qualified',      -- passed from caller to counsellor
  'negotiation',    -- counsellor working the close
  'won',            -- deal booked
  'lost',           -- explicit no
  'invalid',        -- bad number / not a real person
  'nurture',        -- parked, long-cycle, WhatsApp only
  'handed_off'      -- pushed to the advisory pipeline post-payment
);

-- Terminal statuses do not require a scheduled next action.
create type crm.disposition as enum (
  'connected_interested',
  'connected_not_interested',
  'callback_requested',
  'not_answered',
  'busy',
  'switched_off',
  'invalid_number',
  'wrong_person',
  'language_barrier',
  'do_not_call'
);

create type crm.transfer_reason as enum (
  'not_answered_streak',
  'language_mismatch',
  'caller_unavailable',
  'load_balance',
  'escalation',
  'other'
);

create type crm.attendance_source as enum ('web', 'mobile', 'admin_adjustment');

create type crm.instalment_status as enum ('due', 'paid', 'part_paid', 'overdue', 'written_off');

-- ---------------------------------------------------------------------------
-- Session context: the app sets these per request/connection.
--   set_config('app.user_id', '<uuid>', true)
-- RLS policies and audit triggers read from here.
-- ---------------------------------------------------------------------------

create or replace function crm.current_user_id() returns uuid
  language sql stable
as $$
  select nullif(current_setting('app.user_id', true), '')::uuid
$$;

comment on function crm.current_user_id() is
  'UUID of the acting user, set by the application layer per request. NULL for migration/maintenance connections.';

-- ---------------------------------------------------------------------------
-- Time helpers. The floor runs on IST; all storage is timestamptz.
-- ---------------------------------------------------------------------------

create or replace function crm.ist_now() returns timestamptz
  language sql stable
as $$ select now() $$;

create or replace function crm.ist_date(ts timestamptz default now()) returns date
  language sql immutable
as $$ select (ts at time zone 'Asia/Kolkata')::date $$;

comment on function crm.ist_date(timestamptz) is
  'Business date in Asia/Kolkata. All daily rollups key off this, not UTC date.';

-- ---------------------------------------------------------------------------
-- updated_at maintenance
-- ---------------------------------------------------------------------------

create or replace function crm.tg_set_updated_at() returns trigger
  language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end
$$;

-- ---------------------------------------------------------------------------
-- Phone normalisation. Indian mobile numbers arrive from Meta sheets in a
-- dozen shapes: +91 98..., 0098..., 098..., 98... , with spaces and dashes.
-- Dedupe is only as good as this function, so it is a first-class object.
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
  'Canonicalises a raw phone string to E.164. Returns NULL when the input cannot be a dialable number - callers should quarantine those rows, never discard them.';
