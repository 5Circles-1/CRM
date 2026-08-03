-- seed.sql
-- Development seed: two teams, four callers, two counsellors, one shift.
-- Fixed UUIDs so tests can reference rows directly.
-- Safe to re-run.

begin;

insert into crm.teams (id, name, code, rotation_order) values
  ('11111111-0000-0000-0000-000000000001', 'Team A', 'TA', 1),
  ('11111111-0000-0000-0000-000000000002', 'Team B', 'TB', 2)
on conflict (id) do nothing;

insert into crm.users (id, full_name, email, role, employee_code, dialing_msisdn) values
  ('22222222-0000-0000-0000-00000000000a', 'Admin User',    'admin@5circles.test',  'admin',      'ADM-01', null),
  ('22222222-0000-0000-0000-00000000000b', 'Ops User',      'ops@5circles.test',    'ops',        'OPS-01', null),
  ('22222222-0000-0000-0000-00000000000c', 'Founder',       'founder@5circles.test','viewer',     'FND-01', null),
  -- Team A
  ('22222222-0000-0000-0000-000000000001', 'Caller A1',     'a1@5circles.test',     'caller',     'CLR-01', '+919000000001'),
  ('22222222-0000-0000-0000-000000000002', 'Caller A2',     'a2@5circles.test',     'caller',     'CLR-02', '+919000000002'),
  ('22222222-0000-0000-0000-000000000005', 'Counsellor A',  'ca@5circles.test',     'counsellor', 'CNS-01', '+919000000005'),
  -- Team B
  ('22222222-0000-0000-0000-000000000003', 'Caller B1',     'b1@5circles.test',     'caller',     'CLR-03', '+919000000003'),
  ('22222222-0000-0000-0000-000000000004', 'Caller B2',     'b2@5circles.test',     'caller',     'CLR-04', '+919000000004'),
  ('22222222-0000-0000-0000-000000000006', 'Counsellor B',  'cb@5circles.test',     'counsellor', 'CNS-02', '+919000000006')
on conflict (id) do nothing;

insert into crm.team_memberships (user_id, team_id, rotation_order, period) values
  ('22222222-0000-0000-0000-000000000001', '11111111-0000-0000-0000-000000000001', 1, daterange(current_date - 30, null, '[)')),
  ('22222222-0000-0000-0000-000000000002', '11111111-0000-0000-0000-000000000001', 2, daterange(current_date - 30, null, '[)')),
  ('22222222-0000-0000-0000-000000000005', '11111111-0000-0000-0000-000000000001', 9, daterange(current_date - 30, null, '[)')),
  ('22222222-0000-0000-0000-000000000003', '11111111-0000-0000-0000-000000000002', 1, daterange(current_date - 30, null, '[)')),
  ('22222222-0000-0000-0000-000000000004', '11111111-0000-0000-0000-000000000002', 2, daterange(current_date - 30, null, '[)')),
  ('22222222-0000-0000-0000-000000000006', '11111111-0000-0000-0000-000000000002', 9, daterange(current_date - 30, null, '[)'))
on conflict do nothing;

-- The 5C floor shift: 09:30-18:30 IST, 540 minutes.
insert into crm.work_shifts (name, team_id, starts_at, ends_at, expected_minutes)
values ('Floor shift', null, '09:30', '18:30', 540)
on conflict (name) do nothing;

insert into crm.lead_sources (id, name, spreadsheet_id, worksheet_name, column_map, default_priority)
values (
  '33333333-0000-0000-0000-000000000001',
  'Meta Lead Ads - Main Sheet',
  'SHEET_ID_PLACEHOLDER',
  'Leads',
  '{"full_name":"Full Name","phone":"Phone Number","email":"Email","city":"City","campaign_name":"campaign_name","adset_name":"adset_name","ad_name":"ad_name","form_name":"form_name"}'::jsonb,
  'normal'
)
on conflict (id) do nothing;

insert into crm.lead_sources (id, name, default_priority)
values ('33333333-0000-0000-0000-000000000002', 'Website - Request a Callback', 'immediate')
on conflict (id) do nothing;

insert into crm.products (id, name, code, list_price_inr, is_sebi_regulated) values
  ('44444444-0000-0000-0000-000000000001', 'Advisory - Quarterly',  'ADV-Q',  25000,  true),
  ('44444444-0000-0000-0000-000000000002', 'Advisory - Annual',     'ADV-A',  75000,  true),
  ('44444444-0000-0000-0000-000000000003', 'Trading Course - Level 1', 'CRS-1', 15000, false)
on conflict (id) do nothing;

commit;
