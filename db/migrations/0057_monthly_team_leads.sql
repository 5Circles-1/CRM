-- 0057_monthly_team_leads.sql
--
-- The owner: "add an option in the dashboard where the total number of leads
-- received by the team is mentioned in total during the month."
--
-- One row per active team plus one for team-less leads: how many leads
-- landed this calendar month (IST - a lead at 11pm on the 31st belongs to
-- the month the floor experienced, not UTC's), how many of those were
-- inbound calls, and how many are already won. The floor dashboard prints
-- it; the API sums the total.

create or replace view crm.v_month_team_leads as
with month_leads as (
  select l.team_id,
         count(*)::int                                        as leads_month,
         count(*) filter (where l.source_id = '33333333-0000-0000-0000-000000000004')::int
                                                              as inbound_month,
         count(*) filter (where l.status = 'won')::int        as won_month,
         count(*) filter (where crm.ist_date(l.created_at) = crm.ist_date(now()))::int
                                                              as leads_today
    from crm.leads l
   where date_trunc('month', crm.ist_date(l.created_at))
         = date_trunc('month', crm.ist_date(now()))
   group by l.team_id
)
select
  t.id                            as team_id,
  t.name                          as team_name,
  coalesce(m.leads_month, 0)      as leads_month,
  coalesce(m.inbound_month, 0)    as inbound_month,
  coalesce(m.won_month, 0)        as won_month,
  coalesce(m.leads_today, 0)      as leads_today
from crm.teams t
left join month_leads m on m.team_id = t.id
where t.is_active
union all
select
  null, 'Not yet with a team',
  m.leads_month, m.inbound_month, m.won_month, m.leads_today
from month_leads m
where m.team_id is null;

-- Definer rights like the other flow views: the question "how many leads did
-- each team receive this month" needs the true floor-wide answer, and the
-- route gates who may ask it.
grant select on crm.v_month_team_leads to crm_app;

comment on view crm.v_month_team_leads is
  'Leads received per team this IST month - total, inbound calls, won so
   far, and today''s slice. The floor dashboard''s month counter.';
