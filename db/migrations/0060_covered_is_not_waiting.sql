-- 0060_covered_is_not_waiting.sql
--
-- The owner, reading the Lead flow banner: "81 leads waiting with no
-- caller" - while the breakdown underneath it truthfully said 14.
--
-- 0056 taught v_lead_flow_waiting that a lead held by a team lead as
-- absence cover is OWNED - caller column empty by design - but missed the
-- sibling view the banner headline reads. v_lead_flow_summary kept counting
-- every caller-less open lead, so the dozens of leads the team leads were
-- actively working were shouted about as if they were sitting with nobody.
-- A banner whose own breakdown contradicts it teaches the floor to trust
-- neither number.
--
-- The summary now counts waiting the same way the breakdown does, and the
-- covered leads are not dropped from sight: they get their own count, so
-- the floor can see how much work absence cover has put on the team leads.

create or replace view crm.v_lead_flow_summary as
select
  (select count(*) from crm.leads
    where caller_id is null and counsellor_id is null
      and status in ('new', 'working'))::int                       as unassigned,
  (select count(*) from crm.distribution_events
    where caller_id is null
      and crm.ist_date(decided_at) = crm.ist_date(now()))::int     as deferred_today,
  (select count(*) from crm.leads
    where crm.ist_date(created_at) = crm.ist_date(now()))::int     as arrived_today,
  (select max(decided_at) from crm.distribution_events)            as last_decision_at,
  -- Leads the team leads are holding as cover for absent callers: owned
  -- and being worked, never "waiting" - but worth seeing, because it is
  -- workload sitting on the counsellors.
  (select count(*) from crm.leads
    where caller_id is null and counsellor_id is not null
      and status in ('new', 'working'))::int                       as covered;

grant select on crm.v_lead_flow_summary to crm_app;

comment on view crm.v_lead_flow_summary is
  'Floor-wide lead-flow counts: genuinely unowned leads (no caller AND no
   covering team lead), today''s deferrals and arrivals, and how many leads
   the team leads currently hold as absence cover.';
