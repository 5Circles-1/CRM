-- 0074_tata_tele_smartflo.sql
-- Tata Tele Smartflo replaces Callyzer (owner decision, 22 Sep): the owner
-- bought Smartflo cloud telephony, so calls no longer happen on personal SIMs
-- observed after the fact - the CRM now PLACES the call. One click bridges the
-- agent's phone and the client's, back to back through the day, and Smartflo's
-- own call records confirm what happened. Callyzer is retired wholesale before
-- it ever went live.
--
-- The shape survives even though the vendor changed, because the question did
-- not: did this call really happen, and for how long? Smartflo is the floor's
-- DIALLER and its call SENSOR - and still never a second CRM. Its CDRs land in
-- crm.device_call_logs exactly as Callyzer's did (namespaced by source and a
-- 'tata:' row-key prefix), the log-call pre-fill and call_attempts.is_verified
-- hang off the same table, and its lead ids, dispositions and campaign tools
-- stay deliberately unconnected: a second system distributing leads would
-- fight the fairness engine, RLS and the next_action_at guarantee.
--
-- What is genuinely new is the OUTBOUND leg: crm.telephony_calls records every
-- click-to-call the CRM originates - who asked for which lead's number, when,
-- and Smartflo's ref_id for the bridge. That row is how the CDR that arrives a
-- minute later finds its lead (ref_id is Smartflo's documented correlation
-- key), and how "clicks that never became calls" stays a visible number
-- instead of a shrug.
--
-- Identity is still one fact in one place: crm.users.dialing_msisdn is now
-- "the number Smartflo bridges first" - the agent's follow-me number. The
-- roster cache (crm.tata_tele_agents) is status, never a second mapping.
-- Rows that cannot be placed are quarantined whole and re-ingest themselves
-- once the cause is fixed, exactly like the sheet importer. The one deliberate
-- exception: an inbound call that rang the floor and was never answered by any
-- agent names nobody - there is no user to verify a dial against, no fix ever
-- places it, so it is counted and left to Smartflo's own reports rather than
-- parked in quarantine forever.

-- ---------------------------------------------------------------------------
-- 0. Retire Callyzer. Its objects go; its history stays. Rows already in
--    device_call_logs with source = 'callyzer' are real calls that verified
--    real attempts - deleting them would falsify every past dial count - so
--    the source CHECK keeps 'callyzer' as a legal historical value with no
--    remaining writer.
-- ---------------------------------------------------------------------------

drop function if exists crm.check_callyzer_health();
drop view if exists crm.v_callyzer_health;
drop function if exists crm.ingest_callyzer_logs(jsonb);
drop function if exists crm.refresh_callyzer_employees(jsonb);
drop function if exists crm.callyzer_timestamp(text);
drop table if exists crm.callyzer_quarantine;
drop table if exists crm.callyzer_employees;

delete from crm.settings where key like 'callyzer.%';

-- Any Callyzer alarm still unread has nothing left to watch it: the watchdog
-- that would have stood it down was dropped above. Close them here, once.
update crm.notifications
   set read_at = now()
 where kind = 'callyzer_stalled' and read_at is null;

update crm.settings
   set value = (value - 'callyzer_stalled') - 'callyzer_recovered'
 where key = 'alerts.bell_kinds';

alter table crm.device_call_logs
  drop constraint device_call_logs_source_check;
alter table crm.device_call_logs
  add constraint device_call_logs_source_check
  check (source in ('device_app', 'callyzer', 'tata_tele'));

comment on column crm.device_call_logs.source is
  'Which sensor wrote the row: the in-house companion app or Tata Tele Smartflo. ''callyzer'' is historical only - that integration was retired in 0074 and no writer remains. All sources feed the same verification pipeline.';
comment on column crm.device_call_logs.recording_url is
  'Smartflo-hosted call recording. Stored only while tata_tele.store_recording_url is on; surfaced to counsellors and admin for coaching, never to the caller themselves.';
comment on column crm.device_call_logs.external_note is
  'The notes field on the provider''s call record. Kept for audit; it never drives CRM behaviour.';

-- ---------------------------------------------------------------------------
-- 1. Settings. Ships OFF; enabling it is an ops action, like every tunable.
--    Credentials stay in the API environment (TATA_TELE_LOGIN_EMAIL /
--    TATA_TELE_LOGIN_PASSWORD or TATA_TELE_API_TOKEN, TATA_TELE_WEBHOOK_SECRET)
--    - the same split as the sheet importer: secrets from the environment,
--    behaviour from settings.
-- ---------------------------------------------------------------------------

