-- 0055_inbound_calls.sql
--
-- The owner: "add an option for the Inbound Calls which will be entered
-- manually by the team whoever receives that call from either of the team.
-- These Inbound Calls are of the Highest Quality which I don't want to skip
-- at any chance so proper follow up's here also with the dates should be
-- there."
--
-- An inbound call is a client who dialled the office themselves - the
-- warmest lead the floor ever sees. Three things follow:
--
--   1. WHOEVER answered enters it - including a caller. The "callers cannot
--      create leads" guarantee (0039) protected fair distribution from
--      self-created queue-jumping; an inbound call a caller personally
--      answered is not that. A caller logging one keeps it, always - they
--      cannot route it anywhere else, so the fairness engine is untouched.
--   2. It is IMMEDIATE priority by construction, from its own source, so
--      every screen shows where it came from and no report buries it.
--   3. The follow-up is a real date the client heard on the phone. It is
--      required, it becomes the lead's next action, AND it becomes a pending
--      callback - the one kind of appointment that rings the bell and pops
--      up (0052). Missing it is made loud, which is what "never skip" means
--      mechanically.
--
-- The person who answered has already spoken to the client, so the lead is
-- born first-touched: it never sits in the "never called" bucket pretending
-- to be colder than it is, and its clock is the follow-up promise.

insert into crm.lead_sources (id, name, default_priority)
values ('33333333-0000-0000-0000-000000000004', 'Inbound call', 'immediate')
on conflict (id) do nothing;

-- The 6-argument form is replaced by one function with two more optional
-- parameters; dropping first keeps a single unambiguous signature.
drop function if exists crm.add_manual_lead(text, text, text, crm.lead_priority, uuid, text);

create or replace function crm.add_manual_lead(
  p_full_name   text,
  p_phone       text,
  p_city        text default null,
  p_priority    crm.lead_priority default 'normal',
  p_assign_to   uuid default null,        -- a specific person; null = fair distribution
  p_note        text default null,
  p_kind        text default 'manual',    -- 'manual' | 'inbound'
  p_followup_at timestamptz default null  -- inbound: the date the client was promised
) returns uuid
  language plpgsql
  security definer
  set search_path = crm, public
as $$
declare
  v_role   crm.user_role := crm.current_user_role();
  v_me     uuid := crm.current_user_id();
  v_phone  text;
  v_dupe   record;
  v_lead   uuid;
  v_team   uuid;
  v_owner_role crm.user_role;
  v_as_counsellor boolean := false;
