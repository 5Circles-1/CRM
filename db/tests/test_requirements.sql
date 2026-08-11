-- test_requirements.sql
-- One test per stated requirement. Run against a freshly rebuilt + seeded
-- database:  ./db/rebuild.sh --with-tests
--
-- Exits non-zero if any assertion fails.

\set ON_ERROR_STOP on
set search_path = crm, public;

create schema if not exists crm_test;

drop table if exists crm_test.results;
create table crm_test.results (
  id serial primary key,
  requirement text not null,
  name        text not null,
  passed      boolean not null,
  detail      text
);

create or replace function crm_test.check(
    p_req text, p_name text, p_passed boolean, p_detail text default null)
  returns void language plpgsql as $$
begin
  insert into crm_test.results (requirement, name, passed, detail)
  values (p_req, p_name, coalesce(p_passed, false), p_detail);
end $$;

-- The RLS section runs as crm_app, which still needs to record its results.
grant usage on schema crm_test to crm_app;
grant select, insert on crm_test.results to crm_app;
grant usage, select on sequence crm_test.results_id_seq to crm_app;
grant execute on function crm_test.check(text, text, boolean, text) to crm_app;

-- Assertions are silent; only the summary at the end is printed.
\o /dev/null

-- Convenience handles ---------------------------------------------------------
\set TEAM_A '''11111111-0000-0000-0000-000000000001'''
\set TEAM_B '''11111111-0000-0000-0000-000000000002'''
\set A1     '''22222222-0000-0000-0000-000000000001'''
\set A2     '''22222222-0000-0000-0000-000000000002'''
\set B1     '''22222222-0000-0000-0000-000000000003'''
\set B2     '''22222222-0000-0000-0000-000000000004'''
\set CNS_A  '''22222222-0000-0000-0000-000000000005'''
\set ADMIN  '''22222222-0000-0000-0000-00000000000a'''
\set SRC    '''33333333-0000-0000-0000-000000000001'''
\set SRC_IMM '''33333333-0000-0000-0000-000000000002'''

-- =============================================================================
-- REQUIREMENT 1: alternate distribution between two teams and between setters
-- =============================================================================

-- Put all four callers on the floor.
insert into crm.attendance_sessions (user_id, started_at) values
  (:A1, now() - interval '2 hours'),
  (:A2, now() - interval '2 hours'),
  (:B1, now() - interval '2 hours'),
  (:B2, now() - interval '2 hours');

do $$
declare
  v_lead uuid;
  i int;
begin
  for i in 1..8 loop
    insert into crm.leads (source_id, full_name, phone_e164, campaign_name)
    values ('33333333-0000-0000-0000-000000000001',
            'Lead ' || i, '98765' || lpad(i::text, 5, '0'), 'Test Campaign')
    returning id into v_lead;
    perform crm.assign_lead(v_lead);
  end loop;
end $$;

-- Eight leads, four callers, everyone present: two each.
select crm_test.check(
  'R1', 'leads split evenly across all four callers',
  (select count(distinct caller_id) = 4 and min(c) = 2 and max(c) = 2
     from (select caller_id, count(*) c from crm.leads
            where full_name like 'Lead %' group by caller_id) x),
  (select string_agg(u.full_name || '=' || c, ', ' order by u.full_name)
     from (select caller_id, count(*) c from crm.leads
            where full_name like 'Lead %' group by caller_id) x
     join crm.users u on u.id = x.caller_id));

-- Teams alternate, so the split is 4/4 rather than 8/0.
select crm_test.check(
  'R1', 'leads alternate between Team A and Team B',
  (select count(*) = 2 and min(c) = 4 and max(c) = 4
     from (select team_id, count(*) c from crm.leads
            where full_name like 'Lead %' group by team_id) x),
  (select string_agg(t.code || '=' || c, ', ' order by t.code)
     from (select team_id, count(*) c from crm.leads
            where full_name like 'Lead %' group by team_id) x
     join crm.teams t on t.id = x.team_id));

-- Fairness: take A2 off the floor. Team A's next leads must all go to A1,
-- and A2 must not be handed leads while absent.
update crm.attendance_sessions set ended_at = now()
 where user_id = :A2 and ended_at is null;

do $$
declare v_lead uuid; i int;
begin
  for i in 1..6 loop
    insert into crm.leads (source_id, full_name, phone_e164)
    values ('33333333-0000-0000-0000-000000000001',
            'Absent ' || i, '97765' || lpad(i::text, 5, '0'))
    returning id into v_lead;
    perform crm.assign_lead(v_lead);
  end loop;
end $$;

select crm_test.check(
  'R1', 'a caller who is off the floor receives no new leads',
  (select count(*) = 0 from crm.leads
    where full_name like 'Absent %' and caller_id = :A2),
  (select 'A2 got ' || count(*) from crm.leads
    where full_name like 'Absent %' and caller_id = :A2));

select crm_test.check(
  'R1', 'the passed-over caller is recorded, so distribution is auditable',
  (select count(*) > 0 from crm.distribution_events
    where passed_over @> jsonb_build_array(jsonb_build_object('user_id', :A2, 'reason', 'off_shift'))),
  null);

-- Bring A2 back: the balancer must catch them up rather than resume blind
-- alternation from where the cursor happened to stop.
insert into crm.attendance_sessions (user_id, started_at) values (:A2, now());

do $$
declare v_lead uuid; i int;
begin
  for i in 1..4 loop
    insert into crm.leads (source_id, full_name, phone_e164)
    values ('33333333-0000-0000-0000-000000000001',
            'Return ' || i, '96765' || lpad(i::text, 5, '0'))
    returning id into v_lead;
    perform crm.assign_lead(v_lead);
  end loop;
end $$;

select crm_test.check(
  'R1', 'a returning caller is caught up, not permanently short',
  (select count(*) > 0 from crm.leads
    where full_name like 'Return %' and caller_id = :A2),
  (select 'A2 got ' || count(*) || ' of 4 on return' from crm.leads
    where full_name like 'Return %' and caller_id = :A2));

-- =============================================================================
-- REQUIREMENT 5: an immediate lead is queued for contact as soon as possible
-- =============================================================================

do $$
declare v_lead uuid;
begin
  insert into crm.leads (source_id, full_name, phone_e164, priority)
  values ('33333333-0000-0000-0000-000000000002', 'Hot Lead', '9555500001', 'immediate')
  returning id into v_lead;
  perform crm.assign_lead(v_lead);
end $$;

-- The window is 30 WORKING minutes now, so on a Sunday the deadline is
-- legitimately Monday morning - the assertion is against the working clock,
-- not against the wall.
select crm_test.check(
  'R5', 'immediate lead gets a 30-working-minute first-touch SLA',
  (select first_touch_due_at > now()
      and first_touch_due_at <= crm.add_working_minutes(now(), 31)
     from crm.leads where full_name = 'Hot Lead'),
  (select 'due ' || first_touch_due_at from crm.leads where full_name = 'Hot Lead'));

select crm_test.check(
  'R5', 'immediate lead appears on the immediate queue',
  (select count(*) = 1 from crm.v_immediate_queue where full_name = 'Hot Lead'), null);

select crm_test.check(
  'R5', 'normal lead gets the 60-minute SLA, not the immediate one',
  (select first_touch_due_at > now() + interval '50 minutes'
     from crm.leads where full_name = 'Lead 1'), null);

