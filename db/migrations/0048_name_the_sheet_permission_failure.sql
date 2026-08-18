-- 0048_name_the_sheet_permission_failure.sql
--
-- The real outage, diagnosed: the importer was running every five minutes and
-- every single run failed with Google's message
--
--     "The caller does not have permission"
--
-- which means the spreadsheet is not shared with the CRM's service account.
-- rows_seen was 0 on every run, so nothing was ever lost - the leads are all
-- still in the sheet, waiting for one Share click.
--
-- "The caller does not have permission" is Google talking about an API client.
-- On a sales floor it reads as though a caller - a person - lacks a CRM
-- permission, which is exactly the wrong place to go looking. This gives that
-- failure its own state so the screen can name the actual fix.

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
    when s.spreadsheet_id is null                     then 'not_connected'
    -- Named separately from a generic failure: the fix is a Share click in
    -- Google, not anything inside the CRM.
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
   create or reject, and the last error. "not_shared" is the case that cost
   the floor two days - the importer runs fine, Google refuses to open the
   spreadsheet, and every run reads zero rows.';
