-- 0017_outcomes_walkins_and_performance.sql
--
-- Everything that uses the outcomes added in 0016, plus the rest of the floor's
-- first-week feedback:
--
--   * how each new outcome moves the lead
--   * WhatsApp: was a message sent to this lead, by whom, when
--   * walk-ins recorded as a fact, so "who brought the most in" is answerable
--   * the untouched sweep goes round every caller, then back to the first one
--   * one performance view that serves the caller, the counsellor and the admin

-- ---------------------------------------------------------------------------
-- Retry gaps
--
-- The floor's complaint was being nagged hourly about leads that are not going
-- anywhere. The gap per outcome is the lever, so every one of them is a
-- setting rather than a number buried in a trigger.
-- ---------------------------------------------------------------------------

insert into crm.settings (key, value, description) values
  ('sla.retry_after_switched_off_minutes', '240'::jsonb,
   'Minutes before retrying a switched-off number. Was sharing the busy gap, which meant an hourly nag for a phone that is off.'),
  ('sla.retry_after_unavailable_minutes', '240'::jsonb,
   'Minutes before retrying a number that could not be reached at all.'),
  ('sla.retry_after_intro_drop_minutes', '1440'::jsonb,
   'Minutes before retrying someone who hung up during the introduction. A day, not an hour - calling straight back annoys them.'),
  ('sla.retry_after_will_call_back_minutes', '2880'::jsonb,
   'Minutes before chasing someone who said they would call us. Two days: chasing sooner contradicts what we agreed with them.'),
  ('sla.walkin_followup_minutes', '1440'::jsonb,
   'Minutes after a promised visit before someone checks whether they came.'),
  ('alerts.poll_seconds', '20'::jsonb,
   'How often the browser asks for new alerts. Lower means new leads appear sooner without a manual refresh.'),
  ('alerts.popup_kinds', '["callback_due","callback_soon","reassigned_in","new_lead"]'::jsonb,
   'Which alerts interrupt with a popup. Remove a kind to leave it in the bell only.')
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- WhatsApp, walk-ins, and where a lead started
-- ---------------------------------------------------------------------------

alter table crm.leads
  add column if not exists whatsapp_sent_at   timestamptz,
  add column if not exists whatsapp_sent_by   uuid references crm.users(id) on delete set null,
  add column if not exists walkin_expected_at timestamptz,
  add column if not exists walked_in_at       timestamptz,
  -- Who the lead was first given to. The sweep hands it back here once every
  -- caller has had their ten minutes, so it must survive the round trip.
  add column if not exists original_caller_id uuid references crm.users(id) on delete set null;

update crm.leads set original_caller_id = caller_id
 where original_caller_id is null and caller_id is not null;

create index if not exists leads_walkin_idx on crm.leads (walked_in_at)
  where walked_in_at is not null;
create index if not exists leads_whatsapp_idx on crm.leads (whatsapp_sent_at)
  where whatsapp_sent_at is not null;

comment on column crm.leads.whatsapp_sent_at is
  'When a WhatsApp message was last sent to this lead. Recorded by the caller -
   the CRM cannot see WhatsApp, so this is a claim, not a delivery receipt.';
comment on column crm.leads.walked_in_at is
  'When they actually came in. Distinct from walkin_expected_at: a promise to
   visit and a visit are different numbers, and only one of them is revenue.';

-- Remember the first caller on assignment, without disturbing assigned_at.
create or replace function crm.tg_lead_original_caller() returns trigger
  language plpgsql
as $$
begin
  if new.caller_id is not null and new.original_caller_id is null then
    new.original_caller_id := new.caller_id;
  end if;
  return new;
end
$$;

drop trigger if exists lead_original_caller on crm.leads;
create trigger lead_original_caller
  before insert or update of caller_id on crm.leads
  for each row execute function crm.tg_lead_original_caller();

