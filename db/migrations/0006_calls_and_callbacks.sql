-- 0006_calls_and_callbacks.sql
-- Call attempts, device call-log reconciliation, and callbacks.
--
-- Callers dial from personal SIMs, so the CRM cannot observe calls directly.
-- The companion Android app uploads the device call log; rows whose number
-- matches a lead the caller owns are reconciled into call_attempts. That is
-- what makes dial counts and talk time honest rather than self-reported.

insert into crm.settings (key, value, description) values
  ('sla.retry_after_not_answered_minutes', '180'::jsonb,
   'How long before an unanswered lead is automatically re-queued, so no lead ever sits without a next action.'),
  ('sla.retry_after_busy_minutes', '60'::jsonb,
   'Retry gap after busy or switched-off.');

-- ---------------------------------------------------------------------------
-- Raw device call log. Append-only, kept whether or not it matched a lead:
-- unmatched personal calls are counted only in aggregate and never inspected.
-- ---------------------------------------------------------------------------

create table crm.device_call_logs (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references crm.users(id) on delete cascade,
  -- Hash of (device id + call log row id). Makes re-uploads idempotent.
  device_row_key text not null,
  counterparty_msisdn text,
  direction      text not null check (direction in ('outgoing', 'incoming', 'missed', 'rejected')),
  started_at     timestamptz not null,
  duration_seconds int not null default 0 check (duration_seconds >= 0),
  matched_lead_id uuid references crm.leads(id) on delete set null,
  uploaded_at    timestamptz not null default now()
);

create unique index device_call_logs_identity_idx
  on crm.device_call_logs (user_id, device_row_key);
create index device_call_logs_match_idx
  on crm.device_call_logs (counterparty_msisdn, started_at);

comment on table crm.device_call_logs is
  'Uploaded from the caller handset. Only rows matching a CRM lead are surfaced anywhere in the product; the rest exist solely so dial totals can be reconciled.';

-- ---------------------------------------------------------------------------
-- Call attempts: the CRM-meaningful record of a dial.
-- ---------------------------------------------------------------------------

create table crm.call_attempts (
  id            uuid primary key default gen_random_uuid(),
  lead_id       uuid not null references crm.leads(id) on delete cascade,
  user_id       uuid not null references crm.users(id) on delete restrict,
  device_log_id uuid references crm.device_call_logs(id) on delete set null,
  started_at    timestamptz not null default now(),
  duration_seconds int not null default 0 check (duration_seconds >= 0),
  disposition   crm.disposition not null,
  -- Derived: a connect requires both a connected disposition and real talk time.
  is_connect    boolean not null default false,
  notes         text,
  -- TRUE when the attempt came from the device log rather than manual entry.
  -- Manually-entered calls with no matching device row are a QA signal.
  is_verified   boolean not null default false,
  created_at    timestamptz not null default now()
);

create index call_attempts_lead_idx on crm.call_attempts (lead_id, started_at desc);
create index call_attempts_user_day_idx
  on crm.call_attempts (user_id, started_at desc);

create trigger call_attempts_append_only
  before update or delete on crm.call_attempts
  for each row execute function crm.tg_append_only();

comment on column crm.call_attempts.is_verified is
  'False means the caller logged this call but no matching device call-log row was found. A high unverified rate is the strongest single indicator of fabricated activity.';

-- ---------------------------------------------------------------------------
-- Callbacks. Requirement 3: when a client asks to be called back, the caller
-- sets a reminder and it appears in their day.
-- ---------------------------------------------------------------------------

create type crm.callback_status as enum ('pending', 'completed', 'missed', 'cancelled');

