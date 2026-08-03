-- 0002_org_users_teams.sql
-- Users, teams, and effective-dated team membership.
--
-- Membership is effective-dated rather than a plain FK on users because
-- performance history must stay attached to the team a person was in at the
-- time. If a caller moves from Team A to Team B in March, February's numbers
-- must still roll up under Team A.

create table crm.users (
  id              uuid primary key default gen_random_uuid(),
  full_name       text        not null check (length(trim(full_name)) > 0),
  email           citext      not null unique,
  phone           text,
  role            crm.user_role not null,
  employee_code   text unique,
  is_active       boolean     not null default true,
  deactivated_at  timestamptz,
  -- Personal SIM the caller dials from. Used to reconcile device call logs
  -- against CRM leads; see 0005.
  dialing_msisdn  text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  constraint users_deactivation_consistent
    check ((is_active and deactivated_at is null) or (not is_active and deactivated_at is not null))
);

create index users_role_active_idx on crm.users (role) where is_active;
create unique index users_dialing_msisdn_idx on crm.users (dialing_msisdn)
  where dialing_msisdn is not null and is_active;

create trigger users_set_updated_at
  before update on crm.users
  for each row execute function crm.tg_set_updated_at();

comment on column crm.users.dialing_msisdn is
  'The SIM number this caller dials from. Callers use personal handsets, so this is how device call logs are matched back to a CRM user.';

-- ---------------------------------------------------------------------------

create table crm.teams (
  id            uuid primary key default gen_random_uuid(),
  name          text not null unique check (length(trim(name)) > 0),
  code          text not null unique,
  -- Team-level rotation order for alternating lead distribution between teams.
  rotation_order int  not null,
  is_active     boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create unique index teams_rotation_order_idx on crm.teams (rotation_order) where is_active;

create trigger teams_set_updated_at
  before update on crm.teams
  for each row execute function crm.tg_set_updated_at();

-- ---------------------------------------------------------------------------
-- Effective-dated membership.
-- `period` is a daterange; the exclusion constraint guarantees a user is
-- never in two teams on the same day, which would double-count them in
-- every dashboard.
-- ---------------------------------------------------------------------------

create table crm.team_memberships (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references crm.users(id) on delete cascade,
  team_id        uuid not null references crm.teams(id) on delete restrict,
  -- Rotation slot within the team. Distribution alternates in this order.
  rotation_order int  not null,
  period         daterange not null default daterange(current_date, null, '[)'),
  created_at     timestamptz not null default now(),

  constraint team_memberships_no_overlap
    exclude using gist (user_id with =, period with &&)
);

create index team_memberships_team_idx on crm.team_memberships (team_id);
create index team_memberships_lookup_idx on crm.team_memberships using gist (user_id, period);

comment on constraint team_memberships_no_overlap on crm.team_memberships is
  'A person can only belong to one team on any given day - prevents double-counting in team rollups.';

-- Team of a user on a given date. Used by every historical rollup.
create or replace function crm.team_of(p_user_id uuid, p_on date default current_date)
  returns uuid
  language sql stable
as $$
  select tm.team_id
    from crm.team_memberships tm
   where tm.user_id = p_user_id
     and tm.period @> p_on
   limit 1
$$;

-- ---------------------------------------------------------------------------
-- Role lookup used by RLS policies.
-- SECURITY DEFINER so policies can read crm.users without recursing through
-- that table's own RLS.
-- ---------------------------------------------------------------------------

create or replace function crm.current_user_role() returns crm.user_role
  language sql stable security definer
  set search_path = crm, pg_temp
as $$
  select u.role from crm.users u where u.id = crm.current_user_id() and u.is_active
$$;

create or replace function crm.current_user_team() returns uuid
  language sql stable security definer
  set search_path = crm, pg_temp
as $$
  select crm.team_of(crm.current_user_id(), current_date)
$$;

-- True for roles that may see every lead regardless of ownership.
create or replace function crm.is_privileged() returns boolean
  language sql stable
as $$ select coalesce(crm.current_user_role() in ('admin', 'ops'), false) $$;

-- ---------------------------------------------------------------------------
-- Working shift. Requirement: 9 hours, 09:30-18:30 IST.
-- Stored as configuration rather than hardcoded so it can change without a
-- code deploy, and so per-team variation is possible later.
-- ---------------------------------------------------------------------------

create table crm.work_shifts (
  id               uuid primary key default gen_random_uuid(),
  name             text not null unique,
  team_id          uuid references crm.teams(id) on delete cascade,
  starts_at        time not null,
  ends_at          time not null,
  -- Expected logged-in minutes. 09:30-18:30 = 540.
  expected_minutes int  not null check (expected_minutes > 0),
  -- Grace before a login counts as late.
  late_grace_minutes int not null default 10 check (late_grace_minutes >= 0),
  is_active        boolean not null default true,
  created_at       timestamptz not null default now(),

  constraint work_shifts_span_valid check (ends_at > starts_at)
);

comment on table crm.work_shifts is
  'Shift definition driving attendance compliance. Default row is the 5C floor shift: 09:30-18:30 IST, 540 expected minutes.';
