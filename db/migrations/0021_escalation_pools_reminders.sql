-- 0021_escalation_pools_reminders.sql
--
-- The floor's second round of feedback, mechanised:
--
--  1. A caller who cannot reach a number twice should not keep being nagged
--     hourly. After two attempts with no connect the lead moves to the team
--     counsellor to tap. If the counsellor also cannot reach it (no answer,
--     switched off, not interested) it drops into a RE-TAP POOL - a parked
--     list they can work when they choose, never shown as overdue.
--
--  2. A lead nobody has managed to work for a long stretch moves to the OTHER
--     team, and that team's counsellor is told (0022 carries the notification
--     and chat tables). Owners see it coming: a lead nearing the cross-team
--     deadline shows in a watch list before it moves.
--
--  3. Fresh leads first, always. Breached and long-overdue work lives in its
--     own bucket, not mixed into the top of the list.
--
--  4. A promised visit ("will visit") is its own visible bucket - the floor
--     reported these "going missing" because they had no list of their own.
--
--  5. Each owner decides whether a lead reminds them, and when.

-- ---------------------------------------------------------------------------
-- Lead columns for the ladder, the pools, and per-lead reminders
-- ---------------------------------------------------------------------------

alter table crm.leads
  add column if not exists escalation_stage text not null default 'caller'
    check (escalation_stage in ('caller', 'counsellor')),
  add column if not exists escalated_at   timestamptz,
  -- A parked lead's tab. NULL for active leads. 'retap' = nobody could reach
  -- it; 'previous_month' = imported history (0022).
  add column if not exists pool text
    check (pool is null or pool in ('retap', 'previous_month')),
  add column if not exists retap_since    timestamptz,
  add column if not exists cross_team_count int not null default 0 check (cross_team_count >= 0),
  add column if not exists cross_team_at  timestamptz,
  -- Per-lead reminder choice, set by whoever owns the lead.
  add column if not exists reminder_muted boolean not null default false,
  add column if not exists reminder_at    timestamptz,
  add column if not exists reminder_note  text;

create index if not exists leads_pool_idx on crm.leads (pool, retap_since)
  where pool is not null;
create index if not exists leads_escalation_idx on crm.leads (escalation_stage, counsellor_id)
  where escalation_stage = 'counsellor';

comment on column crm.leads.escalation_stage is
  'Where the lead sits on the calling ladder: caller (normal) or counsellor
   (escalated because the caller could not reach it). The queue owner follows
   this - an escalated lead leaves the caller''s list and appears on the
   counsellor''s.';
comment on column crm.leads.pool is
  'A parked, still-tappable list. retap = the re-tap pool; previous_month =
   imported historical record. Parked leads never read as overdue.';

-- ---------------------------------------------------------------------------
-- Settings - every threshold tunable without a deploy
-- ---------------------------------------------------------------------------

insert into crm.settings (key, value, description) values
  ('escalation.caller_attempts_before_counsellor', '2'::jsonb,
   'Number of no-connect attempts by a caller before the lead moves to the team counsellor to tap.'),
  ('escalation.cross_team_days', '18'::jsonb,
   'Days a lead may sit un-worked before it moves to the other team (0 disables it). The floor asked for 15-20.'),
  ('escalation.cross_team_warn_days', '3'::jsonb,
   'How many days ahead of the cross-team move a lead shows in the "moving soon" watch list.'),
  ('escalation.cross_team_max', '1'::jsonb,
   'How many times a lead may be handed to another team before it is parked instead of bounced again.')
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- The team's counsellor (team lead). One place, so every path agrees.
-- ---------------------------------------------------------------------------

create or replace function crm.team_counsellor(p_team_id uuid)
  returns uuid
  language sql stable
as $$
  select u.id
    from crm.users u
    join crm.team_memberships tm
      on tm.user_id = u.id and tm.period @> current_date
   where tm.team_id = p_team_id and u.role = 'counsellor' and u.is_active
   order by tm.rotation_order
   limit 1
$$;

-- The other active team (for the two-team floor this is simply "not this one").
create or replace function crm.other_team(p_team_id uuid)
  returns uuid
  language sql stable
as $$
  select t.id from crm.teams t
   where t.is_active and t.id is distinct from p_team_id
     and exists (select 1 from crm.team_memberships tm
                  where tm.team_id = t.id and tm.period @> current_date)
   order by t.rotation_order
   limit 1
$$;

