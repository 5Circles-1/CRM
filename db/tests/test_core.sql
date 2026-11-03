-- test_core.sql
-- Assertions for the core rules. Run by db/rebuild.sh --with-tests against a
-- freshly seeded database. Every block raises on failure, so a clean exit is
-- a pass.
--
-- Areas: phone normalisation, round-robin assignment, call outcomes and
-- stage transitions, the qualified handover, checkpoints, re-enquiries,
-- assignment authority, the open-lead-has-a-date constraint, one live lead
-- per phone, row-level security, append-only activities.

\set ON_ERROR_STOP 1

-- Fixed ids from db/seed/seed.sql
\set admin  '''22222222-0000-0000-0000-00000000000a'''
\set system '''22222222-0000-0000-0000-00000000000b'''
\set sanya  '''22222222-0000-0000-0000-000000000001'''
\set harsh  '''22222222-0000-0000-0000-000000000002'''
\set aisha  '''22222222-0000-0000-0000-000000000003'''
\set meta   '''33333333-0000-0000-0000-000000000001'''
\set manual '''33333333-0000-0000-0000-000000000003'''

-- ---------------------------------------------------------------------------
-- T1: phone normalisation
-- ---------------------------------------------------------------------------
do $$
begin
  if crm.normalise_phone('+91 98765 43210') <> '+919876543210' then raise exception 'T1a'; end if;
  if crm.normalise_phone('09876543210')     <> '+919876543210' then raise exception 'T1b'; end if;
  if crm.normalise_phone('919876543210')    <> '+919876543210' then raise exception 'T1c'; end if;
  if crm.normalise_phone('98765-43210')     <> '+919876543210' then raise exception 'T1d'; end if;
  if crm.normalise_phone('12345') is not null then raise exception 'T1e: junk must be NULL'; end if;
  if crm.normalise_phone(null) is not null then raise exception 'T1f'; end if;
end $$;

-- ---------------------------------------------------------------------------
-- T2: round-robin assignment. Four fresh leads alternate Sanya/Harsh
-- (least-loaded today, rotation order breaking ties). Admins never receive.
-- ---------------------------------------------------------------------------
do $$
declare
  a uuid; b uuid; c uuid; d uuid;
  n_sanya int; n_harsh int;
begin
  perform set_config('app.user_id', '22222222-0000-0000-0000-00000000000b', true);

  -- Four single inserts on an empty book alternate strictly: tie goes to
  -- rotation order 1 (Sanya), then least-loaded flips it each time.
  insert into crm.leads (source_id, full_name, phone_e164)
  values ('33333333-0000-0000-0000-000000000001', 'RR One', '+919000000101')
  returning assigned_to into a;
  insert into crm.leads (source_id, full_name, phone_e164)
  values ('33333333-0000-0000-0000-000000000001', 'RR Two', '+919000000102')
  returning assigned_to into b;
  insert into crm.leads (source_id, full_name, phone_e164)
  values ('33333333-0000-0000-0000-000000000001', 'RR Three', '+919000000103')
  returning assigned_to into c;
  insert into crm.leads (source_id, full_name, phone_e164)
  values ('33333333-0000-0000-0000-000000000001', 'RR Four', '+919000000104')
  returning assigned_to into d;

  if a <> '22222222-0000-0000-0000-000000000001' then raise exception 'T2a: first lead must go to rotation 1'; end if;
  if b <> '22222222-0000-0000-0000-000000000002' then raise exception 'T2b: second lead must alternate'; end if;
  if c <> a or d <> b then raise exception 'T2c: A-B-A-B expected'; end if;

  -- A batch insert in one statement still spreads (assign_next_caller is
  -- volatile, so each row sees the rows before it).
  insert into crm.leads (source_id, full_name, phone_e164)
  values ('33333333-0000-0000-0000-000000000001', 'RR Five',  '+919000000105'),
         ('33333333-0000-0000-0000-000000000001', 'RR Six',   '+919000000106'),
         ('33333333-0000-0000-0000-000000000001', 'RR Seven', '+919000000107');

  select count(*) filter (where assigned_to = '22222222-0000-0000-0000-000000000001'),
         count(*) filter (where assigned_to = '22222222-0000-0000-0000-000000000002')
    into n_sanya, n_harsh
    from crm.leads where full_name like 'RR %';
  if abs(n_sanya - n_harsh) > 1 then
    raise exception 'T2d: batch did not spread (sanya=%, harsh=%)', n_sanya, n_harsh;
  end if;

  -- Every lead arrived open with a follow-up date (due now).
  if exists (select 1 from crm.leads where stage = 'new' and next_follow_up_at is null) then
    raise exception 'T2c: a fresh lead has no next_follow_up_at';
  end if;

  -- And a "Lead received" system activity.
  if (select count(*) from crm.activities a2
       join crm.leads l on l.id = a2.lead_id
      where a2.kind = 'system' and l.full_name like 'RR %') < 7 then
    raise exception 'T2e: lead-received activity missing';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- T3: outcomes and transitions
