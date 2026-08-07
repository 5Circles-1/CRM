-- 0025_exclusive_events.sql
--
-- "Exclusive Events": a separate inflow for leads from one-off campaigns. A new
-- sheet is added and marked as an event source; its leads are tagged with the
-- event name and surfaced on their own page, live. Old leads can also be pulled
-- into an event by hand and worked from the same place.

alter table crm.lead_sources
  add column if not exists is_exclusive   boolean not null default false,
  add column if not exists exclusive_label text;

comment on column crm.lead_sources.is_exclusive is
  'When true, leads ingested from this source are tagged as an Exclusive Event
   (exclusive_label) and appear on the Exclusive Events page.';

alter table crm.leads
  add column if not exists exclusive_event text;

create index if not exists leads_exclusive_event_idx
  on crm.leads (exclusive_event) where exclusive_event is not null;

comment on column crm.leads.exclusive_event is
  'Name of the Exclusive Event this lead belongs to, or NULL. Set automatically
   from an event source on ingest, or by hand to pull an old lead in.';

-- Tag on insert from an event source. A separate before-insert trigger rather
-- than folding into tg_lead_defaults, so each concern stays legible.
create or replace function crm.tg_lead_exclusive() returns trigger
  language plpgsql
as $$
begin
  if new.exclusive_event is null and new.source_id is not null then
    select case when s.is_exclusive then coalesce(s.exclusive_label, s.name) end
      into new.exclusive_event
      from crm.lead_sources s where s.id = new.source_id;
  end if;
  return new;
end
$$;

drop trigger if exists lead_exclusive on crm.leads;
create trigger lead_exclusive
  before insert on crm.leads
  for each row execute function crm.tg_lead_exclusive();

-- The page: every event, its live leads, most recent first. RLS scopes it -
-- a counsellor sees their team's event leads, an admin sees all.
create or replace view crm.v_exclusive_events as
select
  l.id            as lead_id,
  l.exclusive_event,
  l.full_name,
  l.phone_e164,
  l.city,
  l.team_id,
  l.caller_id,
  l.counsellor_id,
  l.status,
  l.priority,
  l.next_action_at,
  l.attempt_count,
  l.connect_count,
  l.walked_in_at,
  l.created_at,
  la.disposition  as last_disposition
from crm.leads l
left join lateral (
  select ca.disposition from crm.call_attempts ca
   where ca.lead_id = l.id order by ca.started_at desc limit 1
) la on true
where l.exclusive_event is not null
  and l.status not in ('won', 'lost', 'invalid', 'handed_off');

alter view crm.v_exclusive_events set (security_invoker = true);
grant select on crm.v_exclusive_events to crm_app;

comment on view crm.v_exclusive_events is
  'Live leads belonging to an Exclusive Event, for the Exclusive Events page.';