-- ---------------------------------------------------------------------------
-- The call-attempt engine, now with the escalation ladder appended.
--
-- The whole body from 0017 is reproduced (functions are replaced wholesale,
-- not patched) and the ladder added after the main update. Order matters: the
-- ladder reads the lead AFTER the disposition has been applied, then overrides
-- ownership and the parked state where the ladder says so.
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
  v_actor_role crm.user_role;
  v_esc_after  int := crm.setting_int('escalation.caller_attempts_before_counsellor', 2);
  v_counsellor uuid;
  -- Outcomes that mean "still could not get anywhere with them".
  v_stuck      boolean;
begin
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
         walkin_expected_at = case
           when new.disposition = 'will_visit'
             then coalesce(l.walkin_expected_at, new.started_at + make_interval(mins => v_retry_min))
           else l.walkin_expected_at
         end,
         status = case
           when new.disposition = 'invalid_number' then 'invalid'::crm.lead_status
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

  -- ----- the escalation ladder --------------------------------------------
  select role into v_actor_role from crm.users where id = new.user_id;
  select * into v_lead from crm.leads where id = new.lead_id;

  -- "Stuck" = could not get anywhere: no answer, unreachable, or a flat no.
  v_stuck := new.disposition in ('not_answered', 'busy', 'switched_off',
                                 'incoming_unavailable', 'disconnected_after_intro',
                                 'connected_not_interested');

  if v_actor_role = 'caller'
     and v_lead.escalation_stage = 'caller'
     and v_lead.status in ('new', 'working', 'callback')
     and not v_connect
     and v_lead.connect_count = 0
     and v_lead.attempt_count >= v_esc_after
  then
    -- Two tries, still no voice on the line: hand it to the counsellor to tap.
    v_counsellor := crm.team_counsellor(v_lead.team_id);
    if v_counsellor is not null then
      -- na_streak is deliberately NOT reset: it is the lead's unanswered
      -- history, and the counsellor's reassign queue still reads it.
      update crm.leads
         set escalation_stage = 'counsellor',
             counsellor_id    = v_counsellor,
             escalated_at     = now(),
             status           = case when status = 'new' then 'working' else status end,
             next_action_at   = now() + interval '10 minutes',
             next_action_note = 'Escalated - caller could not reach; counsellor to tap',
             updated_at       = now()
       where id = new.lead_id;
      insert into crm.lead_events (lead_id, event_type, actor_id, payload)
      values (new.lead_id, 'escalated_to_counsellor', new.user_id,
              jsonb_build_object('after_attempts', v_lead.attempt_count,
                                 'counsellor_id', v_counsellor));
    end if;

  elsif v_actor_role = 'counsellor'
     and v_lead.escalation_stage = 'counsellor'
     and v_stuck
  then
    -- The counsellor also could not get through. It is not a failure and it is
    -- not overdue - it goes to the re-tap pool to be worked again later.
    update crm.leads
       set status           = 'nurture',
           pool             = 'retap',
           retap_since      = now(),
           next_action_at   = null,
           next_action_note = 'Re-tap pool - tap again when you choose',
           closed_at        = null,
           lost_reason      = null,
           updated_at       = now()
     where id = new.lead_id;
    insert into crm.lead_events (lead_id, event_type, actor_id, payload)
    values (new.lead_id, 'moved_to_retap', new.user_id,
            jsonb_build_object('disposition', new.disposition));
  end if;

  return new;
end
$$;

-- ---------------------------------------------------------------------------
-- Cross-team escalation: a lead nobody has worked for too long moves to the
-- other team, and lands there as a fresh, unassigned lead so that team's
-- distribution picks it up. Scheduled (0022 wires the job in).
-- ---------------------------------------------------------------------------

create or replace function crm.escalate_stuck_leads(p_limit int default 200)
  returns int
  language plpgsql
  security definer
  set search_path = crm, public
as $$
declare
  v_days   int := crm.setting_int('escalation.cross_team_days', 18);
  v_max    int := crm.setting_int('escalation.cross_team_max', 1);
  v_lead   record;
  v_target uuid;
  v_moved  int := 0;
