-- 0032_events.sql
--
-- Events: seminars, webinars, office open days - and the roster of leads
-- invited to them.
--
-- The load-bearing decision here is that importing a lead into an event
-- COPIES it. crm.event_leads carries its own name, phone and city, snapshotted
-- at import, plus a link back to the original lead id. Three things follow,
-- all of them wanted:
--
--   * The original lead is never touched. Its owner, stage, next action and
--     history are exactly what they were. An event cannot disturb the floor's
--     pipeline, which is the one thing that would make people refuse to use it.
--   * Both teams see the same roster. A caller can work an event list without
--     the lead-book fence hiding half of it - because a roster row is not a
--     lead, it is an invitation. The fence still holds on crm.leads itself.
--   * The roster survives the lead. Merge, park or close the original and the
--     attendance record of who came to the January seminar is still true.
--
-- Who may import is still fenced: the candidate query runs with invoker
-- rights, so a counsellor can only pull their own team's leads into an event.

create type crm.event_kind   as enum ('in_office', 'online', 'external');
create type crm.event_status as enum ('draft', 'published', 'live', 'completed', 'cancelled');
create type crm.attendee_status as enum
  ('invited', 'confirmed', 'attended', 'no_show', 'converted');

create table crm.events (
  id           uuid primary key default gen_random_uuid(),
  name         text not null check (length(trim(name)) > 0),
  kind         crm.event_kind not null default 'in_office',
  status       crm.event_status not null default 'draft',
  starts_at    timestamptz not null,
  ends_at      timestamptz,
  venue        text,
  meeting_link text,
  host_id      uuid references crm.users(id) on delete set null,
  team_id      uuid references crm.teams(id) on delete set null,
  capacity     int check (capacity is null or capacity > 0),
  description  text,
  banner_url   text,
  audience_tags text[] not null default '{}',
  created_by   uuid references crm.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint events_end_after_start check (ends_at is null or ends_at >= starts_at),
  -- An online event without a link is an event nobody can attend.
  constraint events_online_needs_link
    check (kind <> 'online' or status = 'draft' or meeting_link is not null)
);

create index events_starts_idx on crm.events (starts_at desc);
create index events_status_idx on crm.events (status, starts_at desc);

create table crm.event_leads (
  id            uuid primary key default gen_random_uuid(),
  event_id      uuid not null references crm.events(id) on delete cascade,
  -- The link home. ON DELETE SET NULL, not CASCADE: nothing deletes leads
  -- here, but if one ever were, the attendance record must outlive it.
  lead_id       uuid references crm.leads(id) on delete set null,
  -- The copy. Snapshotted at import so the roster reads the same to everyone.
  full_name     text,
  phone_e164    text,
  city          text,
  source_name   text,
  status        crm.attendee_status not null default 'invited',
  invite_sent_at timestamptz,
  attended_at   timestamptz,
  follow_up_owner_id uuid references crm.users(id) on delete set null,
  followed_up_at timestamptz,
  notes         text,
  added_by      uuid references crm.users(id) on delete set null,
  added_at      timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  -- The same lead cannot be invited to the same event twice. Re-running an
  -- import with a wider filter therefore tops the roster up instead of
  -- duplicating it.
  unique (event_id, lead_id)
);

create index event_leads_event_idx on crm.event_leads (event_id, status);
create index event_leads_owner_idx on crm.event_leads (follow_up_owner_id)
  where status in ('attended', 'no_show');

create trigger events_touch before update on crm.events
  for each row execute function crm.tg_set_updated_at();
create trigger event_leads_touch before update on crm.event_leads
  for each row execute function crm.tg_set_updated_at();

create trigger events_audit
  after insert or update or delete on crm.events
  for each row execute function crm.tg_audit();

-- ---------------------------------------------------------------------------
-- Access. Everyone on the floor reads events and rosters - that is the point
-- of a shared event. Editing the event is admin/counsellor; working a roster
-- row (marking attendance, taking follow-up) is open to callers too, because
-- they are the ones who ring round the day before.
-- ---------------------------------------------------------------------------
alter table crm.events enable row level security;
create policy events_read on crm.events
  for select using (crm.current_user_id() is not null);
create policy events_write on crm.events
  for all using (crm.current_user_role() in ('admin', 'ops', 'counsellor'))
  with check (crm.current_user_role() in ('admin', 'ops', 'counsellor'));

alter table crm.event_leads enable row level security;
create policy event_leads_read on crm.event_leads
  for select using (crm.current_user_id() is not null);
create policy event_leads_write on crm.event_leads
  for insert with check (crm.current_user_role() <> 'viewer');
create policy event_leads_update on crm.event_leads
  for update using (crm.current_user_role() <> 'viewer')
  with check (crm.current_user_role() <> 'viewer');

grant select, insert, update on crm.events to crm_app;
grant select, insert, update on crm.event_leads to crm_app;

-- ---------------------------------------------------------------------------
-- Import candidates. One predicate, used by both the preview count and the
-- import itself, so the number shown before importing is the number imported.
-- Invoker rights on purpose: RLS decides whose leads you may pull in.
-- ---------------------------------------------------------------------------
create or replace function crm.event_import_candidates(
  p_statuses    text[]  default null,
  p_source_id   uuid    default null,
  p_owner_id    uuid    default null,
  p_team_id     uuid    default null,
  p_city        text    default null,
  p_campaign    text    default null,
  p_from        date    default null,
  p_to          date    default null,
  p_exclude_event uuid  default null,
  p_limit       int     default 5000
) returns table (
  lead_id uuid, full_name text, phone_e164 text, city text, source_name text
)
  language sql stable