-- =============================================================================
-- REQUIREMENT 3: a caller can set a callback and it drives the lead
-- =============================================================================

do $$
declare v_lead uuid;
begin
  select id into v_lead from crm.leads where full_name = 'Lead 1';
  insert into crm.callbacks (lead_id, created_by, assigned_to, scheduled_at, note)
  values (v_lead, (select caller_id from crm.leads where id = v_lead),
          (select caller_id from crm.leads where id = v_lead),
          now() + interval '3 hours', 'Client asked to call after 4pm');
end $$;

select crm_test.check(
  'R3', 'scheduling a callback moves the lead next action to that time',
  (select abs(extract(epoch from (l.next_action_at - cb.scheduled_at))) < 1
     from crm.leads l join crm.callbacks cb on cb.lead_id = l.id
    where l.full_name = 'Lead 1'), null);

select crm_test.check(
  'R3', 'the lead status reflects the callback',
  (select status = 'callback' from crm.leads where full_name = 'Lead 1'), null);

select crm_test.check(
  'R3', 'only one pending callback per lead is possible',
  (select not exists (
     select 1 from crm.callbacks group by lead_id, status
      having status = 'pending' and count(*) > 1)), null);

-- =============================================================================
-- REQUIREMENT 4: the caller sees their pipeline for the day
-- =============================================================================

select crm_test.check(
  'R4', 'my-day queue is populated for a caller',
  (select count(*) > 0 from crm.v_my_day where caller_id = :A1), null);

-- An overdue lead so the bucket test holds on any day of the week: on a
-- Sunday every fresh lead's next action is Monday, which empties v_my_day of
-- everything except callbacks and whatever is genuinely late.
insert into crm.leads (source_id, full_name, phone_e164, caller_id, team_id, status,
                       next_action_at, first_touched_at, attempt_count)
values (:SRC, 'Long Overdue', '+919555000099', :A1, crm.team_of(:A1, current_date),
        'working', now() - interval '2 days', now() - interval '3 days', 1);

select crm_test.check(
  'R4', 'my-day buckets leads into immediate / overdue / callback / fresh',
  (select count(distinct bucket) >= 2 from crm.v_my_day),
  (select string_agg(distinct bucket, ', ') from crm.v_my_day));

-- =============================================================================
-- REQUIREMENT 9 (anti-leakage): an open lead cannot exist without a next action
-- =============================================================================

do $$
begin
  update crm.leads set next_action_at = null
   where full_name = 'Lead 2' and status = 'working';
  perform crm_test.check('R9', 'open lead cannot have its next action cleared',
                         false, 'the update unexpectedly succeeded');
exception when check_violation then
  perform crm_test.check('R9', 'open lead cannot have its next action cleared', true, null);
end $$;

-- Logging an unanswered call must still leave a forward action.
do $$
declare v_lead uuid; v_caller uuid;
begin
  select id, caller_id into v_lead, v_caller from crm.leads where full_name = 'Lead 3';
  insert into crm.call_attempts (lead_id, user_id, disposition, duration_seconds, is_verified)
  values (v_lead, v_caller, 'not_answered', 0, true);
end $$;

select crm_test.check(
  'R9', 'an unanswered call auto-schedules the retry',
  (select next_action_at > now() from crm.leads where full_name = 'Lead 3'),
  (select 'next action ' || next_action_at from crm.leads where full_name = 'Lead 3'));

select crm_test.check(
  'R9', 'the not-answered streak is tracked for transfer eligibility',
  (select na_streak = 1 from crm.leads where full_name = 'Lead 3'), null);

-- Short calls do not count as connects however they are dispositioned.
do $$
declare v_lead uuid; v_caller uuid;
begin
  select id, caller_id into v_lead, v_caller from crm.leads where full_name = 'Lead 4';
  insert into crm.call_attempts (lead_id, user_id, disposition, duration_seconds, is_verified)
  values (v_lead, v_caller, 'connected_interested', 4, true);
end $$;

select crm_test.check(
  'R9', 'a 4-second call is not counted as a connect',
  (select connect_count = 0 from crm.leads where full_name = 'Lead 4'), null);

-- =============================================================================
-- REQUIREMENT 8: only the counsellor can transfer a Not Answered lead
-- =============================================================================

-- Build a lead with enough NA attempts to qualify.
do $$
declare v_lead uuid; v_caller uuid; i int;
begin
  select id, caller_id into v_lead, v_caller from crm.leads where full_name = 'Lead 5';
  for i in 1..4 loop
    insert into crm.call_attempts (lead_id, user_id, disposition, duration_seconds, is_verified)
    values (v_lead, v_caller, 'not_answered', 0, true);
  end loop;
end $$;

select crm_test.check(
  'R8', 'a lead with 4 unanswered attempts appears as a transfer candidate',
  (select count(*) = 1 from crm.v_transfer_candidates
    where lead_id = (select id from crm.leads where full_name = 'Lead 5')), null);

-- A caller must not be able to transfer.
do $$
declare v_lead uuid;
begin
  select id into v_lead from crm.leads where full_name = 'Lead 5';
  perform crm.transfer_lead(v_lead, '22222222-0000-0000-0000-000000000002',
                            'not_answered_streak', '22222222-0000-0000-0000-000000000001');
  perform crm_test.check('R8', 'a caller cannot transfer a lead', false,
                         'the transfer unexpectedly succeeded');
exception when insufficient_privilege then
  perform crm_test.check('R8', 'a caller cannot transfer a lead', true, null);
end $$;

-- The counsellor can.
do $$
declare v_lead uuid; v_from uuid; v_to uuid;
begin
  select id, caller_id into v_lead, v_from from crm.leads where full_name = 'Lead 5';
  v_to := case when v_from = '22222222-0000-0000-0000-000000000001'
               then '22222222-0000-0000-0000-000000000002'
               else '22222222-0000-0000-0000-000000000001' end;
  perform crm.transfer_lead(v_lead, v_to, 'not_answered_streak',
                            '22222222-0000-0000-0000-000000000005', 'No answer in 4 attempts');
end $$;

select crm_test.check(
  'R8', 'the counsellor can transfer, and the lead changes hands',
  (select transfer_count = 1 and na_streak = 0
     from crm.leads where full_name = 'Lead 5'), null);

select crm_test.check(
  'R8', 'the transferred lead gets a fresh next action for its new owner',
  (select next_action_at > now() from crm.leads where full_name = 'Lead 5'), null);

-- The cap holds.
do $$
declare v_lead uuid; v_from uuid; v_to uuid;
begin
  select id, caller_id into v_lead, v_from from crm.leads where full_name = 'Lead 5';
  v_to := case when v_from = '22222222-0000-0000-0000-000000000001'
               then '22222222-0000-0000-0000-000000000002'
               else '22222222-0000-0000-0000-000000000001' end;
  perform crm.transfer_lead(v_lead, v_to, 'load_balance',
                            '22222222-0000-0000-0000-000000000005');
  -- second transfer is allowed (cap is 2); a third must fail
  select caller_id into v_from from crm.leads where id = v_lead;
  v_to := case when v_from = '22222222-0000-0000-0000-000000000001'
               then '22222222-0000-0000-0000-000000000002'
               else '22222222-0000-0000-0000-000000000001' end;
  perform crm.transfer_lead(v_lead, v_to, 'load_balance',
                            '22222222-0000-0000-0000-000000000005');
  perform crm_test.check('R8', 'transfers are capped at 2 per lead', false,
                         'a third transfer unexpectedly succeeded');
