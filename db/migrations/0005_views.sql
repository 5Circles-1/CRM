-- 0005_views.sql
-- The one read shape the lead screens share. Every list in the UI renders
-- rows of v_lead_list, so a lead looks the same everywhere.

create view crm.v_lead_list as
select
  l.id,
  l.full_name,
  l.phone_e164,
  l.email,
  l.city,
  l.campaign,
  l.stage,
  l.assigned_to,
  u.full_name as assigned_name,
  u.role      as assigned_role,
  l.source_id,
  s.name      as source_name,
  l.next_follow_up_at,
  l.follow_up_note,
  l.last_outcome,
  l.last_outcome_at,
  l.call_count,
  l.na_streak,
  l.enquiry_count,
  l.template_sent_at,
  l.confirmed_at,
  l.qualified_at,
  l.converted_at,
  l.closed_at,
  l.created_at,
  crm.ist_date(l.created_at) as received_on,
  -- open = still needs somebody's attention
  (l.stage in ('new', 'calling', 'qualified')) as is_open,
  case
    when l.stage not in ('new', 'calling', 'qualified') or l.next_follow_up_at is null then null
    when l.next_follow_up_at <= now() then 'overdue'
    when crm.ist_date(l.next_follow_up_at) = crm.ist_date(now()) then 'today'
    else 'upcoming'
  end as due_bucket
from crm.leads l
left join crm.users u on u.id = l.assigned_to
join crm.lead_sources s on s.id = l.source_id;

-- Views run with the caller's privileges, so RLS on the base tables applies
-- through them.
alter view crm.v_lead_list set (security_invoker = true);