as $$
  select l.id, l.full_name, l.phone_e164, l.city, s.name
    from crm.leads l
    left join crm.lead_sources s on s.id = l.source_id
   where (p_statuses  is null or l.status::text = any(p_statuses))
     and (p_source_id is null or l.source_id = p_source_id)
     and (p_owner_id  is null or l.caller_id = p_owner_id or l.counsellor_id = p_owner_id)
     and (p_team_id   is null or l.team_id = p_team_id)
     and (p_city      is null or l.city ilike '%' || p_city || '%')
     and (p_campaign  is null or l.campaign_name ilike '%' || p_campaign || '%')
     and (p_from      is null or crm.ist_date(l.created_at) >= p_from)
     and (p_to        is null or crm.ist_date(l.created_at) <= p_to)
     and (p_exclude_event is null or not exists (
           select 1 from crm.event_leads el
            where el.event_id = p_exclude_event and el.lead_id = l.id))
   order by l.created_at desc
   limit greatest(p_limit, 0)
$$;

create or replace function crm.import_leads_to_event(
  p_event_id    uuid,
  p_statuses    text[] default null,
  p_source_id   uuid   default null,
  p_owner_id    uuid   default null,
  p_team_id     uuid   default null,
  p_city        text   default null,
  p_campaign    text   default null,
  p_from        date   default null,
  p_to          date   default null,
  p_limit       int    default 5000
) returns int
  language plpgsql
as $$
declare
  v_added int;
begin
  if not exists (select 1 from crm.events e where e.id = p_event_id) then
    raise exception 'no such event' using errcode = 'no_data_found';
  end if;

  insert into crm.event_leads
    (event_id, lead_id, full_name, phone_e164, city, source_name, added_by)
  select p_event_id, c.lead_id, c.full_name, c.phone_e164, c.city, c.source_name,
         crm.current_user_id()
    from crm.event_import_candidates(
           p_statuses, p_source_id, p_owner_id, p_team_id, p_city, p_campaign,
           p_from, p_to, p_event_id, p_limit) c
  on conflict (event_id, lead_id) do nothing;

  get diagnostics v_added = row_count;
  return v_added;
end
$$;

comment on function crm.import_leads_to_event is
  'Copies matching leads onto an event roster. The originals are never modified - the roster row carries its own snapshot of name, phone and city and a link back by id.';

-- ---------------------------------------------------------------------------
-- Counters, per event. Attendance and conversion percentages are computed
-- from the roster, and revenue is attributed only to deals booked AFTER the
-- event started - a deal closed the week before was not won by the seminar.
-- ---------------------------------------------------------------------------
create or replace view crm.v_event_summary as
select
  e.id as event_id, e.name, e.kind, e.status, e.starts_at, e.ends_at,
  e.venue, e.meeting_link, e.capacity, e.description, e.banner_url,
  e.audience_tags, e.team_id, e.host_id,
  h.full_name as host_name,
  t.name      as team_name,
  count(el.id)::int                                                    as invited,
  count(el.id) filter (where el.status = 'confirmed')::int             as confirmed,
  count(el.id) filter (where el.status = 'attended')::int              as attended,
  count(el.id) filter (where el.status = 'no_show')::int               as no_shows,
  count(el.id) filter (where el.status = 'converted')::int             as converted,
  count(el.id) filter (where el.status in ('attended', 'no_show')
                         and el.followed_up_at is null)::int           as followups_open,
  round(100.0 * count(el.id) filter (where el.status in ('attended', 'converted'))
        / nullif(count(el.id), 0), 1)                                  as attendance_pct,
  round(100.0 * count(el.id) filter (where el.status = 'converted')
        / nullif(count(el.id) filter (where el.status in ('attended', 'converted')), 0), 1)
                                                                       as conversion_pct,
  coalesce((
    select sum(p.amount)
      from crm.event_leads el2
      join crm.deals d  on d.lead_id = el2.lead_id and d.booked_at >= e.starts_at
      join crm.payments p on p.deal_id = d.id
     where el2.event_id = e.id), 0)                                    as revenue_attributed
from crm.events e
left join crm.event_leads el on el.event_id = e.id
left join crm.users h on h.id = e.host_id
left join crm.teams t on t.id = e.team_id
group by e.id, h.full_name, t.name;

alter view crm.v_event_summary set (security_invoker = true);
grant select on crm.v_event_summary to crm_app;

-- The post-event task list: everyone who came or failed to, still unworked.
create or replace view crm.v_event_followups as
select
  el.id as roster_id, el.event_id, e.name as event_name, e.starts_at,
  el.lead_id, el.full_name, el.phone_e164, el.status,
  el.follow_up_owner_id, u.full_name as owner_name, el.notes
from crm.event_leads el
join crm.events e on e.id = el.event_id
left join crm.users u on u.id = el.follow_up_owner_id
where el.status in ('attended', 'no_show')
  and el.followed_up_at is null;

alter view crm.v_event_followups set (security_invoker = true);
grant select on crm.v_event_followups to crm_app;