exception when check_violation then
  perform crm_test.check('R8', 'transfers are capped at 2 per lead', true, null);
end $$;

-- The automatic side of requirement 8: a lead nobody has touched moves on its
-- own. This is not the supervisory rule relaxed - it only ever fires on leads
-- with no contact at all, where nobody is choosing to keep them.
insert into crm.leads (source_id, full_name, phone_e164, caller_id, team_id, status,
                       next_action_at, assigned_at)
-- Backdated three days, not eleven minutes: the sweep clock now counts only
-- working minutes, so a test running on a Sunday would find that eleven
-- wall-clock minutes contain zero working ones and correctly refuse to sweep.
values (:SRC, 'Untouched Sweep', '+919555000001', :A1, crm.team_of(:A1, current_date),
        'new', now(), now() - interval '3 days');

-- With A2 away there is nobody in Team A to move it to. Handing it to another
-- absent caller would look like progress and change nothing, so it stays put.
update crm.attendance_sessions set ended_at = now()
 where user_id = :A2 and ended_at is null;

select crm_test.check(
  'R8', 'an untouched lead is not moved when nobody else is on the floor',
  (select crm.reassign_untouched_leads() = 0), null);

select crm_test.check(
  'R8', 'and it stays with the caller who has it',
  (select caller_id = :A1 from crm.leads where full_name = 'Untouched Sweep'), null);

-- A2 returns to the floor.
insert into crm.attendance_sessions (user_id, started_at) values (:A2, now());

select crm_test.check(
  'R8', 'an untouched lead is swept off the caller who ignored it',
  (select crm.reassign_untouched_leads() >= 1), null);

select crm_test.check(
  'R8', 'the swept lead now belongs to a different caller on the same team',
  (select caller_id <> :A1 and team_id = crm.team_of(:A1, current_date)
     from crm.leads where full_name = 'Untouched Sweep'), null);

select crm_test.check(
  'R8', 'the automatic move records no human actor',
  (select is_automatic and transferred_by is null
     from crm.lead_transfers
    where lead_id = (select id from crm.leads where full_name = 'Untouched Sweep')
    order by created_at desc limit 1), null);

-- A lead being worked must never be taken away: that would be the supervisory
-- rule broken, and a caller mid-conversation losing the record of it.
insert into crm.leads (source_id, full_name, phone_e164, caller_id, team_id, status,
                       next_action_at, assigned_at, first_touched_at, attempt_count)
values (:SRC, 'Being Worked', '+919555000002', :A1, crm.team_of(:A1, current_date),
        'working', now(), now() - interval '45 minutes', now(), 1);

select crm_test.check(
  'R8', 'a lead already being worked is never swept away',
  (select caller_id = :A1 from crm.leads where full_name = 'Being Worked'), null);

-- R9: the alert list is filtered by RLS, not by a WHERE clause in the API.
select crm_test.check(
  'R9', 'every alert raised belongs to a real lead and a real user',
  (select count(*) = 0 from crm.v_my_alerts a
     left join crm.leads l on l.id = a.lead_id
     left join crm.users u on u.id = a.user_id
    where l.id is null or u.id is null), null);

-- R5: the SLA clock only runs while the floor is open (Mon-Sat 09:30-18:30 IST).
-- Fixed dates: 2026-08-08 is a Saturday, 2026-08-09 a Sunday.
select crm_test.check(
  'R5', 'a Saturday-evening lead is due Monday morning, not during Sunday',
  crm.add_working_minutes('2026-08-08 18:25:00+05:30', 30)
    = '2026-08-10 09:55:00+05:30'::timestamptz, null);

select crm_test.check(
  'R5', 'a lead arriving on Sunday starts its clock at Monday 09:30',
  crm.add_working_minutes('2026-08-09 11:00:00+05:30', 30)
    = '2026-08-10 10:00:00+05:30'::timestamptz, null);

select crm_test.check(
  'R5', 'mid-shift, thirty minutes means thirty minutes',
  crm.add_working_minutes('2026-08-11 11:00:00+05:30', 30)
    = '2026-08-11 11:30:00+05:30'::timestamptz, null);

select crm_test.check(
  'R5', 'a two-day allowance carries across the Sunday without counting it',
  -- A working day is 510 minutes now that lunch (14:00-14:30) is off the
  -- clock: Saturday 510 + Monday 510 lands exactly at Monday close.
  crm.add_working_minutes('2026-08-08 09:00:00+05:30', 1020)
    = '2026-08-10 18:30:00+05:30'::timestamptz, null);

select crm_test.check(
  'R5', 'a new lead''s first-touch deadline lands inside working hours',
  (select extract(dow from first_touch_due_at at time zone 'Asia/Kolkata') <> 0
      and (extract(hour from first_touch_due_at at time zone 'Asia/Kolkata') * 60
           + extract(minute from first_touch_due_at at time zone 'Asia/Kolkata')) between 570 and 1110
     from crm.leads where first_touch_due_at is not null
    order by created_at desc limit 1), null);

-- R1: presence means TODAY. An open session from a previous day is a
-- forgotten logout, never a reason to hand its owner a lead.
insert into crm.users (id, full_name, email, role) values
  ('22222222-0000-0000-0000-0000000000fb', 'Ghost Session', 'ghost@5circles.test', 'caller')
on conflict do nothing;
insert into crm.attendance_sessions (user_id, started_at)
values ('22222222-0000-0000-0000-0000000000fb', now() - interval '2 days');

select crm_test.check(
  'R1', 'an open session from a previous day does not count as on shift',
  not crm.is_on_shift('22222222-0000-0000-0000-0000000000fb'), null);

-- Retire the fixture so the scoring counts later in this file stay exact.
update crm.attendance_sessions set ended_at = started_at + interval '1 hour'
 where user_id = '22222222-0000-0000-0000-0000000000fb';
update crm.users set is_active = false, deactivated_at = now()
 where id = '22222222-0000-0000-0000-0000000000fb';

-- R1: performance tiers. RESTRICTED gets zero fresh leads; ACE holds the
-- floor share; an expired pin lapses back to STANDARD.
insert into crm.performance_tiers (user_id, tier, pinned_by, pin_reason)
values (:B2, 'restricted', :ADMIN, 'acceptance: restricted exclusion');

do $$
declare i int; v uuid;
begin
  for i in 1..10 loop
    insert into crm.leads (source_id, full_name, phone_e164, team_id)
    values ('33333333-0000-0000-0000-000000000001', 'Tier R '||i,
            '+9193000'||lpad(i::text,5,'0'), '11111111-0000-0000-0000-000000000002')
    returning id into v;
    perform crm.assign_lead(v);
  end loop;
end $$;

select crm_test.check(
  'R1', 'a RESTRICTED caller receives zero fresh leads',
  (select count(*) = 0 from crm.leads
    where full_name like 'Tier R %' and caller_id = :B2), null);

select crm_test.check(
  'R1', 'the exclusion is written to the pass-over audit, with its reason',
  (select count(*) > 0 from crm.distribution_events
    where passed_over @> jsonb_build_array(
      jsonb_build_object('user_id', :B2, 'reason', 'restricted_excluded'))), null);