-- ---------------------------------------------------------------------------
-- What each new outcome does to the lead
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
  -- They picked up. disconnected_after_intro belongs here even though it will
  -- usually fail the talk-time test: whether it counts as a connect is decided
  -- by seconds spoken, not by the label, and that rule stays exactly as it was.
  v_connect := new.disposition in ('connected_interested', 'connected_not_interested',
                                   'callback_requested', 'wrong_person', 'language_barrier',
                                   'disconnected_after_intro', 'will_visit',
                                   'will_call_back_self')
               and new.duration_seconds >= v_min_talk;
  new.is_connect := v_connect;

  select * into v_lead from crm.leads where id = new.lead_id for update;

  v_retry_min := case new.disposition
    when 'not_answered'  then crm.setting_int('sla.retry_after_not_answered_minutes', 180)
    when 'busy'          then crm.setting_int('sla.retry_after_busy_minutes', 60)
    when 'switched_off'  then crm.setting_int('sla.retry_after_switched_off_minutes', 240)
    when 'incoming_unavailable'     then crm.setting_int('sla.retry_after_unavailable_minutes', 240)
    when 'disconnected_after_intro' then crm.setting_int('sla.retry_after_intro_drop_minutes', 1440)
    when 'will_call_back_self'      then crm.setting_int('sla.retry_after_will_call_back_minutes', 2880)
    when 'will_visit'               then crm.setting_int('sla.walkin_followup_minutes', 1440)
    else null
  end;

  update crm.leads l
     set attempt_count     = l.attempt_count + 1,
         connect_count     = l.connect_count + (case when v_connect then 1 else 0 end),
         na_streak         = case when new.disposition = 'not_answered' then l.na_streak + 1 else 0 end,
         last_contacted_at = case when v_connect then new.started_at else l.last_contacted_at end,
         first_touched_at  = coalesce(l.first_touched_at, new.started_at),
         -- A promised visit is a date somebody has to check up on.
         walkin_expected_at = case
           when new.disposition = 'will_visit'
             then coalesce(l.walkin_expected_at, new.started_at + make_interval(mins => v_retry_min))
           else l.walkin_expected_at
         end,
         status = case
           when new.disposition = 'invalid_number' then 'invalid'::crm.lead_status
           -- Someone asking about a job is not a sales lead that was lost. It
           -- was never a lead, and counting it as lost would make every
           -- conversion rate on the floor quietly wrong.
           when new.disposition = 'job_enquiry'    then 'invalid'::crm.lead_status
           when new.disposition = 'do_not_call'    then 'lost'::crm.lead_status
           when new.disposition = 'connected_not_interested' then 'lost'::crm.lead_status
           when l.attempt_count + 1 >= v_max_attempts and not v_connect then 'nurture'::crm.lead_status
           when l.status = 'new' then 'working'::crm.lead_status
           else l.status
         end,
         closed_at = case
           when new.disposition in ('invalid_number', 'job_enquiry', 'do_not_call',
                                    'connected_not_interested')
             then coalesce(l.closed_at, now())
           else l.closed_at
         end,
         lost_reason = case
           when new.disposition = 'connected_not_interested' then coalesce(l.lost_reason, 'Not interested')
           when new.disposition = 'do_not_call'              then coalesce(l.lost_reason, 'Do not call')
           when new.disposition = 'job_enquiry'              then coalesce(l.lost_reason, 'Job enquiry, not a client')
           else l.lost_reason
         end,
         next_action_at = case
           when new.disposition in ('invalid_number', 'job_enquiry', 'do_not_call',
                                    'connected_not_interested') then null
           when l.attempt_count + 1 >= v_max_attempts and not v_connect then null
           when v_retry_min is not null then greatest(now(), new.started_at) + make_interval(mins => v_retry_min)
           else l.next_action_at
         end,
         next_action_note = case
           when new.disposition = 'will_visit'          then 'Check whether they visited'
           when new.disposition = 'will_call_back_self' then 'They said they would call - check in if they have not'
           when v_retry_min is not null then 'Retry after ' || replace(new.disposition::text, '_', ' ')
           else l.next_action_note
         end,
         updated_at = now()
   where l.id = new.lead_id;

  update crm.callbacks
     set status = 'completed', completed_at = now(), completed_attempt_id = new.id,
         updated_at = now()
   where lead_id = new.lead_id and status = 'pending' and scheduled_at <= now() + interval '1 hour';

  insert into crm.lead_events (lead_id, event_type, actor_id, payload)
  values (new.lead_id, 'call_logged', new.user_id,
          jsonb_build_object('disposition', new.disposition,
                             'duration_seconds', new.duration_seconds,
                             'is_connect', v_connect));

  return new;
