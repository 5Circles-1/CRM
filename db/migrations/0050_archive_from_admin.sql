-- 0050_archive_from_admin.sql
--
-- "Why are 10-day-old leads still waiting? I only want data from the 15th."
--
-- The answer used to be an SSH session and db/ops/archive-before.sql, which
-- means in practice it never happened. This turns the archive into a button:
-- an admin picks a date in Admin -> Data and everything older is PARKED into
-- the previous-months pool - out of every pipeline, alert and fresh list,
-- still searchable, one click from being picked back into work. Nothing is
-- deleted, matching the schema's rule that the application never destroys a
-- lead.
--
-- Deliberately untouched, whatever the date says:
--   - anyone with a deal (they are clients, not leads),
--   - anything worked since the cutoff (live conversations stay live).

create or replace function crm.archive_leads_before(
  p_cutoff  date,
  p_dry_run boolean default false
) returns int
  language plpgsql
  security definer
  set search_path = crm, public
as $$
declare
  v_role    text := crm.current_user_role();
  v_actor   uuid := crm.current_user_id();
  v_cut     timestamptz;
  v_count   int;
begin
  -- Definer rights see the whole book, so the door is guarded here, not in
  -- the API: parking the floor's data is an owner-level act.
  if v_role not in ('admin', 'ops') then
    raise exception 'only an admin may archive the lead book'
      using errcode = 'insufficient_privilege';
  end if;
  if p_cutoff is null or p_cutoff > current_date + 1 then
    raise exception 'the cutoff must be a real past date'
      using errcode = 'check_violation';
  end if;

  v_cut := (p_cutoff)::timestamp at time zone 'Asia/Kolkata';

  if p_dry_run then
    select count(*) into v_count
      from crm.leads l
     where l.created_at < v_cut
       and coalesce(l.last_contacted_at, l.created_at) < v_cut
       and l.status in ('new', 'working', 'callback', 'qualified', 'negotiation', 'nurture')
       and l.pool is distinct from 'previous_month'
       and not exists (select 1 from crm.deals d where d.lead_id = l.id);
    return v_count;
  end if;

  -- Park the leads and write each one's own "why I left the pipeline" line in
  -- the same statement, so the count, the rows and the history cannot drift.
  with parked as (
    update crm.leads l
       set status           = 'nurture',
           pool             = 'previous_month',
           next_action_at   = null,
           next_action_note = 'Archived - created before ' || to_char(p_cutoff, 'DD Mon YYYY'),
           reminder_at      = null,
           updated_at       = now()
     where l.created_at < v_cut
       and coalesce(l.last_contacted_at, l.created_at) < v_cut
       and l.status in ('new', 'working', 'callback', 'qualified', 'negotiation', 'nurture')
       and l.pool is distinct from 'previous_month'
       and not exists (select 1 from crm.deals d where d.lead_id = l.id)
     returning l.id
  ),
  noted as (
    insert into crm.lead_events (lead_id, event_type, actor_id, payload)
    select p.id, 'archived', v_actor, jsonb_build_object('cutoff', p_cutoff)
      from parked p
    returning 1
  )
  select count(*) into v_count from parked;

  -- A callback on a parked lead would keep ringing the bell forever. Cancel
  -- (never delete) every pending one across the previous-months pool.
  update crm.callbacks c
     set status = 'cancelled', updated_at = now()
   where c.status = 'pending'
     and exists (select 1 from crm.leads l
                  where l.id = c.lead_id and l.pool = 'previous_month');

  return v_count;
end
$$;

comment on function crm.archive_leads_before(date, boolean) is
  'Parks every undealt, unworked-since-cutoff lead created before the cutoff
   into the previous_month pool, stamping each lead''s history. Admin/ops
   only; dry_run counts without moving. The Admin -> Data button calls this;
   db/ops/archive-before.sql is the same act from psql.';

revoke all on function crm.archive_leads_before(date, boolean) from public;
grant execute on function crm.archive_leads_before(date, boolean) to crm_app;
