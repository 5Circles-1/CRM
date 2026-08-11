-- 0026_performance_tiers.sql
--
-- Performance tiers for fresh-lead distribution: ACE / STANDARD / RESTRICTED.
--
-- ACE holds a guaranteed floor share of fresh leads (default 66.7%).
-- RESTRICTED receives ZERO fresh leads - but still receives internal
-- transfers, re-tap pool work and offline imports, which is deliberately the
-- road back: the exit metric is walk-in conversion, and conversions can be
-- earned on transferred and re-tapped leads just as well as on fresh ones.
--
-- No names in code. Tiers live in a table, default STANDARD, and are set
-- either by the nightly ranking or by an admin pin with a reason and expiry.
-- The founding decision that produced this system (a specific caller pinned
-- RESTRICTED) is data, entered by the admin, recorded in the audit log.

create table crm.performance_tiers (
  user_id     uuid primary key references crm.users(id) on delete cascade,
  tier        text not null default 'standard'
              check (tier in ('ace', 'standard', 'restricted')),
  -- Pinned = a human decision that outranks the nightly ranking until expiry.
  pinned_by   uuid references crm.users(id) on delete set null,
  pin_reason  text,
  pin_expires_at timestamptz,
  updated_at  timestamptz not null default now(),
  constraint tiers_pin_needs_reason
    check (pinned_by is null or pin_reason is not null)
);

alter table crm.performance_tiers enable row level security;
create policy tiers_read on crm.performance_tiers
  for select using (crm.current_user_id() is not null);
create policy tiers_admin_write on crm.performance_tiers
  for all using (crm.current_user_role() = 'admin')
  with check (crm.current_user_role() = 'admin');
grant select, insert, update on crm.performance_tiers to crm_app;

-- The audit trigger family covers who changed whose tier and to what.
create trigger performance_tiers_audit
  after insert or update or delete on crm.performance_tiers
  for each row execute function crm.tg_audit();

insert into crm.settings (key, value, description) values
  ('distribution.ace_share_pct', '66.7'::jsonb,
   'Share of a team''s fresh leads guaranteed to an ACE-tier caller when one is on the floor.')
on conflict (key) do nothing;

/**
 * A user's tier right now. An expired pin falls back to standard rather than
 * to the pinned value - a punishment (or a privilege) with a lapsed expiry
 * date must not outlive the decision.
 */
create or replace function crm.tier_of(p_user_id uuid) returns text
  language sql stable
as $$
  select coalesce((
    select case
             when t.pinned_by is not null
                  and (t.pin_expires_at is null or t.pin_expires_at > now())
               then t.tier
             when t.pinned_by is not null then 'standard'
             else t.tier
           end
      from crm.performance_tiers t
     where t.user_id = p_user_id), 'standard')
$$;

-- ---------------------------------------------------------------------------
-- The caller pick, tier-aware. Everything the old pick guaranteed survives:
-- the advisory lock, the pass-over audit trail, the catch-up clamp, rotation
-- tie-breaks. What changes: RESTRICTED users are excluded from fresh leads
-- outright, and when an ACE is on the floor the pick becomes deficit-based
-- against target shares, so the 66.7% is exact over the day, not approximate.
-- ---------------------------------------------------------------------------

create or replace function crm.next_caller_for_team(p_team_id uuid)
  returns table (caller_id uuid, passed_over jsonb)
  language plpgsql
as $$
declare
  v_require_shift boolean := crm.setting_bool('distribution.require_on_shift', true);
  v_max_catchup   int     := crm.setting_int('distribution.max_catchup_leads', 5);
  v_ace_share     numeric := crm.setting_num('distribution.ace_share_pct', 66.7) / 100.0;
  v_cursor        int;
  v_max_load      int;
  v_chosen        uuid;
  v_passed        jsonb := '[]'::jsonb;
  v_pool_n        int;
  v_ace_n         int;
  v_total         int;
begin
  perform pg_advisory_xact_lock(hashtext('crm.dist.team'), hashtext(p_team_id::text));

  insert into crm.distribution_cursors (scope_kind, scope_id)
  values ('team', p_team_id)
  on conflict do nothing;

  select last_rotation_order into v_cursor
    from crm.distribution_cursors
   where scope_kind = 'team' and scope_id = p_team_id
   for update;

  -- The pass-over record now names both reasons for exclusion.
  select coalesce(jsonb_agg(jsonb_build_object(
           'user_id', ec.user_id,
           'reason', case when crm.tier_of(ec.user_id) = 'restricted'
                          then 'restricted_excluded' else 'off_shift' end)), '[]'::jsonb)
    into v_passed
    from crm.eligible_callers(p_team_id) ec
   where (v_require_shift and not ec.on_shift)
      or crm.tier_of(ec.user_id) = 'restricted';

  select count(*) filter (where true),
         count(*) filter (where crm.tier_of(ec.user_id) = 'ace'),
         coalesce(sum(ec.load_today), 0)::int,
         max(ec.load_today)
    into v_pool_n, v_ace_n, v_total, v_max_load
    from crm.eligible_callers(p_team_id) ec
   where (ec.on_shift or not v_require_shift)
     and crm.tier_of(ec.user_id) <> 'restricted';

  if v_pool_n = 0 then
    -- Nobody eligible: the lead parks at team level (caller stays null), which
    -- is the existing hold-and-assign-at-shift-start behaviour. A RESTRICTED
    -- user alone on the floor changes nothing: parking beats mis-assigning.
    return query select null::uuid, v_passed;
    return;
  end if;

  if v_ace_n > 0 then
    -- Deficit pick: whoever is furthest below their target share of the day's
    -- (total + 1) leads gets this one. ACE targets v_ace_share of the whole;
    -- the remainder splits equally over the others. Exact, order-free, and
    -- self-correcting when someone arrives late.
    select ec.user_id into v_chosen
      from crm.eligible_callers(p_team_id) ec
     where (ec.on_shift or not v_require_shift)
       and crm.tier_of(ec.user_id) <> 'restricted'
     order by
       (case when crm.tier_of(ec.user_id) = 'ace'
             then v_ace_share / greatest(v_ace_n, 1)
             else (1 - v_ace_share) / greatest(v_pool_n - v_ace_n, 1) end)
         * (v_total + 1) - ec.load_today desc,
       case when ec.rotation_order > v_cursor then 0 else 1 end asc,
       ec.rotation_order asc
     limit 1;
  else
    -- No ACE on the floor: the original least-loaded-with-catch-up rule.
    select ec.user_id into v_chosen
      from crm.eligible_callers(p_team_id) ec
     where (ec.on_shift or not v_require_shift)
       and crm.tier_of(ec.user_id) <> 'restricted'
     order by
       greatest(ec.load_today, coalesce(v_max_load, 0) - v_max_catchup) asc,
       case when ec.rotation_order > v_cursor then 0 else 1 end asc,
       ec.rotation_order asc
     limit 1;
  end if;

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