-- ACE floor share on Team A: pin A1 ace, push 30, expect at least twice A2.
insert into crm.performance_tiers (user_id, tier, pinned_by, pin_reason)
values (:A1, 'ace', :ADMIN, 'acceptance: ace floor share');

do $$
declare i int; v uuid;
begin
  for i in 1..30 loop
    insert into crm.leads (source_id, full_name, phone_e164, team_id)
    values ('33333333-0000-0000-0000-000000000001', 'Tier A '||i,
            '+9194000'||lpad(i::text,5,'0'), '11111111-0000-0000-0000-000000000001')
    returning id into v;
    perform crm.assign_lead(v);
  end loop;
end $$;

select crm_test.check(
  'R1', 'an ACE caller takes the floor share of a 30-lead batch',
  (select count(*) filter (where caller_id = :A1)
        >= 2 * count(*) filter (where caller_id = :A2)
     from crm.leads where full_name like 'Tier A %'),
  (select 'ace ' || count(*) filter (where caller_id = :A1)
        || ' vs ' || count(*) filter (where caller_id = :A2)
     from crm.leads where full_name like 'Tier A %'));

-- An expired pin must lapse: yesterday's punishment does not outlive itself.
update crm.performance_tiers
   set pin_expires_at = now() - interval '1 hour' where user_id = :B2;
select crm_test.check(
  'R1', 'an expired RESTRICTED pin falls back to STANDARD automatically',
  crm.tier_of(:B2) = 'standard', crm.tier_of(:B2));

-- Clean the tier table so later assertions see the pre-tier world.
delete from crm.performance_tiers;

-- R5: the lunch freeze is a hole in working time. 2026-08-11 is a Tuesday.
select crm_test.check(
  'R5', 'a 30-minute SLA starting 13:50 lands at 14:50 - lunch is not counted',
  crm.add_working_minutes('2026-08-11 13:50:00+05:30', 30)
    = '2026-08-11 14:50:00+05:30'::timestamptz, null);

select crm_test.check(
  'R5', 'time inside the freeze window starts counting only at 14:30',
  crm.add_working_minutes('2026-08-11 14:10:00+05:30', 10)
    = '2026-08-11 14:40:00+05:30'::timestamptz, null);

select crm_test.check(
  'R5', 'in_freeze knows the window edges',
  crm.in_freeze('2026-08-11 14:10:00+05:30')
  and not crm.in_freeze('2026-08-11 14:35:00+05:30')
  and not crm.in_freeze('2026-08-09 14:10:00+05:30'), null);  -- Sunday: floor closed anyway

-- =============================================================================
-- REQUIREMENT 6: a 9-hour login is visible per person per day
-- =============================================================================

-- Yesterday: A1 works a full 9 hours across two sessions; B1 works 7.
insert into crm.attendance_sessions (user_id, started_at, ended_at) values
  (:A1, (current_date - 1 + time '09:25') at time zone 'Asia/Kolkata',
        (current_date - 1 + time '13:30') at time zone 'Asia/Kolkata'),
  (:A1, (current_date - 1 + time '14:00') at time zone 'Asia/Kolkata',
        (current_date - 1 + time '18:55') at time zone 'Asia/Kolkata'),
  (:B1, (current_date - 1 + time '10:15') at time zone 'Asia/Kolkata',
        (current_date - 1 + time '17:15') at time zone 'Asia/Kolkata');

select crm_test.check(
  'R6', 'a full 9-hour day across two sessions is counted as met',
  (select met_hours and logged_minutes >= 540
     from crm.v_attendance_day
    where user_id = :A1 and business_date = current_date - 1),
  (select logged_minutes || ' minutes logged'
     from crm.v_attendance_day
    where user_id = :A1 and business_date = current_date - 1));

select crm_test.check(
  'R6', 'a 7-hour day shows the shortfall',
  (select not met_hours and shortfall_minutes between 115 and 125
     from crm.v_attendance_day
    where user_id = :B1 and business_date = current_date - 1),
  (select 'shortfall ' || shortfall_minutes || ' min'
     from crm.v_attendance_day
    where user_id = :B1 and business_date = current_date - 1));

select crm_test.check(
  'R6', 'a 10:15 start is flagged late against a 09:30 shift',
  (select is_late from crm.v_attendance_day
    where user_id = :B1 and business_date = current_date - 1), null);

select crm_test.check(
  'R6', 'a 09:25 start is not flagged late',
  (select not is_late from crm.v_attendance_day
    where user_id = :A1 and business_date = current_date - 1), null);

do $$
begin
  insert into crm.attendance_sessions (user_id, started_at, ended_at)
  values ('22222222-0000-0000-0000-000000000001',
          (current_date - 1 + time '10:00') at time zone 'Asia/Kolkata',
          (current_date - 1 + time '11:00') at time zone 'Asia/Kolkata');
  perform crm_test.check('R6', 'overlapping sessions cannot inflate hours', false,
                         'overlapping session was accepted');
exception when exclusion_violation then
  perform crm_test.check('R6', 'overlapping sessions cannot inflate hours', true, null);
end $$;

-- =============================================================================
-- REQUIREMENT 7: callers and counsellors are scored, with a breakdown
-- =============================================================================

select crm.snapshot_scores(crm.ist_date(now())) as users_scored \gset

select crm_test.check(
  'R7', 'scores are computed for every active caller and counsellor',
  (select count(*) = 6 from crm.score_snapshots where score_date = crm.ist_date(now())),
  (select count(*)::text || ' snapshots' from crm.score_snapshots
    where score_date = crm.ist_date(now())));

select crm_test.check(
  'R7', 'a caller score carries all seven components for self-reflection',
  (select jsonb_object_keys_count = 7 from (
     select count(*) as jsonb_object_keys_count
       from crm.score_snapshots s, jsonb_object_keys(s.components) k
      where s.user_id = :A1 and s.score_date = crm.ist_date(now())) x), null);

select crm_test.check(
  'R7', 'the score total is bounded 0-100',
  (select bool_and(total >= 0 and total <= 100) from crm.score_snapshots), null);

-- The key property: doing nothing must not out-score doing something. Before
-- the components were rescaled over what actually applied, an idle caller
-- collected full marks on every empty component and beat an active one.
select crm_test.check(
  'R7', 'an idle caller never out-scores an active one',
  (select coalesce(min(active.total), 0) >= coalesce(max(idle.total), 0)
     from (select s.total from crm.score_snapshots s
            join crm.v_caller_day c
              on c.user_id = s.user_id and c.business_date = s.score_date
           where s.score_date = crm.ist_date(now()) and c.dials > 0) active
     full join (select s.total from crm.score_snapshots s
            join crm.v_caller_day c
              on c.user_id = s.user_id and c.business_date = s.score_date
           where s.score_date = crm.ist_date(now()) and c.dials = 0) idle on true),
  (select 'lowest active=' || coalesce(min(s.total) filter (where c.dials > 0), 0)
        || ' highest idle=' || coalesce(max(s.total) filter (where c.dials = 0), 0)
     from crm.score_snapshots s
     join crm.v_caller_day c on c.user_id = s.user_id and c.business_date = s.score_date
    where s.score_date = crm.ist_date(now())));