-- ---------------------------------------------------------------------------
do $$
declare
  v_lead uuid;
  v crm.leads%rowtype;
begin
  perform set_config('app.user_id', '22222222-0000-0000-0000-000000000001', true); -- Sanya

  insert into crm.leads (source_id, full_name, phone_e164, assigned_to)
  values ('33333333-0000-0000-0000-000000000003', 'Outcome Case', '+919000000201',
          '22222222-0000-0000-0000-000000000001')
  returning id into v_lead;

  -- not answered: stage -> calling, streak 1, follow-up ~24h out
  perform crm.log_call(v_lead, 'not_answered', null, null);
  select * into v from crm.leads where id = v_lead;
  if v.stage <> 'calling' or v.na_streak <> 1 or v.call_count <> 1 then raise exception 'T3a'; end if;
  if v.next_follow_up_at < now() + interval '23 hours' then raise exception 'T3b: retry not pushed out'; end if;

  -- switched off: streak grows
  perform crm.log_call(v_lead, 'switched_off', 'phone off', null);
  select * into v from crm.leads where id = v_lead;
  if v.na_streak <> 2 or v.last_outcome <> 'switched_off' then raise exception 'T3c'; end if;

  -- call_back without a time is refused with a named SQLSTATE
  begin
    perform crm.log_call(v_lead, 'call_back', null, null);
    raise exception 'T3d: call_back without time must fail';
  exception when check_violation then null;
  end;

  -- call_back with a time books it and resets the streak
  perform crm.log_call(v_lead, 'call_back', 'asked for evening', now() + interval '6 hours');
  select * into v from crm.leads where id = v_lead;
  if v.na_streak <> 0 or v.last_outcome <> 'call_back' then raise exception 'T3e'; end if;
  if v.next_follow_up_at not between now() + interval '5 hours' and now() + interval '7 hours' then
    raise exception 'T3f: callback time not kept';
  end if;

  -- qualified by a caller: hands over to Aisha
  perform crm.log_call(v_lead, 'qualified', 'wants the webinar', null);
  select * into v from crm.leads where id = v_lead;
  if v.stage <> 'qualified' then raise exception 'T3g'; end if;
  if v.assigned_to <> '22222222-0000-0000-0000-000000000003' then
    raise exception 'T3h: qualified lead did not pass to the follow-up person';
  end if;
  if v.qualified_at is null then raise exception 'T3i'; end if;

  -- Aisha logs her own outcomes without losing the lead
  perform set_config('app.user_id', '22222222-0000-0000-0000-000000000003', true);
  perform crm.log_call(v_lead, 'not_answered', null, null);
  select * into v from crm.leads where id = v_lead;
  if v.stage <> 'qualified' or v.assigned_to <> '22222222-0000-0000-0000-000000000003' then
    raise exception 'T3j: a not-answered on a qualified lead must not demote it';
  end if;

  -- not qualified closes it; reopen restores the qualified stage
  perform crm.log_call(v_lead, 'not_qualified', 'said no', null);
  select * into v from crm.leads where id = v_lead;
  if v.stage <> 'not_qualified' or v.closed_at is null or v.next_follow_up_at is not null then
    raise exception 'T3k';
  end if;

  perform crm.reopen_lead(v_lead);
  select * into v from crm.leads where id = v_lead;
  if v.stage <> 'qualified' or v.closed_at is not null or v.next_follow_up_at is null then
    raise exception 'T3l: reopen must restore a qualified lead to qualified';
  end if;

  -- the timeline recorded every step, attributed
  if (select count(*) from crm.activities where lead_id = v_lead and kind = 'call') <> 6 then
    raise exception 'T3m: expected 6 call activities';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- T4: checkpoints
