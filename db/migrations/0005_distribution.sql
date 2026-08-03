-- 0005_distribution.sql
-- Requirement 1: leads from the Meta-connected Google Sheet are distributed
-- alternately between two teams, and alternately between the setters in a team.
--
-- DESIGN NOTE - why this is not a naive A-B-A-B counter.
--
-- Strict alternation breaks the first time someone is at lunch, in a meeting,
-- or logs in late: the cursor lands on them, they are skipped, and they are
-- permanently short of leads. Whoever takes the longest breaks quietly wins.
--
-- So the rule is: among callers who are actually on the floor right now,
-- assign to the one with the fewest leads today; break ties by rotation order.
-- When everyone is present and level this produces exactly A-B-A-B. When
-- someone steps away it self-corrects on their return, without a separate
-- credit ledger to drift out of sync.
--
-- The catch-up is bounded (distribution.max_catchup_leads) so a caller who
-- returns after a long absence is not buried under fifty consecutive leads.

insert into crm.settings (key, value, description) values
  ('distribution.max_catchup_leads', '5'::jsonb,
   'Largest lead deficit the balancer will try to correct at once, so a caller returning from an absence is not flooded.'),
  ('distribution.require_on_shift', 'true'::jsonb,
   'When true, leads are only assigned to callers currently logged in. Leads arriving off-hours are held at team level and assigned at shift start.');

create or replace function crm.setting_bool(p_key text, p_default boolean default false)
  returns boolean
  language sql stable
