-- 0025_on_shift_means_today.sql
--
-- "On shift" now also means "today". is_on_shift() asked only whether an open
-- attendance session existed - so a Friday session nobody closed made its
-- owner look present on Sunday, and distribution handed a lead to the empty
-- chair at 15:03 while every dashboard said "off" (they count today's hours;
-- the engine counted open rows). The idle sweep would have caught it minutes
-- later, but presence should not depend on a sweep having run: a shift is 9
-- hours, so an open session from a previous IST date is definitionally stale.

create or replace function crm.is_on_shift(p_user_id uuid) returns boolean
  language sql stable
as $$
  select exists (
    select 1 from crm.attendance_sessions s
     where s.user_id = p_user_id
       and s.ended_at is null
       and crm.ist_date(s.started_at) = crm.ist_date(now())
  )
$$;