-- ---------------------------------------------------------------------------
do $$
declare
  v_lead uuid;
  v crm.leads%rowtype;
begin
  perform set_config('app.user_id', '22222222-0000-0000-0000-000000000003', true); -- Aisha

  insert into crm.leads (source_id, full_name, phone_e164, assigned_to, stage, qualified_at)
  values ('33333333-0000-0000-0000-000000000003', 'Checkpoint Case', '+919000000301',
          '22222222-0000-0000-0000-000000000003', 'qualified', now())
  returning id into v_lead;

  perform crm.set_checkpoint(v_lead, 'template_sent', true);
  perform crm.set_checkpoint(v_lead, 'confirmed', true);
  select * into v from crm.leads where id = v_lead;
  if v.template_sent_at is null or v.confirmed_at is null then raise exception 'T4a'; end if;

  perform crm.set_checkpoint(v_lead, 'converted', true);
  select * into v from crm.leads where id = v_lead;
  if v.stage <> 'converted' or v.converted_at is null or v.next_follow_up_at is not null then
    raise exception 'T4b';
  end if;

  -- a non-admin cannot undo a conversion
  begin
    perform crm.set_checkpoint(v_lead, 'converted', false);
    raise exception 'T4c: non-admin undo must fail';
  exception when insufficient_privilege then null;
  end;

  -- an admin can
  perform set_config('app.user_id', '22222222-0000-0000-0000-00000000000a', true);
  perform crm.set_checkpoint(v_lead, 'converted', false);
  select * into v from crm.leads where id = v_lead;
  if v.stage <> 'qualified' or v.converted_at is not null or v.next_follow_up_at is null then
    raise exception 'T4d';
  end if;

  -- a not_qualified lead cannot be converted without reopening
  perform crm.log_call(v_lead, 'not_qualified', null, null);
  begin
    perform crm.set_checkpoint(v_lead, 'converted', true);
    raise exception 'T4e: converting a closed lead must fail';
  exception when check_violation then null;
  end;
end $$;

-- ---------------------------------------------------------------------------
-- T5: re-enquiry attaches, reopens, pulls the follow-up to now
-- ---------------------------------------------------------------------------
do $$
declare
  v_lead uuid;
  v crm.leads%rowtype;
begin
  perform set_config('app.user_id', '22222222-0000-0000-0000-00000000000b', true); -- System

  insert into crm.leads (source_id, full_name, phone_e164)
  values ('33333333-0000-0000-0000-000000000001', 'Re-enquiry Case', '+919000000401')
  returning id into v_lead;

  -- close it, then the same phone enquires again
  perform set_config('app.user_id', '22222222-0000-0000-0000-000000000001', true);
  perform crm.log_call(v_lead, 'not_qualified', null, null);

  perform set_config('app.user_id', '22222222-0000-0000-0000-00000000000b', true);
  perform crm.attach_enquiry(v_lead, '33333333-0000-0000-0000-000000000001', '{}'::jsonb);

  select * into v from crm.leads where id = v_lead;
  if v.enquiry_count <> 2 then raise exception 'T5a'; end if;
  if v.stage <> 'calling' or v.closed_at is not null then raise exception 'T5b: must reopen'; end if;
  if v.next_follow_up_at > now() then raise exception 'T5c: must be due now'; end if;
  if not exists (select 1 from crm.activities where lead_id = v_lead and kind = 'enquiry') then
    raise exception 'T5d';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- T6: one live lead per phone