insert into crm.settings (key, value, description) values
  ('tata_tele.enabled', 'false'::jsonb,
   'Master switch for the Tata Tele Smartflo integration. Off means click-to-call is refused and the CDR sync, webhook and health watchdog all stand down.'),
  ('tata_tele.base_url', '"https://api-smartflo.tatateleservices.com/v1/"'::jsonb,
   'Smartflo API base URL, version pinned. A version bump is a code change with tests, not a settings edit.'),
  ('tata_tele.backfill_hours', '26'::jsonb,
   'How far back each scheduled CDR pull reconciles. Webhooks drop; the pull is what makes the push safe to trust.'),
  ('tata_tele.stale_sync_minutes', '60'::jsonb,
   'Raise the Tata Tele alarm when neither the pull nor a webhook has succeeded for this long. The sync runs every 15 minutes, so this tolerates a few missed ticks.'),
  ('tata_tele.caller_id', '""'::jsonb,
   'The DID shown to the client on a click-to-call. Blank uses the Smartflo account''s default Pilot Number.'),
  ('tata_tele.timezone', '"Asia/Kolkata"'::jsonb,
   'The Smartflo ACCOUNT timezone. CDR date/time and webhook stamps arrive as wall-clock with no zone; a wrong value here moves calls between business days in every daily rollup. Must match the timezone configured in the Smartflo portal.'),
  ('tata_tele.store_recording_url', 'true'::jsonb,
   'Store the recording_url Smartflo supplies. Off genuinely stops storing it (and clears it on re-sync), not merely hides it.')
on conflict (key) do nothing;

-- Deliberately NOT a setting: Smartflo's call_timeout caps the WHOLE call's
-- duration, not the ring. Passing it would hang up mid-conversation at the
-- configured second, so the CRM never sends it.

-- ---------------------------------------------------------------------------
-- 2. The outbound leg: one row per click-to-call the CRM originates.
--
--    Append-ish by design: the route INSERTs exactly one row per click
--    (status 'requested' with Smartflo''s ref_id, or 'failed' with the refusal
--    - a click that never became a call is data, not silence). Only the
--    definer-rights ingester below may touch it afterwards, to link the CDR
--    that confirms the bridge; crm_app has UPDATE revoked like every
--    append-only table, so RLS can never silently no-op a write.
-- ---------------------------------------------------------------------------

create table crm.telephony_calls (
  id                 uuid primary key default gen_random_uuid(),
  lead_id            uuid not null references crm.leads(id) on delete cascade,
  user_id            uuid not null references crm.users(id) on delete restrict,
  agent_msisdn       text not null,
  destination_msisdn text not null,
  provider           text not null default 'tata_tele'
    constraint telephony_calls_provider_check check (provider = 'tata_tele'),
  -- Smartflo's ref_id, returned by /click_to_call and echoed by its webhook:
  -- "unique call reference used to match API request with webhook callback".
  provider_ref_id    text,
  -- The telephony call id from the CDR, once the ingester links it.
  provider_call_id   text,
  status             text not null default 'requested'
    constraint telephony_calls_status_check check (status in ('requested', 'failed')),
  failure_reason     text,
  -- Set by the ingester when Smartflo's CDR for this bridge arrives. Null on
  -- a 'requested' row older than a few minutes means the bridge never rang -
  -- the health panel counts those.
  device_log_id      uuid references crm.device_call_logs(id) on delete set null,
  requested_at       timestamptz not null default now()
);

create index telephony_calls_lead_idx
  on crm.telephony_calls (lead_id, requested_at desc);
create unique index telephony_calls_ref_idx
  on crm.telephony_calls (provider_ref_id) where provider_ref_id is not null;
-- The ingester's fallback correlation: latest unlinked request by this user
-- to this number.
create index telephony_calls_unlinked_idx
  on crm.telephony_calls (user_id, destination_msisdn, requested_at desc)
  where device_log_id is null and status = 'requested';

comment on table crm.telephony_calls is
  'Every click-to-call the CRM asked Smartflo to place: who clicked, on which lead, when, and Smartflo''s ref_id. The CDR that arrives moments later is tied back through it, and requests that never became calls stay countable.';

