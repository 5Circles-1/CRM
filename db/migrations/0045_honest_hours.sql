-- 0045_honest_hours.sql
--
-- "How come Mahi's logged hours are abnormally high when she was absent?"
--
-- Because a shift that nobody ended never stopped counting. An attendance
-- session ends three ways: the person presses End shift, the hour-of-silence
-- engine closes it (crm.auto_logout_idle - which only runs when the API's
-- background jobs are enabled, i.e. SERVICE_USER_ID is set), or never.
-- In the "never" case two things compound:
--
--   1. v_attendance_day counted an open session as started_at -> now(),
--      accruing 24 hours per day INCLUDING the days the person was absent.
--   2. The person could not press Start shift on their return ("already
--      logged in"), so their present days were never even recorded - which
--      is why the inflated people are exactly the ones with missing days:
--      few sessions, each spanning days. When they finally pressed End
--      shift, a five-day session was written down as one enormous "day".
--
-- Three layers of fix, so the number is honest even if every other layer
-- fails:
--
--   a. The view caps every session at the end of its own business day.
--      No session can ever contribute more than the day it belongs to.
--   b. Stale shifts (open, from a previous day) are closed honestly - at
--      the person's last recorded action that day, capped at midnight IST -
--      by a function called from the scheduler AND at the moment the person
--      next presses Start shift, so a fresh day always starts clean.
--   c. The damage already in the table is repaired the same way, including
--      sessions that were eventually closed by hand days later.

-- ---------------------------------------------------------------------------
-- a. The view: a session never outlives its own business day.
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
  max(least(coalesce(s.ended_at, now()),
            ((s.business_date + 1)::timestamp) at time zone 'Asia/Kolkata'))
                                                     as last_activity_at,
  count(*)                                           as session_count,
  count(*) filter (where s.auto_closed)              as auto_closed_count,
  -- Total time actually logged in, in minutes. An open or wrongly-long
  -- session is capped at its own day's midnight IST: hours can only be
  -- earned on the day they belong to.
  round(sum(
    extract(epoch from (least(coalesce(s.ended_at, now()),
                              ((s.business_date + 1)::timestamp) at time zone 'Asia/Kolkata')
                        - s.started_at))
  ) / 60.0)::int                                     as logged_minutes,
  sh.expected_minutes,
  greatest(
    sh.expected_minutes - round(sum(
      extract(epoch from (least(coalesce(s.ended_at, now()),
                                ((s.business_date + 1)::timestamp) at time zone 'Asia/Kolkata')
                          - s.started_at))
    ) / 60.0)::int,
    0
  )                                                  as shortfall_minutes,
  -- Late if the first login is after shift start + grace.
  ((min(s.started_at) at time zone 'Asia/Kolkata')::time
     > (sh.starts_at + make_interval(mins => sh.late_grace_minutes)))
                                                     as is_late,
  round(sum(
    extract(epoch from (least(coalesce(s.ended_at, now()),
                              ((s.business_date + 1)::timestamp) at time zone 'Asia/Kolkata')
                        - s.started_at))
  ) / 60.0)::int >= sh.expected_minutes              as met_hours,
  bool_or(s.ended_at is null)                        as currently_logged_in
from crm.attendance_sessions s
join crm.users u on u.id = s.user_id
cross join shift sh
group by s.user_id, u.full_name, u.role, s.business_date, sh.expected_minutes,
         sh.starts_at, sh.late_grace_minutes;

-- Re-assert the posture 0012 gave it: CREATE OR REPLACE does not reliably
-- carry reloptions, and this view must keep running as the caller.
alter view crm.v_attendance_day set (security_invoker = true);
grant select on crm.v_attendance_day to crm_app;

comment on view crm.v_attendance_day is
  'Requirement 6: one row per person per business day. Every session is
   capped at its own day''s midnight IST, so a forgotten End shift can never
   accrue hours across absent days.';

-- ---------------------------------------------------------------------------
-- b. Closing a stale shift honestly: at the last thing the person actually
--    did that day, capped at that day's midnight, floored at one minute.
-- ---------------------------------------------------------------------------
create or replace function crm.close_stale_shifts(p_user_id uuid default null)
  returns int
  language plpgsql
  security definer
  set search_path = crm, public
as $$
declare
  v_row  record;
  v_cap  timestamptz;
  v_last timestamptz;
  v_n    int := 0;
begin
  for v_row in
    select id, user_id, started_at, business_date
      from crm.attendance_sessions
     where ended_at is null
       and business_date < crm.ist_date(now())
       and (p_user_id is null or user_id = p_user_id)
     for update skip locked
  loop
    v_cap := ((v_row.business_date + 1)::timestamp) at time zone 'Asia/Kolkata';
    select greatest(
             v_row.started_at,
             coalesce((select max(ca.started_at) from crm.call_attempts ca
                        where ca.user_id = v_row.user_id and ca.started_at < v_cap),
                      v_row.started_at),
             coalesce((select max(al.accessed_at) from crm.lead_access_log al
                        where al.user_id = v_row.user_id and al.accessed_at < v_cap),
                      v_row.started_at))
      into v_last;

    update crm.attendance_sessions
       set ended_at = least(greatest(v_last, started_at + interval '1 minute'), v_cap),
           ended_reason = coalesce(ended_reason, 'stale_shift_closed')
     where id = v_row.id;
    v_n := v_n + 1;
  end loop;
  return v_n;
end
$$;

revoke all on function crm.close_stale_shifts(uuid) from public;
grant execute on function crm.close_stale_shifts(uuid) to crm_app;

comment on function crm.close_stale_shifts is
  'Ends any open shift left over from a previous day, at the person''s last
   recorded action that day (capped at midnight IST, floored at one minute).
   Called by the scheduler and by Start shift itself, so a new day always
   begins clean even when background jobs are down.';

-- The idle engine now owns only TODAY's sessions; older ones belong to
-- close_stale_shifts, whose day-capping is correct for them. Without this
-- guard, an engine waking after downtime would close a days-old session at
-- the person's activity from a completely different day.
create or replace function crm.auto_logout_idle(p_limit int default 100)
  returns int
  language plpgsql
  security definer
  set search_path = crm, public
as $$
declare
  v_idle int := crm.setting_int('shift.auto_logout_idle_minutes', 60);
  v_row  record;
  v_last timestamptz;
  v_n    int := 0;
begin
  if v_idle <= 0 then return 0; end if;

  for v_row in
    select s.id, s.user_id, s.started_at
      from crm.attendance_sessions s
     where s.ended_at is null
       and s.business_date = crm.ist_date(now())
       and s.started_at < now() - make_interval(mins => v_idle)
     limit p_limit
    for update skip locked
  loop
    select greatest(
             v_row.started_at,
             coalesce((select max(ca.started_at) from crm.call_attempts ca
                        where ca.user_id = v_row.user_id), v_row.started_at),
             coalesce((select max(al.accessed_at) from crm.lead_access_log al
                        where al.user_id = v_row.user_id), v_row.started_at))
      into v_last;

    continue when v_last > now() - make_interval(mins => v_idle);

    update crm.attendance_sessions
       set ended_at = greatest(v_last, started_at + interval '1 minute'),
           ended_reason = 'auto_idle'
     where id = v_row.id;
    v_n := v_n + 1;
  end loop;
  return v_n;
end
$$;

-- ---------------------------------------------------------------------------
-- c. Repair what already happened: sessions closed days after their own
--    business day (the five-day "Monday End shift" case), then any still
--    hanging open from previous days.
-- ---------------------------------------------------------------------------
do $$
declare
  v_row  record;
  v_cap  timestamptz;
  v_last timestamptz;
  v_n    int := 0;
begin
  for v_row in
    select id, user_id, started_at, business_date
      from crm.attendance_sessions
     where ended_at is not null
       and ended_at > ((business_date + 1)::timestamp) at time zone 'Asia/Kolkata'
  loop
    v_cap := ((v_row.business_date + 1)::timestamp) at time zone 'Asia/Kolkata';
    select greatest(
             v_row.started_at,
             coalesce((select max(ca.started_at) from crm.call_attempts ca
                        where ca.user_id = v_row.user_id and ca.started_at < v_cap),
                      v_row.started_at),
             coalesce((select max(al.accessed_at) from crm.lead_access_log al
                        where al.user_id = v_row.user_id and al.accessed_at < v_cap),
                      v_row.started_at))
      into v_last;

    update crm.attendance_sessions
       set ended_at = least(greatest(v_last, v_row.started_at + interval '1 minute'), v_cap),
           ended_reason = 'stale_repaired'
     where id = v_row.id;
    v_n := v_n + 1;
  end loop;
  raise notice 'multi-day attendance sessions repaired: %', v_n;
  raise notice 'stale open shifts closed: %', crm.close_stale_shifts(null);
end $$;