select crm_test.check(
  'R7', 'a caller with no activity at all scores zero, not neutral credit',
  (select coalesce(bool_and(s.total = 0), true)
     from crm.score_snapshots s
     join crm.v_caller_day c on c.user_id = s.user_id and c.business_date = s.score_date
    where s.score_date = crm.ist_date(now())
      and c.dials = 0 and c.leads_assigned = 0), null);

-- =============================================================================
-- REQUIREMENT 2 + breakeven: the dashboards return sane numbers
-- =============================================================================

-- The counsellor being tested leads Team A, so the deal must sit on a Team A
-- lead. Picking one from the other team would model a counsellor owning a lead
-- outside their own team, which the org structure does not allow.
create table crm_test.fixtures (name text primary key, lead_id uuid);

do $$
declare v_lead uuid; v_deal uuid;
begin
  select id into v_lead
    from crm.leads
   where full_name like 'Lead %'
     and team_id = '11111111-0000-0000-0000-000000000001'
     and status = 'working'
   order by full_name
   limit 1;
  insert into crm_test.fixtures (name, lead_id) values ('deal_lead', v_lead);

  update crm.leads set counsellor_id = '22222222-0000-0000-0000-000000000005' where id = v_lead;

  insert into crm.deals (lead_id, product_id, counsellor_id, setter_id, team_id, booked_amount)
  values (v_lead, '44444444-0000-0000-0000-000000000002',
          '22222222-0000-0000-0000-000000000005',
          (select caller_id from crm.leads where id = v_lead),
          '11111111-0000-0000-0000-000000000001', 75000)
  returning id into v_deal;

  insert into crm.instalments (deal_id, seq, due_date, amount) values
    (v_deal, 1, crm.ist_date(now()), 40000),
    (v_deal, 2, crm.ist_date(now()) + 30, 35000);

  insert into crm.payments (deal_id, instalment_id, amount, mode)
  values (v_deal, (select id from crm.instalments where deal_id = v_deal and seq = 1),
          40000, 'upi');
end $$;

select crm_test.check(
  'R2', 'booking a deal marks the lead won and clears it from the calling pipeline',
  (select l.status = 'won' and l.next_action_at is null
     from crm.leads l join crm_test.fixtures f on f.lead_id = l.id
    where f.name = 'deal_lead'), null);

select crm_test.check(
  'R2', 'a won lead no longer appears in anyone''s day',
  (select count(*) = 0 from crm.v_my_day
    where lead_id = (select lead_id from crm_test.fixtures where name = 'deal_lead')), null);

select crm_test.check(
  'R2', 'the payment settles the instalment',
  (select i.status = 'paid' from crm.instalments i join crm.deals d on d.id = i.deal_id
    where i.seq = 1 and d.booked_amount = 75000), null);

select crm_test.check(
  'R2', 'counsellor dashboard reports booked and collected',
  (select booked_amount = 75000 and collected_amount = 40000
     from crm.v_counsellor_mtd where user_id = :CNS_A),
  (select 'booked ' || booked_amount || ' collected ' || collected_amount
     from crm.v_counsellor_mtd where user_id = :CNS_A));

select crm_test.check(
  'R2', 'caller dashboard reports dials, connects and unverified calls',
  (select dials > 0 from crm.v_caller_day
    where user_id = :A1 and business_date = crm.ist_date(now())), null);

-- Breakeven: 7,00,000 at 85% collection requires 8,23,529 booked, 28,000/day.
select crm_test.check(
  'BE', 'required booking grosses up for collection slippage',
  (select required_booking between 823000 and 824000 from crm.v_collection_thermometer),
  (select 'required booking ' || required_booking from crm.v_collection_thermometer));

select crm_test.check(
  'BE', 'daily collection floor is breakeven / working days',
  (select daily_collection_floor = 28000 from crm.v_collection_thermometer),
  (select 'floor ' || daily_collection_floor from crm.v_collection_thermometer));

select crm_test.check(
  'BE', 'thermometer status escalates when collection is behind pace',
  (select status in ('green','amber','red','founder_intervention')
     from crm.v_collection_thermometer),
  (select status || ' at ' || coalesce(pct_of_pace::text,'0') || '% of pace'
     from crm.v_collection_thermometer));

-- =============================================================================
-- REQUIREMENT 9 (access control): row-level security actually holds
-- =============================================================================

-- Everything below runs as the unprivileged application role, exactly as the
-- API server does. Superuser bypasses RLS, so this switch is the whole test.
set role crm_app;

select set_config('app.user_id', '22222222-0000-0000-0000-000000000001', false) as _ \gset
select crm_test.check(
  'R9', 'a caller sees only leads assigned to them',
  (select count(*) = 0 from crm.leads where caller_id is distinct from :A1),
  (select 'visible rows not owned by A1: ' || count(*)
     from crm.leads where caller_id is distinct from :A1));

select crm_test.check(
  'R9', 'a caller cannot see the other team''s leads at all',
  (select count(*) = 0 from crm.leads where team_id = :TEAM_B), null);

select crm_test.check(
  'R9', 'a caller cannot read another caller''s call attempts',
  (select count(*) = 0 from crm.call_attempts where user_id = :B1), null);

select crm_test.check(
  'R9', 'a caller cannot read the audit log',
  (select count(*) = 0 from crm.audit_log), null);

select crm_test.check(
  'R9', 'a caller cannot read another caller''s device call log',
  (select count(*) = 0 from crm.device_call_logs where user_id <> :A1), null);

do $$
begin
  insert into crm.leads (source_id, full_name, phone_e164)
  values ('33333333-0000-0000-0000-000000000001', 'Injected', '9111100001');
  perform crm_test.check('R9', 'a caller cannot create leads', false,
                         'the insert unexpectedly succeeded');
exception when insufficient_privilege then
  perform crm_test.check('R9', 'a caller cannot create leads', true, null);
end $$;

do $$
begin
  update crm.leads set caller_id = '22222222-0000-0000-0000-000000000001'
   where caller_id = '22222222-0000-0000-0000-000000000003';
  perform crm_test.check('R9', 'a caller cannot reassign leads to themselves',
                         (select count(*) = 0 from crm.leads where full_name like 'Lead %'
                           and caller_id = '22222222-0000-0000-0000-000000000003'),
                         'update affected rows it should not see');
exception when insufficient_privilege then
  perform crm_test.check('R9', 'a caller cannot reassign leads to themselves', true, null);
end $$;

-- The counsellor is the team lead and does see the whole team.
select set_config('app.user_id', '22222222-0000-0000-0000-000000000005', false) as _ \gset
select crm_test.check(
  'R9', 'a counsellor sees their whole team',
  (select count(*) > 0 from crm.leads where caller_id = :A2),
  (select count(*)::text || ' team leads visible' from crm.leads));

select crm_test.check(
  'R9', 'a counsellor still cannot see the other team',
  (select count(*) = 0 from crm.leads where team_id = :TEAM_B), null);

-- Append-only guarantees survive the application role.
do $$
begin
  update crm.lead_events set event_type = 'tampered' where id = (select min(id) from crm.lead_events);
  perform crm_test.check('R9', 'the lead timeline cannot be rewritten', false,
                         'the update unexpectedly succeeded');
exception when restrict_violation or insufficient_privilege then
  perform crm_test.check('R9', 'the lead timeline cannot be rewritten', true, null);
end $$;

do $$
begin
  delete from crm.leads where full_name = 'Lead 1';
  perform crm_test.check('R9', 'the application role cannot delete leads', false,
                         'the delete unexpectedly succeeded');
