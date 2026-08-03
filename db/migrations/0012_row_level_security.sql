-- 0012_row_level_security.sql
-- Requirement 9, part two: a caller must not be able to reach another caller's
-- leads - not through the UI, not through a bug in the API, not through a
-- hand-crafted request.
--
-- The rule is enforced in the database, not the application. A missing WHERE
-- clause in a route handler is then a bug that returns too few rows, never one
-- that leaks the lead book.
--
-- The application connects as crm_app (no BYPASSRLS, not the table owner) and
-- sets app.user_id at the start of every request.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'crm_app') then
    create role crm_app nologin;
  end if;
end
$$;

grant usage on schema crm to crm_app;
grant select, insert, update on all tables in schema crm to crm_app;
grant usage, select on all sequences in schema crm to crm_app;
grant execute on all functions in schema crm to crm_app;

alter default privileges in schema crm
  grant select, insert, update on tables to crm_app;
alter default privileges in schema crm
  grant usage, select on sequences to crm_app;

-- Nothing in this system is ever hard-deleted by the application.
revoke delete on all tables in schema crm from crm_app;

-- Append-only tables: withhold UPDATE at the privilege level, not just via the
-- trigger. Without this a denied write silently affects zero rows (RLS filters
-- before the trigger fires), which reads as success to the caller. Revoking the
-- privilege turns it into a hard error the application can log.
revoke update on
  crm.lead_events,
  crm.call_attempts,
  crm.audit_log,
  crm.lead_access_log,
  crm.distribution_events,
  crm.device_call_logs
from crm_app;

-- ---------------------------------------------------------------------------
-- Views run with the privileges of the caller, so RLS on the base tables
-- applies through them. Without this, every dashboard view would be a hole.
-- ---------------------------------------------------------------------------

alter view crm.v_my_day               set (security_invoker = true);
alter view crm.v_immediate_queue      set (security_invoker = true);
alter view crm.v_caller_day           set (security_invoker = true);
alter view crm.v_counsellor_mtd       set (security_invoker = true);
alter view crm.v_pipeline_leakage     set (security_invoker = true);
alter view crm.v_collection_thermometer set (security_invoker = true);
alter view crm.v_floor_live           set (security_invoker = true);
alter view crm.v_attendance_day       set (security_invoker = true);
alter view crm.v_transfer_candidates  set (security_invoker = true);
alter view crm.v_my_score             set (security_invoker = true);

-- ---------------------------------------------------------------------------
-- Directory data. Names and roles are not secret inside the floor; being able
-- to edit them is.
-- ---------------------------------------------------------------------------

alter table crm.users enable row level security;

create policy users_read on crm.users
  for select using (crm.current_user_id() is not null);

create policy users_admin_write on crm.users
  for update using (crm.current_user_role() = 'admin')
  with check (crm.current_user_role() = 'admin');

create policy users_admin_insert on crm.users
  for insert with check (crm.current_user_role() = 'admin');

alter table crm.teams enable row level security;
create policy teams_read on crm.teams
  for select using (crm.current_user_id() is not null);
create policy teams_admin_write on crm.teams
  for all using (crm.current_user_role() = 'admin')
  with check (crm.current_user_role() = 'admin');

alter table crm.team_memberships enable row level security;
create policy memberships_read on crm.team_memberships
  for select using (crm.current_user_id() is not null);
create policy memberships_admin_write on crm.team_memberships
  for all using (crm.current_user_role() in ('admin', 'ops'))
  with check (crm.current_user_role() in ('admin', 'ops'));

-- Settings are readable (the UI shows targets) but only admin may change them.
alter table crm.settings enable row level security;
create policy settings_read on crm.settings
  for select using (crm.current_user_id() is not null);
create policy settings_admin_write on crm.settings
  for all using (crm.current_user_role() = 'admin')
  with check (crm.current_user_role() = 'admin');

-- ---------------------------------------------------------------------------
-- Leads. The core rule.
--   caller     -> only leads assigned to them
--   counsellor -> their team (they are the team lead) plus anything they own
--   ops        -> all (they run ingestion and distribution)
--   admin      -> all
--   viewer     -> all, read only
-- ---------------------------------------------------------------------------

alter table crm.leads enable row level security;

create policy leads_select on crm.leads
  for select using (
    crm.current_user_role() in ('admin', 'ops', 'viewer')
    or caller_id = crm.current_user_id()
    or counsellor_id = crm.current_user_id()
    or (crm.current_user_role() = 'counsellor' and team_id = crm.current_user_team())
  );

