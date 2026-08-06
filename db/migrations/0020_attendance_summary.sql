-- 0020_attendance_summary.sql
--
-- "Don't just show today's login - show overall attendance and time logged
-- till date." One row per person, since their first recorded day.
--
-- The attendance RATE needs a denominator, and a holiday calendar is exactly
-- the kind of side-table that drifts. So the denominator is observed, not
-- configured: a "floor day" is any business date on which anyone at all was
-- logged in. Sundays and office holidays never appear, so they are never held
-- against anybody; a day the whole floor worked and one person missed is.

create or replace view crm.v_attendance_summary as
with floor_days as (
  select distinct business_date from crm.attendance_sessions
),
per_user as (
  select
    ad.user_id,
    min(ad.business_date)                        as first_day,
    max(ad.business_date)                        as last_day,
    count(*)                                     as days_present,
    count(*) filter (where ad.is_late)           as late_days,
    count(*) filter (where ad.met_hours)         as full_days,
    sum(ad.logged_minutes)::bigint               as total_minutes,
    round(avg(ad.logged_minutes))::int           as avg_minutes_per_day,
    bool_or(ad.currently_logged_in)              as currently_logged_in
  from crm.v_attendance_day ad
  group by ad.user_id
)
select
  u.id                                  as user_id,
  u.full_name,
  u.role,
  u.is_active,
  crm.team_of(u.id, current_date)       as team_id,
  p.first_day,
  p.last_day,
  p.days_present,
  p.late_days,
  p.full_days,
  p.total_minutes,
  p.avg_minutes_per_day,
  p.currently_logged_in,
  -- Floor days since this person's first day: the fair denominator.
  (select count(*) from floor_days fd
    where fd.business_date >= p.first_day)::int  as floor_days_since_joining,
  round(100.0 * p.days_present
        / nullif((select count(*) from floor_days fd
                   where fd.business_date >= p.first_day), 0), 1)
                                        as attendance_pct
from per_user p
join crm.users u on u.id = p.user_id;

comment on view crm.v_attendance_summary is
  'Attendance till date, one row per person: days present against the floor
   days since they joined, total and average minutes, 9h-met days, late days.';

grant select on crm.v_attendance_summary to crm_app;
