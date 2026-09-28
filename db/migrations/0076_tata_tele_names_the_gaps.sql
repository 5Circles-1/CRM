-- 0076_tata_tele_names_the_gaps.sql
-- The Tata Tele panel said "2 active callers have no Dialing number" and "1
-- caller's Dialing number is not a Smartflo agent" - and named nobody. The
-- admin was left to hunt through Admin > Users comparing numbers by eye,
-- which is exactly the job a screen that names a problem exists to do.
--
-- Two changes:
--
--   crm.v_tata_tele_coverage names each active caller or counsellor Smartflo
--   cannot serve, and why. v_tata_tele_health now counts from it, so the
--   number on the banner and the names under it are one definition.
--
--   crm.tata_tele_reconcile() applies a Dialing-number change at once. The
--   agent roster used to catch up only at the next pull, and held call
--   records were re-delivered only if they were younger than the pull's
--   26-hour window - so a number fixed on Monday for calls held since Friday
--   released nothing, despite the panel promising the held calls would
--   re-ingest themselves. Every held record is kept whole, so the reconcile
--   simply puts them back through the one ingest door.

-- ---------------------------------------------------------------------------
-- 1. Who cannot be dialled, by name.
--    Definer-rights like v_tata_tele_health: plumbing status the route gates
--    by role. "not_an_agent" is judged only once a roster has been pulled -
--    before that it would name everyone.
-- ---------------------------------------------------------------------------

create view crm.v_tata_tele_coverage as
select u.id as user_id,
       u.full_name,
       u.role,
       u.dialing_msisdn,
       case when u.dialing_msisdn is null then 'no_number' else 'not_an_agent' end as problem
  from crm.users u
 where u.is_active
   and u.role in ('caller', 'counsellor')
   and (u.dialing_msisdn is null
        or (exists (select 1 from crm.tata_tele_agents)
            and not exists (select 1 from crm.tata_tele_agents ta
                             where ta.agent_msisdn = u.dialing_msisdn)));

grant select on crm.v_tata_tele_coverage to crm_app;

comment on view crm.v_tata_tele_coverage is
  'Active callers and counsellors Smartflo cannot serve: no Dialing number (click-to-call has no phone to ring), or a number that is no Smartflo agent''s follow-me number (their clicks are refused and their calls never verify).';

-- ---------------------------------------------------------------------------
-- 2. The health row, unchanged in shape, counting from the view above.
-- ---------------------------------------------------------------------------

create or replace view crm.v_tata_tele_health as
with sync as (
  select * from crm.job_runs where name = 'tata_tele_sync'
),
hook as (
  select * from crm.job_runs where name = 'tata_tele_webhook'
)
select
  crm.setting_bool('tata_tele.enabled', false)             as enabled,
  (select last_run_at from sync)                           as sync_last_run_at,
  (select last_ok_at  from sync)                           as sync_last_ok_at,
  (select last_error  from sync)                           as sync_last_error,
  (select last_run_at from hook)                           as webhook_last_at,
  (select last_ok_at  from hook)                           as webhook_last_ok_at,
  (select last_error  from hook)                           as webhook_last_error,
  round(extract(epoch from (now() - greatest(
    (select last_ok_at from sync), (select last_ok_at from hook)))) / 60)::int
                                                           as minutes_since_alive,
  (select count(*)::int from crm.tata_tele_agents)         as agents,
  (select count(*)::int from crm.tata_tele_agents
    where user_id is null)                                 as agents_unmapped,
  (select count(*)::int from crm.v_tata_tele_coverage
    where problem = 'not_an_agent')                        as callers_uncovered,
  (select count(*)::int from crm.v_tata_tele_coverage
    where problem = 'no_number')                           as callers_unregistered,
  (select count(*)::int from crm.telephony_quarantine
    where resolved_at is null)                             as quarantine_open,
  (select count(*)::int from crm.device_call_logs
    where source = 'tata_tele'
      and crm.ist_date(started_at) = crm.ist_date(now()))  as calls_today,
  (select count(*)::int from crm.device_call_logs
    where source = 'tata_tele' and matched_lead_id is not null
      and crm.ist_date(started_at) = crm.ist_date(now()))  as matched_today,
  (select count(*)::int from crm.telephony_calls
    where crm.ist_date(requested_at) = crm.ist_date(now())) as clicks_today,
  (select count(*)::int from crm.telephony_calls
    where crm.ist_date(requested_at) = crm.ist_date(now())
      and status = 'failed')                               as clicks_failed_today,
  case
    when not crm.setting_bool('tata_tele.enabled', false)           then 'off'
    when (select last_run_at from sync) is null
     and (select last_run_at from hook) is null                     then 'never_run'
    when (select last_error from sync) ~* '401|unauthori|token|password|login'
                                                                    then 'auth'
    when (select last_error from sync) is not null                  then 'failing'
    when greatest((select last_ok_at from sync),
                  (select last_ok_at from hook)) is null
      or greatest((select last_ok_at from sync),
                  (select last_ok_at from hook))
         < now() - make_interval(
             mins => crm.setting_int('tata_tele.stale_sync_minutes', 60))
                                                                    then 'stale'
    when (select count(*) from crm.tata_tele_agents where user_id is null) > 0
      or (select count(*) from crm.telephony_quarantine where resolved_at is null) > 0
                                                                    then 'attention'
    else 'healthy'
  end                                                      as state;

-- ---------------------------------------------------------------------------
-- 3. Apply a Dialing-number change now, not at the next pull.
--    SECURITY DEFINER like the ingester it calls: it rewrites the roster
--    cache and resolves quarantine rows, neither of which crm_app may touch.
--    Idempotent - running it with nothing to fix changes nothing.
-- ---------------------------------------------------------------------------

create or replace function crm.tata_tele_reconcile()
  returns table (agents_mapped int, released int, still_held int)
  language plpgsql
  security definer
  set search_path = crm, public
as $$
declare
  v_before   int;
  v_after    int;
  v_payloads jsonb;
begin
  -- The roster follows the one mapping fact, users.dialing_msisdn.
  update crm.tata_tele_agents ta
     set user_id = m.user_id
    from (select ta2.agent_msisdn,
                 (select u.id from crm.users u
                   where u.dialing_msisdn = ta2.agent_msisdn and u.is_active) as user_id
            from crm.tata_tele_agents ta2) m
   where m.agent_msisdn = ta.agent_msisdn
     and ta.user_id is distinct from m.user_id;

  -- Held call records go back through the one door. Whatever now places is
  -- ingested and resolves its own quarantine row; the rest stay held, with
  -- their reason refreshed.
  select count(*) into v_before from crm.telephony_quarantine where resolved_at is null;
  select jsonb_agg(q.payload order by q.received_at) into v_payloads
    from (select payload, received_at
            from crm.telephony_quarantine
           where resolved_at is null
           order by received_at desc
           limit 2000) q;
  if v_payloads is not null then
    perform crm.ingest_tata_tele_cdrs(v_payloads);
  end if;
  select count(*) into v_after from crm.telephony_quarantine where resolved_at is null;

  return query
    select (select count(*)::int from crm.tata_tele_agents where user_id is not null),
           greatest(v_before - v_after, 0),
           v_after;
end
$$;

revoke all on function crm.tata_tele_reconcile() from public;
grant execute on function crm.tata_tele_reconcile() to crm_app;

comment on function crm.tata_tele_reconcile() is
  'Re-map the Smartflo agent roster from users.dialing_msisdn and replay every held call record through crm.ingest_tata_tele_cdrs. Run whenever a Dialing number changes, so a fixed number releases its held calls at once - however old they are.';
