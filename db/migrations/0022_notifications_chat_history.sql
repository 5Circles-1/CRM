-- 0022_notifications_chat_history.sql
--
-- Three things the floor asked for on top of the ladder:
--
--  * Notifications - the receiving counsellor is told when a lead lands on
--    their team, and everyone can see the "moving soon" watch list.
--  * Team chat - the admin floats a message to one team or the whole floor,
--    inside the CRM, no side WhatsApp group.
--  * History - previous months' records, uploaded team-wise and month-wise,
--    landing in a Previous-months pool the counsellor and admin can tap.

-- ---------------------------------------------------------------------------
-- Notifications - targeted, per user, read/unread.
-- ---------------------------------------------------------------------------

create table crm.notifications (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references crm.users(id) on delete cascade,
  kind       text not null,
  title      text not null,
  body       text,
  lead_id    uuid references crm.leads(id) on delete set null,
  created_at timestamptz not null default now(),
  read_at    timestamptz
);

create index notifications_user_idx on crm.notifications (user_id, created_at desc);
create index notifications_unread_idx on crm.notifications (user_id) where read_at is null;

alter table crm.notifications enable row level security;

-- A person sees, and clears, only their own notifications. Admin can read all.
create policy notifications_select on crm.notifications
  for select using (
    user_id = crm.current_user_id() or crm.current_user_role() = 'admin'
  );
create policy notifications_update on crm.notifications
  for update using (user_id = crm.current_user_id())
  with check (user_id = crm.current_user_id());
-- Inserts come from the SECURITY DEFINER engine (runs as owner, bypasses RLS)
-- and from admins acting deliberately.
create policy notifications_insert on crm.notifications
  for insert with check (crm.current_user_role() in ('admin', 'ops'));

grant select, insert, update on crm.notifications to crm_app;

-- ---------------------------------------------------------------------------
-- Team chat - broadcast, not a thread. Admin (and ops) post; the team reads.
-- ---------------------------------------------------------------------------

create table crm.team_messages (
  id         uuid primary key default gen_random_uuid(),
  author_id  uuid not null references crm.users(id) on delete set null,
  -- NULL team = the whole floor. Otherwise scoped to one team.
  team_id    uuid references crm.teams(id) on delete cascade,
  body       text not null check (length(trim(body)) > 0),
  pinned     boolean not null default false,
  created_at timestamptz not null default now()
);

create index team_messages_feed_idx on crm.team_messages (team_id, created_at desc);

alter table crm.team_messages enable row level security;

-- Read a message if it is floor-wide, or for your team, or you can see everyone.
create policy team_messages_select on crm.team_messages
  for select using (
    team_id is null
    or crm.current_user_role() in ('admin', 'ops', 'viewer')
    or team_id = crm.current_user_team()
  );
-- Only admin and ops broadcast. A counsellor leading the floor can be added
-- later; for now the megaphone is deliberately small.
create policy team_messages_insert on crm.team_messages
  for insert with check (crm.current_user_role() in ('admin', 'ops'));
create policy team_messages_delete_admin on crm.team_messages
  for update using (crm.current_user_role() = 'admin')
  with check (crm.current_user_role() = 'admin');

grant select, insert, update on crm.team_messages to crm_app;

-- ---------------------------------------------------------------------------
-- History - previous months, uploaded team-wise and month-wise.
-- ---------------------------------------------------------------------------

alter table crm.leads
  add column if not exists is_historical boolean not null default false,
  add column if not exists imported_month date,
  add column if not exists import_batch text;

create index if not exists leads_prev_month_idx
  on crm.leads (imported_month, team_id)
  where pool = 'previous_month';

comment on column crm.leads.imported_month is
  'For an uploaded historical record, the calendar month it belongs to (first
   of the month). Drives the month-wise grouping on the Previous-months tab.';

create or replace view crm.v_previous_month_pool as
select
  l.id            as lead_id,
  l.full_name,
  l.phone_e164,
  l.city,
  l.team_id,
  t.name          as team_name,
  l.imported_month,
  to_char(l.imported_month, 'Mon YYYY') as month_label,
  l.import_batch,
  l.created_at,
  l.attempt_count,
  la.disposition  as last_disposition,
  la.started_at   as last_call_at
from crm.leads l
left join crm.teams t on t.id = l.team_id
left join lateral (
  select ca.disposition, ca.started_at from crm.call_attempts ca
   where ca.lead_id = l.id order by ca.started_at desc limit 1
) la on true
where l.pool = 'previous_month';

alter view crm.v_previous_month_pool set (security_invoker = true);
grant select on crm.v_previous_month_pool to crm_app;

comment on view crm.v_previous_month_pool is
  'Uploaded historical leads, grouped by month and team, tappable from their
   own tab. RLS scopes a counsellor to their team; admin sees every month.';

-- ---------------------------------------------------------------------------
-- One helper to move a parked lead back into live work when someone taps it.
-- Used by the re-tap pool and the previous-months tab: taking a parked lead
-- gives it a fresh action and hands it to whoever picked it up.
-- ---------------------------------------------------------------------------

create or replace function crm.claim_parked_lead(p_lead_id uuid, p_actor uuid default crm.current_user_id())
  returns void
  language plpgsql
as $$
declare
  v_role crm.user_role;
begin
  select role into v_role from crm.users where id = p_actor and is_active;
  if v_role is null then
    raise exception 'claim_parked_lead requires an acting user'
      using errcode = 'insufficient_privilege';
  end if;

  update crm.leads
     set status = 'working',
         pool = null,
         retap_since = null,
         -- A counsellor who taps it owns it; a caller taps as the caller.
         counsellor_id = case when v_role = 'counsellor' then p_actor else counsellor_id end,
         caller_id     = case when v_role = 'caller' then p_actor else caller_id end,
         escalation_stage = case when v_role = 'counsellor' then 'counsellor' else 'caller' end,
         next_action_at = now() + interval '10 minutes',
         next_action_note = 'Picked up from the pool',
         closed_at = null,
         updated_at = now()
   where id = p_lead_id
     and pool is not null;

  if found then
    insert into crm.lead_events (lead_id, event_type, actor_id, payload)
    values (p_lead_id, 'claimed_from_pool', p_actor, '{}'::jsonb);
  end if;
end
$$;

grant execute on function crm.claim_parked_lead(uuid, uuid) to crm_app;
