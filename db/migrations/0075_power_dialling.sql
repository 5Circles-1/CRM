-- 0075_power_dialling.sql
-- Power dialling: the CRM works the caller's due list back to back (owner
-- request, 23 Sep). One press of Start and the caller never picks a lead or
-- presses Call again: the next due lead is dialled after a short countdown,
-- the caller talks, logs the outcome, and the one after it rings.
--
-- Two things stay deliberately human:
--   * The outcome. It is what sets the next follow-up, fires callbacks, keeps
--     a green lead green and feeds every score - a dialler that moved on
--     without it would be a dialler attached to an amnesiac.
--   * Answering. Smartflo rings the CALLER first and dials the client only
--     when the caller picks up, so an unattended dialler can never ring a
--     client nobody is there to speak to.
--
-- What is due is the rule below, in SQL like every other rule here, so the
-- dialler and the pipeline screen can never disagree about what "due" means.
-- NOTE for later migrations: this view is built on crm.v_my_pipeline, so
-- dropping or renaming a pipeline column means dropping this view first.

-- ---------------------------------------------------------------------------
-- 1. Settings. Every tunable number lives in crm.settings.
-- ---------------------------------------------------------------------------

insert into crm.settings (key, value, description) values
  ('power_dial.countdown_seconds', '5'::jsonb,
   'Seconds the Power dial screen counts down before each automatic call - the window to skip a lead or pause.'),
  ('power_dial.redial_gap_minutes', '30'::jsonb,
   'A lead called this recently is not power-dialled again, whatever its next action says. Outcomes such as wrong person or language barrier leave an overdue lead overdue; without this gap the dialler would ring the same client straight back. A callback whose time has come and a fresh re-enquiry are never held back by it.'),
  ('power_dial.start_hour', '9'::jsonb,
   'IST hour from which power dialling may run (inclusive). 09:00-21:00 is the TRAI window for calls to customers; a single Call press is never restricted.'),
  ('power_dial.end_hour', '21'::jsonb,
   'IST hour at which power dialling stops (exclusive).'),
  ('tata_tele.click_cooldown_seconds', '10'::jsonb,
   'A second click-to-call by the same person inside this many seconds is refused: Smartflo is still ringing their phone for the first one, and two bridges ring the client twice.')
on conflict (key) do nothing;

-- The double-click guard on POST /leads/:id/call asks "when did this person
-- last click?" on every click; without this it scans every click ever made.
create index if not exists telephony_calls_user_recent_idx
  on crm.telephony_calls (user_id, requested_at desc);

-- ---------------------------------------------------------------------------
-- 2. The dial queue: what is due NOW, in the order it should be dialled.
--
-- Due means: never contacted (immediate or fresh), past its next action
-- (overdue or breached - which is also where a callback lands the moment its
-- time arrives), a promised visit whose follow-up date has come, or a person
-- who enquired again and has not been dialled since. Later-today and future
-- work is never auto-dialled: a callback booked for 16:00 is not rung at 11:00.
--
-- Order: the immediate lead first (its first-touch window is minutes); then a
-- callback whose time has come, because the client chose that time and it
-- is marked missed after sla.callback_grace_minutes; then fresh work and
-- re-enquiries, which the owner's rule treats alike; then due visit
-- follow-ups, overdue, and breached last. Inside a rank, the pipeline
-- screen's own tie-breaks, so the dialler works the list in the order the
-- caller already sees it.
--
-- redial_held_until: set while a lead was called within
-- power_dial.redial_gap_minutes. Such a lead is due but not dialable. The
-- two exceptions are the appointments a person made: a callback whose time
-- has come ("call me back in ten minutes"), and a re-enquiry that arrived
-- after the last call.
-- ---------------------------------------------------------------------------

create or replace view crm.v_dial_queue as
select q.*,
       (q.redial_held_until is null) as dialable,
       row_number() over (
         partition by q.queue_owner_id
         order by (q.redial_held_until is not null), q.dial_rank,
                  q.minutes_overdue desc, q.created_at desc, q.next_action_at asc, q.lead_id
       ) as dial_position
  from (
    select p.*,
           re.reenquired_at,
           case
             when p.bucket = 'immediate'                               then 0
             when p.callback_at is not null and p.callback_at <= now() then 1
             when p.bucket = 'fresh' or re.reenquired_at is not null   then 2
             when p.bucket = 'will_visit'                              then 3
             when p.bucket = 'overdue'                                 then 4
             else 5
           end as dial_rank,
           case
             when p.bucket = 'immediate'                               then 'immediate'
             when p.callback_at is not null and p.callback_at <= now() then 'callback_due'
             when re.reenquired_at is not null                         then 'reenquiry'
             when p.bucket = 'fresh'                                   then 'fresh'
             when p.bucket = 'will_visit'                              then 'visit_followup'
             when p.bucket = 'overdue'                                 then 'overdue'
             else 'breached'
           end as dial_reason,
           case
             when p.callback_at is not null and p.callback_at <= now() then null
             when re.reenquired_at is not null                         then null
             when la.last_call_at + make_interval(
                    mins => crm.setting_int('power_dial.redial_gap_minutes', 30)) > now()
               then la.last_call_at + make_interval(
                    mins => crm.setting_int('power_dial.redial_gap_minutes', 30))
           end as redial_held_until
      from crm.v_my_pipeline p
      -- The latest re-enquiry nobody has dialled since - the same "cleared
      -- only by a call placed after it" rule as crm.v_reenquired_leads.
      left join lateral (
        select e.occurred_at as reenquired_at
          from crm.lead_events e
         where e.lead_id = p.lead_id
           and e.event_type = 're_enquiry'
           and not exists (select 1 from crm.call_attempts ca
                            where ca.lead_id = p.lead_id
                              and ca.started_at > e.occurred_at)
         order by e.occurred_at desc
         limit 1
      ) re on true
      left join lateral (
        select max(ca.started_at) as last_call_at
          from crm.call_attempts ca
         where ca.lead_id = p.lead_id
      ) la on true
     where p.bucket in ('immediate', 'fresh', 'overdue', 'breached')
        or (p.bucket = 'will_visit' and p.next_action_at <= now())
        or re.reenquired_at is not null
  ) q;

alter view crm.v_dial_queue set (security_invoker = true);
grant select on crm.v_dial_queue to crm_app;

comment on view crm.v_dial_queue is
  'Each person''s due-now work in power-dial order. dialable is false while a lead sits inside power_dial.redial_gap_minutes of its last call (a due callback and an undialled re-enquiry are never held). Built on v_my_pipeline under the reader''s RLS, so nobody''s queue can contain a lead they cannot see.';

-- ---------------------------------------------------------------------------
-- 3. When power dialling may run. A person pressing Call on one lead is never
--    restricted; a machine dialling on their behalf keeps to the window.
-- ---------------------------------------------------------------------------

create or replace function crm.power_dial_open(p_at timestamptz default now())
  returns boolean
  language sql
  stable
as $$
  select extract(hour from p_at at time zone 'Asia/Kolkata')::int
           >= crm.setting_int('power_dial.start_hour', 9)
     and extract(hour from p_at at time zone 'Asia/Kolkata')::int
           <  crm.setting_int('power_dial.end_hour', 21)
$$;

comment on function crm.power_dial_open(timestamptz) is
  'True inside the IST hours power dialling may run (power_dial.start_hour inclusive, power_dial.end_hour exclusive).';
