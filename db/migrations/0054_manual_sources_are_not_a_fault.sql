-- 0054_manual_sources_are_not_a_fault.sql
--
-- The bell said "Leads have stopped arriving - 1 source(s) not importing"
-- every hour of every shift, for days, on a floor whose sheet was importing
-- perfectly. Seventeen identical unread copies were sitting behind the badge.
--
-- The source it was complaining about was "Manual entry" (0039) - the
-- hand-entry source every deployment gets, the one crm.create_lead defaults
-- to when a counsellor types a lead in. It has no spreadsheet, by design:
-- IngestWorker.runAll() only reads sources WHERE spreadsheet_id is not null,
-- so the importer deliberately skips it. v_intake_health called that
-- "not_connected" and v_intake_summary counted it as a source that cannot
-- import, so the watchdog raised an outage that no action could ever clear -
-- short of deactivating the source the floor types leads into.
--
-- An alarm that cannot be cleared is worse than no alarm: it is the reason a
-- real outage now hides in a badge nobody reads. So:
--
--   1. A source with no sheet is "manual", not broken. It is not counted as
--      unhealthy, and the intake panel stops shouting about it.
--   2. When intake IS broken, the notification names the source and the
--      reason - "Meta Lead Ads - Main Sheet (the sheet is not shared with the
--      CRM)" - instead of "1 source(s)", which told nobody where to go.
--   3. An unread alarm is not duplicated. The hourly nag stays for a problem
--      somebody has already seen and not fixed; it no longer stacks copies of
--      a message that has not been read once.
--
-- Nothing here weakens the watchdog that 0047 exists to provide: a sheet that
-- stops importing, fails, goes stale, has never run, or rejects every row
-- still raises the alarm within the hour.

-- ---------------------------------------------------------------------------
-- 1. "manual" is a state, not a fault.
-- ---------------------------------------------------------------------------
create or replace view crm.v_intake_health as
with runs as (
  select distinct on (source_id)
         source_id, started_at, finished_at, rows_seen, rows_created,
         rows_duplicate, rows_quarantined, error_text
    from crm.ingestion_runs
   order by source_id, started_at desc
),
ok as (
  select source_id, max(started_at) as last_ok_at
    from crm.ingestion_runs
   where error_text is null and finished_at is not null
   group by source_id
),
today as (
  select l.source_id,
         count(*)::int as created_today
    from crm.leads l
   where crm.ist_date(l.created_at) = crm.ist_date(now())
   group by l.source_id
),
quarantined_today as (
  select source_id, count(*)::int as quarantined_today
    from crm.ingested_rows
   where status = 'quarantined' and crm.ist_date(created_at) = crm.ist_date(now())
   group by source_id
)
select
  s.id                                   as source_id,
  s.name                                 as source_name,
  s.is_active,
  (s.spreadsheet_id is not null)         as sheet_configured,
  s.last_synced_at,
  round(extract(epoch from (now() - s.last_synced_at)) / 60)::int as minutes_since_sync,
  ok.last_ok_at,
  r.started_at                           as last_run_at,
  r.rows_seen, r.rows_created, r.rows_duplicate, r.rows_quarantined,
  r.error_text,
  coalesce(t.created_today, 0)           as created_today,
  coalesce(q.quarantined_today, 0)       as quarantined_today,
  case
    when not s.is_active                              then 'off'
    -- No sheet means hand entry or a pasted CSV. The importer never reads it,
    -- so it can never be behind, and calling it "not_connected" turned the
    -- floor's own typing into a permanent outage.
    when s.spreadsheet_id is null                     then 'manual'
    when r.error_text ilike '%does not have permission%'
      or r.error_text ilike '%permission_denied%'
      or r.error_text ilike '%requested entity was not found%'
                                                      then 'not_shared'
    when r.error_text is not null                     then 'failing'
    when s.last_synced_at is null                     then 'never_run'
    when s.last_synced_at < now() - make_interval(
           mins => crm.setting_int('intake.stale_sync_minutes', 30))
                                                      then 'stale'
    when coalesce(q.quarantined_today, 0) > 0
         and coalesce(t.created_today, 0) = 0         then 'all_rejected'
    else 'healthy'
  end                                    as state
from crm.lead_sources s
left join runs r on r.source_id = s.id
left join ok on ok.source_id = s.id
left join today t on t.source_id = s.id
left join quarantined_today q on q.source_id = s.id;

grant select on crm.v_intake_health to crm_app;

comment on view crm.v_intake_health is
  'Per lead source: is it connected, when did it last sync, what did that run
   create or reject, and the last error. Three states are not faults - "off"
   (switched off), "manual" (hand entry or CSV, which the importer never
   reads) and "healthy". "not_shared" is the one that cost the floor two days:
   the importer runs fine, Google refuses to open the spreadsheet, and every
   run reads zero rows.';

