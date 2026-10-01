-- 0082: the softphone rings in the browser (owner request, 1 Oct).
--
-- Smartflo can ring an agent two ways: their follow-me phone (what every
-- click-to-call has sent so far) or their agent extension - the thing the
-- Smartflo Softphone browser extension logs into, which turns a headset on
-- a desk into the phone. The floor wants the headset. Two findings from the
-- live account drive the shape of this migration:
--
--   1. Passing a phone number as click_to_call's agent leg rings THAT NUMBER,
--      whatever the agent's own "Route Agent Through" preference says. The
--      documented way to make Smartflo apply the agent's routing (extension
--      included) is to pass the agent's identity, not a number. So the choice
--      is per person - crm.users.ring_softphone - and the API sends the
--      roster's agent identifier when it is on. The identity mapping is
--      untouched: users.dialing_msisdn is still the one fact that ties a
--      person to their Smartflo agent.
--
--   2. A call answered on a softphone can come back in the CDR identified by
--      the extension (a 13-digit login like 0608337350006), not the follow-me
--      number. crm.normalise_phone keeps that verbatim as +0608... - no
--      user's Dialing number - so every softphone call would quarantine as
--      "no active user has Dialing number +0608...". The ingester now
--      resolves an agent identifier through the roster cache
--      (crm.tata_tele_agents: extension, login_id, agent_id) before giving
--      up, and stores the person's own msisdn on the row, so everything
--      downstream stays keyed on the one mapping.
--
-- The caller's own row in the roster becomes readable to them (it was
-- admin/ops/counsellor/viewer only): the call route, running as the caller
-- under RLS, must see their extension to ring it. One row, their own,
-- nothing about anyone else.

-- ---------------------------------------------------------------------------
-- 1. The choice, per person.
-- ---------------------------------------------------------------------------

alter table crm.users add column ring_softphone boolean not null default false;

comment on column crm.users.ring_softphone is
  'Ring this person''s Smartflo softphone (agent extension, answered on a browser headset) instead of their Dialing number on click-to-call. Needs their Smartflo agent in the roster cache; falls back to the phone when the softphone leg cannot be placed, so switching it on can never make a person unreachable.';

-- ---------------------------------------------------------------------------
-- 2. A person may read their own roster row.
-- ---------------------------------------------------------------------------

create policy tata_tele_agents_self on crm.tata_tele_agents
  for select using (user_id = crm.current_user_id());

-- ---------------------------------------------------------------------------
-- 3. The ingester, taken whole from 0078 with one addition: an agent
--    identifier that matches no Dialing number is resolved through the
--    roster (extension / login id / agent id) before it quarantines.
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
  v_roster_user   uuid;
  v_roster_msisdn text;
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

      -- A softphone answers as its extension, not as a phone number (0082).
      -- An identifier no Dialing number owns may still name a known agent in
      -- the roster - by extension, login id, or agent id, with or without
      -- the + and punctuation normalise_phone leaves on it. Resolve it
      -- there, and store the person's own msisdn on the row, so coverage,
      -- verification and this table's identity all stay keyed on the one
      -- mapping, users.dialing_msisdn.
      if v_user is null and v_agent_raw is not null then
        select u.id, ta.agent_msisdn into v_roster_user, v_roster_msisdn
          from crm.tata_tele_agents ta
          join crm.users u on u.id = ta.user_id and u.is_active
         where regexp_replace(v_agent_raw, '[^0-9A-Za-z]', '', 'g')
               in (ta.extension, ta.login_id, ta.agent_id)
         limit 1;
        if v_roster_user is not null then
          v_user  := v_roster_user;
          v_agent := v_roster_msisdn;
        end if;
      end if;

      v_reason := case
        when v_agent_raw is null then
          'no agent number on the call record'
        when v_agent is null then
          'agent identifier is not a dialable number or a known agent extension: ' || v_agent_raw
          || ' - the CRM maps Smartflo agents by phone; give the agent a mobile follow-me number'
        when v_user is null then
          'no active user has Dialing number ' || v_agent
          || ' and no roster agent owns identifier ' || v_agent_raw || ' - set it on Admin > Users'
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