-- ---------------------------------------------------------------------------
do $$
begin
  perform set_config('app.user_id', '22222222-0000-0000-0000-00000000000b', true);
  begin
    insert into crm.leads (source_id, full_name, phone_e164)
    values ('33333333-0000-0000-0000-000000000001', 'Dup', '+919000000401');
    raise exception 'T6a: second live lead for one phone must fail';
  exception when unique_violation then null;
  end;
end $$;

-- ---------------------------------------------------------------------------
-- T7: assignment authority
-- ---------------------------------------------------------------------------
do $$
declare
  v_lead uuid;
  v_owner uuid;
begin
  perform set_config('app.user_id', '22222222-0000-0000-0000-00000000000b', true);
  insert into crm.leads (source_id, full_name, phone_e164)
  values ('33333333-0000-0000-0000-000000000003', 'Assign Case', '+919000000501')
  returning id, assigned_to into v_lead, v_owner;

  -- a caller cannot move an owned lead
  perform set_config('app.user_id', '22222222-0000-0000-0000-000000000001', true);
  begin
    perform crm.assign_lead(v_lead, '22222222-0000-0000-0000-000000000002');
    raise exception 'T7a: non-admin moving an owned lead must fail';
  exception when insufficient_privilege then null;
  end;

  -- an admin can
  perform set_config('app.user_id', '22222222-0000-0000-0000-00000000000a', true);
  perform crm.assign_lead(v_lead, '22222222-0000-0000-0000-000000000002');
  if (select assigned_to from crm.leads where id = v_lead)
       <> '22222222-0000-0000-0000-000000000002' then
    raise exception 'T7b';
  end if;

  -- an unassigned lead can be claimed by anyone, for themselves only
  update crm.leads set assigned_to = null where id = v_lead;
  perform set_config('app.user_id', '22222222-0000-0000-0000-000000000001', true);
  begin
    perform crm.assign_lead(v_lead, '22222222-0000-0000-0000-000000000002');
    raise exception 'T7c: claiming for a colleague must fail';
  exception when insufficient_privilege then null;
  end;
  perform crm.assign_lead(v_lead, '22222222-0000-0000-0000-000000000001');
  if (select assigned_to from crm.leads where id = v_lead)
       <> '22222222-0000-0000-0000-000000000001' then
    raise exception 'T7d';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- T8: the open-lead constraint cannot be dodged by a direct update
-- ---------------------------------------------------------------------------
do $$
begin
  perform set_config('app.user_id', '22222222-0000-0000-0000-00000000000a', true);
  begin
    update crm.leads set next_follow_up_at = null
     where stage in ('new', 'calling', 'qualified')
       and id = (select id from crm.leads where stage in ('new','calling','qualified') limit 1);
    raise exception 'T8a: an open lead with no follow-up date must be refused';
  exception when check_violation then null;
  end;
end $$;

-- ---------------------------------------------------------------------------
-- T9: row-level security, exercised as the application role
-- ---------------------------------------------------------------------------
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'crm_rls_probe') then
    create role crm_rls_probe login in role crm_app;
  end if;
end $$;
grant usage on schema crm to crm_rls_probe;

set role crm_rls_probe;

