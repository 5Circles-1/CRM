-- 0047_intake_alarm_and_products.sql
--
-- The floor lost two days of Meta leads and the CRM said nothing. That is the
-- real defect: whatever stopped the flow, a system that quietly shows an empty
-- Fresh leads page while a sheet fills up is unusable, because the first
-- person to notice is a counsellor wondering why the phones are quiet.
--
-- The sheet sync is a timer inside the API process (index.ts), started only
-- when BOTH SERVICE_USER_ID and Google credentials are configured. If either
-- is missing the process logs a warning at boot and then runs forever in
-- silence. Nothing recorded whether it ever ran, so nothing could alarm.
--
-- So:
--   1. Every background job and every sync writes a heartbeat. "When did the
--      importer last run" becomes a question with an answer.
--   2. v_intake_health turns those heartbeats plus the ingestion runs into
--      one row per source: last success, minutes since, what it created, what
--      it quarantined, and the last error - with a state the UI can colour.
--   3. check_lead_intake() raises an admin notification when the floor is
--      open and nothing has arrived for too long. A two-day silence becomes a
--      bell inside the hour.
--
-- Plus the four products the floor sells.

-- ---------------------------------------------------------------------------
-- 1. Heartbeats.
-- ---------------------------------------------------------------------------
create table if not exists crm.job_runs (
  name        text primary key,
  last_run_at timestamptz not null,
  last_ok_at  timestamptz,
  last_ms     int,
  last_error  text,
  run_count   bigint not null default 0,
  fail_count  bigint not null default 0
);

comment on table crm.job_runs is
  'One row per background job, overwritten each run. Not history - the
   question it answers is "is the engine alive right now", which is the
   question nobody could answer when lead intake stopped.';

grant select, insert, update on crm.job_runs to crm_app;
alter table crm.job_runs enable row level security;
create policy job_runs_read on crm.job_runs
  for select using (crm.current_user_id() is not null);
-- Written only through the recorder below, which is definer-rights.
create policy job_runs_none on crm.job_runs
  for all using (false) with check (false);

create or replace function crm.record_job_run(
  p_name  text,
  p_ms    int default null,
  p_error text default null
) returns void
  language plpgsql
  security definer
  set search_path = crm, public
as $$
begin
  insert into crm.job_runs (name, last_run_at, last_ok_at, last_ms, last_error,
                            run_count, fail_count)
  values (p_name, now(), case when p_error is null then now() end, p_ms, p_error,
          1, case when p_error is null then 0 else 1 end)
  on conflict (name) do update set
    last_run_at = now(),
    last_ok_at  = case when p_error is null then now() else crm.job_runs.last_ok_at end,
    last_ms     = coalesce(p_ms, crm.job_runs.last_ms),
    last_error  = p_error,
    run_count   = crm.job_runs.run_count + 1,
    fail_count  = crm.job_runs.fail_count + case when p_error is null then 0 else 1 end;
end
$$;

revoke all on function crm.record_job_run(text, int, text) from public;
grant execute on function crm.record_job_run(text, int, text) to crm_app;

-- ---------------------------------------------------------------------------
-- 2. Is lead intake actually working?
-- ---------------------------------------------------------------------------
insert into crm.settings (key, value, description) values
  ('intake.silence_alert_minutes', '120'::jsonb,
   'Raise an alarm when no lead has been created for this many minutes during shift hours.'),
  ('intake.stale_sync_minutes', '30'::jsonb,
   'A sheet source whose last successful sync is older than this is shown as stale.')
on conflict (key) do nothing;

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
  -- One word the screen can colour, most alarming first.
  case
    when not s.is_active                              then 'off'
    when s.spreadsheet_id is null                     then 'not_connected'
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

-- Definer rights, like the other flow-diagnosis views: this is plumbing
-- status, carries no lead data, and the person asking "where are the leads"
-- must get the true answer rather than their own slice of it.
grant select on crm.v_intake_health to crm_app;

comment on view crm.v_intake_health is
  'Per lead source: is it connected, when did it last sync, what did that run
   create or reject, and the last error. The answer to "why are no leads
   arriving" - which used to require reading server logs.';