create policy leads_update on crm.leads
  for update using (
    crm.current_user_role() in ('admin', 'ops')
    or caller_id = crm.current_user_id()
    or counsellor_id = crm.current_user_id()
    or (crm.current_user_role() = 'counsellor' and team_id = crm.current_user_team())
  )
  with check (
    crm.current_user_role() in ('admin', 'ops')
    or caller_id = crm.current_user_id()
    or counsellor_id = crm.current_user_id()
    or (crm.current_user_role() = 'counsellor' and team_id = crm.current_user_team())
  );

-- Only ingestion and admin create leads. Callers cannot invent them.
create policy leads_insert on crm.leads
  for insert with check (crm.current_user_role() in ('admin', 'ops'));

-- ---------------------------------------------------------------------------
-- Lead-scoped child tables inherit lead visibility.
-- ---------------------------------------------------------------------------

create or replace function crm.can_see_lead(p_lead_id uuid) returns boolean
  language sql stable
as $$
  select exists (select 1 from crm.leads l where l.id = p_lead_id)
$$;

comment on function crm.can_see_lead(uuid) is
  'Relies on RLS: the inner SELECT only finds the lead if the current user is allowed to see it, so child-table policies inherit the lead rule automatically.';

alter table crm.lead_events enable row level security;
create policy lead_events_select on crm.lead_events
  for select using (crm.can_see_lead(lead_id));
create policy lead_events_insert on crm.lead_events
  for insert with check (crm.can_see_lead(lead_id));

alter table crm.call_attempts enable row level security;
create policy call_attempts_select on crm.call_attempts
  for select using (
    crm.current_user_role() in ('admin', 'ops', 'viewer')
    or user_id = crm.current_user_id()
    or crm.can_see_lead(lead_id)
  );
-- A caller may only log calls as themselves.
create policy call_attempts_insert on crm.call_attempts
  for insert with check (
    user_id = crm.current_user_id() or crm.current_user_role() in ('admin', 'ops')
  );

alter table crm.callbacks enable row level security;
create policy callbacks_select on crm.callbacks
  for select using (
    crm.current_user_role() in ('admin', 'ops', 'viewer')
    or assigned_to = crm.current_user_id()
    or created_by = crm.current_user_id()
    or crm.can_see_lead(lead_id)
  );
create policy callbacks_write on crm.callbacks
  for insert with check (crm.can_see_lead(lead_id));
create policy callbacks_update on crm.callbacks
  for update using (
    assigned_to = crm.current_user_id()
    or crm.current_user_role() in ('admin', 'counsellor')
  )
  with check (
    assigned_to = crm.current_user_id()
    or crm.current_user_role() in ('admin', 'counsellor')
  );

alter table crm.lead_transfers enable row level security;
create policy lead_transfers_select on crm.lead_transfers
  for select using (
    crm.current_user_role() in ('admin', 'ops', 'viewer')
    or from_caller_id = crm.current_user_id()
    or to_caller_id = crm.current_user_id()
    or crm.can_see_lead(lead_id)
  );
-- Insert authority is additionally enforced inside crm.transfer_lead().
create policy lead_transfers_insert on crm.lead_transfers
  for insert with check (crm.current_user_role() in ('counsellor', 'admin'));

alter table crm.device_call_logs enable row level security;
-- A caller's personal call log is visible only to them and to admin. Not to
-- their counsellor: the reconciled call_attempts rows are what supervision needs.
create policy device_call_logs_select on crm.device_call_logs
  for select using (
    user_id = crm.current_user_id() or crm.current_user_role() = 'admin'
  );
create policy device_call_logs_insert on crm.device_call_logs
  for insert with check (
    user_id = crm.current_user_id() or crm.current_user_role() = 'admin'
  );

-- ---------------------------------------------------------------------------
-- Attendance: presence is visible floor-wide, but only you (or admin) can
-- open and close your own sessions.
-- ---------------------------------------------------------------------------

alter table crm.attendance_sessions enable row level security;
create policy attendance_select on crm.attendance_sessions
  for select using (crm.current_user_id() is not null);
create policy attendance_insert on crm.attendance_sessions
  for insert with check (
    user_id = crm.current_user_id() or crm.current_user_role() = 'admin'
  );
create policy attendance_update on crm.attendance_sessions
  for update using (
    user_id = crm.current_user_id() or crm.current_user_role() = 'admin'
  )
  with check (
    user_id = crm.current_user_id() or crm.current_user_role() = 'admin'
  );

