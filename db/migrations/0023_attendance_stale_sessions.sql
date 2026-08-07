-- 0023_attendance_stale_sessions.sql
--
-- The "shift time is not increasing" bug.
--
-- Attendance is modelled as sessions: Start shift opens one, End shift closes
-- it, and logged minutes are the sum of session lengths. A session that is
-- never closed - someone shuts the laptop lid without pressing End shift, or
-- the browser is killed - stays open forever. The next day, pressing Start
-- shift finds that still-open session and the login is refused ("already
-- logged in"), so NO session is created for today. Today's logged minutes then
-- sit at zero and never move, which is exactly what the floor reported.
--
-- The fix has two halves: close a session that has run past its own day, and
-- do it automatically both on the next login and on a nightly sweep.

-- ---------------------------------------------------------------------------
-- Close open sessions left running from a previous business day, crediting
-- them up to that day's shift end (never past it, never before they started).
-- ---------------------------------------------------------------------------

create or replace function crm.close_stale_sessions(p_user_id uuid default null)
  returns int
  language plpgsql
  security definer
  set search_path = crm, public
as $$
declare
  v_end   time := coalesce(
    (select ends_at from crm.work_shifts where is_active and team_id is null limit 1),
    time '18:30');
  v_count int;
begin
  with closed as (
    update crm.attendance_sessions s
       set ended_at = greatest(
             s.started_at + interval '1 minute',
             (s.business_date + v_end) at time zone 'Asia/Kolkata'
           ),
           auto_closed = true
     where s.ended_at is null
       and s.business_date < crm.ist_date(now())
       and (p_user_id is null or s.user_id = p_user_id)
    returning id
  )
  select count(*) into v_count from closed;
  return v_count;
end
$$;

comment on function crm.close_stale_sessions(uuid) is
  'Closes attendance sessions left open from a previous day, crediting them to
   that day''s shift end. Called on login (for the one user) and nightly (for
   everyone), so a forgotten End shift never blocks the next day''s Start shift.';

revoke all on function crm.close_stale_sessions(uuid) from public;
grant execute on function crm.close_stale_sessions(uuid) to crm_app;