-- The floor-wide version, including whether the engine itself is alive.
create or replace view crm.v_intake_summary as
select
  (select count(*)::int from crm.leads
    where crm.ist_date(created_at) = crm.ist_date(now()))          as leads_today,
  (select max(created_at) from crm.leads)                          as newest_lead_at,
  (select round(extract(epoch from (now() - max(created_at))) / 60)::int
     from crm.leads)                                               as minutes_since_lead,
  (select count(*)::int from crm.v_intake_health
    where state not in ('healthy', 'off'))                         as sources_unhealthy,
  (select count(*)::int from crm.lead_sources where is_active)     as sources_active,
  (select max(last_run_at) from crm.job_runs)                      as jobs_last_run_at,
  (select round(extract(epoch from (now() - max(last_run_at))) / 60)::int
     from crm.job_runs)                                            as minutes_since_job,
  -- The engine writes a heartbeat every minute during shift hours. No
  -- heartbeat at all means the background worker is not running - which
  -- silently stops sheet sync, distribution sweeps and every reminder.
  (select count(*) = 0 from crm.job_runs)                          as jobs_never_ran;

grant select on crm.v_intake_summary to crm_app;

comment on view crm.v_intake_summary is
  'Is the lead pipe alive: leads today, how long since the last one, how many
   sources are unhealthy, and when the background engine last did anything.';

-- ---------------------------------------------------------------------------
-- 3. The alarm itself. Admins and ops get told; nobody has to notice.
-- ---------------------------------------------------------------------------

-- "Is the floor open right now" existed only inside the API's job gate and as
-- inline date arithmetic in half a dozen engines. The alarm needs it in SQL,
-- and so will everything else that must not shout on a Sunday.
create or replace function crm.is_shift_time(p_at timestamptz default now())
  returns boolean
  language sql
  stable
as $$
  select extract(dow from (p_at at time zone 'Asia/Kolkata')) <> 0
     and (p_at at time zone 'Asia/Kolkata')::time
           between coalesce((select ws.starts_at from crm.work_shifts ws
                              where ws.is_active and ws.team_id is null limit 1),
                            time '09:30')
               and coalesce((select ws.ends_at from crm.work_shifts ws
                              where ws.is_active and ws.team_id is null limit 1),
                            time '18:30');
$$;

comment on function crm.is_shift_time is
  'Is the floor open at that moment: Mon-Sat, between the configured shift
   start and end in IST. Sunday is closed all day.';

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
  v_last    timestamptz;
begin
  -- Only while the floor is open: silence at 3am is not news.
  if not crm.is_shift_time(now()) then return 0; end if;

  select minutes_since_lead, sources_unhealthy into v_since, v_bad
    from crm.v_intake_summary;

  if coalesce(v_since, 999999) < v_quiet and coalesce(v_bad, 0) = 0 then
    return 0;
  end if;

  v_body := case
    when v_bad > 0 then
      'Lead intake problem: ' || v_bad || ' source(s) not importing. '
      || 'Check Floor - Lead intake for the reason.'
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
   arrived for intake.silence_alert_minutes or a source is unhealthy. The
   two-day silent outage is what this exists to prevent.';

-- ---------------------------------------------------------------------------
-- 4. The products the floor sells.
-- ---------------------------------------------------------------------------
insert into crm.products (id, name, code, list_price_inr, is_sebi_regulated) values
  ('44444444-0000-0000-0000-000000000010', 'Swing Advisory',  'ADV-SWING', 0, true),
  ('44444444-0000-0000-0000-000000000011', 'Trader Advisory', 'ADV-TRADE', 0, true),
  ('44444444-0000-0000-0000-000000000012', 'Pro Advisory',    'ADV-PRO',   0, true),
  ('44444444-0000-0000-0000-000000000013', 'Grow+',           'GROW-PLUS', 0, true)
on conflict (id) do nothing;

comment on column crm.products.list_price_inr is
  'Indicative list price. Zero means "priced per deal" - the amount actually
   sold is what the counsellor enters, and that is what the money follows.';