-- ---------------------------------------------------------------------------
-- Money. Callers see the deals they set, and nothing else.
-- ---------------------------------------------------------------------------

alter table crm.deals enable row level security;
create policy deals_select on crm.deals
  for select using (
    crm.current_user_role() in ('admin', 'ops', 'viewer')
    or counsellor_id = crm.current_user_id()
    or setter_id = crm.current_user_id()
    or (crm.current_user_role() = 'counsellor' and team_id = crm.current_user_team())
  );
create policy deals_write on crm.deals
  for insert with check (crm.current_user_role() in ('counsellor', 'admin'));
create policy deals_update on crm.deals
  for update using (
    crm.current_user_role() = 'admin' or counsellor_id = crm.current_user_id()
  )
  with check (
    crm.current_user_role() = 'admin' or counsellor_id = crm.current_user_id()
  );

create or replace function crm.can_see_deal(p_deal_id uuid) returns boolean
  language sql stable
as $$
  select exists (select 1 from crm.deals d where d.id = p_deal_id)
$$;

alter table crm.instalments enable row level security;
create policy instalments_select on crm.instalments
  for select using (crm.can_see_deal(deal_id));
create policy instalments_write on crm.instalments
  for all using (crm.current_user_role() in ('admin', 'counsellor'))
  with check (crm.current_user_role() in ('admin', 'counsellor'));

alter table crm.payments enable row level security;
create policy payments_select on crm.payments
  for select using (crm.can_see_deal(deal_id));
create policy payments_insert on crm.payments
  for insert with check (crm.current_user_role() in ('admin', 'counsellor', 'ops'));

alter table crm.promises_to_pay enable row level security;
create policy promises_select on crm.promises_to_pay
  for select using (crm.current_user_id() is not null);
create policy promises_write on crm.promises_to_pay
  for insert with check (crm.current_user_id() is not null);

-- ---------------------------------------------------------------------------
-- Scores: your own, your team's if you lead it, everything if you run the firm.
-- ---------------------------------------------------------------------------

alter table crm.score_snapshots enable row level security;
create policy scores_select on crm.score_snapshots
  for select using (
    user_id = crm.current_user_id()
    or crm.current_user_role() in ('admin', 'viewer')
    or (crm.current_user_role() = 'counsellor' and team_id = crm.current_user_team())
  );

-- ---------------------------------------------------------------------------
-- Oversight tables. The floor cannot read the watchers.
-- ---------------------------------------------------------------------------

alter table crm.audit_log enable row level security;
create policy audit_log_admin on crm.audit_log
  for select using (crm.current_user_role() = 'admin');

alter table crm.security_alerts enable row level security;
create policy security_alerts_admin on crm.security_alerts
  for all using (crm.current_user_role() = 'admin')
  with check (crm.current_user_role() = 'admin');

alter table crm.lead_access_log enable row level security;
create policy lead_access_log_admin on crm.lead_access_log
  for select using (crm.current_user_role() = 'admin');
-- Anyone may append their own read record; nobody may read the log but admin.
create policy lead_access_log_insert on crm.lead_access_log
  for insert with check (user_id = crm.current_user_id());

alter table crm.distribution_events enable row level security;
create policy distribution_events_select on crm.distribution_events
  for select using (
    crm.current_user_role() in ('admin', 'ops', 'viewer', 'counsellor')
    or caller_id = crm.current_user_id()
  );
create policy distribution_events_insert on crm.distribution_events
  for insert with check (true);

-- Ingestion internals are ops/admin only: raw sheet payloads contain PII for
-- leads that may belong to the other team.
alter table crm.ingested_rows enable row level security;
create policy ingested_rows_ops on crm.ingested_rows
  for all using (crm.current_user_role() in ('admin', 'ops'))
  with check (crm.current_user_role() in ('admin', 'ops'));

alter table crm.ingestion_runs enable row level security;
create policy ingestion_runs_ops on crm.ingestion_runs
  for all using (crm.current_user_role() in ('admin', 'ops'))
  with check (crm.current_user_role() in ('admin', 'ops'));

alter table crm.lead_sources enable row level security;
create policy lead_sources_read on crm.lead_sources
  for select using (crm.current_user_id() is not null);
create policy lead_sources_ops on crm.lead_sources
  for all using (crm.current_user_role() in ('admin', 'ops'))
  with check (crm.current_user_role() in ('admin', 'ops'));