create table crm.callbacks (
  id           uuid primary key default gen_random_uuid(),
  lead_id      uuid not null references crm.leads(id) on delete cascade,
  created_by   uuid not null references crm.users(id) on delete restrict,
  assigned_to  uuid not null references crm.users(id) on delete restrict,
  scheduled_at timestamptz not null,
  note         text,
  status       crm.callback_status not null default 'pending',
  completed_at timestamptz,
  completed_attempt_id uuid references crm.call_attempts(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  constraint callbacks_completion_consistent
    check ((status = 'completed') = (completed_at is not null))
);

-- One live callback per lead: two pending reminders on the same lead is how
-- double-dialling and "I thought you had it" happen.
create unique index callbacks_one_pending_per_lead_idx
  on crm.callbacks (lead_id) where status = 'pending';
create index callbacks_queue_idx
  on crm.callbacks (assigned_to, scheduled_at) where status = 'pending';

create trigger callbacks_set_updated_at
  before update on crm.callbacks
  for each row execute function crm.tg_set_updated_at();

-- A pending callback IS the lead's next action - keep the two in step.
create or replace function crm.tg_callback_sync_lead() returns trigger
  language plpgsql
as $$
begin
  if new.status = 'pending' then
    update crm.leads
       set next_action_at   = new.scheduled_at,
           next_action_note = coalesce(new.note, 'Client requested callback'),
           status = case when status in ('new', 'working') then 'callback' else status end
     where id = new.lead_id;

    insert into crm.lead_events (lead_id, event_type, actor_id, payload)
    values (new.lead_id, 'callback_scheduled', new.created_by,
            jsonb_build_object('scheduled_at', new.scheduled_at, 'note', new.note));
  end if;
  return new;
end
$$;

create trigger callbacks_sync_lead
  after insert or update of scheduled_at, status on crm.callbacks
  for each row execute function crm.tg_callback_sync_lead();

-- ---------------------------------------------------------------------------
-- Recording an attempt updates the lead: counters, streaks, and - critically -
-- always a forward next action.
-- ---------------------------------------------------------------------------

create or replace function crm.tg_call_attempt_apply() returns trigger
  language plpgsql
as $$
declare
  v_min_talk   int := crm.setting_int('dial.min_talk_seconds_for_connect', 30);
  v_connect    boolean;
  v_retry_min  int;
  v_max_attempts int := crm.setting_int('lead.max_attempts_before_nurture', 9);
  v_lead       crm.leads%rowtype;
begin
  v_connect := new.disposition in ('connected_interested', 'connected_not_interested',
                                   'callback_requested', 'wrong_person', 'language_barrier')
               and new.duration_seconds >= v_min_talk;
  new.is_connect := v_connect;

  select * into v_lead from crm.leads where id = new.lead_id for update;

  -- Retry gap by disposition. Terminal dispositions get no retry.
  v_retry_min := case new.disposition
    when 'not_answered'  then crm.setting_int('sla.retry_after_not_answered_minutes', 180)
    when 'busy'          then crm.setting_int('sla.retry_after_busy_minutes', 60)
    when 'switched_off'  then crm.setting_int('sla.retry_after_busy_minutes', 60)
    else null
  end;

  update crm.leads l
     set attempt_count     = l.attempt_count + 1,
         connect_count     = l.connect_count + (case when v_connect then 1 else 0 end),
         na_streak         = case when new.disposition = 'not_answered' then l.na_streak + 1 else 0 end,
         last_contacted_at = case when v_connect then new.started_at else l.last_contacted_at end,
         first_touched_at  = coalesce(l.first_touched_at, new.started_at),
         status = case
           when new.disposition = 'invalid_number' then 'invalid'::crm.lead_status
           when new.disposition = 'do_not_call'    then 'lost'::crm.lead_status
           when new.disposition = 'connected_not_interested' then 'lost'::crm.lead_status
           when l.attempt_count + 1 >= v_max_attempts and not v_connect then 'nurture'::crm.lead_status
           when l.status = 'new' then 'working'::crm.lead_status
           else l.status
         end,
         closed_at = case
           when new.disposition in ('invalid_number', 'do_not_call', 'connected_not_interested')
             then coalesce(l.closed_at, now())
           else l.closed_at
         end,
         lost_reason = case
           when new.disposition = 'connected_not_interested' then coalesce(l.lost_reason, 'Not interested')
           when new.disposition = 'do_not_call'              then coalesce(l.lost_reason, 'Do not call')
           else l.lost_reason
         end,
         -- Never leave an open lead without a forward action.
         next_action_at = case
           when new.disposition in ('invalid_number', 'do_not_call', 'connected_not_interested') then null
           when l.attempt_count + 1 >= v_max_attempts and not v_connect then null
           when v_retry_min is not null then greatest(now(), new.started_at) + make_interval(mins => v_retry_min)
           else l.next_action_at
         end,
         next_action_note = case
           when v_retry_min is not null then 'Retry after ' || new.disposition::text
           else l.next_action_note
         end
   where l.id = new.lead_id;

  -- Close the pending callback this attempt was answering.
  update crm.callbacks
     set status = 'completed', completed_at = now()
   where lead_id = new.lead_id and status = 'pending'
     and scheduled_at <= new.started_at + interval '12 hours';

  insert into crm.lead_events (lead_id, event_type, actor_id, payload)
  values (new.lead_id, 'call_logged', new.user_id,
          jsonb_build_object('disposition', new.disposition,
                             'duration_seconds', new.duration_seconds,
                             'is_connect', v_connect,
                             'verified', new.is_verified));

  return new;
end
$$;

create trigger call_attempts_apply
  before insert on crm.call_attempts
  for each row execute function crm.tg_call_attempt_apply();

-- ---------------------------------------------------------------------------
-- Mark overdue callbacks as missed. Run every few minutes.
-- ---------------------------------------------------------------------------

create or replace function crm.expire_missed_callbacks() returns int
  language plpgsql
as $$
declare
  v_grace int := crm.setting_int('sla.callback_grace_minutes', 15);
  v_count int;
begin
  with expired as (
    update crm.callbacks
       set status = 'missed'
     where status = 'pending'
       and scheduled_at + make_interval(mins => v_grace) < now()
    returning lead_id, assigned_to, scheduled_at
  )
  insert into crm.lead_events (lead_id, event_type, actor_id, payload)
  select lead_id, 'callback_missed', assigned_to,
         jsonb_build_object('scheduled_at', scheduled_at)
    from expired;

  get diagnostics v_count = row_count;
  return v_count;
end
$$;

comment on function crm.expire_missed_callbacks() is
  'A missed callback is a scored event, not a silent one. Feeds the caller score and the counsellor exception queue.';