begin
  if p_kind not in ('manual', 'inbound') then
    raise exception 'unknown lead kind %', p_kind using errcode = 'check_violation';
  end if;

  -- Who may pull the lever. A caller may log ONLY an inbound call, and only
  -- to themselves: the phone rang, they answered, the lead is theirs. Hand
  -- entry of anything else stays admin/ops/counsellor, exactly as before.
  if v_role in ('admin', 'ops', 'counsellor') then
    null;
  elsif v_role = 'caller' and p_kind = 'inbound' then
    if p_assign_to is not null and p_assign_to <> v_me then
      raise exception 'a caller logs an inbound call to themselves - transfers are the counsellor''s call'
        using errcode = 'insufficient_privilege';
    end if;
    p_assign_to := v_me;
  else
    raise exception 'only an admin, ops or counsellor may add a lead by hand'
      using errcode = 'insufficient_privilege';
  end if;

  if p_kind = 'inbound' then
    -- Highest quality, by decree: an inbound call is never a normal-priority
    -- row someone works "later".
    p_priority := 'immediate';
    if p_followup_at is null then
      raise exception 'an inbound call needs a follow-up date - the client was told when we would call'
        using errcode = 'check_violation';
    end if;
    if p_followup_at < now() - interval '5 minutes' then
      raise exception 'the follow-up date has already passed - pick when the client should actually hear from us'
        using errcode = 'check_violation';
    end if;
  end if;

  v_phone := crm.normalise_phone(p_phone);
  if v_phone is null then
    raise exception 'that phone number is not dialable' using errcode = 'check_violation';
  end if;

  select l.id, l.status, u.full_name as owner
    into v_dupe
    from crm.leads l
    left join crm.users u on u.id = coalesce(l.caller_id, l.counsellor_id)
   where l.phone_e164 = v_phone
   order by l.created_at desc
   limit 1;

  if found then
    raise exception 'this number is already in the book (status: %, with %) - open it from Find lead instead of re-entering it',
      v_dupe.status, coalesce(v_dupe.owner, 'no owner yet')
      using errcode = 'unique_violation';
  end if;

  if p_assign_to is not null then
    -- The target may be a caller - or, for an inbound call, a counsellor:
    -- "whoever receives that call" includes the team leads, who keep what
    -- they answered in their own queue rather than re-dialling a client
    -- they just spoke to.
    select u.role, tm.team_id into v_owner_role, v_team
      from crm.users u
      join crm.team_memberships tm
        on tm.user_id = u.id and tm.period @> current_date
     where u.id = p_assign_to and u.is_active
     limit 1;

    if v_team is null
       or v_owner_role not in ('caller', 'counsellor')
       or (v_owner_role = 'counsellor' and p_kind <> 'inbound') then
      raise exception 'leads can only be assigned to an active caller on a team%',
        case when p_kind = 'inbound' then ' (or, for an inbound call, a counsellor)' else '' end
        using errcode = 'check_violation';
    end if;
    v_as_counsellor := (v_owner_role = 'counsellor');
  end if;

  insert into crm.leads (source_id, full_name, phone_e164, city, priority,
                         team_id,
                         caller_id, counsellor_id, escalation_stage,
                         status,
                         first_touched_at, last_contacted_at,
                         next_action_at, next_action_note)
  values (case when p_kind = 'inbound'
               then '33333333-0000-0000-0000-000000000004'::uuid
               else '33333333-0000-0000-0000-000000000003'::uuid end,
          nullif(trim(p_full_name), ''), v_phone, nullif(trim(p_city), ''),
          p_priority, v_team,
          case when v_as_counsellor then null else p_assign_to end,
          case when v_as_counsellor then p_assign_to end,
          (case when v_as_counsellor then 'counsellor' else 'caller' end)::text,
          (case when p_assign_to is null then 'new' else 'working' end)::crm.lead_status,
          -- The inbound client has already been spoken to - by the person
          -- logging it. Born first-touched, so it never masquerades as
          -- "never called" and the follow-up promise is its real clock.
          case when p_kind = 'inbound' then now() end,
          case when p_kind = 'inbound' then now() end,
          case when p_kind = 'inbound' then p_followup_at end,
          coalesce(p_note, case when p_kind = 'inbound'
                                then 'Inbound call - follow up as promised'
                                else 'First contact' end))
  returning id into v_lead;

  insert into crm.lead_events (lead_id, event_type, actor_id, payload)
  values (v_lead, 'manual_lead_added', v_me,
          jsonb_build_object('assigned_to', p_assign_to, 'priority', p_priority,
                             'kind', p_kind, 'followup_at', p_followup_at,
                             'note', p_note));

  -- No specific person named: the same fair-distribution engine as every
  -- sheet lead, so hand entry is never a way to jump the queue.
  if p_assign_to is null then
    perform crm.assign_lead(v_lead);
  end if;

  -- The promise the client heard becomes a pending callback for whoever now
  -- owns the lead. Callbacks are what ring the bell and pop up (0052) and
  -- what the callback-expiry engine chases - the loudest machinery the CRM
  -- has, which is exactly what "never skip an inbound call" needs.
  if p_kind = 'inbound' then
    insert into crm.callbacks (lead_id, created_by, assigned_to, scheduled_at, note)
    select v_lead, v_me, coalesce(l.counsellor_id, l.caller_id), p_followup_at,
           coalesce(p_note, 'Inbound call - client is expecting us')
      from crm.leads l
     where l.id = v_lead
       and coalesce(l.counsellor_id, l.caller_id) is not null;
  end if;

  return v_lead;
end
$$;

revoke all on function crm.add_manual_lead(text, text, text, crm.lead_priority, uuid, text, text, timestamptz) from public;
grant execute on function crm.add_manual_lead(text, text, text, crm.lead_priority, uuid, text, text, timestamptz) to crm_app;

comment on function crm.add_manual_lead is
  'One lead entered by hand: walk-past, referral - or an inbound call, the
   highest-quality lead there is. Inbound calls may be logged by whoever
   answered (a caller logs only to themselves), are always immediate
   priority, are born first-touched, and carry a mandatory follow-up date
   that is also a pending callback so it rings when due.';