begin
  if v_days <= 0 then
    return 0;
  end if;

  for v_lead in
    select l.*
      from crm.leads l
     where l.status in ('new', 'working', 'callback', 'nurture')
       and l.walked_in_at is null
       and l.cross_team_count < v_max
       and l.team_id is not null
       -- Uploaded history is an archive, not live work; it never auto-moves.
       and l.pool is distinct from 'previous_month'
       -- Nothing has happened to it in the window: last contact (or, if never
       -- contacted, arrival) is older than the cutoff, and any scheduled
       -- action is also past due by that much.
       and coalesce(l.last_contacted_at, l.created_at) < now() - make_interval(days => v_days)
       and coalesce(l.next_action_at, l.created_at) < now() - make_interval(days => v_days)
     order by coalesce(l.last_contacted_at, l.created_at)
     limit p_limit
    for update skip locked
  loop
    v_target := crm.other_team(v_lead.team_id);
    continue when v_target is null;

    update crm.leads
       set team_id          = v_target,
           caller_id        = null,          -- the new team's balancer assigns it
           counsellor_id    = crm.team_counsellor(v_target),
           escalation_stage = 'caller',
           pool             = null,
           retap_since      = null,
           status           = 'working',
           cross_team_count = cross_team_count + 1,
           cross_team_at    = now(),
           first_touch_due_at = now() + make_interval(mins => crm.setting_int('sla.normal_first_touch_minutes', 60)),
           next_action_at   = now() + interval '15 minutes',
           next_action_note = 'Moved from the other team - fresh attempt',
           na_streak        = 0,
           updated_at       = now()
     where id = v_lead.id;

    insert into crm.lead_events (lead_id, event_type, payload)
    values (v_lead.id, 'cross_team_transfer',
            jsonb_build_object('from_team', v_lead.team_id, 'to_team', v_target,
                               'after_days', v_days));

    -- Tell the receiving team's counsellor (notifications table lives in 0022;
    -- guard so this file also applies before 0022 during a partial run).
    if to_regclass('crm.notifications') is not null then
      insert into crm.notifications (user_id, kind, title, body, lead_id)
      select crm.team_counsellor(v_target), 'cross_team_in',
             'Lead moved to your team',
             coalesce(v_lead.full_name, 'A lead') || ' was untouched for '
               || v_days || ' days and has moved to your team.',
             v_lead.id
       where crm.team_counsellor(v_target) is not null;
    end if;

    v_moved := v_moved + 1;
  end loop;

  return v_moved;
end
$$;

comment on function crm.escalate_stuck_leads(int) is
  'Moves leads nobody has worked for escalation.cross_team_days to the other
   team as fresh, unassigned leads, and notifies that team''s counsellor.
   Capped by escalation.cross_team_max so a lead is not bounced forever.';

revoke all on function crm.escalate_stuck_leads(int) from public;
grant execute on function crm.escalate_stuck_leads(int) to crm_app;

-- ---------------------------------------------------------------------------
-- A manual transfer to a specific caller must put the lead back on the caller
-- ladder, or an escalated lead would keep reading as the counsellor's. This
-- reproduces crm.transfer_lead (from 0007) with that one addition.
-- ---------------------------------------------------------------------------

create or replace function crm.transfer_lead(
    p_lead_id   uuid,
    p_to_caller uuid,
    p_reason    crm.transfer_reason,
    p_actor     uuid default crm.current_user_id(),
    p_note      text default null
  ) returns void
  language plpgsql
as $$
declare
  v_lead        crm.leads%rowtype;
  v_actor_role  crm.user_role;
  v_to_role     crm.user_role;
  v_to_active   boolean;
  v_max         int := crm.setting_int('lead.max_transfers', 2);
