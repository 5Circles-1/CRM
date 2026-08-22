-- 0058_intake_alarm_resolves_itself.sql
--
-- The owner, on the intake alarm: "if the error is resolved that breach
-- should be removed. The alerts should not be such that they keep piling
-- up - they should rather be resolved, and say that the problem has been
-- resolved."
--
-- 0054 stopped the pile (an unread alarm is never duplicated) and made the
-- alarm name the source. This closes the loop: the same watchdog that
-- raises the alarm now also STANDS IT DOWN. When intake is healthy again -
-- leads flowing, every sheet source importing - any unread "Leads have
-- stopped arriving" is marked resolved and replaced by one green
-- notification saying so. Nobody has to clean up after an outage that
-- fixed itself, and a bell that shows an intake alarm is now always
-- showing a CURRENT problem.
--
-- The stand-down runs on every tick, shift hours or not: a problem may only
-- be announced while the floor is open, but its resolution is good news at
-- any hour.

create or replace function crm.check_lead_intake()
  returns int
  language plpgsql
  security definer
  set search_path = crm, public
as $$
declare
  v_quiet   int := crm.setting_int('intake.silence_alert_minutes', 120);
  v_since   int;
  v_bad     int;
  v_sent    int := 0;
  v_user    record;
  v_body    text;
  v_named   text;
  v_last    timestamptz;
begin
  select minutes_since_lead, sources_unhealthy into v_since, v_bad
    from crm.v_intake_summary;

  if coalesce(v_since, 999999) < v_quiet and coalesce(v_bad, 0) = 0 then
    -- Intake is healthy. Any alarm still ringing is about a solved problem:
    -- resolve it, and tell each person who was alarmed that it is over.
    for v_user in
      select distinct user_id from crm.notifications
       where kind = 'intake_stalled' and read_at is null
    loop
      update crm.notifications set read_at = now()
       where user_id = v_user.user_id and kind = 'intake_stalled' and read_at is null;
      insert into crm.notifications (user_id, kind, title, body)
      values (v_user.user_id, 'intake_recovered', 'Lead intake has recovered',
              'Leads are arriving again - the intake problem is resolved. '
              || 'The earlier alarms have been cleared automatically.');
    end loop;
    return 0;
  end if;

  -- A problem is only ANNOUNCED while the floor is open: silence at 3am is
  -- not news. (Resolution above runs at any hour.)
  if not crm.is_shift_time(now()) then return 0; end if;

  -- Name the source and say what is wrong with it, in the words the intake
  -- panel uses - "1 source(s) not importing" sent the reader hunting.
  select string_agg(
           source_name || ' (' || case state
             when 'not_shared'   then 'the sheet is not shared with the CRM'
             when 'failing'      then 'the last import failed'
             when 'never_run'    then 'it has never imported'
             when 'stale'        then 'the last import is overdue'
             when 'all_rejected' then 'every row is being rejected'
             else state
           end || ')', '; ' order by source_name)
    into v_named
    from crm.v_intake_health
   where state not in ('healthy', 'off', 'manual');

  v_body := case
    when v_named is not null then
      'Lead intake problem: ' || v_named || '. '
      || 'Check Floor - Lead intake for the fix.'
    else
      'No new lead has arrived for ' || coalesce(v_since, 0) || ' minutes. '
      || 'If the sheet is filling up, the importer has stopped - check Floor - Lead intake.'
  end;

  for v_user in
    select id from crm.users where is_active and role in ('admin', 'ops')
  loop
    -- One alarm per person per hour: an outage must nag, but not spam.
    select max(created_at) into v_last
      from crm.notifications
     where user_id = v_user.id and kind = 'intake_stalled';
    continue when v_last is not null and v_last > now() - interval '1 hour';

    -- And never a second copy of a message this person has not read yet.
    continue when exists (
      select 1 from crm.notifications
       where user_id = v_user.id and kind = 'intake_stalled'
         and read_at is null and body = v_body);

    insert into crm.notifications (user_id, kind, title, body)
    values (v_user.id, 'intake_stalled', 'Leads have stopped arriving', v_body);
    v_sent := v_sent + 1;
  end loop;

  return v_sent;
end
$$;

revoke all on function crm.check_lead_intake() from public;
grant execute on function crm.check_lead_intake() to crm_app;

comment on function crm.check_lead_intake is
  'The intake watchdog, both directions: raises a named admin alarm while the
   floor is open and intake is broken; stands every alarm down and announces
   the recovery the moment intake is healthy again. An intake alarm on the
   bell is therefore always a live problem, never history.';

-- The recovery note rings the same bell the alarm did - closure should be as
-- visible as the problem was.
update crm.settings
   set value = value || '["intake_recovered"]'::jsonb
 where key = 'alerts.bell_kinds'
   and not value ? 'intake_recovered';