end
$$;

-- ---------------------------------------------------------------------------
-- The untouched sweep, going round the team and then back to the first caller
--
-- The floor's rule: ten minutes each, everyone gets a turn, and if nobody has
-- started it then it belongs to whoever had it first. That is fairer than the
-- previous least-loaded pick, which could hand the same lead to the same
-- second caller twice while a third never saw it.
-- ---------------------------------------------------------------------------

create or replace function crm.reassign_untouched_leads(p_limit int default 200)
  returns int
  language plpgsql
  security definer
  set search_path = crm, public
as $$
declare
  v_minutes int := crm.setting_int('sla.untouched_reassign_minutes', 10);
  v_lead    record;
  v_target  uuid;
  v_full_circle boolean;
  v_moved   int := 0;
begin
  if v_minutes <= 0 then
    return 0;
  end if;

  for v_lead in
    select l.id, l.team_id, l.caller_id, l.original_caller_id, l.na_streak, l.attempt_count
      from crm.leads l
     where l.caller_id is not null
       and l.first_touched_at is null
       and l.attempt_count = 0
       and l.status in ('new', 'working')
       and l.assigned_at < now() - make_interval(mins => v_minutes)
     order by l.assigned_at
     limit p_limit
    for update skip locked
  loop
    -- Someone on the floor who has not already had this lead. Everyone gets
    -- their own ten minutes before anybody gets a second turn.
    select ec.user_id into v_target
      from crm.eligible_callers(v_lead.team_id) ec
     where ec.on_shift
       and ec.user_id <> v_lead.caller_id
       and not exists (
             select 1 from crm.lead_transfers t
              where t.lead_id = v_lead.id and t.to_caller_id = ec.user_id)
       and ec.user_id is distinct from v_lead.original_caller_id
     order by ec.rotation_order
     limit 1;

    v_full_circle := v_target is null;

    if v_full_circle then
      -- Everyone has had a turn. It goes back to the caller it started with,
      -- who owns it from here - there is nobody left to pass it to, and a lead
      -- circulating forever is how a pipeline leaks while looking busy.
      if v_lead.original_caller_id is null
         or v_lead.caller_id = v_lead.original_caller_id
         or not crm.is_on_shift(v_lead.original_caller_id) then
        continue;
      end if;
      v_target := v_lead.original_caller_id;
    end if;

    insert into crm.lead_transfers
      (lead_id, from_caller_id, to_caller_id, transferred_by, reason, note,
       is_automatic, na_streak_at_transfer, attempts_at_transfer)
    values
      (v_lead.id, v_lead.caller_id, v_target, null, 'caller_unavailable',
       case when v_full_circle
            then format('untouched by everyone - returned to the first caller after %s minutes each', v_minutes)
            else format('untouched for %s minutes', v_minutes) end,
       true, v_lead.na_streak, v_lead.attempt_count);

    update crm.leads
       set caller_id = v_target,
           transfer_count = transfer_count + 1,
           first_touch_due_at = now() + make_interval(mins => v_minutes),
           next_action_at = least(coalesce(next_action_at, now()), now()),
           next_action_note = case when v_full_circle
             then 'Back with you - nobody else picked it up'
             else 'Reassigned - first contact still owed' end,
           updated_at = now()
     where id = v_lead.id;

    insert into crm.lead_events (lead_id, event_type, payload)
    values (v_lead.id, 'transferred',
            jsonb_build_object('automatic', true, 'from', v_lead.caller_id,
                               'to', v_target, 'after_minutes', v_minutes,
                               'returned_to_original', v_full_circle));

    v_moved := v_moved + 1;
  end loop;

  return v_moved;
