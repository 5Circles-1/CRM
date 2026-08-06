-- 0019_avatars_leadflow_overall.sql
--
-- Three things the floor asked for after the leaderboard went up, and the one
-- question the admin could not answer from any screen.
--
-- 1. "Why is <caller> not getting leads?" The distribution engine has recorded
--    every decision - including who was passed over and why - since 0005, but
--    nothing showed it. v_lead_flow turns that record into one row per caller:
--    are they eligible at all, are they on the floor, when did a lead last
--    land on them, and how often have they been passed over today.
--
-- 2. An overall leaderboard next to the per-metric trophies. The weights live
--    in crm.settings like every other tunable number, so "deals should count
--    double this month" is an ops action, not a deploy.
--
-- 3. Faces on the board. An avatar is presentation, not identity - it lives on
--    crm.users as an inline data URL so there is no file store to run, back up,
--    or leak. Size-capped so the users table cannot quietly become a photo album.

-- ---------------------------------------------------------------------------
-- Avatars
-- ---------------------------------------------------------------------------

alter table crm.users
  add column if not exists avatar_url text
  check (avatar_url is null or length(avatar_url) <= 200000);

comment on column crm.users.avatar_url is
  'Inline data: URL for the person''s leaderboard icon, set by an admin. Capped
   at ~200KB so the row stays a row; the UI downsizes images before upload.';

-- ---------------------------------------------------------------------------
-- Settings: reminder cadence, live-refresh cadence, leaderboard weights
-- ---------------------------------------------------------------------------

insert into crm.settings (key, value, description) values
  ('alerts.repeat_minutes', '10'::jsonb,
   'How often an unresolved critical reminder (callback due, follow-up overdue) pops up again. 0 means pop once only.'),
  ('ui.refresh_seconds', '30'::jsonb,
   'How often the live screens (pipeline, floor, collections, performance) redraw themselves. The redraw is seamless - no flash, no scroll jump.'),
  ('leaderboard.weight_deals', '25'::jsonb,
   'Overall-standings weight for conversions (deals closed).'),
  ('leaderboard.weight_revenue', '25'::jsonb,
   'Overall-standings weight for booked revenue.'),
  ('leaderboard.weight_connects', '15'::jsonb,
   'Overall-standings weight for genuine connects (30s+ of talk).'),
  ('leaderboard.weight_dials', '10'::jsonb,
   'Overall-standings weight for dial volume.'),
  ('leaderboard.weight_interested', '10'::jsonb,
   'Overall-standings weight for interested outcomes.'),
  ('leaderboard.weight_walkins', '10'::jsonb,
   'Overall-standings weight for clients who actually walked in.'),
  ('leaderboard.weight_talk', '5'::jsonb,
   'Overall-standings weight for total talk time.')
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- Lead flow: one row per active caller answering "are leads reaching them,
-- and if not, which rule is stopping it".
--
-- Deliberately NOT security_invoker: the API exposes it to counsellors and
-- admins only, and a counsellor diagnosing the floor needs to see every
-- caller's eligibility, not just their own team's leads.
-- ---------------------------------------------------------------------------

create or replace view crm.v_lead_flow as
select
  u.id                                  as user_id,
  u.full_name,
  u.is_active,
  tm.team_id,
  t.name                                as team_name,
  tm.rotation_order,
  (tm.team_id is not null)              as has_team_today,
  crm.is_on_shift(u.id)                 as on_shift,
  -- Open book and today's intake.
  (select count(*) from crm.leads l
    where l.caller_id = u.id
      and l.status not in ('won','lost','invalid','nurture','handed_off')) as open_leads,
  (select count(*) from crm.leads l
    where l.caller_id = u.id
      and crm.ist_date(l.created_at) = crm.ist_date(now()))               as leads_today,
  -- The last time the engine handed this caller anything.
  (select max(de.decided_at) from crm.distribution_events de
    where de.caller_id = u.id)                                            as last_lead_at,
  -- How many times today the engine looked at this caller and moved on.
  (select count(*) from crm.distribution_events de
    where crm.ist_date(de.decided_at) = crm.ist_date(now())
      and de.passed_over @> jsonb_build_array(jsonb_build_object('user_id', u.id::text))) as passed_over_today,
  -- The one-line verdict the admin actually needs.
  case
    when not u.is_active         then 'inactive'
    when tm.team_id is null      then 'no_team'
    when not crm.is_on_shift(u.id) then 'off_shift'
    else 'receiving'
  end                                   as flow_status
