-- 0004_row_level_security.sql
-- Access control lives in the database, not the route handlers.
--
-- The visibility model is deliberately the Google-Sheet one the owner asked
-- for: everyone signed in and active sees the whole pipeline - every lead,
-- every activity, every dashboard number. What RLS guards here is the
-- boundary: no session, no data; deactivated account, no data; and the
-- activity log can never be edited, so "who did what" is always true.
--
-- The application connects as a role inheriting crm_app (no BYPASSRLS, not
-- the table owner) and sets app.user_id at the start of every request.

grant usage on schema crm to crm_app;
grant select, insert, update on all tables in schema crm to crm_app;
grant usage, select on all sequences in schema crm to crm_app;
grant execute on all functions in schema crm to crm_app;

alter default privileges in schema crm
  grant select, insert, update on tables to crm_app;
alter default privileges in schema crm
  grant usage, select on sequences to crm_app;

-- Nothing is ever hard-deleted by the application.
revoke delete on all tables in schema crm from crm_app;

-- Append-only at the privilege level, not just by trigger: RLS filters before
-- triggers fire, so a denied update would otherwise silently affect zero rows
-- and read as success.
revoke update on crm.activities from crm_app;

-- Credentials and sessions were already revoked entirely in 0002.
revoke all on crm.user_credentials from crm_app;
revoke all on crm.api_sessions     from crm_app;

-- ---------------------------------------------------------------------------
-- Users: everyone reads the roster (names appear on every lead row); only an
-- admin writes it.
-- ---------------------------------------------------------------------------

alter table crm.users enable row level security;

create policy users_read on crm.users
  for select using (crm.current_user_id() is not null);

create policy users_admin_insert on crm.users
  for insert with check (crm.is_admin());

create policy users_admin_update on crm.users
  for update using (crm.is_admin()) with check (crm.is_admin());

-- ---------------------------------------------------------------------------
-- Settings: readable by the floor, writable by an admin.
-- ---------------------------------------------------------------------------

alter table crm.settings enable row level security;

create policy settings_read on crm.settings
  for select using (crm.is_active_user());

create policy settings_admin_write on crm.settings
  for all using (crm.is_admin()) with check (crm.is_admin());

-- ---------------------------------------------------------------------------
-- Leads and activities: the whole active floor reads and writes; every write
-- is attributed by the activity log, which cannot be changed after the fact.
-- ---------------------------------------------------------------------------

alter table crm.leads enable row level security;

create policy leads_read on crm.leads
  for select using (crm.is_active_user());

create policy leads_insert on crm.leads
  for insert with check (crm.is_active_user());

create policy leads_update on crm.leads
  for update using (crm.is_active_user()) with check (crm.is_active_user());

alter table crm.activities enable row level security;

create policy activities_read on crm.activities
  for select using (crm.is_active_user());

-- A row must be written as yourself (or as the system, with no user).
create policy activities_insert on crm.activities
  for insert with check (
    crm.is_active_user()
    and (user_id is null or user_id = crm.current_user_id())
  );

-- ---------------------------------------------------------------------------
-- Ingestion bookkeeping: visible to the floor (the admin screen shows sync
-- health and quarantined rows); written by the worker and by admins.
-- ---------------------------------------------------------------------------

alter table crm.lead_sources   enable row level security;
alter table crm.ingestion_runs enable row level security;
alter table crm.ingested_rows  enable row level security;

create policy lead_sources_read on crm.lead_sources
  for select using (crm.is_active_user());
create policy lead_sources_admin_write on crm.lead_sources
  for all using (crm.is_admin()) with check (crm.is_admin());

create policy ingestion_runs_read on crm.ingestion_runs
  for select using (crm.is_active_user());
create policy ingestion_runs_write on crm.ingestion_runs
  for all using (crm.is_admin()) with check (crm.is_admin());

create policy ingested_rows_read on crm.ingested_rows
  for select using (crm.is_active_user());
create policy ingested_rows_write on crm.ingested_rows
  for all using (crm.is_admin()) with check (crm.is_admin());
