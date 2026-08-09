-- 0024_auto_logout_and_open_chat.sql
--
-- Two floor reports.
--
-- 1. People forget to press End shift, so the floor shows them "receiving
--    leads" for hours after they left - and distribution keeps trying to hand
--    work to an empty chair. An hour with no activity now ends the shift
--    automatically, backdated to the last thing they actually did, so the
--    idle hour never counts as hours worked. The reason is recorded, so the
--    admin can tell a forgotten logout from a pressed one.
--
-- 2. Team chat was admin/ops-only by design ("the megaphone is deliberately
--    small"). The floor wants to answer back - so everyone may post, scoped
--    to their own team or the whole floor. Pinning stays admin-only.

alter table crm.attendance_sessions
  add column if not exists ended_reason text;

comment on column crm.attendance_sessions.ended_reason is
  'NULL for a logout the person pressed; auto_idle when the hour-of-silence
   engine ended it. The distinction is the admin''s evidence of who forgets.';

insert into crm.settings (key, value, description) values
  ('shift.auto_logout_idle_minutes', '60'::jsonb,
   'End an open shift after this many minutes with no calls and no lead activity. 0 disables it.')
on conflict (key) do nothing;

create or replace function crm.auto_logout_idle(p_limit int default 100)
  returns int
  language plpgsql
  security definer          -- same reason as every scheduled engine: run as
  set search_path = crm, public   -- the ops account it sees a fraction of the floor
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
       and s.started_at < now() - make_interval(mins => v_idle)
     limit p_limit
    for update skip locked
  loop
    -- Their last sign of life: the shift start, the last call they logged, or
    -- the last lead they opened - whichever is newest.
    select greatest(
             v_row.started_at,
             coalesce((select max(ca.started_at) from crm.call_attempts ca
                        where ca.user_id = v_row.user_id), v_row.started_at),
             coalesce((select max(al.accessed_at) from crm.lead_access_log al
                        where al.user_id = v_row.user_id), v_row.started_at))
      into v_last;

    continue when v_last > now() - make_interval(mins => v_idle);

    -- Backdated to the last activity: the silent hour is not hours worked,
    -- and requirement 6 depends on these minutes being honest.
    update crm.attendance_sessions
       set ended_at = greatest(v_last, started_at + interval '1 minute'),
           ended_reason = 'auto_idle'
     where id = v_row.id;
    v_n := v_n + 1;
  end loop;
  return v_n;
end
$$;

revoke all on function crm.auto_logout_idle(int) from public;
grant execute on function crm.auto_logout_idle(int) to crm_app;

-- Everyone may speak; where they may speak depends on who they are.
drop policy if exists team_messages_insert on crm.team_messages;
create policy team_messages_insert on crm.team_messages
  for insert with check (
    crm.current_user_role() in ('admin', 'ops')
    or (crm.current_user_id() is not null
        and (team_id is null or team_id = crm.current_user_team()))
  );