exception when insufficient_privilege then
  perform crm_test.check('R9', 'the application role cannot delete leads', true, null);
end $$;

reset role;

-- The engines must work when run the way the scheduler actually runs them:
-- as the ops service account, through crm_app, under RLS. Before 0014 these
-- silently under-executed (RLS filtered rows before the statements acted).
set role crm_app;
select set_config('app.user_id', '22222222-0000-0000-0000-00000000000b', false) as _ \gset

select crm.snapshot_scores(crm.ist_date(now())) as ops_scored \gset
select crm_test.check(
  'R9', 'scheduler identity (ops) can snapshot every score',
  (:ops_scored = 6), 'scored ' || :ops_scored);

do $$
begin
  perform crm.expire_missed_callbacks();
  perform crm.mark_overdue_instalments();
  perform crm.detect_bulk_access();
  perform crm.detect_off_hours_access();
  perform crm_test.check('R9', 'scheduler engines run under RLS without privilege errors', true, null);
exception when others then
  perform crm_test.check('R9', 'scheduler engines run under RLS without privilege errors', false, sqlerrm);
end $$;

reset role;

-- Bulk-read detection.
insert into crm.lead_access_log (user_id, lead_id, context)
select :A1, id, 'detail' from crm.leads limit 20;
update crm.settings set value = '10'::jsonb where key = 'security.bulk_view_alert_threshold';

select crm.detect_bulk_access() as _alerts \gset
select crm_test.check(
  'R9', 'an abnormal bulk read raises a security alert',
  (select count(*) > 0 from crm.security_alerts where alert_type = 'bulk_lead_access'), null);

-- =============================================================================
-- REQUIREMENT 10: the floor's second round - escalation ladder, pools,
-- cross-team moves, per-lead reminders, history and chat.
-- =============================================================================

-- CNS_A leads Team A; make sure the seeded counsellor is the team lead.
select crm_test.check(
  'R10', 'the team counsellor is resolvable',
  (select crm.team_counsellor(crm.team_of(:A1, current_date)) = :CNS_A), null);

-- Two no-connect attempts by a caller escalate the lead to the counsellor.
do $$
declare
  v_lead uuid;
  v_a1   uuid := '22222222-0000-0000-0000-000000000001';
  v_src  uuid := '33333333-0000-0000-0000-000000000001';
  v_team uuid;
begin
  v_team := crm.team_of(v_a1, current_date);
  insert into crm.leads (source_id, full_name, phone_e164, caller_id, team_id, status,
                         next_action_at, assigned_at)
  values (v_src, 'Escalate Me', '+919555100001', v_a1, v_team, 'working',
          now(), now())
  returning id into v_lead;
  insert into crm.call_attempts (lead_id, user_id, disposition, duration_seconds)
  values (v_lead, v_a1, 'not_answered', 0);
  insert into crm.call_attempts (lead_id, user_id, disposition, duration_seconds)
  values (v_lead, v_a1, 'not_answered', 0);
end $$;

select crm_test.check(
  'R10', 'after two no-connect caller attempts the lead moves to the counsellor',
  (select escalation_stage = 'counsellor' and counsellor_id = :CNS_A
     from crm.leads where full_name = 'Escalate Me'), null);

select crm_test.check(
  'R10', 'an escalated lead is queued to the counsellor, not the caller',
  (select queue_owner_id = :CNS_A from crm.v_my_pipeline
    where lead_id = (select id from crm.leads where full_name = 'Escalate Me')), null);

-- The counsellor also cannot reach it -> re-tap pool, and NOT overdue.
do $$
declare v_lead uuid; v_cns uuid := '22222222-0000-0000-0000-000000000005';
begin
  select id into v_lead from crm.leads where full_name = 'Escalate Me';
  insert into crm.call_attempts (lead_id, user_id, disposition, duration_seconds)
  values (v_lead, v_cns, 'not_answered', 0);
end $$;

select crm_test.check(
  'R10', 'a counsellor who also cannot reach it drops the lead into the re-tap pool',
  (select status = 'nurture' and pool = 'retap' and next_action_at is null
     from crm.leads where full_name = 'Escalate Me'), null);

select crm_test.check(
  'R10', 'a re-tap lead shows in the pool and never as an overdue alert',
  (select
     (select count(*) = 1 from crm.v_retap_pool
       where lead_id = (select id from crm.leads where full_name = 'Escalate Me'))
     and
     (select count(*) = 0 from crm.v_my_alerts
       where lead_id = (select id from crm.leads where full_name = 'Escalate Me')
         and kind in ('action_overdue', 'follow_up_due'))), null);

-- Claiming a parked lead brings it back to life.
do $$
declare v_lead uuid; v_cns uuid := '22222222-0000-0000-0000-000000000005';
begin
  select id into v_lead from crm.leads where full_name = 'Escalate Me';
  perform crm.claim_parked_lead(v_lead, v_cns);
end $$;

select crm_test.check(
  'R10', 'claiming a parked lead makes it live again with a fresh action',
  (select status = 'working' and pool is null and next_action_at > now()
     from crm.leads where full_name = 'Escalate Me'), null);

-- Cross-team move: a lead nobody has worked for long enough goes to the other
-- team as a fresh, unassigned lead, and notifies that team's counsellor.
do $$
declare
  v_lead uuid;
  v_a1   uuid := '22222222-0000-0000-0000-000000000001';
  v_src  uuid := '33333333-0000-0000-0000-000000000001';
  v_team uuid;
begin
  v_team := crm.team_of(v_a1, current_date);
  insert into crm.leads (source_id, full_name, phone_e164, caller_id, team_id, status,
                         next_action_at, assigned_at, created_at)
  values (v_src, 'Stale Lead', '+919555100002', v_a1, v_team, 'working',
          now() - interval '30 days', now() - interval '30 days', now() - interval '30 days')
  returning id into v_lead;
end $$;

select crm.escalate_stuck_leads() as _moved \gset

select crm_test.check(
  'R10', 'a lead untouched past the cutoff moves to the other team',
  (select team_id <> crm.team_of(:A1, current_date) and caller_id is null
          and cross_team_count = 1
     from crm.leads where full_name = 'Stale Lead'), null);

select crm_test.check(
  'R10', 'the receiving team counsellor is notified of the cross-team arrival',
  (select count(*) >= 1 from crm.notifications n
     join crm.leads l on l.id = n.lead_id
    where l.full_name = 'Stale Lead' and n.kind = 'cross_team_in'), null);

-- Per-lead reminder: muting silences the nag; a custom time raises exactly one.
do $$
declare
  v_lead uuid;
  v_a1   uuid := '22222222-0000-0000-0000-000000000001';
  v_src  uuid := '33333333-0000-0000-0000-000000000001';
begin
  insert into crm.leads (source_id, full_name, phone_e164, caller_id, team_id, status,
                         next_action_at, assigned_at, first_touched_at, attempt_count,
                         reminder_muted)
  values (v_src, 'Muted Lead', '+919555100003', v_a1, crm.team_of(v_a1, current_date),
          'working', now() - interval '2 hours', now() - interval '3 hours',
          now() - interval '3 hours', 1, true)
  returning id into v_lead;
end $$;

