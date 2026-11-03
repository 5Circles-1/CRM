-- seed.sql
-- Development seed: the real floor - admin, two callers, one follow-up - plus
-- the System account the ingestion worker runs as, and the three sources.
-- Fixed UUIDs so tests can reference rows directly. Safe to re-run.
--
-- Nobody here has a password yet: dev/test code sets them via
-- crm.set_password, and production users are created by the bootstrap tool
-- or the Admin screen.

begin;

insert into crm.users (id, full_name, email, role, rotation_order, is_service) values
  ('22222222-0000-0000-0000-00000000000a', 'Admin',  'admin@5circles.test',  'admin',    100, false),
  -- The service account background jobs run as (SERVICE_USER_ID). Admin role
  -- so ingestion bookkeeping passes RLS; no credentials, so no one can log in
  -- as it. Never receives leads: assignment only picks callers and follow-up.
  ('22222222-0000-0000-0000-00000000000b', 'System', 'system@5circles.test', 'admin',    101, true),
  ('22222222-0000-0000-0000-000000000001', 'Sanya',  'sanya@5circles.test',  'caller',   1,   false),
  ('22222222-0000-0000-0000-000000000002', 'Harsh',  'harsh@5circles.test',  'caller',   2,   false),
  ('22222222-0000-0000-0000-000000000003', 'Aisha',  'aisha@5circles.test',  'followup', 1,   false)
on conflict (id) do nothing;

insert into crm.lead_sources (id, name, spreadsheet_id, worksheet_name, column_map) values
  ('33333333-0000-0000-0000-000000000001', 'Meta',
   'SHEET_ID_PLACEHOLDER', 'Leads',
   '{"full_name":"Full Name","phone":"Phone Number","email":"Email","city":"City","campaign":"campaign_name"}'::jsonb),
  ('33333333-0000-0000-0000-000000000002', 'ChatGPT',
   'SHEET_ID_PLACEHOLDER_2', 'Leads', '{}'::jsonb),
  ('33333333-0000-0000-0000-000000000003', 'Manual', null, null, '{}'::jsonb)
on conflict (id) do nothing;

commit;
