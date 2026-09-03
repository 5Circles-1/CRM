-- 0064_reenquiries_are_visible.sql
--
-- "In the sheet there are two leads, but in the CRM only one reflects."
--   - the owner, 3 Sep, reconciling a Meta sheet against the Fresh tab.
--
-- The "missing" lead had enquired three weeks earlier through a different
-- form with the same phone number. The dedupe did exactly what it is built
-- to do (0042): attach the new enquiry to the existing lead, raise it to
-- immediate, pull its next action forward. What it did NOT do is show anyone
-- that this had happened. The re-enquiry worked invisibly - and an invisible
-- mechanism is indistinguishable from a lost lead to anyone comparing sheet
-- rows against the CRM. Worse, the signal it carries ("my team might have
-- missed a follow-up" - the owner, same conversation) reached only the
-- lead's own timeline, which nobody was looking at.
--
-- The rule itself stays: one live lead per phone. A re-enquiry never creates
-- a second lead, because two callers must never chase one person. What this
-- migration changes is visibility:
--
--   1. crm.v_reenquired_leads - every lead whose person enquired AGAIN in
--      the last fresh.reenquiry_show_days, with when, through which form,
--      and who owns the lead. The Fresh tab renders it under the fresh list,
--      so "the latest leads" and "the latest re-enquiries" are one screen -
--      the screen the sheet is reconciled against.
--
--   2. The lead's owner is notified (kind 're_enquiry'), because a repeat
--      enquiry usually means a follow-up was missed and the person is still
--      waiting. It appears on the Alerts work list; per 0052 it does NOT
--      ring the bell - a re-enquiry is not an appointment the customer
--      chose a time for.

insert into crm.settings (key, value, description) values
  ('fresh.reenquiry_show_days', '3'::jsonb,
   'Days a re-enquiry stays on the Fresh tab''s "Enquired again" list. 0 hides the list; the owner notification still fires.')
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- Every lead whose person enquired again recently, newest first.
--
-- Built on the re_enquiry timeline events the ingestion worker already
-- writes, so anything that records a re-enquiry - sheet sync, CSV import,
-- quarantine replay - surfaces here without knowing about this view. The
-- payload's source_id is the form the NEW enquiry arrived through, which is
-- usually not the source the lead is filed under - both are shown, because
-- "why is this lead under a July source when he filled the September form?"
-- is exactly the question this list exists to answer.
-- ---------------------------------------------------------------------------

create or replace view crm.v_reenquired_leads as
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
  rs.name                               as reenquiry_source_name,
  e.occurred_at                         as reenquired_at,
  round(extract(epoch from (now() - e.occurred_at)) / 60)::int
                                        as minutes_ago,
  l.reenquiry_count,
  (l.first_touched_at is null)          as never_contacted,
  l.attempt_count,
  l.next_action_at,
  l.created_at
from (
  -- Latest re-enquiry per lead inside the window; a form filled twice in a
  -- burst is one row here, not two.
  select distinct on (lead_id) lead_id, occurred_at, payload
    from crm.lead_events
   where event_type = 're_enquiry'
     and occurred_at > now() - make_interval(
           days => crm.setting_int('fresh.reenquiry_show_days', 3))
   order by lead_id, occurred_at desc
) e
join crm.leads l on l.id = e.lead_id
left join crm.teams t on t.id = l.team_id
left join crm.lead_sources s on s.id = l.source_id
left join crm.lead_sources rs
  on rs.id = case when (e.payload->>'source_id') ~ '^[0-9a-f-]{36}$'
                  then (e.payload->>'source_id')::uuid end
left join crm.users u
  on u.id = case when l.escalation_stage = 'counsellor' then l.counsellor_id else l.caller_id end;

alter view crm.v_reenquired_leads set (security_invoker = true);
grant select on crm.v_reenquired_leads to crm_app;

comment on view crm.v_reenquired_leads is
  'Leads whose person enquired again within fresh.reenquiry_show_days. The
   enquiry was attached to the existing lead (0042 - never a second live lead
   for one phone); this view is what keeps that attachment from being
   invisible. Rendered on the Fresh tab under the fresh list.';

-- ---------------------------------------------------------------------------
-- Tell the owner. A re-enquiry lands the lead back at the top of their
-- pipeline already (the ingest worker pulls next_action_at forward); the
-- notification says WHY it jumped - the person asked again and may have been
-- waiting on a missed follow-up.
--
-- A trigger on the timeline event, not code in the worker, so every path
-- that records a re-enquiry notifies the same way - and so the rule lives in
-- SQL with the rest of the business rules.
-- ---------------------------------------------------------------------------

create or replace function crm.tg_notify_reenquiry() returns trigger
  language plpgsql
as $$
declare
  v_lead  record;
  v_owner uuid;
  v_via   text;
begin
  select full_name, phone_e164, caller_id, counsellor_id, escalation_stage
    into v_lead
    from crm.leads where id = new.lead_id;
  if not found then return new; end if;

  v_owner := case when v_lead.escalation_stage = 'counsellor'
                  then coalesce(v_lead.counsellor_id, v_lead.caller_id)
                  else coalesce(v_lead.caller_id, v_lead.counsellor_id) end;
  -- A lead nobody owns yet is already on the fresh list and the re-enquired
  -- list; there is no one whose missed follow-up this could be.
  if v_owner is null then return new; end if;

  select name into v_via from crm.lead_sources
   where (new.payload->>'source_id') ~ '^[0-9a-f-]{36}$'
     and id = (new.payload->>'source_id')::uuid;

  -- One unread nudge per lead per person: the same form submitted three
  -- times in a burst must not bury the alerts list under copies of itself.
  if exists (select 1 from crm.notifications
              where user_id = v_owner and kind = 're_enquiry'
                and lead_id = new.lead_id and read_at is null) then
    return new;
  end if;

  insert into crm.notifications (user_id, kind, title, body, lead_id)
  values (
    v_owner,
    're_enquiry',
    coalesce(v_lead.full_name, v_lead.phone_e164) || ' enquired again',
    coalesce(v_lead.full_name, 'This lead')
      || coalesce(' filled the ' || v_via || ' form again', ' enquired again')
      || ' just now. They may be waiting on a missed follow-up - the lead is back at the top of your list.',
    new.lead_id
  );
  return new;
end
$$;

create trigger lead_events_notify_reenquiry
  after insert on crm.lead_events
  for each row
  when (new.event_type = 're_enquiry')
  execute function crm.tg_notify_reenquiry();

comment on function crm.tg_notify_reenquiry is
  'On a re_enquiry timeline event, notifies the lead''s current owner that
   the person asked again. Appears on the Alerts work list; deliberately not
   in alerts.bell_kinds (0052) - the bell stays appointments-only.';