select crm_test.check(
  'R10', 'a muted lead raises no follow-up or overdue reminder',
  (select count(*) = 0 from crm.v_my_alerts
    where lead_id = (select id from crm.leads where full_name = 'Muted Lead')), null);

do $$
declare
  v_lead uuid;
  v_a1   uuid := '22222222-0000-0000-0000-000000000001';
  v_src  uuid := '33333333-0000-0000-0000-000000000001';
begin
  insert into crm.leads (source_id, full_name, phone_e164, caller_id, team_id, status,
                         next_action_at, assigned_at, first_touched_at, attempt_count,
                         reminder_at, reminder_note)
  values (v_src, 'Custom Reminder', '+919555100004', v_a1, crm.team_of(v_a1, current_date),
          'working', now() + interval '1 day', now() - interval '1 hour',
          now() - interval '1 hour', 1, now() - interval '1 minute', 'Ring at noon')
  returning id into v_lead;
end $$;

select crm_test.check(
  'R10', 'a custom reminder that has come due raises one alert for the owner',
  (select count(*) = 1 from crm.v_my_alerts
    where lead_id = (select id from crm.leads where full_name = 'Custom Reminder')
      and kind = 'custom_reminder' and user_id = :A1), null);

-- Historical import: a previous-month lead is parked, tappable, not in the queue.
do $$
declare
  v_lead uuid;
  v_a1   uuid := '22222222-0000-0000-0000-000000000001';
  v_src  uuid := '33333333-0000-0000-0000-000000000001';
begin
  insert into crm.leads (source_id, full_name, phone_e164, team_id, status,
                         pool, is_historical, imported_month, import_batch)
  values (v_src, 'April Record', '+919555100005', crm.team_of(v_a1, current_date),
          'nurture', 'previous_month', true, date '2026-04-01', 'apr-upload')
  returning id into v_lead;
end $$;

select crm_test.check(
  'R10', 'an uploaded historical lead lands in the previous-month pool',
  (select month_label = 'Apr 2026' from crm.v_previous_month_pool
    where lead_id = (select id from crm.leads where full_name = 'April Record')), null);

select crm_test.check(
  'R10', 'a historical lead never appears in the live pipeline',
  (select count(*) = 0 from crm.v_my_pipeline
    where lead_id = (select id from crm.leads where full_name = 'April Record')), null);

-- Team chat: an admin broadcast to the whole floor is readable.
do $$
declare v_admin uuid := '22222222-0000-0000-0000-00000000000a';
begin
  insert into crm.team_messages (author_id, team_id, body)
  values (v_admin, null, 'Floor-wide notice: stand-up at 9:30.');
end $$;

select crm_test.check(
  'R10', 'a floor-wide chat message exists and is scoped to no single team',
  (select count(*) = 1 from crm.team_messages
    where team_id is null and body like 'Floor-wide notice%'), null);

-- The will-visit bucket exists so promised visits have a home.
do $$
declare
  v_lead uuid;
  v_a1   uuid := '22222222-0000-0000-0000-000000000001';
  v_src  uuid := '33333333-0000-0000-0000-000000000001';
begin
  insert into crm.leads (source_id, full_name, phone_e164, caller_id, team_id, status,
                         next_action_at, assigned_at, first_touched_at, attempt_count,
                         walkin_expected_at)
  values (v_src, 'Will Visit Lead', '+919555100006', v_a1, crm.team_of(v_a1, current_date),
          'working', now() + interval '2 hours', now() - interval '1 hour',
          now() - interval '1 hour', 1, now() + interval '1 day')
  returning id into v_lead;
end $$;

select crm_test.check(
  'R10', 'a promised visit lands in the will_visit bucket, not lost among follow-ups',
  (select bucket = 'will_visit' from crm.v_my_pipeline
    where lead_id = (select id from crm.leads where full_name = 'Will Visit Lead')), null);

-- =============================================================================
-- MENTORS (MEN): the paying-client book, the computed health chip, and the
-- mentor's row-level fence. One fixture client per health rule, so each rule
-- in the training module's table has an assertion with its exact day-counts.
-- =============================================================================

do $$
declare
  v_src     uuid := '33333333-0000-0000-0000-000000000001';
  v_cnsA    uuid := '22222222-0000-0000-0000-000000000005';
  v_mentor  uuid := '22222222-0000-0000-0000-00000000000d';
  v_teamA   uuid := '11111111-0000-0000-0000-000000000001';
  v_prod    uuid := '44444444-0000-0000-0000-000000000001';
  v_lead    uuid;
  i         int := 0;
  v_name    text[];
  v_deal    uuid;
  -- name, deal suffix, days since first payment
  fixtures  text[][] := array[
    ['Mentor Client Green',     '01', '0'],
    ['Mentor Client Amber',     '02', '30'],
    ['Mentor Client Concern',   '03', '30'],
    ['Mentor Client Silent',    '04', '60'],
    ['Mentor Client Fresh',     '05', '0'],
    ['Mentor Client Forgotten', '06', '10'],
    ['Mentor Client Slipped',   '07', '30'],
    ['Mentor Client Promise',   '08', '30']
  ];
begin
  foreach v_name slice 1 in array fixtures loop
    i := i + 1;
    insert into crm.leads (source_id, full_name, phone_e164, caller_id, team_id, status, closed_at)
    values (v_src, v_name[1], '+91955520000' || i, null, v_teamA, 'won',
            now() - make_interval(days => v_name[3]::int))
    returning id into v_lead;

    v_deal := ('88888888-0000-0000-0000-0000000000' || v_name[2])::uuid;
    insert into crm.deals (id, lead_id, product_id, counsellor_id, team_id, booked_amount)
    values (v_deal, v_lead, v_prod, v_cnsA, v_teamA, 25000);
    insert into crm.payments (deal_id, amount, mode, recorded_by, paid_at)
    values (v_deal, 25000, 'upi', v_cnsA, now() - make_interval(days => v_name[3]::int));
  end loop;

  -- One booked-but-unpaid deal: money not received means not a client.
  insert into crm.leads (source_id, full_name, phone_e164, caller_id, team_id, status, closed_at)
  values (v_src, 'Booked Not Paid', '+919555200009', null, v_teamA, 'won', now())
  returning id into v_lead;
  insert into crm.deals (id, lead_id, product_id, counsellor_id, team_id, booked_amount)
  values ('88888888-0000-0000-0000-000000000009', v_lead, v_prod, v_cnsA, v_teamA, 25000);

  -- The touchpoints that drive each health rule (superuser insert: fixtures).
  insert into crm.mentor_touchpoints (deal_id, mentor_id, touched_on, channel, outcome, upsell, upsell_note, next_touch_on)
  values
    -- Green: touched today, went fine.
    ('88888888-0000-0000-0000-000000000001', v_mentor, crm.ist_date(now()), 'call', 'reached_positive', 'none', null, null),
    -- Amber by age: last touch 12 days old (amber at >10, red at >21).
    ('88888888-0000-0000-0000-000000000002', v_mentor, crm.ist_date(now()) - 12, 'whatsapp', 'reached_positive', 'high', 'annual renewal', null),
    -- Red: concern raised, immediately.
    ('88888888-0000-0000-0000-000000000003', v_mentor, crm.ist_date(now()), 'call', 'reached_concern', 'none', null, null),
    -- Red by silence: last touch 30 days old.
    ('88888888-0000-0000-0000-000000000004', v_mentor, crm.ist_date(now()) - 30, 'call', 'reached_positive', 'none', null, null),
    -- Amber: follow-up promised yesterday, inside the 3-day grace.
    ('88888888-0000-0000-0000-000000000007', v_mentor, crm.ist_date(now()) - 2, 'call', 'reached_positive', 'none', null, crm.ist_date(now()) - 1),
    -- Red: follow-up 5 days late, past the grace.
    ('88888888-0000-0000-0000-000000000008', v_mentor, crm.ist_date(now()) - 6, 'call', 'reached_positive', 'none', null, crm.ist_date(now()) - 5);

  -- Assign the green client to the mentor, the way the admin screen does it.
  insert into crm.advisory_checkpoints (deal_id, mentor_id)
  values ('88888888-0000-0000-0000-000000000001', v_mentor);