-- ---------------------------------------------------------------------------
-- 2. The floor-wide summary counts faults only.
-- ---------------------------------------------------------------------------
create or replace view crm.v_intake_summary as
select
  (select count(*)::int from crm.leads
    where crm.ist_date(created_at) = crm.ist_date(now()))          as leads_today,
  (select max(created_at) from crm.leads)                          as newest_lead_at,
  (select round(extract(epoch from (now() - max(created_at))) / 60)::int
     from crm.leads)                                               as minutes_since_lead,
  (select count(*)::int from crm.v_intake_health
    where state not in ('healthy', 'off', 'manual'))               as sources_unhealthy,
  (select count(*)::int from crm.lead_sources where is_active)     as sources_active,
  (select max(last_run_at) from crm.job_runs)                      as jobs_last_run_at,
  (select round(extract(epoch from (now() - max(last_run_at))) / 60)::int
     from crm.job_runs)                                            as minutes_since_job,
  (select count(*) = 0 from crm.job_runs)                          as jobs_never_ran;

grant select on crm.v_intake_summary to crm_app;

comment on view crm.v_intake_summary is
  'Is the lead pipe alive: leads today, how long since the last one, how many
   sources are actually failing (hand-entry sources are not), and when the
   background engine last did anything.';

-- ---------------------------------------------------------------------------
-- 3. The alarm names the source, and does not stack unread copies.
-- ---------------------------------------------------------------------------
create or replace function crm.check_lead_intake()
  returns int
  language plpgsql
  security definer
  set search_path = crm, public
as $$
declare
  v_quiet   int := crm.setting_int('intake.silence_alert_minutes', 120);
  v_since   int;
  v_bad     int;
  v_sent    int := 0;
  v_user    record;
  v_body    text;
  v_named   text;
  v_last    timestamptz;
begin
  -- Only while the floor is open: silence at 3am is not news.
  if not crm.is_shift_time(now()) then return 0; end if;

  select minutes_since_lead, sources_unhealthy into v_since, v_bad
    from crm.v_intake_summary;

  if coalesce(v_since, 999999) < v_quiet and coalesce(v_bad, 0) = 0 then
    return 0;
  end if;

  -- "1 source(s) not importing" sent the reader hunting. Name the source and
  -- say what is wrong with it, in the words the intake panel uses.
  select string_agg(
           source_name || ' (' || case state
             when 'not_shared'   then 'the sheet is not shared with the CRM'
             when 'failing'      then 'the last import failed'
             when 'never_run'    then 'it has never imported'
             when 'stale'        then 'the last import is overdue'
             when 'all_rejected' then 'every row is being rejected'
             else state
           end || ')', '; ' order by source_name)
    into v_named
    from crm.v_intake_health
   where state not in ('healthy', 'off', 'manual');

  v_body := case
    when v_named is not null then
      'Lead intake problem: ' || v_named || '. '
      || 'Check Floor - Lead intake for the fix.'
    else
      'No new lead has arrived for ' || coalesce(v_since, 0) || ' minutes. '
      || 'If the sheet is filling up, the importer has stopped - check Floor - Lead intake.'
  end;

  for v_user in
    select id from crm.users where is_active and role in ('admin', 'ops')
  loop
    -- One alarm per person per hour: an outage must nag, but not spam.
    select max(created_at) into v_last
      from crm.notifications
     where user_id = v_user.id and kind = 'intake_stalled';
    continue when v_last is not null and v_last > now() - interval '1 hour';

    -- And never a second copy of a message this person has not read yet. The
    -- nag is for a problem somebody has seen and left; seventeen identical
    -- unread rows only bury the callback underneath them.
    continue when exists (
      select 1 from crm.notifications
       where user_id = v_user.id and kind = 'intake_stalled'
         and read_at is null and body = v_body);

    insert into crm.notifications (user_id, kind, title, body)
    values (v_user.id, 'intake_stalled', 'Leads have stopped arriving', v_body);
    v_sent := v_sent + 1;
  end loop;

  return v_sent;
end
$$;

revoke all on function crm.check_lead_intake() from public;
grant execute on function crm.check_lead_intake() to crm_app;

comment on function crm.check_lead_intake is
  'Raises an admin notification when the floor is open and either no lead has
   arrived for intake.silence_alert_minutes or a sheet source cannot import.
   Names the source and the reason. Hand-entry sources have no sheet and are
   never a fault - counting them raised an outage nobody could clear.';

-- ---------------------------------------------------------------------------
-- 4. Clear the copies this bug already left behind.
-- ---------------------------------------------------------------------------
-- Every one of them is the same false alarm about a hand-entry source, and
-- the badge cannot reach zero while they sit there. If intake IS broken, the
-- next check re-raises it within ten minutes - naming the source this time.
update crm.notifications
   set read_at = now()
 where kind = 'intake_stalled'
   and read_at is null;
