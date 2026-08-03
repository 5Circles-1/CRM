-- 0004_attendance.sql
-- Requirement 6: a 9-hour login (09:30-18:30 IST) must be visible on the dashboard.
--
-- Modelled as sessions rather than a single login/logout pair, because the real
-- pattern is login, lunch, logout, re-login. Total logged minutes is the sum of
-- session durations, not last_logout - first_login.

create table crm.attendance_sessions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references crm.users(id) on delete cascade,
  business_date date not null,
  started_at  timestamptz not null default now(),
  ended_at    timestamptz,
  source      crm.attendance_source not null default 'web',
  -- Set when the session was closed by the nightly job rather than by the user
  -- actually logging out. These are visible on the dashboard as "not logged out".
  auto_closed boolean not null default false,
  ip_address  inet,
  user_agent  text,
  note        text,
  created_at  timestamptz not null default now(),

  constraint attendance_sessions_span_valid
    check (ended_at is null or ended_at > started_at),

  -- A user cannot be logged in twice at once; that would inflate hours.
  constraint attendance_sessions_no_overlap
    exclude using gist (
      user_id with =,
      tstzrange(started_at, coalesce(ended_at, 'infinity'::timestamptz)) with &&
    )
);

create index attendance_sessions_user_date_idx
  on crm.attendance_sessions (user_id, business_date);
create index attendance_sessions_open_idx
  on crm.attendance_sessions (user_id) where ended_at is null;

comment on constraint attendance_sessions_no_overlap on crm.attendance_sessions is
  'Prevents double-counted hours from a user logged in on two devices.';

-- business_date is derived from the IST start time, never supplied by the client.
create or replace function crm.tg_attendance_business_date() returns trigger
  language plpgsql
as $$
begin
  new.business_date := crm.ist_date(new.started_at);
  return new;
end
$$;

create trigger attendance_sessions_set_business_date
  before insert or update of started_at on crm.attendance_sessions
  for each row execute function crm.tg_attendance_business_date();

-- ---------------------------------------------------------------------------
-- Is this user on the floor right now? Distribution uses this so leads are not
-- handed to someone who has gone home.
-- ---------------------------------------------------------------------------

create or replace function crm.is_on_shift(p_user_id uuid) returns boolean
  language sql stable
as $$
  select exists (
    select 1 from crm.attendance_sessions s
     where s.user_id = p_user_id
       and s.ended_at is null
  )
$$;

-- ---------------------------------------------------------------------------
-- Per-user, per-day attendance rollup.
-- ---------------------------------------------------------------------------

create or replace view crm.v_attendance_day as
with shift as (
  select
    coalesce(
      (select ws.starts_at from crm.work_shifts ws where ws.is_active and ws.team_id is null limit 1),
      time '09:30'
    ) as starts_at,
    coalesce(
      (select ws.ends_at from crm.work_shifts ws where ws.is_active and ws.team_id is null limit 1),
      time '18:30'
    ) as ends_at,
    coalesce(
      (select ws.late_grace_minutes from crm.work_shifts ws where ws.is_active and ws.team_id is null limit 1),
      10
    ) as late_grace_minutes,
    crm.setting_int('attendance.expected_minutes', 540) as expected_minutes
)
select
  s.user_id,
  u.full_name,
  u.role,
  crm.team_of(s.user_id, s.business_date) as team_id,
  s.business_date,
  min(s.started_at)                                  as first_login_at,
  max(coalesce(s.ended_at, now()))                   as last_activity_at,
  count(*)                                           as session_count,
  count(*) filter (where s.auto_closed)              as auto_closed_count,
  -- Total time actually logged in, in minutes.
  round(sum(
    extract(epoch from (coalesce(s.ended_at, now()) - s.started_at))
  ) / 60.0)::int                                     as logged_minutes,
  sh.expected_minutes,
  greatest(
    sh.expected_minutes - round(sum(
      extract(epoch from (coalesce(s.ended_at, now()) - s.started_at))
    ) / 60.0)::int,
    0
  )                                                  as shortfall_minutes,
  -- Late if the first login is after shift start + grace.
  ((min(s.started_at) at time zone 'Asia/Kolkata')::time
     > (sh.starts_at + make_interval(mins => sh.late_grace_minutes)))
                                                     as is_late,
  (round(sum(
    extract(epoch from (coalesce(s.ended_at, now()) - s.started_at))
  ) / 60.0)::int >= sh.expected_minutes)             as met_hours,
  bool_or(s.ended_at is null)                        as currently_logged_in
from crm.attendance_sessions s
join crm.users u on u.id = s.user_id
cross join shift sh
group by s.user_id, u.full_name, u.role, s.business_date,
         sh.expected_minutes, sh.starts_at, sh.late_grace_minutes;

comment on view crm.v_attendance_day is
  'Requirement 6. One row per user per business day: logged minutes against the 540-minute expectation, lateness, and whether they are on the floor now.';
