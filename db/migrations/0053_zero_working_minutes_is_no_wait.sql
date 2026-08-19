-- 0053_zero_working_minutes_is_no_wait.sql
--
-- Adding nothing must move nothing.
--
-- crm.add_working_minutes(t, 0) did not return t: the loop first drags an
-- out-of-hours timestamp forward to the next working start, THEN adds the
-- minutes. With a positive number that is exactly right - a deadline may only
-- fall while the floor is open. With zero it invents a wait nobody asked for.
--
-- Where it bit, every single morning: v_fresh_leads flags a never-contacted
-- lead by comparing now() against
--
--     add_working_minutes(first_touch_due_at, fresh.flag_after_minutes)   -- 0
--
-- A lead whose deadline passed at 06:24 had that read as 09:30, so between
-- midnight and the floor opening it reported "waiting" - on the exact screen
-- the team checks while deciding who to ring first, in the exact window they
-- are arriving. The lead was late; the page said it was fine.
--
-- The body below is the LIVE definition (0028, lunch-freeze aware) with the
-- guard added. Reproducing 0023's older body instead would have silently
-- un-done the freeze - which is why the freeze tests are the ones that catch
-- it.

create or replace function crm.add_working_minutes(p_from timestamptz, p_minutes int)
  returns timestamptz
  language plpgsql
  stable
as $fn$
declare
  v_start int := crm.setting_int('shift.day_start_minutes', 570);
  v_end   int := crm.setting_int('shift.day_end_minutes', 1110);
  v_fz0   int := crm.setting_int('freeze.start_minutes', 840);
  v_fz1   int := crm.setting_int('freeze.end_minutes', 870);
  v_local timestamp := p_from at time zone 'Asia/Kolkata';
  v_day   date;
  v_mow   int;
  v_left  int := greatest(coalesce(p_minutes, 0), 0);
  v_cap   int;
begin
  -- Zero is identity. Rolling an out-of-hours moment forward here would be
  -- answering a question nobody asked: "when does this instant fall" rather
  -- than "what is this instant plus nothing".
  if v_left = 0 then
    return p_from;
  end if;
  loop
    v_day := v_local::date;
    if extract(dow from v_day) = 0 then
      v_local := (v_day + 1) + make_interval(mins => v_start);
      continue;
    end if;
    v_mow := extract(hour from v_local)::int * 60 + extract(minute from v_local)::int;
    if v_mow < v_start then
      v_local := v_day + make_interval(mins => v_start);
      v_mow := v_start;
    elsif v_mow >= v_end then
      v_local := (v_day + 1) + make_interval(mins => v_start);
      continue;
    elsif v_mow >= v_fz0 and v_mow < v_fz1 then
      v_local := v_day + make_interval(mins => v_fz1);
      v_mow := v_fz1;
    end if;
    -- Capacity until the next boundary: the freeze start if it is ahead of
    -- us today, otherwise the end of day.
    v_cap := (case when v_mow < v_fz0 and v_fz0 < v_end then v_fz0 else v_end end) - v_mow;
    if v_left <= v_cap then
      return (v_local + make_interval(mins => v_left)) at time zone 'Asia/Kolkata';
    end if;
    v_left := v_left - v_cap;
    if v_mow < v_fz0 and v_fz0 < v_end then
      v_local := v_day + make_interval(mins => v_fz1);   -- hop the freeze
    else
      v_local := (v_day + 1) + make_interval(mins => v_start);
    end if;
  end loop;
end
$fn$;

comment on function crm.add_working_minutes(timestamptz, int) is
  'The SLA clock. Counts minutes only Mon-Sat 09:30-18:30 IST and never during
   the lunch freeze, so a deadline it produces can only fall - and only be
   missed - while the floor is open. Zero minutes returns the moment
   unchanged: adding nothing moves nothing.';
