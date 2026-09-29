-- 0078_inbound_calls_are_never_lost.sql
-- Cross-checking inbound calls end to end (owner, 28 Sep: "the team can make
-- inbound calls and outbound calls") found two ways a client who rang the
-- office could vanish:
--
--   1. Nobody picked up. Smartflo reports the call, but the ingester dropped
--      it - an inbound call no agent answered "names nobody", so it was only
--      counted - and a call that rang an agent who did not answer was kept
--      as that agent's missed ring and nothing more. Nobody was ever asked
--      to call the client back. A person who rang us is the warmest lead
--      there is (0055), and losing one silently is exactly the pipeline
--      leakage requirement 9 forbids.
--
--   2. Somebody picked up, the number was new, and nobody logged it. The
--      call record is in the CRM, on the person who answered, but no screen
--      showed it - the lead existed only if they remembered to type it in.
--
-- Now:
--
--   1. crm.intake_missed_call: a missed inbound call runs the same rule as a
--      repeat form submission. A number with a live lead (or any lead inside
--      lead.dedupe_window_days) is a re-enquiry on it - immediate priority,
--      next action within 15 minutes, owner notified that the client rang and
--      reached nobody. A new number becomes an immediate lead from the
--      Inbound call source, handed out by the fairness engine like any other.
--      A colleague's number is never a lead; a missed call older than
--      tata_tele.missed_call_lead_days (a replay of an old held record) is
--      history, not today's work. Once per call, however many times Smartflo
--      delivers it.
--
--   2. crm.inbound_calls_to_log: the answered inbound calls from numbers the
--      CRM has never seen, shown to the person who answered until they log
--      the lead or say it was not a client.

-- ---------------------------------------------------------------------------
-- 1. Settings.
-- ---------------------------------------------------------------------------

insert into crm.settings (key, value, description) values
  ('tata_tele.missed_call_lead_days', '7'::jsonb,
   'A missed inbound call younger than this many days becomes a lead (or a re-enquiry on the caller''s lead). Older ones - an old held call record released later - are history, not work for today.')
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- 2. One row per missed call acted on. The key is Smartflo's call id, so the
--    webhook and the pull delivering the same call act once.
-- ---------------------------------------------------------------------------

create table crm.telephony_missed_calls (
  external_id   text primary key,
  client_msisdn text not null,
  called_at     timestamptz not null,
  lead_id       uuid references crm.leads(id),
  outcome       text check (outcome in ('lead_created', 'reenquiry', 'staff', 'too_old')),
  recorded_at   timestamptz not null default now()
);

-- Written only by the SECURITY DEFINER intake below; read only through the
-- definer-rights health view. crm_app gets no grant at all.
alter table crm.telephony_missed_calls enable row level security;

comment on table crm.telephony_missed_calls is
  'Each missed inbound Smartflo call the CRM acted on: the lead it created or revived, or why it did neither (a colleague''s number, too old). Keyed on the call id so repeated deliveries act once.';

-- ---------------------------------------------------------------------------
-- 3. A client who rang and reached nobody.
-- ---------------------------------------------------------------------------

create or replace function crm.intake_missed_call(
  p_phone       text,
  p_called_at   timestamptz,
  p_external_id text
) returns text
  language plpgsql
  security definer
  set search_path = crm, public
as $$
declare
  v_phone   text := crm.normalise_phone(p_phone);
  v_at      timestamptz := coalesce(p_called_at, now());
  v_lead    uuid;
  v_outcome text;
begin
  -- A withheld number leaves nobody to call back.
  if v_phone is null or nullif(trim(coalesce(p_external_id, '')), '') is null then
    return null;
  end if;

  -- Once per call. The primary key also settles a race between the webhook
  -- and the pull delivering the same call at the same moment.
  insert into crm.telephony_missed_calls (external_id, client_msisdn, called_at)
  values (p_external_id, v_phone, v_at)
  on conflict (external_id) do nothing;
  if not found then
    return 'already_seen';
  end if;

  if exists (select 1 from crm.users where dialing_msisdn = v_phone) then
    -- A colleague ringing the office line is not a lead.
    v_outcome := 'staff';
  elsif v_at < now() - make_interval(days => crm.setting_int('tata_tele.missed_call_lead_days', 7)) then
    v_outcome := 'too_old';
  else
    -- The repeat-enquiry rule, exactly as for a form submission
    -- (api/src/ingest/worker.ts): a live lead at any age, or any lead inside
    -- the dedupe window.
    select l.id into v_lead
      from crm.leads l
     where l.phone_e164 = v_phone
       and (l.status in ('new', 'working', 'callback', 'qualified', 'negotiation', 'nurture')
            or l.created_at > now() - make_interval(days => crm.setting_int('lead.dedupe_window_days', 90)))
     order by (l.status in ('new', 'working', 'callback', 'qualified', 'negotiation', 'nurture')) desc,
              l.created_at desc
     limit 1;

    if v_lead is not null then
      update crm.leads
         set reenquiry_count  = reenquiry_count + 1,
             priority         = 'immediate',
             next_action_at   = least(coalesce(next_action_at, now()), now() + interval '15 minutes'),
             next_action_note = 'Rang the office and nobody answered - call back',
             status    = case when status in ('nurture', 'lost') then 'working' else status end,
             closed_at = case when status in ('nurture', 'lost') then null else closed_at end,
             pool        = null,
             retap_since = null
       where id = v_lead;
      -- A re_enquiry event, so everything a re-enquiry does follows: the
      -- owner is told (0064), it tops the Fresh tab (0065) and the dialler
      -- rings it with the fresh work (0075) until somebody calls.
      insert into crm.lead_events (lead_id, event_type, payload)
      values (v_lead, 're_enquiry', jsonb_build_object(
        'kind', 'missed_call',
        'source_id', '33333333-0000-0000-0000-000000000004',
        'called_at', v_at,
        'external_id', p_external_id));
      v_outcome := 'reenquiry';
    else
      insert into crm.leads (source_id, phone_e164, phone_raw, priority, next_action_note)
      values ('33333333-0000-0000-0000-000000000004', v_phone, p_phone, 'immediate',
              'Rang the office and nobody answered - call back')
      returning id into v_lead;
      insert into crm.lead_events (lead_id, event_type, payload)
      values (v_lead, 'missed_call', jsonb_build_object('called_at', v_at, 'external_id', p_external_id));
      -- The fairness engine, as for every lead nobody personally answered.
      perform crm.assign_lead(v_lead);
      v_outcome := 'lead_created';
    end if;
  end if;

  update crm.telephony_missed_calls
     set lead_id = v_lead, outcome = v_outcome
   where external_id = p_external_id;
  return v_outcome;
end
$$;

revoke all on function crm.intake_missed_call(text, timestamptz, text) from public;

comment on function crm.intake_missed_call(text, timestamptz, text) is
  'A missed inbound call: a re-enquiry on the number''s lead (the same rule as a repeat form), or a new immediate lead from the Inbound call source handed out by the fairness engine. Never for a colleague''s number or a call older than tata_tele.missed_call_lead_days; once per call id.';

-- ---------------------------------------------------------------------------
-- 4. The ingester, taken whole from 0074 with the two hand-offs above added:
--    the no-agent branch, and a missed ring on an agent.
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

      -- An inbound call no agent ever answered names nobody on the floor.
      -- There is no user to verify a dial against and no fix that ever
      -- places it, so no device log is kept - quarantining it would park an
      -- unresolvable row in the panel forever. But the client who rang is
      -- somebody (0078): they become a lead, or their lead comes back to the
      -- top of its owner's list.
      if v_agent_raw is null and v_dir_raw in ('inbound', 'incoming') then
        perform crm.intake_missed_call(v_client, v_started, v_ext_id);
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

      -- It rang an agent who did not pick up: the device log above records
      -- the missed ring against them, and the client still needs calling
      -- back (0078).
      if v_dir = 'missed' then
        perform crm.intake_missed_call(v_client, v_started, v_ext_id);
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

-- ---------------------------------------------------------------------------
-- 5. The owner's note says what happened. "Filled the Inbound call form
--    again" is wrong for a client whose call nobody answered.
-- ---------------------------------------------------------------------------

create or replace function crm.tg_notify_reenquiry() returns trigger
  language plpgsql
as $$
declare
  v_lead   record;
  v_owner  uuid;
  v_via    text;
  v_missed boolean := (new.payload->>'kind') = 'missed_call';
begin
  select full_name, phone_e164, caller_id, counsellor_id, escalation_stage
    into v_lead
    from crm.leads where id = new.lead_id;
  if not found then return new; end if;

  v_owner := case when v_lead.escalation_stage = 'counsellor'
                  then coalesce(v_lead.counsellor_id, v_lead.caller_id)
                  else coalesce(v_lead.caller_id, v_lead.counsellor_id) end;
  -- A lead nobody owns yet is already on the fresh list and the re-enquired
  -- list; there is no one whose missed follow-up this could be.
  if v_owner is null then return new; end if;

  select name into v_via from crm.lead_sources
   where (new.payload->>'source_id') ~ '^[0-9a-f-]{36}$'
     and id = (new.payload->>'source_id')::uuid;

  -- One unread nudge per lead per person: the same form submitted three
  -- times in a burst must not bury the alerts list under copies of itself.
  if exists (select 1 from crm.notifications
              where user_id = v_owner and kind = 're_enquiry'
                and lead_id = new.lead_id and read_at is null) then
    return new;
  end if;

  insert into crm.notifications (user_id, kind, title, body, lead_id)
  values (
    v_owner,
    're_enquiry',
    case when v_missed
         then coalesce(v_lead.full_name, v_lead.phone_e164) || ' rang the office - nobody answered'
         else coalesce(v_lead.full_name, v_lead.phone_e164) || ' enquired again' end,
    case when v_missed
         then coalesce(v_lead.full_name, 'This lead')
              || ' called the office and reached nobody. They are back at the top of your list - call them back now.'
         else coalesce(v_lead.full_name, 'This lead')
              || coalesce(' filled the ' || v_via || ' form again', ' enquired again')
              || ' just now. They may be waiting on a missed follow-up - the lead is back at the top of your list.' end,
    new.lead_id
  );
  return new;
end
$$;

-- ---------------------------------------------------------------------------
-- 6. The health row gains today's missed calls (appended, same shape).
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
  end                                                      as state,
  -- Appended (0078): clients who rang today and reached nobody, each now a
  -- lead or back at the top of one.
  (select count(*)::int from crm.telephony_missed_calls
    where outcome in ('lead_created', 'reenquiry')
      and crm.ist_date(called_at) = crm.ist_date(now()))  as missed_calls_today;

-- ---------------------------------------------------------------------------
-- 7. Answered, from a number the CRM has never seen, and not yet logged.
--
--    Shown to the person who answered. It leaves the list when a lead exists
--    for the number (logging the inbound call makes one) or when they say it
--    was not a client. Definer rights because "does ANY lead have this
--    number" must look past the reader's RLS - a number that is a colleague's
--    lead is not new, and offering to log it would only hit the duplicate
--    check. The function returns only the reader's own calls.
-- ---------------------------------------------------------------------------

create table crm.inbound_call_dismissals (
  device_log_id uuid primary key references crm.device_call_logs(id) on delete cascade,
  dismissed_by  uuid not null references crm.users(id),
  dismissed_at  timestamptz not null default now()
);

alter table crm.inbound_call_dismissals enable row level security;
create policy inbound_call_dismissals_insert on crm.inbound_call_dismissals
  for insert with check (
    dismissed_by = crm.current_user_id()
    and exists (select 1 from crm.device_call_logs d
                 where d.id = device_log_id and d.user_id = crm.current_user_id()));
create policy inbound_call_dismissals_select on crm.inbound_call_dismissals
  for select using (dismissed_by = crm.current_user_id() or crm.current_user_role() = 'admin');
grant select, insert on crm.inbound_call_dismissals to crm_app;

comment on table crm.inbound_call_dismissals is
  '"Not a client": an answered inbound call from a new number that its taker says needs no lead - a supplier, a wrong number. Insert-only, one per call, only by the person who took it.';

create or replace function crm.inbound_calls_to_log(p_days int default 3)
  returns table (device_log_id uuid, phone text, started_at timestamptz, duration_seconds int)
  language sql
  stable
  security definer
  set search_path = crm, public
as $$
  select d.id, d.counterparty_msisdn, d.started_at, d.duration_seconds
    from crm.device_call_logs d
   where d.user_id = crm.current_user_id()
     and d.source = 'tata_tele'
     and d.direction = 'incoming'
     and d.started_at > now() - make_interval(days => least(greatest(coalesce(p_days, 3), 1), 30))
     and d.counterparty_msisdn is not null
     and not exists (select 1 from crm.leads l where l.phone_e164 = d.counterparty_msisdn)
     and not exists (select 1 from crm.users u where u.dialing_msisdn = d.counterparty_msisdn)
     and not exists (select 1 from crm.inbound_call_dismissals x where x.device_log_id = d.id)
   order by d.started_at desc
   limit 50
$$;

revoke all on function crm.inbound_calls_to_log(int) from public;
grant execute on function crm.inbound_calls_to_log(int) to crm_app;

comment on function crm.inbound_calls_to_log(int) is
  'The reader''s own answered inbound Smartflo calls from numbers no lead has, not yet logged or dismissed - the new clients who rang and exist nowhere else in the CRM.';