begin
  if p_actor is null then
    raise exception 'transfer_lead requires an acting user'
      using errcode = 'insufficient_privilege';
  end if;

  select role into v_actor_role from crm.users where id = p_actor and is_active;
  if v_actor_role is null or v_actor_role not in ('counsellor', 'admin') then
    raise exception 'only a counsellor or admin may transfer a lead (actor role: %)',
      coalesce(v_actor_role::text, 'unknown')
      using errcode = 'insufficient_privilege';
  end if;

  select * into v_lead from crm.leads where id = p_lead_id for update;
  if not found then
    raise exception 'lead % not found', p_lead_id;
  end if;

  if v_lead.caller_id = p_to_caller then
    raise exception 'lead % is already assigned to that caller', p_lead_id;
  end if;

  select role, is_active into v_to_role, v_to_active from crm.users where id = p_to_caller;
  if v_to_role is distinct from 'caller' or not coalesce(v_to_active, false) then
    raise exception 'transfer target must be an active caller';
  end if;

  if v_lead.transfer_count >= v_max then
    raise exception 'lead % has already been transferred % times; park it in nurture instead',
      p_lead_id, v_lead.transfer_count
      using errcode = 'check_violation';
  end if;

  insert into crm.lead_transfers (
    lead_id, from_caller_id, to_caller_id, transferred_by, reason, note,
    na_streak_at_transfer, attempts_at_transfer
  ) values (
    p_lead_id, v_lead.caller_id, p_to_caller, p_actor, p_reason, p_note,
    v_lead.na_streak, v_lead.attempt_count
  );

  update crm.leads
     set caller_id        = p_to_caller,
         team_id          = coalesce(crm.team_of(p_to_caller, current_date), team_id),
         -- Handed to a specific caller: it belongs on the caller ladder again.
         escalation_stage = 'caller',
         transfer_count   = transfer_count + 1,
         na_streak        = 0,
         next_action_at   = greatest(now(), now() + interval '15 minutes'),
         next_action_note = 'Transferred in - first attempt',
         status = case when status = 'nurture' then 'working' else status end
   where id = p_lead_id;

  insert into crm.lead_events (lead_id, event_type, actor_id, payload)
  values (p_lead_id, 'transferred', p_actor,
          jsonb_build_object('from', v_lead.caller_id, 'to', p_to_caller,
                             'reason', p_reason, 'note', p_note));
end
$$;

-- ---------------------------------------------------------------------------
-- The pipeline, rebuilt: fresh first, a will-visit bucket, a breached tab.
--
-- queue_owner_id is the whole point of the ladder on screen: an escalated lead
-- belongs to the counsellor, a normal one to the caller. Every "my pipeline"
-- read filters on this, so a lead is on exactly one person's list.
-- ---------------------------------------------------------------------------

-- Column order changes (queue_owner_id, escalation_stage are new), so replace
-- in place is not possible - drop and recreate. Nothing else depends on it.
drop view if exists crm.v_my_pipeline;
create view crm.v_my_pipeline as
select
  l.id                as lead_id,
  l.caller_id,
  l.counsellor_id,
  l.team_id,
  case when l.escalation_stage = 'counsellor' then l.counsellor_id else l.caller_id end
                      as queue_owner_id,
  l.escalation_stage,
  l.full_name,
  l.phone_e164,
  l.city,
  l.campaign_name,
  l.priority,
  l.status,
  l.next_action_at,
  l.next_action_note,
  l.attempt_count,
  l.connect_count,
  l.na_streak,
  l.first_touched_at,
  l.last_contacted_at,
  l.whatsapp_sent_at,
  l.walkin_expected_at,
  l.walked_in_at,
  l.reminder_muted,
  l.reminder_at,
  l.created_at,
  cb.scheduled_at     as callback_at,
  cb.note             as callback_note,
  la.disposition      as last_disposition,

  -- One lead, one bucket. Fresh first; a promised visit gets its own home;
  -- anything long past due is 'breached' and lives in its own tab.
  case
    when l.priority = 'immediate' and l.first_touched_at is null then 'immediate'
    when l.first_touched_at is null                              then 'fresh'
    when l.next_action_at < now() - make_interval(mins =>
           crm.setting_int('sla.breached_after_minutes', 2880))  then 'breached'
    when l.walkin_expected_at is not null and l.walked_in_at is null
     and l.next_action_at < (crm.ist_date(now()) + 2)::timestamp at time zone 'Asia/Kolkata'
                                                                 then 'will_visit'
    when l.next_action_at < now()                                then 'overdue'
    when cb.id is not null
     and cb.scheduled_at < (crm.ist_date(now()) + 1)::timestamp at time zone 'Asia/Kolkata'
                                                                 then 'callback'
    when cb.id is not null                                       then 'callback_upcoming'
    when l.next_action_at < (crm.ist_date(now()) + 1)::timestamp at time zone 'Asia/Kolkata'
                                                                 then 'followup_today'
    else 'followup_upcoming'
  end                 as bucket,

  case
    when l.next_action_at < now()
      then extract(epoch from (now() - l.next_action_at)) / 60
    else 0
  end::int            as minutes_overdue,
  case
    when l.priority = 'immediate' and l.first_touched_at is null
      then extract(epoch from (l.first_touch_due_at - now())) / 60
  end::int            as sla_minutes_remaining
from crm.leads l
left join crm.callbacks cb
  on cb.lead_id = l.id and cb.status = 'pending'
left join lateral (
  select ca.disposition from crm.call_attempts ca
   where ca.lead_id = l.id order by ca.started_at desc limit 1
) la on true
where l.status not in ('won', 'lost', 'invalid', 'nurture', 'handed_off')
  and l.next_action_at is not null;