-- The untouched-lead sweep must respect tiers too: passing a fresh, untouched
-- lead to a RESTRICTED caller would hand them fresh leads through the back
-- door. (Internal HUMAN transfers to them remain allowed - crm.transfer_lead
-- is a supervisory act and is deliberately not tier-filtered.)
-- The sweep's target query lives in crm.reassign_untouched_leads; rather than
-- restate the whole function, tighten eligible_callers' consumers via a
-- dedicated helper the sweep and future engines share:
create or replace function crm.fresh_lead_eligible(p_user_id uuid) returns boolean
  language sql stable
as $$
  select crm.tier_of(p_user_id) <> 'restricted'
$$;

create or replace function crm.reassign_untouched_leads(p_limit int default 200)
  returns int
  language plpgsql
  security definer
  set search_path = crm, public
as $$
declare
  v_minutes int := crm.setting_int('sla.untouched_reassign_minutes', 10);
  v_lead    record;
  v_target  uuid;
  v_full_circle boolean;
  v_moved   int := 0;
begin
  if v_minutes <= 0 then
    return 0;
  end if;

  for v_lead in
    select l.id, l.team_id, l.caller_id, l.original_caller_id, l.na_streak, l.attempt_count
      from crm.leads l
     where l.caller_id is not null
       and l.first_touched_at is null
       and l.attempt_count = 0
       and l.status in ('new', 'working')
       and crm.add_working_minutes(l.assigned_at, v_minutes) < now()
     order by l.assigned_at
     limit p_limit
    for update skip locked
  loop
    -- Someone on the floor who has not already had this lead. Everyone gets
    -- their own ten minutes before anybody gets a second turn.
    select ec.user_id into v_target
      from crm.eligible_callers(v_lead.team_id) ec
     where ec.on_shift
       and crm.fresh_lead_eligible(ec.user_id)   -- no fresh leads via the back door
       and ec.user_id <> v_lead.caller_id
       and not exists (
             select 1 from crm.lead_transfers t
              where t.lead_id = v_lead.id and t.to_caller_id = ec.user_id)
       and ec.user_id is distinct from v_lead.original_caller_id
     order by ec.rotation_order
     limit 1;

    v_full_circle := v_target is null;

    if v_full_circle then
      -- Everyone has had a turn. It goes back to the caller it started with,
      -- who owns it from here - there is nobody left to pass it to, and a lead
      -- circulating forever is how a pipeline leaks while looking busy.
      if v_lead.original_caller_id is null
         or v_lead.caller_id = v_lead.original_caller_id
         or not crm.is_on_shift(v_lead.original_caller_id) then
        continue;
      end if;
      v_target := v_lead.original_caller_id;
    end if;

    insert into crm.lead_transfers
      (lead_id, from_caller_id, to_caller_id, transferred_by, reason, note,
       is_automatic, na_streak_at_transfer, attempts_at_transfer)
    values
      (v_lead.id, v_lead.caller_id, v_target, null, 'caller_unavailable',
       case when v_full_circle
            then format('untouched by everyone - returned to the first caller after %s minutes each', v_minutes)
            else format('untouched for %s minutes', v_minutes) end,
       true, v_lead.na_streak, v_lead.attempt_count);

    update crm.leads
       set caller_id = v_target,
           transfer_count = transfer_count + 1,
           first_touch_due_at = crm.add_working_minutes(now(), v_minutes),
           next_action_at = least(coalesce(next_action_at, now()), now()),
           next_action_note = case when v_full_circle
             then 'Back with you - nobody else picked it up'
             else 'Reassigned - first contact still owed' end,
           updated_at = now()
     where id = v_lead.id;

    insert into crm.lead_events (lead_id, event_type, payload)
    values (v_lead.id, 'transferred',
            jsonb_build_object('automatic', true, 'from', v_lead.caller_id,
                               'to', v_target, 'after_minutes', v_minutes,
                               'returned_to_original', v_full_circle));

    v_moved := v_moved + 1;
  end loop;

  return v_moved;
end
$$;
