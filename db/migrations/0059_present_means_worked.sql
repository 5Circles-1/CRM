-- 0059_present_means_worked.sql
--
-- The owner, reading the attendance tab: a mentor marked 50% present with
-- 0h00m ever logged, and the owner's own 4 Aug - one tap of Start shift,
-- nothing after it - counted as a day on the floor.
--
-- "Present" was any business date with any session at all. One press of
-- Start shift, even a forgotten one the stale-closer later trimmed to a
-- minute, earned the same attendance tick as a full nine-hour day. An
-- attendance percentage that can be farmed with one tap is not attendance.
--
-- From here a day counts as present only when real time was logged -
-- attendance.min_present_minutes, default 60 - or the person is on the
-- floor right now (today always counts while it is still being earned,
-- otherwise everyone reads absent at 09:35). Late days and full days are
-- counted over present days only, and the floor-day denominator applies
-- the same bar: a Sunday where one person tapped Start for a minute is
-- not a floor day held against everyone else.
--
-- Nothing is deleted or hidden: every session still shows in the day
-- lists exactly as it happened. Only the SUMMARY judgement changes.

insert into crm.settings (key, value, description) values
  ('attendance.min_present_minutes', '60'::jsonb,
   'Minimum minutes actually logged for a day to count as present in the attendance summary. A day still being worked (currently logged in) always counts.')
on conflict (key) do nothing;

create or replace view crm.v_attendance_summary as
with floor_days as (
  -- A floor day is a date somebody actually worked, by the same bar.
  select distinct ad.business_date
    from crm.v_attendance_day ad
   where ad.logged_minutes >= crm.setting_int('attendance.min_present_minutes', 60)
      or ad.currently_logged_in
),
per_user as (
  select
    ad.user_id,
    coalesce(
      min(ad.business_date) filter (where ad.logged_minutes >= crm.setting_int('attendance.min_present_minutes', 60)
                                       or ad.currently_logged_in),
      min(ad.business_date))                       as first_day,
    max(ad.business_date)                          as last_day,
    count(*) filter (where ad.logged_minutes >= crm.setting_int('attendance.min_present_minutes', 60)
                        or ad.currently_logged_in) as days_present,
    count(*) filter (where ad.is_late
                       and (ad.logged_minutes >= crm.setting_int('attendance.min_present_minutes', 60)
                            or ad.currently_logged_in)) as late_days,
    count(*) filter (where ad.met_hours)           as full_days,
    sum(ad.logged_minutes)::bigint                 as total_minutes,
    -- Averaged over days that COUNT: a farm of one-minute taps must not
    -- be allowed to drag a real average up or down.
    coalesce(round(sum(ad.logged_minutes)
             / nullif(count(*) filter (where ad.logged_minutes >= crm.setting_int('attendance.min_present_minutes', 60)
                                          or ad.currently_logged_in), 0)), 0)::int
                                                   as avg_minutes_per_day,
    bool_or(ad.currently_logged_in)                as currently_logged_in
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
  (select count(*) from floor_days fd
    where fd.business_date >= p.first_day)::int  as floor_days_since_joining,
  round(100.0 * p.days_present
        / nullif((select count(*) from floor_days fd
                   where fd.business_date >= p.first_day), 0), 1)
                                        as attendance_pct
from per_user p
join crm.users u on u.id = p.user_id;

comment on view crm.v_attendance_summary is
  'Attendance till date, one row per person. Present means worked: a day
   counts only above attendance.min_present_minutes of logged time (or while
   still on the floor), and the floor-day denominator holds the same bar.
   Sessions themselves are never hidden - only the judgement is honest.';

grant select on crm.v_attendance_summary to crm_app;