alter view crm.v_my_pipeline set (security_invoker = true);
grant select on crm.v_my_pipeline to crm_app;

insert into crm.settings (key, value, description) values
  ('sla.breached_after_minutes', '2880'::jsonb,
   'How far past its next action a lead must be to count as breached (own tab) rather than merely overdue. Default 48 hours.')
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- The re-tap pool and the cross-team watch list.
-- ---------------------------------------------------------------------------

create or replace view crm.v_retap_pool as
select
  l.id            as lead_id,
  l.full_name,
  l.phone_e164,
  l.city,
  l.team_id,
  l.caller_id,
  l.counsellor_id,
  l.attempt_count,
  l.connect_count,
  l.retap_since,
  la.disposition  as last_disposition,
  la.started_at   as last_call_at
from crm.leads l
left join lateral (
  select ca.disposition, ca.started_at from crm.call_attempts ca
   where ca.lead_id = l.id order by ca.started_at desc limit 1
) la on true
where l.pool = 'retap' and l.status = 'nurture';

alter view crm.v_retap_pool set (security_invoker = true);
grant select on crm.v_retap_pool to crm_app;

comment on view crm.v_retap_pool is
  'Leads nobody could reach, parked for re-tapping. Never overdue; worked from
   its own tab when the counsellor chooses.';

-- Leads about to move to the other team, so the current owner is not surprised.
create or replace view crm.v_cross_team_watch as
select
  l.id            as lead_id,
  l.full_name,
  l.phone_e164,
  l.team_id,
  l.caller_id,
  l.counsellor_id,
  case when l.escalation_stage = 'counsellor' then l.counsellor_id else l.caller_id end
                  as queue_owner_id,
  coalesce(l.last_contacted_at, l.created_at) as idle_since,
  (coalesce(l.last_contacted_at, l.created_at)
     + make_interval(days => crm.setting_int('escalation.cross_team_days', 18))) as moves_at,
  crm.other_team(l.team_id) as moving_to_team
from crm.leads l
where l.status in ('new', 'working', 'callback', 'nurture')
  and l.walked_in_at is null
  and l.cross_team_count < crm.setting_int('escalation.cross_team_max', 1)
  and l.pool is distinct from 'previous_month'
  and crm.setting_int('escalation.cross_team_days', 18) > 0
  and coalesce(l.last_contacted_at, l.created_at)
        < now() - make_interval(days =>
            crm.setting_int('escalation.cross_team_days', 18)
            - crm.setting_int('escalation.cross_team_warn_days', 3));

alter view crm.v_cross_team_watch set (security_invoker = true);
grant select on crm.v_cross_team_watch to crm_app;

comment on view crm.v_cross_team_watch is
  'Leads within escalation.cross_team_warn_days of moving to the other team.
   Powers the "moving soon" notification tab so untapped leads are worked
   before they leave.';

-- ---------------------------------------------------------------------------
-- Live floor activity: every outcome logged today, newest first, for the team.
-- This is the answer to "leads are going missing" - whatever a caller records
-- appears here at once, filterable by outcome.
-- ---------------------------------------------------------------------------

create or replace view crm.v_floor_activity as
select
  ca.id           as attempt_id,
  ca.started_at,
  ca.disposition,
  ca.is_connect,
  ca.duration_seconds,
  ca.user_id,
  u.full_name     as by_name,
  u.role          as by_role,
  crm.team_of(ca.user_id, crm.ist_date(ca.started_at)) as team_id,
  l.id            as lead_id,
  l.full_name     as lead_name,
  l.phone_e164,
  l.status        as lead_status,
  l.escalation_stage
from crm.call_attempts ca
join crm.users u on u.id = ca.user_id
join crm.leads l on l.id = ca.lead_id
where crm.ist_date(ca.started_at) = crm.ist_date(now());

alter view crm.v_floor_activity set (security_invoker = true);
grant select on crm.v_floor_activity to crm_app;

comment on view crm.v_floor_activity is
  'Today''s call outcomes, live. RLS scopes it: a counsellor sees their team,
   an admin sees the floor. The disposition filter on screen reads from here.';

-- ---------------------------------------------------------------------------
-- Alerts: honour the per-lead reminder choice, and add the custom reminder.
-- Rebuilt wholesale (the whole union is reproduced from 0018).
-- ---------------------------------------------------------------------------

