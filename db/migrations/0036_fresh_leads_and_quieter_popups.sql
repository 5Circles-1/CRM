-- 0036_fresh_leads_and_quieter_popups.sql
--
-- Two changes that pull in opposite directions on purpose: fewer
-- interruptions, and fewer ways for a lead to go unseen.
--
-- 1. FEWER POPUPS. Eight alert kinds were configured to interrupt. On a busy
--    floor that is a popup every few minutes, and the response is to dismiss
--    reflexively - which is how a real callback gets clicked away. Only two
--    things now interrupt: a callback the customer asked for, and the same
--    one a few minutes before it is due. Both are appointments with a time
--    the customer chose.
--
--    NOTHING IS REMOVED FROM VIEW. Every other alert still appears in the
--    bell, still counts in its badge, and still has its own row in the Alerts
--    tab. Only the interrupting stops. Losing a lead and being nagged about a
--    lead are different problems, and this fixes the second without touching
--    the first.
--
-- 2. A FIRST-CLASS FRESH LIST. crm.v_my_pipeline already puts fresh leads
--    second, behind immediate, and keeps them there however late they get -
--    that ordering is correct and stays. What it cannot do is answer the
--    question the floor actually asks: "which never-contacted leads are we
--    now late on, across the whole floor, including the ones sitting with no
--    caller at all?" A caller's pipeline only ever shows their own, and a
--    lead held at team level appears in nobody's.
--
--    v_fresh_leads is that list: every never-contacted lead, whoever owns it
--    or does not, with a flag saying how far past its first-touch deadline it
--    has gone. It is the tab you check to be sure nothing arrived and sat.

-- Only customer appointments interrupt. Everything else waits in the bell.
update crm.settings
   set value = '["callback_due","callback_soon"]'::jsonb,
       description = 'Alert kinds that interrupt with a popup. Deliberately short: '
                     || 'only appointments the customer chose a time for. Everything '
                     || 'else still appears in the bell and the Alerts tab.',
       updated_at = now()
 where key = 'alerts.popup_kinds';

insert into crm.settings (key, value, description) values
  ('fresh.flag_after_minutes', '0'::jsonb,
   'Extra working minutes past a fresh lead''s first-touch deadline before it is flagged. 0 = flag as soon as the deadline passes.')
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- Every lead nobody has ever spoken to, with how urgent it has become.
--
-- Deliberately NOT bucketed away: a fresh lead that is late is still a fresh
-- lead, and it is the one most worth calling. The flag says how late; the row
-- never leaves the list until somebody actually contacts the person.
-- ---------------------------------------------------------------------------
create or replace view crm.v_fresh_leads as
select
  l.id                                  as lead_id,
  case when l.escalation_stage = 'counsellor' then l.counsellor_id else l.caller_id end
                                        as user_id,
  l.caller_id, l.counsellor_id, l.team_id,
  t.name                                as team_name,
  u.full_name                           as owner_name,
  l.full_name, l.phone_e164, l.city,
  l.priority, l.status,
  s.name                                as source_name,
  l.campaign_name,
  l.created_at, l.assigned_at,
  l.first_touch_due_at,
  l.attempt_count,
  round(extract(epoch from (now() - coalesce(l.assigned_at, l.created_at))) / 60)::int
                                        as age_minutes,
  case
    when l.first_touch_due_at is null then null
    else round(extract(epoch from (now() - l.first_touch_due_at)) / 60)::int
  end                                   as minutes_late,
  -- The flag. "waiting" is the healthy state; everything else needs a call.
  case
    when l.first_touch_due_at is null                       then 'waiting'
    when now() < l.first_touch_due_at                       then 'waiting'
    when now() < crm.add_working_minutes(l.first_touch_due_at,
                   crm.setting_int('fresh.flag_after_minutes', 0))
                                                            then 'waiting'
    when now() > crm.add_working_minutes(l.first_touch_due_at,
                   crm.setting_int('sla.breached_after_minutes', 2880))
                                                            then 'breached'
    else 'flagged'
  end                                   as flag
from crm.leads l
left join crm.teams t on t.id = l.team_id
left join crm.lead_sources s on s.id = l.source_id
left join crm.users u
  on u.id = case when l.escalation_stage = 'counsellor' then l.counsellor_id else l.caller_id end
where l.first_touched_at is null
  and l.attempt_count = 0
  and l.status in ('new', 'working');

alter view crm.v_fresh_leads set (security_invoker = true);
grant select on crm.v_fresh_leads to crm_app;

comment on view crm.v_fresh_leads is
  'Every lead nobody has ever contacted, whatever its due state, with a flag
   for how far past its first-touch deadline it is. Unlike v_my_pipeline this
   does not re-bucket a late fresh lead as merely "overdue", where it would
   sit among leads that have actually been worked.';

-- Floor-wide counts, for the tab badge and the counsellor's view. Definer
-- rights for the same reason as the other flow views: a counsellor's RLS
-- cannot see leads held with no caller, and reporting zero to the person
-- checking for stranded leads is the worst possible answer.
create or replace view crm.v_fresh_summary as
select
  coalesce(t.name, 'Unassigned')                                as team_name,
  f.team_id,
  count(*)::int                                                 as fresh,
  count(*) filter (where f.flag = 'waiting')::int               as waiting,
  count(*) filter (where f.flag = 'flagged')::int               as flagged,
  count(*) filter (where f.flag = 'breached')::int              as breached,
  count(*) filter (where f.user_id is null)::int                as unassigned,
  max(f.age_minutes)                                            as oldest_minutes
from crm.v_fresh_leads f
left join crm.teams t on t.id = f.team_id
group by f.team_id, t.name;

grant select on crm.v_fresh_summary to crm_app;