-- No app.user_id: nothing is visible, in the deny direction.
do $$
begin
  if (select count(*) from crm.leads) <> 0 then
    raise exception 'T9a: leads visible without a user';
  end if;
  if (select count(*) from crm.users) <> 0 then
    raise exception 'T9b: users visible without a user';
  end if;
end $$;

-- With an active user: the whole pipeline is visible (the transparency rule).
do $$
begin
  perform set_config('app.user_id', '22222222-0000-0000-0000-000000000002', true); -- Harsh
  if (select count(*) from crm.leads) < 8 then
    raise exception 'T9c: an active user must see every lead';
  end if;
  if (select count(*) from crm.v_lead_list) <> (select count(*) from crm.leads) then
    raise exception 'T9d: the view must show the same rows';
  end if;
end $$;

-- Credentials and sessions are unreachable for the app role entirely.
do $$
begin
  perform set_config('app.user_id', '22222222-0000-0000-0000-00000000000a', true);
  begin
    perform count(*) from crm.user_credentials;
    raise exception 'T9e: credentials readable by the app role';
  exception when insufficient_privilege then null;
  end;
end $$;

-- Activities cannot be updated (privilege) or deleted (privilege).
do $$
begin
  perform set_config('app.user_id', '22222222-0000-0000-0000-00000000000a', true);
  begin
    update crm.activities set note = 'rewritten history'
     where id = (select id from crm.activities limit 1);
    raise exception 'T9f: activities update must be refused';
  exception when insufficient_privilege then null;
  end;
  begin
    delete from crm.activities where id = (select id from crm.activities limit 1);
    raise exception 'T9g: activities delete must be refused';
  exception when insufficient_privilege then null;
  end;
end $$;

-- A non-admin cannot write users.
do $$
declare v int;
begin
  perform set_config('app.user_id', '22222222-0000-0000-0000-000000000001', true); -- Sanya
  update crm.users set full_name = 'Hacked' where role = 'admin';
  get diagnostics v = row_count;
  if v <> 0 then raise exception 'T9h: non-admin updated a user row'; end if;
end $$;

reset role;

-- A deactivated user sees nothing.
do $$
begin
  update crm.users set is_active = false, deactivated_at = now()
   where id = '22222222-0000-0000-0000-000000000002';
end $$;

set role crm_rls_probe;
do $$
begin
  perform set_config('app.user_id', '22222222-0000-0000-0000-000000000002', true);
  if (select count(*) from crm.leads) <> 0 then
    raise exception 'T9i: a deactivated user still sees leads';
  end if;
end $$;
reset role;

do $$
begin
  update crm.users set is_active = true, deactivated_at = null
   where id = '22222222-0000-0000-0000-000000000002';
end $$;

-- ---------------------------------------------------------------------------
-- T10: deactivating the only callers falls back to follow-up, then to nobody
-- ---------------------------------------------------------------------------
do $$
declare
  v_owner uuid;
begin
  perform set_config('app.user_id', '22222222-0000-0000-0000-00000000000a', true);

  update crm.users set is_active = false, deactivated_at = now() where role = 'caller';

  insert into crm.leads (source_id, full_name, phone_e164)
  values ('33333333-0000-0000-0000-000000000003', 'Fallback Case', '+919000000601')
  returning assigned_to into v_owner;
  if v_owner <> '22222222-0000-0000-0000-000000000003' then
    raise exception 'T10a: with no callers the follow-up person must receive';
  end if;

  update crm.users set is_active = false, deactivated_at = now()
   where id = '22222222-0000-0000-0000-000000000003';

  insert into crm.leads (source_id, full_name, phone_e164)
  values ('33333333-0000-0000-0000-000000000003', 'Fallback Two', '+919000000602')
  returning assigned_to into v_owner;
  if v_owner is not null then
    raise exception 'T10b: with nobody on the floor the lead must park unassigned';
  end if;

  update crm.users set is_active = true, deactivated_at = null
   where role in ('caller', 'followup');
end $$;

select 'db core tests: all passed' as result;