create or replace view crm.v_my_alerts as
select
  'sla_breach'::text                as kind,
  'critical'::text                  as severity,
  l.id                              as lead_id,
  l.caller_id                       as user_id,
  l.full_name                       as lead_name,
  l.phone_e164,
  l.first_touch_due_at              as due_at,
  'First contact overdue'::text     as title,
  null::uuid                        as callback_id
  from crm.leads l
 where l.first_touched_at is null
   and l.first_touch_due_at is not null
   and l.first_touch_due_at < now()
   and l.status in ('new', 'working')
   and not l.reminder_muted

union all

select
  'new_lead', 'warning', l.id, l.caller_id, l.full_name, l.phone_e164,
  l.first_touch_due_at, 'New lead assigned to you', null
  from crm.leads l
 where l.first_touched_at is null
   and l.attempt_count = 0
   and l.status in ('new', 'working')
   and l.assigned_at > now() - interval '2 hours'
   and (l.first_touch_due_at is null or l.first_touch_due_at >= now())
   and not l.reminder_muted

union all

select
  'callback_due', 'critical', c.lead_id, c.assigned_to, l.full_name, l.phone_e164,
  c.scheduled_at, 'Callback due', c.id
  from crm.callbacks c
  join crm.leads l on l.id = c.lead_id
 where c.status = 'pending'
   and c.scheduled_at <= now()
   and not l.reminder_muted

union all

select
  'callback_soon', 'warning', c.lead_id, c.assigned_to, l.full_name, l.phone_e164,
  c.scheduled_at, 'Callback due shortly', c.id
  from crm.callbacks c
  join crm.leads l on l.id = c.lead_id
 where c.status = 'pending'
   and c.scheduled_at > now()
   and c.scheduled_at <= now() + interval '15 minutes'
   and not l.reminder_muted

union all

-- A follow-up that has just come due. A nudge, not a failure.
select
  'follow_up_due', 'warning', l.id,
  case when l.escalation_stage = 'counsellor' then l.counsellor_id else l.caller_id end,
  l.full_name, l.phone_e164,
  l.next_action_at, coalesce(l.next_action_note, 'Follow-up due now'), null
  from crm.leads l
 where l.next_action_at is not null
   and l.next_action_at <= now()
   and l.next_action_at > now() - make_interval(mins => crm.setting_int('sla.followup_grace_minutes', 30))
   and l.status in ('new', 'working', 'callback')
   and l.first_touched_at is not null
   and not l.reminder_muted

union all

-- Past the grace period. Now it is a problem - but parked pools never nag.
select
  'action_overdue', 'critical', l.id,
  case when l.escalation_stage = 'counsellor' then l.counsellor_id else l.caller_id end,
  l.full_name, l.phone_e164,
  l.next_action_at, coalesce(l.next_action_note, 'Follow-up overdue'), null
  from crm.leads l
 where l.next_action_at is not null
   and l.next_action_at <= now() - make_interval(mins => crm.setting_int('sla.followup_grace_minutes', 30))
   and l.status in ('new', 'working', 'callback')
   and l.first_touched_at is not null
   and not l.reminder_muted

union all

-- The reminder the owner set for themselves, at the time they chose.
select
  'custom_reminder', 'warning', l.id,
  case when l.escalation_stage = 'counsellor' then l.counsellor_id else l.caller_id end,
  l.full_name, l.phone_e164,
  l.reminder_at, coalesce(l.reminder_note, 'Your reminder for this lead'), null
  from crm.leads l
 where l.reminder_at is not null
   and l.reminder_at <= now()
   and l.status not in ('won', 'lost', 'invalid', 'handed_off')

union all

select
  'reassigned_in', 'info', t.lead_id, t.to_caller_id, l.full_name, l.phone_e164,
  t.created_at, 'Reassigned to you - first contact still owed', null
  from crm.lead_transfers t
  join crm.leads l on l.id = t.lead_id
 where t.is_automatic
   and t.created_at > now() - interval '2 hours'
   and l.first_touched_at is null;

alter view crm.v_my_alerts set (security_invoker = true);
grant select on crm.v_my_alerts to crm_app;

-- Custom reminders and the cross-team notice interrupt by default too.
update crm.settings
   set value = '["callback_due","callback_soon","follow_up_due","action_overdue","new_lead","reassigned_in","custom_reminder","cross_team_in"]'::jsonb,
       updated_at = now()
 where key = 'alerts.popup_kinds';