from crm.users u
left join crm.team_memberships tm
  on tm.user_id = u.id and tm.period @> current_date
left join crm.teams t on t.id = tm.team_id
where u.role = 'caller';

comment on view crm.v_lead_flow is
  'Distribution eligibility per caller. flow_status names the first rule that
   stops leads reaching them: inactive, no_team (not in any team today - the
   engine cannot ever pick them), off_shift (skipped while
   distribution.require_on_shift is true), or receiving.';

grant select on crm.v_lead_flow to crm_app;

-- Floor-wide counts to sit above the per-caller table. A separate view for the
-- same reason v_lead_flow is one: a counsellor's RLS cannot see unassigned
-- leads, so counting them under invoker rights would report zero to exactly
-- the person trying to find out where the leads went.
create or replace view crm.v_lead_flow_summary as
select
  (select count(*) from crm.leads
    where caller_id is null and status in ('new', 'working'))::int as unassigned,
  (select count(*) from crm.distribution_events
    where caller_id is null
      and crm.ist_date(decided_at) = crm.ist_date(now()))::int     as deferred_today,
  (select count(*) from crm.leads
    where crm.ist_date(created_at) = crm.ist_date(now()))::int     as arrived_today,
  (select max(decided_at) from crm.distribution_events)            as last_decision_at;

grant select on crm.v_lead_flow_summary to crm_app;

-- ---------------------------------------------------------------------------
-- Follow-up radar: per caller, what is due, what is late, what got missed.
-- The counsellor's answer to "is anyone sitting on their follow-ups" without
-- opening five leads to find out.
-- ---------------------------------------------------------------------------

create or replace view crm.v_followup_radar as
select
  u.id                                   as user_id,
  u.full_name,
  u.role,
  crm.team_of(u.id, current_date)        as team_id,
  crm.is_on_shift(u.id)                  as on_shift,
  -- Follow-ups (next_action_at) on open leads this person owns.
  count(l.id) filter (where l.next_action_at < now())                     as overdue_now,
  coalesce(max(extract(epoch from (now() - l.next_action_at)) / 60)
           filter (where l.next_action_at < now()), 0)::int               as oldest_overdue_minutes,
  count(l.id) filter (where l.next_action_at >= now()
                        and l.next_action_at < now() + interval '1 hour') as due_next_hour,
  count(l.id) filter (where l.next_action_at >= now()
                        and crm.ist_date(l.next_action_at) = crm.ist_date(now())) as due_later_today,
  -- Callbacks the client asked for.
  (select count(*) from crm.callbacks cb
    where cb.assigned_to = u.id and cb.status = 'pending'
      and cb.scheduled_at <= now())                                       as callbacks_due,
  (select count(*) from crm.callbacks cb
    where cb.assigned_to = u.id and cb.status = 'missed'
      and cb.scheduled_at > now() - interval '7 days')                    as callbacks_missed_7d,
  (select min(cb.scheduled_at) from crm.callbacks cb
    where cb.assigned_to = u.id and cb.status = 'pending'
      and cb.scheduled_at > now())                                        as next_callback_at
from crm.users u
left join crm.leads l
  -- Whose court is the ball in? Once a lead is qualified it is the
  -- counsellor's follow-up, not the caller's - counting it for both would
  -- show one overdue promise as two people slacking.
  on (case when l.status in ('qualified', 'negotiation')
           then l.counsellor_id else l.caller_id end) = u.id
 and l.status not in ('won','lost','invalid','nurture','handed_off')
 and l.next_action_at is not null
where u.is_active and u.role in ('caller', 'counsellor')
group by u.id, u.full_name, u.role;

comment on view crm.v_followup_radar is
  'Per-person follow-up discipline, live: what is overdue right now, what falls
   due within the hour, and the 7-day missed-callback count. If overdue_now is
   zero across the board, nobody is sitting on a promise.';

grant select on crm.v_followup_radar to crm_app;