end
$$;

comment on function crm.reassign_untouched_leads(int) is
  'Ten minutes each, round the team in rotation order, then back to the caller
   it started with. Once it is home again nobody else has a claim on it, so it
   stops moving rather than circulating while looking busy.';

revoke all on function crm.reassign_untouched_leads(int) from public;
grant execute on function crm.reassign_untouched_leads(int) to crm_app;

-- ---------------------------------------------------------------------------
-- Performance, per person, for the day
--
-- One view rather than three. A caller looking at themselves, a counsellor
-- looking at their team and an admin looking at everyone are the same question
-- asked with different reach, and RLS already decides the reach.
-- ---------------------------------------------------------------------------

create or replace view crm.v_person_performance as
with days as (
  select u.id as user_id, u.full_name, u.role, d::date as day
    from crm.users u
    cross join generate_series(crm.ist_date(now()) - 30, crm.ist_date(now()), '1 day') d
   where u.is_active and u.role in ('caller', 'counsellor')
     -- Whose numbers this person may see.
     --
     -- RLS on the underlying tables is not enough here, and the reason is
     -- subtle: a caller can read call_attempts on leads they own, and after a
     -- reassignment they own leads someone ELSE called. Aggregating those rows
     -- would show them a colleague's dials and connects. Everyone can already
     -- read crm.users, so the restriction has to be on which rows this view
     -- builds at all.
     and (
       crm.current_user_role() in ('admin', 'ops', 'viewer')
       or u.id = crm.current_user_id()
       or (crm.current_user_role() = 'counsellor'
           and crm.team_of(u.id, current_date)
               = crm.team_of(crm.current_user_id(), current_date))
     )
),
calls as (
  select ca.user_id, crm.ist_date(ca.started_at) as day,
         count(*)                                                   as dials,
         count(*) filter (where ca.is_connect)                      as connects,
         count(*) filter (where ca.disposition = 'connected_interested')     as interested,
         count(*) filter (where ca.disposition = 'connected_not_interested') as not_interested,
         count(*) filter (where ca.disposition = 'not_answered')    as not_answered,
         count(*) filter (where ca.disposition = 'callback_requested') as callbacks_booked,
         count(*) filter (where ca.disposition = 'will_visit')      as visits_promised,
         count(*) filter (where ca.disposition = 'job_enquiry')     as job_enquiries,
         coalesce(sum(ca.duration_seconds), 0)::bigint              as talk_seconds
    from crm.call_attempts ca
   group by ca.user_id, crm.ist_date(ca.started_at)
),
walkins as (
  select l.caller_id as user_id, crm.ist_date(l.walked_in_at) as day, count(*) as walked_in
    from crm.leads l where l.walked_in_at is not null
   group by l.caller_id, crm.ist_date(l.walked_in_at)
),
messages as (
  select l.whatsapp_sent_by as user_id, crm.ist_date(l.whatsapp_sent_at) as day,
         count(*) as whatsapp_sent
    from crm.leads l where l.whatsapp_sent_at is not null
   group by l.whatsapp_sent_by, crm.ist_date(l.whatsapp_sent_at)
),
closed as (
  select d.counsellor_id as user_id, crm.ist_date(d.booked_at) as day,
         count(*) as deals, coalesce(sum(d.booked_amount), 0) as revenue
    from crm.deals d where d.status <> 'refunded'
   group by d.counsellor_id, crm.ist_date(d.booked_at)
),
setter as (
  select d.setter_id as user_id, crm.ist_date(d.booked_at) as day, count(*) as assisted
    from crm.deals d where d.status <> 'refunded' and d.setter_id is not null
   group by d.setter_id, crm.ist_date(d.booked_at)
)
select
  days.user_id, days.full_name, days.role, days.day,
  coalesce(calls.dials, 0)            as dials,
  coalesce(calls.connects, 0)         as connects,
  coalesce(calls.interested, 0)       as interested,
  coalesce(calls.not_interested, 0)   as not_interested,
  coalesce(calls.not_answered, 0)     as not_answered,
  coalesce(calls.callbacks_booked, 0) as callbacks_booked,
  coalesce(calls.visits_promised, 0)  as visits_promised,
  coalesce(calls.job_enquiries, 0)    as job_enquiries,
  coalesce(calls.talk_seconds, 0)     as talk_seconds,
  coalesce(walkins.walked_in, 0)      as walked_in,
  coalesce(messages.whatsapp_sent, 0) as whatsapp_sent,
  coalesce(closed.deals, 0)           as deals,
  coalesce(closed.revenue, 0)         as revenue,
  coalesce(setter.assisted, 0)        as assisted_deals,
  -- Rates are null rather than zero when there was nothing to divide by. A
  -- caller who made no calls has no conversion rate; showing 0% would rank
  -- them alongside someone who called forty people and closed none.
  case when coalesce(calls.dials, 0) > 0
       then round(100.0 * calls.connects / calls.dials, 1) end        as connect_rate,
  case when coalesce(calls.connects, 0) > 0
       then round(100.0 * calls.interested / calls.connects, 1) end   as interest_rate,
  case when coalesce(calls.connects, 0) > 0
       then round(100.0 * coalesce(closed.deals, 0) / calls.connects, 1) end as conversion_rate