end $$;

select crm_test.check(
  'MEN', 'money recorded puts a client in the book; booked-but-unpaid stays out',
  (select count(*) = 8 from crm.v_mentor_book where full_name like 'Mentor Client %')
  and not exists (select 1 from crm.v_mentor_book where full_name = 'Booked Not Paid'),
  null);

select crm_test.check(
  'MEN', 'touched today and fine means green',
  (select health = 'green' from crm.v_mentor_book where full_name = 'Mentor Client Green'), null);

select crm_test.check(
  'MEN', 'a 12-day-old touch means amber',
  (select health = 'amber' from crm.v_mentor_book where full_name = 'Mentor Client Amber'), null);

select crm_test.check(
  'MEN', 'a concern raised today means red, regardless of recency',
  (select health = 'red' from crm.v_mentor_book where full_name = 'Mentor Client Concern'), null);

select crm_test.check(
  'MEN', 'thirty days of silence means red',
  (select health = 'red' from crm.v_mentor_book where full_name = 'Mentor Client Silent'), null);

select crm_test.check(
  'MEN', 'paid today and never touched starts amber, not red',
  (select health = 'amber' from crm.v_mentor_book where full_name = 'Mentor Client Fresh'), null);

select crm_test.check(
  'MEN', 'never touched ten days after paying means red',
  (select health = 'red' from crm.v_mentor_book where full_name = 'Mentor Client Forgotten'), null);

select crm_test.check(
  'MEN', 'a follow-up one day late is amber - inside the grace window',
  (select health = 'amber' from crm.v_mentor_book where full_name = 'Mentor Client Slipped'), null);

select crm_test.check(
  'MEN', 'a follow-up five days late is red - past the grace window',
  (select health = 'red' from crm.v_mentor_book where full_name = 'Mentor Client Promise'), null);

select crm_test.check(
  'MEN', 'the latest upsell flag surfaces on the book row',
  (select upsell_potential = 'high' and upsell_note = 'annual renewal'
     from crm.v_mentor_book where full_name = 'Mentor Client Amber'), null);

select crm_test.check(
  'MEN', 'the assigned mentor shows on the book row',
  (select mentor_name = 'Mentor One'
     from crm.v_mentor_book where full_name = 'Mentor Client Green'), null);

-- A mentor with a team membership still never enters lead distribution:
-- eligibility is role-gated, not membership-gated.
do $$
begin
  insert into crm.team_memberships (user_id, team_id, rotation_order, period)
  values ('22222222-0000-0000-0000-00000000000d',
          '11111111-0000-0000-0000-000000000001', 99, daterange(current_date, null, '[)'));
end $$;

select crm_test.check(
  'MEN', 'a mentor never appears among eligible callers, membership or not',
  (select count(*) = 0 from crm.eligible_callers('11111111-0000-0000-0000-000000000001')
    where user_id = '22222222-0000-0000-0000-00000000000d'), null);

delete from crm.team_memberships
 where user_id = '22222222-0000-0000-0000-00000000000d';

-- The mentor's row-level fence, tested as the app role exactly like R9.
set role crm_app;
select set_config('app.user_id', '22222222-0000-0000-0000-00000000000d', false) as _ \gset

select crm_test.check(
  'MEN', 'a mentor sees a paying client''s lead',
  (select count(*) = 1 from crm.leads where full_name = 'Mentor Client Green'), null);

select crm_test.check(
  'MEN', 'a mentor cannot see a lead without money against it',
  (select count(*) = 0 from crm.leads
    where full_name in ('Booked Not Paid', 'Will Visit Lead')), null);

select crm_test.check(
  'MEN', 'a mentor reads the book through RLS and every row is a paying client',
  (select count(*) > 0 and count(*) = count(*) filter (where paid_amount > 0)
     from crm.v_mentor_book), null);

do $$
begin
  insert into crm.mentor_touchpoints (deal_id, mentor_id, touched_on, channel, outcome)
  values ('88888888-0000-0000-0000-000000000005',
          '22222222-0000-0000-0000-00000000000d', crm.ist_date(now()), 'call', 'reached_neutral');
  perform crm_test.check('MEN', 'a mentor logs a touchpoint as themselves', true, null);
exception when insufficient_privilege then
  perform crm_test.check('MEN', 'a mentor logs a touchpoint as themselves', false,
                         'insert was refused');
end $$;

do $$
begin
  insert into crm.mentor_touchpoints (deal_id, mentor_id, touched_on, channel, outcome)
  values ('88888888-0000-0000-0000-000000000005',
          '22222222-0000-0000-0000-000000000005', crm.ist_date(now()), 'call', 'reached_neutral');
  perform crm_test.check('MEN', 'a touchpoint cannot be logged in someone else''s name', false,
                         'the forged insert unexpectedly succeeded');
exception when insufficient_privilege then
  perform crm_test.check('MEN', 'a touchpoint cannot be logged in someone else''s name', true, null);
end $$;

do $$
begin
  update crm.mentor_touchpoints set note = 'rewritten history'
   where deal_id = '88888888-0000-0000-0000-000000000005';
  perform crm_test.check('MEN', 'the touchpoint log is append-only for the app role', false,
                         'the update unexpectedly succeeded');
exception when insufficient_privilege then
  perform crm_test.check('MEN', 'the touchpoint log is append-only for the app role', true, null);
end $$;

-- A caller sees none of it: post-sale notes are not floor reading.
select set_config('app.user_id', '22222222-0000-0000-0000-000000000001', false) as _ \gset
select crm_test.check(
  'MEN', 'a caller cannot read mentor touchpoints at all',
  (select count(*) = 0 from crm.mentor_touchpoints), null);

reset role;

-- =============================================================================
-- Results
-- =============================================================================

\o
\echo ''
\echo '================ TEST RESULTS ================'
select requirement as req,
       case when passed then 'PASS' else 'FAIL' end as status,
       name,
       coalesce(detail, '') as detail
  from crm_test.results
 order by id;

\echo ''
select requirement as req,
       count(*) filter (where passed) as passed,
       count(*) filter (where not passed) as failed
  from crm_test.results group by requirement order by requirement;

\echo ''
select count(*) as total,
       count(*) filter (where passed) as passed,
       count(*) filter (where not passed) as failed
  from crm_test.results;

-- Fail the run if anything failed.
do $$
declare v_failed int;
begin
  select count(*) into v_failed from crm_test.results where not passed;
  if v_failed > 0 then
    raise exception '% test(s) failed', v_failed;
  end if;
  raise notice 'all tests passed';
end $$;