as $$
  select coalesce((select (value #>> '{}')::boolean from crm.settings where key = p_key), p_default)
$$;

-- ---------------------------------------------------------------------------
-- Rotation cursors. One row per rotation scope.
--   ('source', <source_id>) -> which team got the last lead from this source
--   ('team',   <team_id>)   -> which caller got the last lead in this team
-- ---------------------------------------------------------------------------

create table crm.distribution_cursors (
  scope_kind          text not null check (scope_kind in ('source', 'team')),
  scope_id            uuid not null,
  last_rotation_order int  not null default 0,
  updated_at          timestamptz not null default now(),
  primary key (scope_kind, scope_id)
);

-- ---------------------------------------------------------------------------
-- Every assignment decision is recorded, including who was passed over and
-- why. When a caller says "I'm not getting leads", this table answers it.
-- ---------------------------------------------------------------------------

create table crm.distribution_events (
  id          bigserial primary key,
  lead_id     uuid not null references crm.leads(id) on delete cascade,
  team_id     uuid references crm.teams(id) on delete set null,
  caller_id   uuid references crm.users(id) on delete set null,
  strategy    text not null,
  -- [{"user_id":"...","reason":"off_shift"}, ...]
  passed_over jsonb not null default '[]'::jsonb,
  decided_at  timestamptz not null default now()
);

create index distribution_events_lead_idx   on crm.distribution_events (lead_id);
create index distribution_events_caller_idx on crm.distribution_events (caller_id, decided_at desc);

-- ---------------------------------------------------------------------------
-- Eligible callers in a team, with the data the balancer needs.
-- ---------------------------------------------------------------------------

create or replace function crm.eligible_callers(p_team_id uuid)
  returns table (
    user_id        uuid,
    rotation_order int,
    load_today     int,
    on_shift       boolean
  )
  language sql stable
as $$
  select
    u.id,
    tm.rotation_order,
    (select count(*)::int
       from crm.leads l
      where l.caller_id = u.id
        and crm.ist_date(l.created_at) = crm.ist_date(now())),
    crm.is_on_shift(u.id)
  from crm.users u
  join crm.team_memberships tm
    on tm.user_id = u.id
   and tm.period @> current_date
  where tm.team_id = p_team_id
    and u.role = 'caller'
    and u.is_active
  order by tm.rotation_order
$$;

-- ---------------------------------------------------------------------------
-- Pick the next caller in a team.
-- Returns NULL when nobody on that team is available.
-- ---------------------------------------------------------------------------

create or replace function crm.next_caller_for_team(p_team_id uuid)
  returns table (caller_id uuid, passed_over jsonb)
  language plpgsql
as $$
declare
  v_require_shift boolean := crm.setting_bool('distribution.require_on_shift', true);
  v_max_catchup   int     := crm.setting_int('distribution.max_catchup_leads', 5);
  v_cursor        int;
  v_max_load      int;
  v_chosen        uuid;
  v_passed        jsonb := '[]'::jsonb;
begin
  -- Serialise concurrent assignment within this team only.
  perform pg_advisory_xact_lock(hashtext('crm.dist.team'), hashtext(p_team_id::text));

  insert into crm.distribution_cursors (scope_kind, scope_id)
  values ('team', p_team_id)
  on conflict do nothing;

  select last_rotation_order into v_cursor
    from crm.distribution_cursors
   where scope_kind = 'team' and scope_id = p_team_id
   for update;

  -- Record who is being passed over and why - this is what makes the
  -- distribution auditable rather than a black box.
  select coalesce(jsonb_agg(jsonb_build_object('user_id', ec.user_id, 'reason', 'off_shift')), '[]'::jsonb)
    into v_passed
    from crm.eligible_callers(p_team_id) ec
   where v_require_shift and not ec.on_shift;

  select max(ec.load_today) into v_max_load
    from crm.eligible_callers(p_team_id) ec
   where ec.on_shift or not v_require_shift;

  -- Least-loaded first, with the deficit clamped so catch-up is gradual;
  -- rotation order breaks ties, which is what produces A-B-A-B when level.
  select ec.user_id into v_chosen
    from crm.eligible_callers(p_team_id) ec
   where ec.on_shift or not v_require_shift
   order by
     greatest(ec.load_today, coalesce(v_max_load, 0) - v_max_catchup) asc,
     case when ec.rotation_order > v_cursor then 0 else 1 end asc,
     ec.rotation_order asc
   limit 1;

  if v_chosen is not null then
    update crm.distribution_cursors c
       set last_rotation_order = (
             select ec.rotation_order from crm.eligible_callers(p_team_id) ec
              where ec.user_id = v_chosen
           ),
           updated_at = now()
     where c.scope_kind = 'team' and c.scope_id = p_team_id;
  end if;

  return query select v_chosen, v_passed;
end
$$;

-- ---------------------------------------------------------------------------
-- Pick the next team for a source. Teams with nobody available are skipped so
-- a lead is never parked behind an empty team while the other has capacity.
-- ---------------------------------------------------------------------------

create or replace function crm.next_team_for_source(p_source_id uuid)
  returns uuid
  language plpgsql
as $$
declare
  v_pinned  uuid;
  v_cursor  int;
  v_chosen  uuid;
begin
  select pinned_team_id into v_pinned from crm.lead_sources where id = p_source_id;
  if v_pinned is not null then
    return v_pinned;
  end if;

  perform pg_advisory_xact_lock(hashtext('crm.dist.source'), hashtext(p_source_id::text));

  insert into crm.distribution_cursors (scope_kind, scope_id)
  values ('source', p_source_id)
  on conflict do nothing;

  select last_rotation_order into v_cursor
    from crm.distribution_cursors
   where scope_kind = 'source' and scope_id = p_source_id
   for update;

  -- Prefer a team that has someone on the floor; fall back to plain rotation
  -- so off-hours leads still land somewhere and wait for shift start.
  select t.id into v_chosen
    from crm.teams t
   where t.is_active
   order by
     case when exists (
       select 1 from crm.eligible_callers(t.id) ec where ec.on_shift
     ) then 0 else 1 end asc,
     case when t.rotation_order > v_cursor then 0 else 1 end asc,
     t.rotation_order asc
   limit 1;

  if v_chosen is not null then
    update crm.distribution_cursors c
       set last_rotation_order = (select rotation_order from crm.teams where id = v_chosen),
           updated_at = now()
     where c.scope_kind = 'source' and c.scope_id = p_source_id;
  end if;

  return v_chosen;
end
$$;

-- ---------------------------------------------------------------------------
-- Assign one lead end to end: team, caller, first-touch SLA, timeline entry.
-- Safe to call again on a lead whose caller went inactive.
-- ---------------------------------------------------------------------------

create or replace function crm.assign_lead(p_lead_id uuid)
  returns uuid
  language plpgsql
as $$
declare
  v_lead      crm.leads%rowtype;
  v_team      uuid;
  v_caller    uuid;
  v_passed    jsonb;
  v_sla_min   int;
  v_due       timestamptz;
begin
  select * into v_lead from crm.leads where id = p_lead_id for update;
  if not found then
    raise exception 'lead % not found', p_lead_id;
  end if;

  v_team := coalesce(v_lead.team_id, crm.next_team_for_source(v_lead.source_id));

  if v_team is not null then
    select nc.caller_id, nc.passed_over into v_caller, v_passed
      from crm.next_caller_for_team(v_team) nc;
  end if;

  v_sla_min := case v_lead.priority
                 when 'immediate' then crm.setting_int('sla.immediate_first_touch_minutes', 5)
                 else crm.setting_int('sla.normal_first_touch_minutes', 60)
               end;
  v_due := coalesce(v_lead.first_touch_due_at, now() + make_interval(mins => v_sla_min));

  update crm.leads
     set team_id            = v_team,
         caller_id          = coalesce(v_caller, caller_id),
         first_touch_due_at = v_due,
         -- An assigned lead is immediately in someone's day. Requirement 4.
         next_action_at     = coalesce(next_action_at, v_due),
         next_action_note   = coalesce(next_action_note, 'First contact'),
         status             = case when status = 'new' and v_caller is not null then 'working' else status end
   where id = p_lead_id;

  insert into crm.distribution_events (lead_id, team_id, caller_id, strategy, passed_over)
  values (
    p_lead_id, v_team, v_caller,
    case when v_caller is null then 'deferred_no_caller_available'
         else 'balanced_alternation' end,
    coalesce(v_passed, '[]'::jsonb)
  );

  insert into crm.lead_events (lead_id, event_type, actor_id, payload)
  values (
    p_lead_id,
    case when v_caller is null then 'assignment_deferred' else 'assigned' end,
    null,
    jsonb_build_object('team_id', v_team, 'caller_id', v_caller, 'due_at', v_due)
  );

  return v_caller;
end
$$;

comment on function crm.assign_lead(uuid) is
  'Assigns a lead to a team and caller and stamps its first-touch SLA. Returns NULL when no caller was available, in which case the lead is held at team level for assignment at shift start.';

-- ---------------------------------------------------------------------------
-- Sweep for leads held while nobody was on the floor. Run at shift start and
-- every few minutes thereafter.
-- ---------------------------------------------------------------------------

create or replace function crm.assign_pending_leads(p_limit int default 500)
  returns int
  language plpgsql
as $$
declare
  r      record;
  v_done int := 0;
begin
  for r in
    select id from crm.leads
     where caller_id is null
       and status in ('new', 'working')
     order by priority desc, created_at asc
     limit p_limit
  loop
    if crm.assign_lead(r.id) is not null then
      v_done := v_done + 1;
    end if;
  end loop;
  return v_done;
end
$$;