from days
left join calls    on calls.user_id    = days.user_id and calls.day    = days.day
left join walkins  on walkins.user_id  = days.user_id and walkins.day  = days.day
left join messages on messages.user_id = days.user_id and messages.day = days.day
left join closed   on closed.user_id   = days.user_id and closed.day   = days.day
left join setter   on setter.user_id   = days.user_id and setter.day   = days.day;

alter view crm.v_person_performance set (security_invoker = true);

comment on view crm.v_person_performance is
  'Per-person daily performance. Rates are NULL when the denominator was zero,
   so nobody is ranked on a percentage of nothing.';

grant select on crm.v_person_performance to crm_app;

-- ---------------------------------------------------------------------------
-- Leads a person has already interacted with, with the last outcome attached.
-- This is the "what did I do and who do I chase" list.
-- ---------------------------------------------------------------------------

create or replace view crm.v_lead_history as
select
  l.id as lead_id, l.full_name, l.phone_e164, l.city, l.status, l.priority,
  l.caller_id, l.counsellor_id, l.team_id,
  l.attempt_count, l.connect_count, l.na_streak,
  l.first_touched_at, l.last_contacted_at, l.next_action_at, l.next_action_note,
  l.whatsapp_sent_at, l.walkin_expected_at, l.walked_in_at, l.created_at,
  la.disposition   as last_disposition,
  la.started_at    as last_call_at,
  la.duration_seconds as last_duration_seconds
from crm.leads l
left join lateral (
  select ca.disposition, ca.started_at, ca.duration_seconds
    from crm.call_attempts ca
   where ca.lead_id = l.id
   order by ca.started_at desc
   limit 1
) la on true;

alter view crm.v_lead_history set (security_invoker = true);

comment on view crm.v_lead_history is
  'Every lead with its most recent call outcome. Powers the re-tap lists, so a
   caller can work "did not answer" or "asked for a callback" as a list rather
   than remembering who they still owe.';

grant select on crm.v_lead_history to crm_app;
