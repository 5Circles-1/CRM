-- 0063_callyzer.sql
-- Callyzer: a second writer to crm.device_call_logs, never a second CRM.
--
-- Callyzer Biz is an app on each caller's handset that syncs the device call
-- log (and optionally recordings) to Callyzer's cloud, which exposes it over
-- a REST API (v2.2) and a webhook. This CRM already has exactly that hole and
-- already has the table that fills it: crm.device_call_logs, written today by
-- the in-house Android companion app. Everything downstream - the log-call
-- pre-fill, call_attempts.is_verified, honest dial counts, the fabricated-
-- activity QA signal - hangs off that one table, so Callyzer plugs in as a
-- sensor answering one question: did this call really happen, and for how long?
--
-- What is deliberately NOT here: Callyzer's Lead APIs, lead statuses,
-- reminders and lead ids. A second system distributing leads and holding a
-- second opinion of lead status would fight the fairness engine, the ACE
-- share, RLS and the next_action_at guarantee. Callyzer's crm_status,
-- reminder_date and lead_id are not stored and never touch our leads.
--
-- Identity: Callyzer knows an employee by the SIM number they registered;
-- this CRM already knows the same fact as crm.users.dialing_msisdn ("the SIM
-- number this caller dials from", unique among active users). That column IS
-- the mapping - a separate mapping table would be the same fact in a second
-- place, where it would drift. crm.callyzer_employees below is a status
-- cache of what Callyzer reports (which handsets exist, when each last
-- synced), not a second copy of the mapping.
--
-- Rows whose employee number matches no active user are quarantined with the
-- raw payload, exactly as the sheet importer quarantines a bad lead row -
-- a call that really happened must never be silently dropped, because the
-- number it feeds (is_verified) is the number this CRM exists to keep honest.

-- ---------------------------------------------------------------------------
-- 0. A text settings getter, alongside setting_int/num/bool.
-- ---------------------------------------------------------------------------

create or replace function crm.setting_text(p_key text, p_default text default null)
  returns text
  language sql stable
as $$
  select coalesce((select value #>> '{}' from crm.settings where key = p_key), p_default)
$$;

-- ---------------------------------------------------------------------------
-- 1. Settings. Ships OFF; enabling it is an ops action, like every tunable.
-- ---------------------------------------------------------------------------

insert into crm.settings (key, value, description) values
  ('callyzer.enabled', 'false'::jsonb,
   'Master switch for the Callyzer call-log integration. Off means the sync job, webhook and health watchdog all stand down.'),
  ('callyzer.base_url', '"https://api1.callyzer.co/api/v2.2/"'::jsonb,
   'Callyzer API base URL, version pinned. v2.2 made call_method/call_mode mandatory, so a version bump is a code change with tests, not a settings edit.'),
  ('callyzer.backfill_hours', '26'::jsonb,
   'How far back each scheduled pull reconciles (on synced_at). Webhooks drop; the pull is what makes the push safe to trust.'),
  ('callyzer.stale_sync_minutes', '60'::jsonb,
   'Raise the Callyzer alarm when neither the pull nor a webhook has succeeded for this long. The sync runs every 15 minutes, so this tolerates a few missed ticks.'),
  ('callyzer.count_whatsapp_calls', 'false'::jsonb,
   'Whether a WhatsApp call may verify a dial. Dial targets and connect rates were baselined on phone calls; WhatsApp rows are always stored, but only offered for verification when this is on.'),
  ('callyzer.store_recording_url', 'true'::jsonb,
   'Store the call_recording_url Callyzer supplies. Off genuinely stops storing it (and clears it on re-sync), not merely hides it.'),
  ('callyzer.timezone', '"Asia/Kolkata"'::jsonb,
   'The Callyzer ACCOUNT timezone. call_date/call_time arrive with no zone; a wrong value here moves calls between business days in every daily rollup. Rows whose synced_at names a different zone are quarantined, not guessed at.'),
  ('callyzer.handset_stale_hours', '24'::jsonb,
   'Flag a handset whose Callyzer app has not requested a sync for this long - the failure mode that makes verification silently useless.')
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- 2. Widen crm.device_call_logs. All nullable / defaulted: existing rows and
--    the in-house app are untouched, and the two writers are namespaced by
--    `source` plus the 'callyzer:' prefix on device_row_key, so they can
--    never collide or double-count.
-- ---------------------------------------------------------------------------

alter table crm.device_call_logs
  add column source               text not null default 'device_app'
    constraint device_call_logs_source_check check (source in ('device_app', 'callyzer')),
  add column recording_url        text,
  add column call_method          text
    constraint device_call_logs_call_method_check
    check (call_method is null or call_method in ('PhoneCall', 'WhatsAppCall')),
  add column call_mode            text
    constraint device_call_logs_call_mode_check
    check (call_mode is null or call_mode in ('Voice', 'Video')),
  add column external_note        text,
  add column external_synced_at   timestamptz,
  add column external_modified_at timestamptz;

comment on column crm.device_call_logs.source is
  'Which sensor wrote the row: the in-house companion app or Callyzer. Both feed the same verification pipeline.';
comment on column crm.device_call_logs.recording_url is
  'Callyzer-hosted call recording. Stored only while callyzer.store_recording_url is on; surfaced to counsellors and admin for coaching, never to the caller themselves.';
comment on column crm.device_call_logs.external_note is
  'The note typed in the Callyzer app. Kept for audit; it never drives CRM behaviour.';

-- A caller's personal call log stays visible only to them and admin - but a
-- row MATCHED to a lead a counsellor can see is CRM business, not a personal
-- call, and it is where the coaching recording lives. Unmatched rows remain
-- invisible to counsellors, exactly as before.
drop policy device_call_logs_select on crm.device_call_logs;
create policy device_call_logs_select on crm.device_call_logs
  for select using (
    user_id = crm.current_user_id()
    or crm.current_user_role() = 'admin'
    or (crm.current_user_role() = 'counsellor'
        and matched_lead_id is not null
        and crm.can_see_lead(matched_lead_id))
  );

-- ---------------------------------------------------------------------------
-- 3. The handset roster Callyzer reports, refreshed on every sync.
--    Status cache only: user_id is resolved FROM users.dialing_msisdn, never
--    edited here. A row with user_id null is an unmapped number - visible on
--    the health panel, named by the watchdog, fixed by setting the person's
--    Dialing SIM on Admin > Users.
-- ---------------------------------------------------------------------------

create table crm.callyzer_employees (
  emp_msisdn       text primary key,          -- crm.normalise_phone(cc || number)
  emp_country_code text,
  emp_number       text,
  emp_name         text,
  emp_code         text,
  user_id          uuid references crm.users(id) on delete set null,
  app_version      text,
  registered_at    timestamptz,
  last_call_at     timestamptz,
  last_sync_req_at timestamptz,
  refreshed_at     timestamptz not null default now()
);

comment on table crm.callyzer_employees is
  'What Callyzer says about each enrolled handset, refreshed by every sync. app_version and last_sync_req_at are how a handset that quietly stopped syncing is detected - the failure that makes verification silently useless.';

-- Plumbing status about staff handsets, no lead data: written only through
-- the definer refresh below, readable by the people who run the floor.
revoke insert, update on crm.callyzer_employees from crm_app;
alter table crm.callyzer_employees enable row level security;
create policy callyzer_employees_select on crm.callyzer_employees
  for select using (crm.current_user_role() in ('admin', 'ops', 'counsellor', 'viewer'));

-- ---------------------------------------------------------------------------
-- 4. Quarantine. Same rule as the sheet importer: nothing external is ever
--    dropped. A row lands here with the raw payload and a reason; once the
--    cause is fixed (usually a missing Dialing SIM) the next sync re-delivers
--    the row, it ingests cleanly, and the quarantine entry marks itself
--    resolved.
-- ---------------------------------------------------------------------------

create table crm.callyzer_quarantine (
  id           uuid primary key default gen_random_uuid(),
  external_id  text not null unique,          -- Callyzer's call-log id
  emp_msisdn   text,                          -- normalised, when parseable
  reason       text not null,
  payload      jsonb not null,
  received_at  timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  resolved_at  timestamptz
);

create index callyzer_quarantine_open_idx
  on crm.callyzer_quarantine (received_at) where resolved_at is null;

comment on table crm.callyzer_quarantine is
  'Callyzer call-log rows that could not be ingested, kept whole. A call that really happened must never be silently dropped - an open row here is a verification gap the health panel and the watchdog both surface.';

revoke insert, update on crm.callyzer_quarantine from crm_app;
alter table crm.callyzer_quarantine enable row level security;
create policy callyzer_quarantine_select on crm.callyzer_quarantine
  for select using (crm.current_user_role() in ('admin', 'ops'));

-- ---------------------------------------------------------------------------
-- 5. Timestamp parsing for Callyzer's "yyyy-mm-dd hh:mm:ss[ ZZZ]" strings,
--    interpreted in the configured account timezone. Returns null rather than
--    raising: a malformed timestamp is a reason to quarantine a row, never to
--    kill a batch.
-- ---------------------------------------------------------------------------

create or replace function crm.callyzer_timestamp(p_raw text)
  returns timestamptz
  language plpgsql
  stable
as $$
declare
  v_tz    text := crm.setting_text('callyzer.timezone', 'Asia/Kolkata');
  v_clean text;
begin
  -- Strip a trailing zone abbreviation ("2023-11-30 22:42:53 IST"); whether
  -- that abbreviation MATCHES the configured zone is checked by the ingester.
  v_clean := trim(regexp_replace(coalesce(p_raw, ''), '\s+[A-Za-z]{2,5}$', ''));
  if v_clean = '' then return null; end if;
  return v_clean::timestamp at time zone v_tz;
exception when others then
  return null;
end
$$;

comment on function crm.callyzer_timestamp(text) is
  'Callyzer date-times carry no numeric offset; they are wall-clock in the account timezone (callyzer.timezone). Interpreting them in the wrong zone moves calls across crm.ist_date() boundaries, which corrupts every daily rollup.';

-- ---------------------------------------------------------------------------
-- 6. Refresh the handset roster from /employee/get output.
--    SECURITY DEFINER: runs from the scheduler as the ops account, and must
--    resolve numbers against every user row regardless of RLS.
-- ---------------------------------------------------------------------------

create or replace function crm.refresh_callyzer_employees(p_rows jsonb)
  returns table (seen int, mapped int, unmapped int)
  language plpgsql
  security definer
  set search_path = crm, public
as $$
declare
  r        jsonb;
  v_msisdn text;
  v_seen   int := 0;
begin
  for r in select * from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) loop
    v_msisdn := crm.normalise_phone(coalesce(r->>'emp_country_code', '') || coalesce(r->>'emp_number', ''));
    continue when v_msisdn is null;
    v_seen := v_seen + 1;

    insert into crm.callyzer_employees as ce
      (emp_msisdn, emp_country_code, emp_number, emp_name, emp_code, user_id,
       app_version, registered_at, last_call_at, last_sync_req_at, refreshed_at)
    values
      (v_msisdn, r->>'emp_country_code', r->>'emp_number', r->>'emp_name', r->>'emp_code',
       (select u.id from crm.users u where u.dialing_msisdn = v_msisdn and u.is_active),
       r->>'app_version',
       crm.callyzer_timestamp(r->>'registered_at'),
       crm.callyzer_timestamp(r->>'last_call_at'),
       crm.callyzer_timestamp(r->>'last_sync_req_at'),
       now())
    on conflict (emp_msisdn) do update set
      emp_country_code = excluded.emp_country_code,
      emp_number       = excluded.emp_number,
      emp_name         = excluded.emp_name,
      emp_code         = excluded.emp_code,
      user_id          = excluded.user_id,
      app_version      = excluded.app_version,
      registered_at    = coalesce(excluded.registered_at, ce.registered_at),
      last_call_at     = coalesce(excluded.last_call_at, ce.last_call_at),
      last_sync_req_at = coalesce(excluded.last_sync_req_at, ce.last_sync_req_at),
      refreshed_at     = now();
  end loop;

  return query
    select v_seen,
           (select count(*)::int from crm.callyzer_employees where user_id is not null),
           (select count(*)::int from crm.callyzer_employees where user_id is null);
end
$$;

revoke all on function crm.refresh_callyzer_employees(jsonb) from public;
grant execute on function crm.refresh_callyzer_employees(jsonb) to crm_app;

-- ---------------------------------------------------------------------------
-- 7. The ingester. One function, used by both the scheduled pull and the
--    webhook, so idempotency and quarantine behave identically for both.
--
--    SECURITY DEFINER for the same reason as the 0014 engines: it runs from
--    the scheduler/webhook as the ops account and must write rows for every
--    caller and match leads across the whole book, which no invoker-rights
--    function can do. It is also the only writer that can UPDATE
--    device_call_logs - crm_app had UPDATE revoked in 0012, and that stays:
--    Callyzer rows are legitimately modified after the fact (a note or a
--    recording arrives late), so this is an upsert where the in-house app's
--    sync is insert-only.
-- ---------------------------------------------------------------------------

create or replace function crm.ingest_callyzer_logs(p_rows jsonb)
  returns table (seen int, inserted int, updated int, matched int, quarantined int)
  language plpgsql
  security definer
  set search_path = crm, public
as $$
declare
  v_store_rec boolean := crm.setting_bool('callyzer.store_recording_url', true);
  v_tz        text    := crm.setting_text('callyzer.timezone', 'Asia/Kolkata');
  v_abbrev    text;
  r           jsonb;
  v_seen int := 0; v_ins int := 0; v_upd int := 0; v_match int := 0; v_quar int := 0;

  v_ext_id   text;
  v_emp_raw  text;
  v_emp      text;
  v_user     uuid;
  v_client   text;
  v_dir      text;
  v_started  timestamptz;
  v_token    text;
  v_reason   text;
  v_was_insert boolean;
  v_matched_lead uuid;
begin
  -- The zone abbreviation the configured account timezone actually uses right
  -- now (IST for Asia/Kolkata). A row stamped with a different one is not
  -- reinterpreted - it is quarantined, because a silently shifted timestamp
  -- moves the call to the wrong business day.
  select coalesce(max(abbrev), '') into v_abbrev
    from pg_timezone_names where name = v_tz;

  for r in select * from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) loop
    v_seen := v_seen + 1;
    v_reason := null;
    v_user := null;

    v_ext_id := nullif(trim(coalesce(r->>'id', '')), '');
    if v_ext_id is null then
      -- No stable id: still idempotent, keyed on the payload itself.
      v_ext_id := 'noid:' || md5(r::text);
    end if;

    begin
      v_emp_raw := coalesce(r->>'emp_country_code', '') || coalesce(r->>'emp_number', '');
      v_emp     := crm.normalise_phone(v_emp_raw);
      v_client  := crm.normalise_phone(coalesce(r->>'client_country_code', '') || coalesce(r->>'client_number', ''));
      v_dir     := lower(coalesce(r->>'call_type', ''));
      v_started := crm.callyzer_timestamp((r->>'call_date') || ' ' || (r->>'call_time'));
      v_token   := (regexp_match(coalesce(r->>'synced_at', ''), '\s([A-Za-z]{2,5})$'))[1];

      if v_emp is not null then
        select u.id into v_user from crm.users u
         where u.dialing_msisdn = v_emp and u.is_active;
      end if;

      v_reason := case
        when v_emp is null then
          'employee number is not dialable: ' || v_emp_raw
        when v_user is null then
          'no active user has Dialing SIM ' || v_emp || ' - set it on Admin > Users'
        when v_dir not in ('outgoing', 'incoming', 'missed', 'rejected') then
          'unknown call_type: ' || coalesce(r->>'call_type', '(missing)')
        when v_started is null then
          'unparseable call_date/call_time: '
            || coalesce(r->>'call_date', '(missing)') || ' ' || coalesce(r->>'call_time', '(missing)')
        when v_token is not null and v_abbrev <> '' and upper(v_token) <> upper(v_abbrev) then
          'timezone mismatch: synced_at says ' || v_token || ' but callyzer.timezone ('
            || v_tz || ') is ' || v_abbrev || ' - fix the setting before ingesting'
        else null
      end;

      if v_reason is not null then
        insert into crm.callyzer_quarantine as cq (external_id, emp_msisdn, reason, payload)
        values (v_ext_id, v_emp, v_reason, r)
        on conflict (external_id) do update set
          emp_msisdn   = excluded.emp_msisdn,
          reason       = excluded.reason,
          payload      = excluded.payload,
          last_seen_at = now(),
          resolved_at  = null;
        v_quar := v_quar + 1;
        continue;
      end if;

      insert into crm.device_call_logs as dcl
        (user_id, device_row_key, counterparty_msisdn, direction, started_at,
         duration_seconds, matched_lead_id, source, recording_url, call_method,
         call_mode, external_note, external_synced_at, external_modified_at)
      values
        (v_user,
         'callyzer:' || v_ext_id,
         v_client,
         v_dir,
         v_started,
         greatest(0, coalesce(nullif(trim(coalesce(r->>'duration', '')), '')::int, 0)),
         -- The existing phone-match rule, preferring the caller's own lead so
         -- a number two teams have both held lands on the dialler's copy.
         (select l.id from crm.leads l
           where l.phone_e164 = v_client
           order by (l.caller_id = v_user) desc, l.created_at desc
           limit 1),
         'callyzer',
         case when v_store_rec then nullif(trim(coalesce(r->>'call_recording_url', '')), '') end,
         nullif(r->>'call_method', ''),
         nullif(r->>'call_mode', ''),
         nullif(trim(coalesce(r->>'note', '')), ''),
         crm.callyzer_timestamp(r->>'synced_at'),
         crm.callyzer_timestamp(r->>'modified_at'))
      on conflict (user_id, device_row_key) do update set
        counterparty_msisdn  = excluded.counterparty_msisdn,
        direction            = excluded.direction,
        started_at           = excluded.started_at,
        duration_seconds     = excluded.duration_seconds,
        -- A match already made stays made (an attempt may reference it); an
        -- empty one may fill in if the lead arrived after the call did.
        matched_lead_id      = coalesce(dcl.matched_lead_id, excluded.matched_lead_id),
        -- A recording never un-happens: keep the old URL when a re-delivery
        -- omits it - unless storing is off, which clears rather than hides.
        recording_url        = case when v_store_rec
                                    then coalesce(excluded.recording_url, dcl.recording_url) end,
        call_method          = coalesce(excluded.call_method, dcl.call_method),
        call_mode            = coalesce(excluded.call_mode, dcl.call_mode),
        external_note        = coalesce(excluded.external_note, dcl.external_note),
        external_synced_at   = coalesce(excluded.external_synced_at, dcl.external_synced_at),
        external_modified_at = coalesce(excluded.external_modified_at, dcl.external_modified_at)
      where dcl.source = 'callyzer'
      returning (xmax = 0), matched_lead_id into v_was_insert, v_matched_lead;

      if v_was_insert is null then
        -- The conflict row belongs to the other writer. The 'callyzer:'
        -- prefix makes this unreachable, but never overwrite another
        -- sensor's data if it somehow happens.
        raise exception 'device_row_key callyzer:% collides with a non-Callyzer row', v_ext_id;
      end if;

      if v_was_insert then v_ins := v_ins + 1; else v_upd := v_upd + 1; end if;
      if v_matched_lead is not null then v_match := v_match + 1; end if;

      -- The row is in: any quarantine entry about it is history now.
      update crm.callyzer_quarantine
         set resolved_at = now()
       where external_id = v_ext_id and resolved_at is null;

    exception when others then
      -- One bad row must not stop the batch - same property as the sheet
      -- importer. Keep the row and the error; ops can see both.
      insert into crm.callyzer_quarantine as cq (external_id, emp_msisdn, reason, payload)
      values (v_ext_id, v_emp, 'ingest error: ' || sqlerrm, r)
      on conflict (external_id) do update set
        reason       = excluded.reason,
        payload      = excluded.payload,
        last_seen_at = now(),
        resolved_at  = null;
      v_quar := v_quar + 1;
    end;
  end loop;

  return query select v_seen, v_ins, v_upd, v_match, v_quar;
end
$$;

revoke all on function crm.ingest_callyzer_logs(jsonb) from public;
grant execute on function crm.ingest_callyzer_logs(jsonb) to crm_app;

comment on function crm.ingest_callyzer_logs(jsonb) is
  'The one door Callyzer call logs enter through, from the scheduled pull and the webhook alike. Normalises, maps the employee SIM to a user, matches the client number to a lead, upserts (rows are modified after delivery - notes and recordings arrive late), and quarantines rather than drops anything it cannot place.';

-- ---------------------------------------------------------------------------
-- 8. Health, one row. Definer-rights like v_intake_health: plumbing status,
--    no lead data, and the person asking "is verification alive" must get the
--    true answer rather than their own slice of it.
-- ---------------------------------------------------------------------------

create or replace view crm.v_callyzer_health as
with sync as (
  select * from crm.job_runs where name = 'callyzer_sync'
),
hook as (
  select * from crm.job_runs where name = 'callyzer_webhook'
)
select
  crm.setting_bool('callyzer.enabled', false)              as enabled,
  (select last_run_at from sync)                           as sync_last_run_at,
  (select last_ok_at  from sync)                           as sync_last_ok_at,
  (select last_error  from sync)                           as sync_last_error,
  (select last_run_at from hook)                           as webhook_last_at,
  (select last_ok_at  from hook)                           as webhook_last_ok_at,
  (select last_error  from hook)                           as webhook_last_error,
  round(extract(epoch from (now() - greatest(
    (select last_ok_at from sync), (select last_ok_at from hook)))) / 60)::int
                                                           as minutes_since_alive,
  (select count(*)::int from crm.callyzer_employees)       as employees,
  (select count(*)::int from crm.callyzer_employees
    where user_id is null)                                 as employees_unmapped,
  (select count(*)::int from crm.callyzer_employees ce
    where ce.user_id is not null
      and ce.last_sync_req_at < now() - make_interval(
            hours => crm.setting_int('callyzer.handset_stale_hours', 24)))
                                                           as handsets_stale,
  -- Active dialling staff whose SIM Callyzer does not cover: their calls
  -- never arrive, so their attempts can never verify.
  (select count(*)::int from crm.users u
    where u.is_active and u.role in ('caller', 'counsellor')
      and u.dialing_msisdn is not null
      and not exists (select 1 from crm.callyzer_employees ce
                       where ce.emp_msisdn = u.dialing_msisdn))
                                                           as callers_uncovered,
  (select count(*)::int from crm.callyzer_quarantine
    where resolved_at is null)                             as quarantine_open,
  (select count(*)::int from crm.device_call_logs
    where source = 'callyzer'
      and crm.ist_date(started_at) = crm.ist_date(now()))  as logs_today,
  (select count(*)::int from crm.device_call_logs
    where source = 'callyzer' and matched_lead_id is not null
      and crm.ist_date(started_at) = crm.ist_date(now()))  as matched_today,
  case
    when not crm.setting_bool('callyzer.enabled', false)            then 'off'
    when (select last_run_at from sync) is null
     and (select last_run_at from hook) is null                     then 'never_run'
    when (select last_error from sync) ~* 'subscription'            then 'expired'
    when (select last_error from sync) is not null                  then 'failing'
    when greatest((select last_ok_at from sync),
                  (select last_ok_at from hook)) is null
      or greatest((select last_ok_at from sync),
                  (select last_ok_at from hook))
         < now() - make_interval(
             mins => crm.setting_int('callyzer.stale_sync_minutes', 60))
                                                                    then 'stale'
    when (select count(*) from crm.callyzer_employees where user_id is null) > 0
      or (select count(*) from crm.callyzer_quarantine where resolved_at is null) > 0
                                                                    then 'attention'
    else 'healthy'
  end                                                      as state;

grant select on crm.v_callyzer_health to crm_app;

comment on view crm.v_callyzer_health is
  'Is handset call verification alive: when Callyzer last delivered (pull or webhook), which numbers match no user, which handsets went quiet, and what sits in quarantine. One state word the screen can colour.';

-- ---------------------------------------------------------------------------
-- 9. The watchdog, both directions - same shape as check_lead_intake (0058):
--    raises a NAMED admin alarm while the floor is open and verification is
--    broken; stands every alarm down and announces recovery the moment it is
--    healthy again. A callyzer alarm on the bell is always a live problem.
--
--    A lapsed Callyzer invoice (their 403 says "subscription expired")
--    silently ending call verification is exactly the class of failure the
--    intake alarm was built for, so it gets the same treatment by name.
-- ---------------------------------------------------------------------------

create or replace function crm.check_callyzer_health()
  returns int
  language plpgsql
  security definer
  set search_path = crm, public
as $$
declare
  h         record;
  v_sent    int := 0;
  v_user    record;
  v_body    text;
  v_last    timestamptz;
  v_unmapped text;
begin
  select * into h from crm.v_callyzer_health;

  if h.state in ('off', 'healthy') then
    -- Whatever was alarming is over (fixed, or deliberately switched off):
    -- resolve it and tell each person who was alarmed that it is over.
    for v_user in
      select distinct user_id from crm.notifications
       where kind = 'callyzer_stalled' and read_at is null
    loop
      update crm.notifications set read_at = now()
       where user_id = v_user.user_id and kind = 'callyzer_stalled' and read_at is null;
      insert into crm.notifications (user_id, kind, title, body)
      values (v_user.user_id, 'callyzer_recovered', 'Call verification has recovered',
              case when h.state = 'off'
                then 'The Callyzer integration was switched off - the earlier alarms no longer apply.'
                else 'Callyzer is delivering call logs again - the verification problem is resolved. '
                  || 'The earlier alarms have been cleared automatically.' end);
    end loop;
    return 0;
  end if;

  -- A problem is only ANNOUNCED while the floor is open. (Resolution above
  -- runs at any hour.)
  if not crm.is_shift_time(now()) then return 0; end if;

  select string_agg(emp_msisdn || coalesce(' (' || emp_name || ')', ''), ', ')
    into v_unmapped
    from (select emp_msisdn, emp_name from crm.callyzer_employees
           where user_id is null order by emp_msisdn limit 5) x;

  v_body := case h.state
    when 'expired' then
      'The Callyzer subscription has expired - handset call verification has stopped. '
      || 'Renew it, or switch callyzer.enabled off if it is being retired.'
    when 'failing' then
      'The Callyzer sync is failing: ' || coalesce(h.sync_last_error, 'unknown error')
      || '. Check Admin - Ingestion - Callyzer.'
    when 'never_run' then
      'Callyzer is enabled but no sync has ever run and no webhook has arrived. '
      || 'Is CALLYZER_API_KEY set on the server, and the webhook configured in the Callyzer dashboard?'
    when 'stale' then
      'No Callyzer delivery (pull or webhook) for '
      || coalesce(h.minutes_since_alive::text, '?') || ' minutes - call verification is running blind. '
      || 'Check Admin - Ingestion - Callyzer.'
    else -- attention: unmapped numbers / quarantined rows are live data loss
      case when h.employees_unmapped > 0 then
        h.employees_unmapped || ' Callyzer number(s) match no CRM user ('
        || coalesce(v_unmapped, '') || ') - their calls are quarantined, not verified. '
        || 'Set the Dialing SIM on Admin - Users.'
      else '' end
      || case when h.quarantine_open > 0 then
        ' ' || h.quarantine_open || ' Callyzer call(s) are quarantined - see Admin - Ingestion - Callyzer.'
      else '' end
  end;
  v_body := trim(v_body);

  for v_user in
    select id from crm.users where is_active and role in ('admin', 'ops')
  loop
    -- One alarm per person per hour, and never a second copy of a message
    -- this person has not read yet - the 0054/0058 anti-spam rules.
    select max(created_at) into v_last
      from crm.notifications
     where user_id = v_user.id and kind = 'callyzer_stalled';
    continue when v_last is not null and v_last > now() - interval '1 hour';

    continue when exists (
      select 1 from crm.notifications
       where user_id = v_user.id and kind = 'callyzer_stalled'
         and read_at is null and body = v_body);

    insert into crm.notifications (user_id, kind, title, body)
    values (v_user.id, 'callyzer_stalled', 'Call verification has a problem', v_body);
    v_sent := v_sent + 1;
  end loop;

  return v_sent;
end
$$;

revoke all on function crm.check_callyzer_health() from public;
grant execute on function crm.check_callyzer_health() to crm_app;

comment on function crm.check_callyzer_health is
  'The Callyzer watchdog, both directions: raises a named admin alarm while the floor is open and call verification is broken (subscription lapsed, sync failing or silent, numbers unmapped, rows quarantined); stands every alarm down and announces recovery the moment it is healthy or deliberately off.';

-- The alarm and its all-clear ring the bell like the intake pair do: closure
-- should be as visible as the problem was. Zero remains the bell's healthy state.
update crm.settings
   set value = value || '["callyzer_stalled"]'::jsonb
 where key = 'alerts.bell_kinds' and not value ? 'callyzer_stalled';
update crm.settings
   set value = value || '["callyzer_recovered"]'::jsonb
 where key = 'alerts.bell_kinds' and not value ? 'callyzer_recovered';