revoke update, delete on crm.telephony_calls from crm_app;
alter table crm.telephony_calls enable row level security;

-- Your own clicks; admin and ops see the floor; a counsellor sees clicks on
-- leads they can see (their team's pipeline is their business).
create policy telephony_calls_select on crm.telephony_calls
  for select using (
    user_id = crm.current_user_id()
    or crm.current_user_role() in ('admin', 'ops')
    or (crm.current_user_role() = 'counsellor' and crm.can_see_lead(lead_id))
  );
-- A click is always recorded as yourself. The lead's visibility is enforced
-- upstream: the route reads the lead under RLS to get the number at all.
create policy telephony_calls_insert on crm.telephony_calls
  for insert with check (user_id = crm.current_user_id());

-- ---------------------------------------------------------------------------
-- 3. The agent roster Smartflo reports (/v1/users), refreshed on every sync.
--    Status cache only: user_id is resolved FROM users.dialing_msisdn, never
--    edited here. A row with user_id null is an unmapped agent - visible on
--    the health panel, named by the watchdog, fixed by setting the person's
--    Dialing number on Admin > Users.
-- ---------------------------------------------------------------------------

create table crm.tata_tele_agents (
  agent_msisdn text primary key,          -- crm.normalise_phone(agent.follow_me_number)
  agent_id     text,
  agent_name   text,
  extension    text,
  login_id     text,
  user_status  text,
  user_id      uuid references crm.users(id) on delete set null,
  refreshed_at timestamptz not null default now()
);

comment on table crm.tata_tele_agents is
  'What Smartflo says about each configured agent, refreshed by every sync. An agent whose follow-me number matches no user''s Dialing number is how verification (and that person''s click-to-call) silently fails - the health panel names them.';

revoke insert, update on crm.tata_tele_agents from crm_app;
alter table crm.tata_tele_agents enable row level security;
create policy tata_tele_agents_select on crm.tata_tele_agents
  for select using (crm.current_user_role() in ('admin', 'ops', 'counsellor', 'viewer'));

-- ---------------------------------------------------------------------------
-- 4. Quarantine. Same rule as the sheet importer and Callyzer before it:
--    nothing external is ever dropped. A row lands here with the raw payload
--    and a reason; once the cause is fixed (usually a missing Dialing number)
--    the next sync re-delivers the row, it ingests cleanly, and the
--    quarantine entry marks itself resolved.
-- ---------------------------------------------------------------------------

create table crm.telephony_quarantine (
  id               uuid primary key default gen_random_uuid(),
  external_id      text not null unique,   -- Smartflo call uuid / call_id
  agent_identifier text,
  reason           text not null,
  payload          jsonb not null,
  received_at      timestamptz not null default now(),
  last_seen_at     timestamptz not null default now(),
  resolved_at      timestamptz
);

create index telephony_quarantine_open_idx
  on crm.telephony_quarantine (received_at) where resolved_at is null;

comment on table crm.telephony_quarantine is
  'Smartflo call records that could not be ingested, kept whole. A call that really happened must never be silently dropped - an open row here is a verification gap the health panel and the watchdog both surface.';

revoke insert, update on crm.telephony_quarantine from crm_app;
alter table crm.telephony_quarantine enable row level security;
create policy telephony_quarantine_select on crm.telephony_quarantine
  for select using (crm.current_user_role() in ('admin', 'ops'));

-- ---------------------------------------------------------------------------
-- 5. Timestamp parsing. Smartflo CDRs carry date + time as wall-clock in the
--    account timezone; webhooks can be configured to Default (wall-clock),
--    ISO 8601 (explicit offset) or Epoch. Accept all three; return null
--    rather than raising - a malformed timestamp is a reason to quarantine a
--    row, never to kill a batch.
-- ---------------------------------------------------------------------------

create or replace function crm.tata_tele_timestamp(p_raw text)
  returns timestamptz
  language plpgsql
  stable
as $$
declare
  v_tz    text := crm.setting_text('tata_tele.timezone', 'Asia/Kolkata');
  v_clean text := nullif(trim(coalesce(p_raw, '')), '');
begin
  if v_clean is null then return null; end if;

  -- Epoch seconds (or milliseconds), if the webhook was set to Unix time.
  if v_clean ~ '^\d{13}$' then
    return to_timestamp(v_clean::bigint / 1000.0);
  elsif v_clean ~ '^\d{10}$' then
    return to_timestamp(v_clean::bigint);
  end if;

  -- An explicit offset ("2026-09-22T10:15:00+05:30", "...Z") speaks for itself.
  if v_clean ~ '([+-]\d{2}:?\d{2}|Z)$' then
    return v_clean::timestamptz;
  end if;

  -- Wall-clock in the account timezone, the CDR default.
  return replace(v_clean, 'T', ' ')::timestamp at time zone v_tz;
exception when others then
  return null;
end
$$;

comment on function crm.tata_tele_timestamp(text) is
  'Smartflo date-times are wall-clock in the account timezone (tata_tele.timezone) unless they carry an explicit offset or are epoch-formatted. Interpreting them in the wrong zone moves calls across crm.ist_date() boundaries, which corrupts every daily rollup.';

-- ---------------------------------------------------------------------------
-- 6. Refresh the agent roster from /v1/users output.
--    SECURITY DEFINER: runs from the scheduler as the ops account, and must
--    resolve numbers against every user row regardless of RLS. The pull hands
--    over the COMPLETE roster, so agents Smartflo no longer knows are pruned -
--    a ghost agent alarming as "unmapped" forever would teach people to
--    ignore the panel.
-- ---------------------------------------------------------------------------

create or replace function crm.refresh_tata_tele_agents(p_rows jsonb)
  returns table (seen int, mapped int, unmapped int)
  language plpgsql
  security definer
  set search_path = crm, public
as $$
declare
  r        jsonb;
  v_msisdn text;
  v_seen   int := 0;
  v_kept   text[] := '{}';
begin
  for r in select * from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) loop
    v_msisdn := crm.normalise_phone(coalesce(
      r #>> '{agent,follow_me_number}',
      r ->> 'follow_me_number',
      r ->> 'number'));
    continue when v_msisdn is null;
    v_seen := v_seen + 1;
    v_kept := v_kept || v_msisdn;

    insert into crm.tata_tele_agents as ta
      (agent_msisdn, agent_id, agent_name, extension, login_id, user_status,
       user_id, refreshed_at)
    values
      (v_msisdn,
       coalesce(r #>> '{agent,id}', r ->> 'agent_id'),
       coalesce(r #>> '{agent,name}', r ->> 'name'),
       r ->> 'extension',
       r ->> 'login_id',
       coalesce(r ->> 'user_status', r #>> '{agent,status}'),
       (select u.id from crm.users u where u.dialing_msisdn = v_msisdn and u.is_active),
       now())
    on conflict (agent_msisdn) do update set
      agent_id     = excluded.agent_id,
      agent_name   = excluded.agent_name,
      extension    = excluded.extension,
      login_id     = excluded.login_id,
      user_status  = excluded.user_status,
      user_id      = excluded.user_id,
      refreshed_at = now();
  end loop;

  -- Only a non-empty refresh prunes: an empty payload is far more likely a
  -- failed fetch than an account with zero agents.
  if v_seen > 0 then
    delete from crm.tata_tele_agents where not (agent_msisdn = any (v_kept));
  end if;

  return query
    select v_seen,
           (select count(*)::int from crm.tata_tele_agents where user_id is not null),
           (select count(*)::int from crm.tata_tele_agents where user_id is null);
end
$$;

revoke all on function crm.refresh_tata_tele_agents(jsonb) from public;
grant execute on function crm.refresh_tata_tele_agents(jsonb) to crm_app;

-- ---------------------------------------------------------------------------
-- 7. The ingester. One function, used by the scheduled CDR pull and the
--    webhook alike, so idempotency and quarantine behave identically however
--    a row arrives. Field names are read tolerantly across the two shapes
--    (the /call/records CDR and the webhook template variables), because they
--    describe the same call with different spellings.
--
--    SECURITY DEFINER for the same reason as the 0014 engines: it runs from
--    the scheduler/webhook as the ops account and must write rows for every
--    caller, match leads across the whole book, and link telephony_calls
--    rows, which no invoker-rights function can do. It is also the only
--    writer that can UPDATE device_call_logs and telephony_calls - crm_app
--    has UPDATE revoked, and that stays: Smartflo legitimately delivers the
--    same call twice (answered event, then hangup; webhook, then pull), so
--    this is an upsert where the in-house app's sync is insert-only.
-- ---------------------------------------------------------------------------

create or replace function crm.ingest_tata_tele_cdrs(p_rows jsonb)
  returns table (seen int, inserted int, updated int, matched int,
                 linked int, skipped int, quarantined int)
  language plpgsql
  security definer
  set search_path = crm, public
as $$
declare
  v_store_rec boolean := crm.setting_bool('tata_tele.store_recording_url', true);
  r           jsonb;
  v_seen int := 0; v_ins int := 0; v_upd int := 0; v_match int := 0;
  v_link int := 0; v_skip int := 0; v_quar int := 0;

  v_ext_id     text;
  v_agent_raw  text;
  v_agent      text;
  v_user       uuid;
  v_client     text;
  v_dir_raw    text;
  v_status     text;
  v_dir        text;
  v_started    timestamptz;
  v_talk       int;
  v_ref        text;
  v_reason     text;
  v_was_insert boolean;
  v_log_id     uuid;
  v_matched_lead uuid;
  v_orig_id    uuid;
  v_orig_lead  uuid;
begin
  for r in select * from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) loop
    v_seen := v_seen + 1;
    v_reason := null; v_user := null; v_orig_id := null; v_orig_lead := null;

    -- uuid is the one call identifier both the CDR pull and the webhook
    -- carry, so keying on it makes the two deliveries one row.
    v_ext_id := coalesce(
      nullif(trim(coalesce(r->>'uuid', '')), ''),
      nullif(trim(coalesce(r->>'call_id', '')), ''),
      nullif(trim(coalesce(r->>'id', '')), ''),
      'noid:' || md5(r::text));

    begin
      v_agent_raw := coalesce(
        nullif(trim(coalesce(r->>'answered_agent_number', '')), ''),
        nullif(trim(coalesce(r->>'agent_number_with_prefix', '')), ''),
        nullif(trim(coalesce(r->>'agent_number', '')), ''));
      v_agent   := crm.normalise_phone(v_agent_raw);
      v_dir_raw := lower(coalesce(r->>'direction', ''));
      v_status  := lower(coalesce(nullif(r->>'status', ''), nullif(r->>'call_status', ''), ''));
      v_client  := crm.normalise_phone(coalesce(
        nullif(trim(coalesce(r->>'client_number', '')), ''),
        nullif(trim(coalesce(r->>'customer_number_with_prefix', '')), ''),
        case when v_dir_raw in ('inbound', 'incoming')
             then coalesce(nullif(r->>'caller_id_num', ''), nullif(r->>'caller_id_number', ''))
             else nullif(r->>'call_to_number', '') end));
      v_started := crm.tata_tele_timestamp(coalesce(
        case when nullif(r->>'date', '') is not null and nullif(r->>'time', '') is not null
             then (r->>'date') || ' ' || (r->>'time') end,
        nullif(r->>'start_stamp', '')));
      -- answered_seconds/billsec is talk time; duration includes ringing.
      -- Counting ring time as talk would let a 40-second unanswered dial
      -- read as a connect, which is the exact fiction this table exists
      -- to prevent.
      v_talk := case when v_status = 'missed' then 0
                else greatest(0, coalesce(
                  nullif(trim(coalesce(r->>'answered_seconds', '')), '')::int,
                  nullif(trim(coalesce(r->>'billsec', '')), '')::int,
                  0)) end;
      v_ref := nullif(trim(coalesce(r->>'ref_id', '')), '');
      v_dir := case
        when v_dir_raw in ('inbound', 'incoming') then
          case when v_status = 'missed' then 'missed' else 'incoming' end
        when v_dir_raw in ('outbound', 'outgoing', 'clicktocall', 'click_to_call', 'c2c', 'dialer')
          then 'outgoing'
        else null
      end;

      -- An inbound call no agent ever answered names nobody. There is no user
      -- to verify a dial against and no fix that ever places it, so it is
      -- counted and left to Smartflo's own reports - quarantining it would
      -- park an unresolvable row in the panel forever.
      if v_agent_raw is null and v_dir_raw in ('inbound', 'incoming') then
        v_skip := v_skip + 1;
        continue;
      end if;

      if v_agent is not null then
        select u.id into v_user from crm.users u
         where u.dialing_msisdn = v_agent and u.is_active;
      end if;

      v_reason := case
        when v_agent_raw is null then
          'no agent number on the call record'
        when v_agent is null then
          'agent identifier is not a dialable number: ' || v_agent_raw
          || ' - the CRM maps Smartflo agents by phone; give the agent a mobile follow-me number'
        when v_user is null then
          'no active user has Dialing number ' || v_agent || ' - set it on Admin > Users'
        when v_dir is null then
          'unknown direction: ' || coalesce(nullif(v_dir_raw, ''), '(missing)')
        when v_started is null then
          'unparseable call time: ' || coalesce(r->>'date', r->>'start_stamp', '(missing)')
            || ' ' || coalesce(r->>'time', '')
        else null
      end;

      if v_reason is not null then
        insert into crm.telephony_quarantine as tq (external_id, agent_identifier, reason, payload)
        values (v_ext_id, coalesce(v_agent, v_agent_raw), v_reason, r)
        on conflict (external_id) do update set
          agent_identifier = excluded.agent_identifier,
          reason           = excluded.reason,
          payload          = excluded.payload,
          last_seen_at     = now(),
          resolved_at      = null;
        v_quar := v_quar + 1;
        continue;
      end if;

      -- The origination this CDR confirms: Smartflo's documented correlation
      -- (ref_id) first, then the latest unlinked click by this user to this
      -- number around the call's start.
      if v_ref is not null then
        select tc.id, tc.lead_id into v_orig_id, v_orig_lead
          from crm.telephony_calls tc where tc.provider_ref_id = v_ref;
      end if;
      if v_orig_id is null and v_client is not null then
        select tc.id, tc.lead_id into v_orig_id, v_orig_lead
          from crm.telephony_calls tc
         where tc.user_id = v_user
           and tc.destination_msisdn = v_client
           and tc.device_log_id is null
           and tc.status = 'requested'
           and tc.requested_at between v_started - interval '30 minutes'
                                   and v_started + interval '5 minutes'
         order by tc.requested_at desc
         limit 1;
      end if;

      insert into crm.device_call_logs as dcl
        (user_id, device_row_key, counterparty_msisdn, direction, started_at,
         duration_seconds, matched_lead_id, source, recording_url,
         external_note, external_synced_at, external_modified_at)
      values
        (v_user,
         'tata:' || v_ext_id,
         v_client,
         v_dir,
         v_started,
         v_talk,
         -- The click's own lead wins; otherwise the existing phone-match
         -- rule, preferring the dialler's copy so a number two teams have
         -- both held lands on theirs.
         coalesce(v_orig_lead,
           (select l.id from crm.leads l
             where l.phone_e164 = v_client
             order by (l.caller_id = v_user) desc, l.created_at desc
             limit 1)),
         'tata_tele',
         case when v_store_rec then nullif(trim(coalesce(r->>'recording_url', '')), '') end,
         nullif(trim(coalesce(r->>'notes', '')), ''),
         now(),
         crm.tata_tele_timestamp(nullif(r->>'end_stamp', '')))
      on conflict (user_id, device_row_key) do update set
        counterparty_msisdn  = excluded.counterparty_msisdn,
        direction            = excluded.direction,
        started_at           = excluded.started_at,
        -- Smartflo fires "answered" before "hangup" and deliveries can
        -- arrive out of order; talk time never shrinks.
        duration_seconds     = greatest(dcl.duration_seconds, excluded.duration_seconds),
        -- A match already made stays made (an attempt may reference it); an
        -- empty one may fill in if the lead arrived after the call did.
        matched_lead_id      = coalesce(dcl.matched_lead_id, excluded.matched_lead_id),
        -- A recording never un-happens: keep the old URL when a re-delivery
        -- omits it - unless storing is off, which clears rather than hides.
        recording_url        = case when v_store_rec
                                    then coalesce(excluded.recording_url, dcl.recording_url) end,
        external_note        = coalesce(excluded.external_note, dcl.external_note),
        external_synced_at   = excluded.external_synced_at,
        external_modified_at = coalesce(excluded.external_modified_at, dcl.external_modified_at)
      where dcl.source = 'tata_tele'
      returning (xmax = 0), dcl.id, dcl.matched_lead_id
        into v_was_insert, v_log_id, v_matched_lead;

      if v_was_insert is null then
        -- The conflict row belongs to another writer. The 'tata:' prefix
        -- makes this unreachable, but never overwrite another sensor's data
        -- if it somehow happens.
        raise exception 'device_row_key tata:% collides with a non-Tata row', v_ext_id;
      end if;

      if v_was_insert then v_ins := v_ins + 1; else v_upd := v_upd + 1; end if;
      if v_matched_lead is not null then v_match := v_match + 1; end if;

      if v_orig_id is not null then
        update crm.telephony_calls
           set device_log_id    = v_log_id,
               provider_call_id = coalesce(provider_call_id, nullif(r->>'call_id', '')),
               provider_ref_id  = coalesce(provider_ref_id, v_ref)
         where id = v_orig_id;
        v_link := v_link + 1;
      end if;

      -- The row is in: any quarantine entry about it is history now.
      update crm.telephony_quarantine
         set resolved_at = now()
       where external_id = v_ext_id and resolved_at is null;

    exception when others then
      -- One bad row must not stop the batch - same property as the sheet
      -- importer. Keep the row and the error; ops can see both.
      insert into crm.telephony_quarantine as tq (external_id, agent_identifier, reason, payload)
      values (v_ext_id, v_agent, 'ingest error: ' || sqlerrm, r)
      on conflict (external_id) do update set
        reason       = excluded.reason,
        payload      = excluded.payload,
        last_seen_at = now(),
        resolved_at  = null;
      v_quar := v_quar + 1;
    end;
  end loop;

  return query select v_seen, v_ins, v_upd, v_match, v_link, v_skip, v_quar;
end
$$;

revoke all on function crm.ingest_tata_tele_cdrs(jsonb) from public;
grant execute on function crm.ingest_tata_tele_cdrs(jsonb) to crm_app;

comment on function crm.ingest_tata_tele_cdrs(jsonb) is
  'The one door Smartflo call records enter through, from the scheduled CDR pull and the webhook alike. Normalises, maps the agent number to a user, ties the record to the click-to-call that placed it (ref_id, then user+number+time), matches the client number to a lead, upserts (the same call is legitimately delivered twice), and quarantines rather than drops anything it cannot place.';

-- ---------------------------------------------------------------------------
-- 8. Health, one row. Definer-rights like v_intake_health: plumbing status,
--    no lead data, and the person asking "is cloud calling alive" must get
--    the true answer rather than their own slice of it.
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
  -- Dialling staff Smartflo does not know: their clicks are refused and
  -- their calls never arrive, so their attempts can never verify. Counted
  -- only once a roster has been pulled - before that it would name everyone.
  (select case when exists (select 1 from crm.tata_tele_agents) then
      (select count(*)::int from crm.users u
        where u.is_active and u.role in ('caller', 'counsellor')
          and u.dialing_msisdn is not null
          and not exists (select 1 from crm.tata_tele_agents ta
                           where ta.agent_msisdn = u.dialing_msisdn))
    else 0 end)                                            as callers_uncovered,
  -- Dialling staff with no Dialing number at all: click-to-call has no
  -- number to bridge, whatever Smartflo knows.
  (select count(*)::int from crm.users u
    where u.is_active and u.role in ('caller', 'counsellor')
      and u.dialing_msisdn is null)                        as callers_unregistered,
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

grant select on crm.v_tata_tele_health to crm_app;

comment on view crm.v_tata_tele_health is
  'Is cloud calling alive: when Smartflo last delivered (pull or webhook), which agents match no user, who cannot click-to-call at all, what sits in quarantine, and today''s clicks and calls. One state word the screen can colour.';

-- ---------------------------------------------------------------------------
-- 9. The watchdog, both directions - same shape as check_lead_intake (0058):
--    raises a NAMED admin alarm while the floor is open and cloud calling is
--    broken; stands every alarm down and announces recovery the moment it is
--    healthy again. A Tata Tele alarm on the bell is always a live problem.
--
--    The failure it exists for: Smartflo rotates API passwords every 90 days.
--    The morning that lands, every click on the floor starts failing at once
--    - that must ring as "the Smartflo login expired", by name, not surface
--    as a mystery.
-- ---------------------------------------------------------------------------

create or replace function crm.check_tata_tele_health()
  returns int
  language plpgsql
  security definer
  set search_path = crm, public
as $$
declare
  h          record;
  v_sent     int := 0;
  v_user     record;
  v_body     text;
  v_last     timestamptz;
  v_unmapped text;
begin
  select * into h from crm.v_tata_tele_health;

  if h.state in ('off', 'healthy') then
    -- Whatever was alarming is over (fixed, or deliberately switched off):
    -- resolve it and tell each person who was alarmed that it is over.
    for v_user in
      select distinct user_id from crm.notifications
       where kind = 'tata_tele_stalled' and read_at is null
    loop
      update crm.notifications set read_at = now()
       where user_id = v_user.user_id and kind = 'tata_tele_stalled' and read_at is null;
      insert into crm.notifications (user_id, kind, title, body)
      values (v_user.user_id, 'tata_tele_recovered', 'Cloud calling has recovered',
              case when h.state = 'off'
                then 'The Tata Tele integration was switched off - the earlier alarms no longer apply.'
                else 'Smartflo is delivering call records again - the problem is resolved. '
                  || 'The earlier alarms have been cleared automatically.' end);
    end loop;
    return 0;
  end if;

  -- A problem is only ANNOUNCED while the floor is open. (Resolution above
  -- runs at any hour.)
  if not crm.is_shift_time(now()) then return 0; end if;

  select string_agg(agent_msisdn || coalesce(' (' || agent_name || ')', ''), ', ')
    into v_unmapped
    from (select agent_msisdn, agent_name from crm.tata_tele_agents
           where user_id is null order by agent_msisdn limit 5) x;

  v_body := case h.state
    when 'auth' then
      'Smartflo is refusing the CRM''s login - click-to-call and call verification have stopped. '
      || 'Smartflo rotates API passwords every 90 days; update the credentials on the server '
      || '(TATA_TELE_LOGIN_PASSWORD or TATA_TELE_API_TOKEN), or switch tata_tele.enabled off if it is being retired.'
    when 'failing' then
      'The Tata Tele CDR sync is failing: ' || coalesce(h.sync_last_error, 'unknown error')
      || '. Check Admin - Ingestion - Tata Tele.'
    when 'never_run' then
      'Tata Tele is enabled but no sync has ever run and no webhook has arrived. '
      || 'Are the Smartflo credentials set on the server, and the webhook configured in the Smartflo portal?'
    when 'stale' then
      'No Smartflo delivery (pull or webhook) for '
      || coalesce(h.minutes_since_alive::text, '?') || ' minutes - call verification is running blind. '
      || 'Check Admin - Ingestion - Tata Tele.'
    else -- attention: unmapped agents / quarantined rows are live data loss
      case when h.agents_unmapped > 0 then
        h.agents_unmapped || ' Smartflo agent(s) match no CRM user ('
        || coalesce(v_unmapped, '') || ') - their calls are quarantined, not verified. '
        || 'Set the Dialing number on Admin - Users.'
      else '' end
      || case when h.quarantine_open > 0 then
        ' ' || h.quarantine_open || ' call record(s) are quarantined - see Admin - Ingestion - Tata Tele.'
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
     where user_id = v_user.id and kind = 'tata_tele_stalled';
    continue when v_last is not null and v_last > now() - interval '1 hour';

    continue when exists (
      select 1 from crm.notifications
       where user_id = v_user.id and kind = 'tata_tele_stalled'
         and read_at is null and body = v_body);

    insert into crm.notifications (user_id, kind, title, body)
    values (v_user.id, 'tata_tele_stalled', 'Cloud calling has a problem', v_body);
    v_sent := v_sent + 1;
  end loop;

  return v_sent;
end
$$;

revoke all on function crm.check_tata_tele_health() from public;
grant execute on function crm.check_tata_tele_health() to crm_app;

comment on function crm.check_tata_tele_health is
  'The Tata Tele watchdog, both directions: raises a named admin alarm while the floor is open and cloud calling is broken (login expired, sync failing or silent, agents unmapped, rows quarantined); stands every alarm down and announces recovery the moment it is healthy or deliberately off.';

-- The alarm and its all-clear ring the bell like the intake pair do: closure
-- should be as visible as the problem was. Zero remains the bell's healthy state.
update crm.settings
   set value = value || '["tata_tele_stalled"]'::jsonb
 where key = 'alerts.bell_kinds' and not value ? 'tata_tele_stalled';
update crm.settings
   set value = value || '["tata_tele_recovered"]'::jsonb
 where key = 'alerts.bell_kinds' and not value ? 'tata_tele_recovered';
