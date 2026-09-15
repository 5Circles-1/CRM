-- 0069_a_walk_in_is_counselled_and_answered_for.sql
--
-- The owner's rule (15 Sep): "There has to be a proper Office Visits to
-- Conversions Ratio - the counsellor needs to punch in the walk-in client or
-- just take it forward from the pipeline, which means the caller assigns the
-- walk-in to the counsellor, and once the counselling is done he feeds the
-- response."
--
-- Until now a walk-in was ONE NULLABLE TIMESTAMP on the lead
-- (leads.walked_in_at). That timestamp can say a visit happened. It cannot
-- say any of the four things the floor actually asks about a visit:
--
--   who sent them in          (the caller earns the walk-in, not the closer)
--   who sat with them         (the counsellor who did the counselling)
--   what was said at the desk (the response - converted, thinking, revisit)
--   what it was about         (the product discussed, converted or not)
--
-- Without those, "office visits to conversions" is not a ratio anyone can
-- compute: the numerator (deals) is per counsellor, the denominator
-- (walked_in_at) belongs to nobody, and a visit that ended in "come back with
-- your spouse" is indistinguishable from one that never happened.
--
-- So a visit becomes a row. crm.walkin_visits is the office desk's record:
-- one row per person who came in, moving expected -> arrived -> counselled,
-- with the counselling response recorded at the end of it.
--
-- Two entry doors, both of them the owner's words:
--
--   1. The CALLER assigns it from the pipeline. They booked the visit, so
--      they name the counsellor and the day. Row is born 'expected'.
--   2. The COUNSELLOR punches it in at the desk. Somebody walked through the
--      door, with or without a booking. Row is born 'arrived'.
--
-- Both leave `caller_id` pointing at whoever owned the lead when it was
-- booked, which is the one honest answer to "who called the maximum
-- walk-ins" - the closer must never be able to take that credit by being the
-- one who happened to greet them.
--
-- CONVERSION IS NEVER TYPED TWICE. The counsellor books the deal the way they
-- always have; a trigger on crm.deals finds that lead's open visit and marks
-- it converted, carrying the deal and its product across. A ratio computed
-- from hand-entered outcomes drifts from the money by the end of the first
-- week; this one cannot, because the deal IS the conversion.
--
-- leads.walked_in_at stays exactly where it is and keeps its meaning, set
-- from this table when a visit arrives. Every existing walk-in figure - the
-- Overview tile, the ticker, the daily brief, the leaderboard weight - keeps
-- reading the column it always read. This migration adds the detail behind
-- the number; it does not move the number.

-- ---------------------------------------------------------------------------
-- Settings. Every tunable number lives here, not in code.
-- ---------------------------------------------------------------------------
insert into crm.settings (key, value, description) values
  ('walkin.expected_window_hours', '12'::jsonb,
   'How long after its expected time a booked visit still counts as expected
    today rather than a no-show. The desk sees it for the whole day.'),
  ('walkin.counselling_due_minutes', '90'::jsonb,
   'How long a counsellor has to feed back the counselling response after the
    client arrives, before the visit is flagged as awaiting a response.'),
  ('walkin.monthly_target_per_caller', '10'::jsonb,
   'Default walk-ins a caller is expected to put in the office each month,
    used when no individual target is set for them.')
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- The visit itself.
-- ---------------------------------------------------------------------------
create table crm.walkin_visits (
  id            uuid primary key default gen_random_uuid(),
  lead_id       uuid not null references crm.leads(id) on delete cascade,
  team_id       uuid references crm.teams(id) on delete set null,

  -- Credit, split the way the floor splits it. caller_id is who put the
  -- client in the building; counsellor_id is who sat with them. assigned_by
  -- is whoever created the row, which is usually but not always the caller
  -- (a counsellor punching in a walk-off-the-street is assigned_by themself).
  caller_id     uuid references crm.users(id) on delete set null,
  counsellor_id uuid references crm.users(id) on delete set null,
  assigned_by   uuid references crm.users(id) on delete set null,

  status        text not null default 'expected'
    check (status in ('expected', 'arrived', 'counselled', 'no_show', 'cancelled')),

  expected_at   timestamptz,
  arrived_at    timestamptz,
  counselled_at timestamptz,

  -- The counselling response, in the counsellor's own terms. 'converted' is
  -- never typed by hand - the deal trigger below sets it - but it is a legal
  -- value so a historical import can carry one.
  outcome       text
    check (outcome in ('converted', 'thinking', 'revisit', 'not_interested',
                       'not_eligible', 'no_show')),
  -- What was discussed at the desk. Set from the deal on a conversion;
  -- chosen by the counsellor otherwise, so "which product does the office
  -- actually pitch" is answerable even for the visits that did not close.
  product_id    uuid references crm.products(id) on delete set null,
  deal_id       uuid references crm.deals(id) on delete set null,
  notes         text,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  -- A status is a claim about time; the timestamps have to back it up.
  constraint walkin_arrived_has_time
    check (status <> 'arrived' or arrived_at is not null),
  -- Deliberately silent about counsellor_id: every path that writes a
  -- response sets one (the function coalesces to the actor, the deal trigger
  -- to the closer), but a backfilled historical visit may honestly not know
  -- who sat with them, and inventing a name is worse than an empty column.
  constraint walkin_counselled_is_complete
    check (status <> 'counselled'
           or (arrived_at is not null and counselled_at is not null
               and outcome is not null)),
  constraint walkin_expected_has_a_time
    check (status <> 'expected' or expected_at is not null),
  constraint walkin_converted_has_a_deal
    check (outcome <> 'converted' or deal_id is not null)
);

-- One live visit per lead. A client who is expected or standing at the desk
-- cannot also be expected a second time; book the next visit after this one
-- is answered for.
create unique index walkin_visits_one_live_per_lead_idx
  on crm.walkin_visits (lead_id) where status in ('expected', 'arrived');

create index walkin_visits_counsellor_idx on crm.walkin_visits (counsellor_id, arrived_at desc);
create index walkin_visits_caller_idx     on crm.walkin_visits (caller_id, arrived_at desc);
create index walkin_visits_desk_idx       on crm.walkin_visits (status, expected_at)
  where status in ('expected', 'arrived');
create index walkin_visits_arrived_idx    on crm.walkin_visits (arrived_at desc)
  where arrived_at is not null;

create trigger walkin_visits_set_updated_at
  before update on crm.walkin_visits
  for each row execute function crm.tg_set_updated_at();

create trigger walkin_visits_audit
  after insert or update or delete on crm.walkin_visits
  for each row execute function crm.tg_audit();

comment on table crm.walkin_visits is
  'One row per office visit: who sent them in, who sat with them, what was
   said, and what it turned into. The denominator of the office-visits-to-
   conversions ratio. leads.walked_in_at remains the single "did they come
   in" flag and is kept in step by crm.tg_walkin_touches_lead.';

-- Lead-scoped, so lead visibility decides visit visibility - the same rule
-- as lead_events and call_attempts, in one place, not restated here.
alter table crm.walkin_visits enable row level security;

create policy walkin_visits_select on crm.walkin_visits
  for select using (crm.can_see_lead(lead_id));

create policy walkin_visits_insert on crm.walkin_visits
  for insert with check (crm.can_see_lead(lead_id));

create policy walkin_visits_update on crm.walkin_visits
  for update using (crm.can_see_lead(lead_id))
  with check (crm.can_see_lead(lead_id));

grant select, insert, update on crm.walkin_visits to crm_app;

-- ---------------------------------------------------------------------------
-- The visit keeps the lead in step.
--
-- Arriving sets leads.walked_in_at (so every existing walk-in figure keeps
-- working), clears the open promise, and hands the lead to the counsellor who
-- is about to sit with them - a client in the building is not a calling task.
-- ---------------------------------------------------------------------------
create or replace function crm.tg_walkin_touches_lead() returns trigger
  language plpgsql
as $$
begin
  if new.arrived_at is not null
     and (tg_op = 'INSERT' or old.arrived_at is distinct from new.arrived_at) then
    update crm.leads l
       set walked_in_at   = coalesce(l.walked_in_at, new.arrived_at),
           -- The counsellor at the desk owns it from here. Status only moves
           -- forward out of the calling stages: a won lead stays won.
           counsellor_id  = coalesce(new.counsellor_id, l.counsellor_id),
           status         = case
                              when l.status in ('new', 'working', 'callback', 'nurture')
                                then 'qualified'
                              else l.status
                            end,
           escalation_stage = case
                                when new.counsellor_id is not null then 'counsellor'
                                else l.escalation_stage
                              end,
           -- An open lead always has a next action (leads_open_requires_next
           -- _action). The counselling response is that action, and it is due
           -- now - somebody is sitting in front of them.
           next_action_at = case
                              when l.status in ('won', 'lost', 'invalid', 'handed_off')
                                then l.next_action_at
                              else greatest(now(), coalesce(l.next_action_at, now()))
                            end,
           next_action_note = case
                                when l.status in ('won', 'lost', 'invalid', 'handed_off')
                                  then l.next_action_note
                                else 'Walked in - record the counselling response'
                              end,
           updated_at = now()
     where l.id = new.lead_id;

    insert into crm.lead_events (lead_id, event_type, actor_id, payload)
    values (new.lead_id, 'walkin_arrived', new.counsellor_id,
            jsonb_build_object('visit_id', new.id,
                               'counsellor_id', new.counsellor_id,
                               'caller_id', new.caller_id));

  elsif tg_op = 'INSERT' and new.status = 'expected' then
    -- Booked, not yet arrived: the promise is the lead's, so the lead's own
    -- visit-promise machinery (0067) carries it and the green light holds.
    update crm.leads l
       set walkin_expected_at = new.expected_at,
           counsellor_id      = coalesce(l.counsellor_id, new.counsellor_id),
           updated_at         = now()
     where l.id = new.lead_id
       and l.status not in ('won', 'lost', 'invalid', 'handed_off');

    insert into crm.lead_events (lead_id, event_type, actor_id, payload)
    values (new.lead_id, 'walkin_assigned', new.assigned_by,
            jsonb_build_object('visit_id', new.id,
                               'counsellor_id', new.counsellor_id,
                               'expected_at', new.expected_at));
  end if;

  if tg_op = 'UPDATE' and new.status = 'counselled'
     and old.status is distinct from 'counselled' then
    insert into crm.lead_events (lead_id, event_type, actor_id, payload)
    values (new.lead_id, 'walkin_counselled', new.counsellor_id,
            jsonb_build_object('visit_id', new.id, 'outcome', new.outcome,
                               'product_id', new.product_id));
  end if;

  return new;
end
$$;

create trigger walkin_visits_touch_lead
  after insert or update on crm.walkin_visits
  for each row execute function crm.tg_walkin_touches_lead();

-- ---------------------------------------------------------------------------
-- A booked deal IS the conversion.
--
-- The counsellor books a deal exactly as before. If that lead has a visit
-- open or already counselled, this closes the loop on it: outcome
-- 'converted', the deal and its product carried across, and the counsellor
-- who booked it credited if nobody was recorded at the desk.
--
-- Runs AFTER INSERT on crm.deals, after crm.tg_deal_close_lead. Nothing about
-- the deal depends on a visit existing - a phone-only sale simply finds no
-- row and changes nothing.
-- ---------------------------------------------------------------------------
create or replace function crm.tg_deal_converts_walkin() returns trigger
  language plpgsql
as $$
declare
  v_visit uuid;
begin
  -- The most recent visit this lead actually MADE that has not already been
  -- credited to another deal. A revisit ("come back Friday") closes on the
  -- Friday visit, which is the one the ratio should count.
  select id into v_visit
    from crm.walkin_visits
   where lead_id = new.lead_id
     and deal_id is null
     and status in ('arrived', 'counselled')
   order by arrived_at desc
   limit 1;

  if v_visit is not null then
    update crm.walkin_visits
       set status        = 'counselled',
           outcome       = 'converted',
           deal_id       = new.id,
           product_id    = coalesce(product_id, new.product_id),
           counsellor_id = coalesce(counsellor_id, new.counsellor_id),
           counselled_at = coalesce(counselled_at, new.booked_at),
           updated_at    = now()
     where id = v_visit;
    return new;
  end if;

  -- Closed before they ever came in. The booked visit is not a conversion -
  -- counting it would inflate the office-visit denominator with a sale made
  -- on the phone - but it must not sit on the desk forever waiting for a
  -- client who no longer needs to come.
  update crm.walkin_visits
     set status     = 'cancelled',
         notes      = trim(both e'\n' from
                       coalesce(notes || e'\n', '')
                       || 'Closed before the visit - deal booked '
                       || to_char(new.booked_at at time zone 'Asia/Kolkata', 'DD Mon YYYY')),
         updated_at = now()
   where lead_id = new.lead_id and status = 'expected';

  return new;
end
$$;

create trigger deals_convert_walkin
  after insert on crm.deals
  for each row execute function crm.tg_deal_converts_walkin();

-- ---------------------------------------------------------------------------
-- The one row shape every walk-in screen reads.
--
-- The Office visits tab, the Overview ratios and any export all group THIS
-- view, so the funnel on one screen and the counsellor board on another
-- cannot disagree about what a conversion is. security_invoker, so RLS on
-- crm.leads scopes it: a caller sees the visits they generated, a counsellor
-- their team's, admin the floor's.
-- ---------------------------------------------------------------------------
create or replace view crm.v_walkin_visits as
select
  v.id                       as visit_id,
  v.lead_id,
  l.full_name,
  l.phone_e164,
  l.city,
  l.status                   as lead_status,
  v.team_id,
  t.name                     as team_name,
  v.caller_id,
  cu.full_name               as caller_name,
  v.counsellor_id,
  ku.full_name               as counsellor_name,
  v.assigned_by,
  au.full_name               as assigned_by_name,
  v.status,
  v.expected_at,
  v.arrived_at,
  v.counselled_at,
  v.outcome,
  coalesce(v.product_id, d.product_id)      as product_id,
  coalesce(p.name, dp.name)                 as product_name,
  v.deal_id,
  d.booked_amount,
  coalesce(pay.collected, 0)                as collected_amount,
  v.notes,
  v.created_at,
  -- coalesce, not a bare comparison: a visit with no outcome yet would
  -- otherwise be NULL here, and `where not is_converted` would silently drop
  -- exactly the visits that have not converted - the rows the ratio is about.
  coalesce(v.outcome = 'converted', false)  as is_converted,
  (v.arrived_at is not null)                as has_arrived,
  crm.ist_date(coalesce(v.arrived_at, v.expected_at, v.created_at)) as visit_date,
  -- Awaiting a response: they came in, they were not converted on the spot,
  -- and the counsellor has not fed back inside the allowed window. This is
  -- the only thing on the tab that is anybody's fault.
  (v.status = 'arrived'
   and v.arrived_at < now()
       - make_interval(mins => crm.setting_int('walkin.counselling_due_minutes', 90)))
                                            as response_overdue,
  crm.lead_green_reason(v.lead_id)          as green_reason
from crm.walkin_visits v
join crm.leads l          on l.id = v.lead_id
left join crm.teams t     on t.id = v.team_id
left join crm.users cu    on cu.id = v.caller_id
left join crm.users ku    on ku.id = v.counsellor_id
left join crm.users au    on au.id = v.assigned_by
left join crm.products p  on p.id = v.product_id
left join crm.deals d     on d.id = v.deal_id
left join crm.products dp on dp.id = d.product_id
left join lateral (
  select sum(amount) as collected from crm.payments pp where pp.deal_id = d.id
) pay on true;

alter view crm.v_walkin_visits set (security_invoker = true);
grant select on crm.v_walkin_visits to crm_app;

comment on view crm.v_walkin_visits is
  'One enriched row per office visit - who sent them, who counselled them,
   what was said, what it converted to. Every walk-in figure on every screen
   is an aggregate of this view, so the funnel, the counsellor board and the
   product board cannot drift apart.';

-- ---------------------------------------------------------------------------
-- The desk: what is happening in the office right now.
-- ---------------------------------------------------------------------------
create or replace view crm.v_walkin_desk as
select *
  from crm.v_walkin_visits
 where status in ('expected', 'arrived')
    or (status = 'counselled' and crm.ist_date(counselled_at) = crm.ist_date(now()));

alter view crm.v_walkin_desk set (security_invoker = true);
grant select on crm.v_walkin_desk to crm_app;

comment on view crm.v_walkin_desk is
  'Today''s office desk: everyone expected, everyone in the building, and
   everyone counselled today. What the Office visits tab opens on.';

-- ---------------------------------------------------------------------------
-- Punching in a walk-in, and answering for it. Both as functions, so the
-- authority rule lives in ONE place and the route just maps the SQLSTATE -
-- the same shape as crm.transfer_lead. Invoker rights on purpose: RLS must
-- still decide which leads this person can touch.
-- ---------------------------------------------------------------------------

create or replace function crm.assign_walkin(
  p_lead_id       uuid,
  p_counsellor_id uuid,
  p_expected_at   timestamptz,
  p_note          text default null
) returns uuid
  language plpgsql
as $$
declare
  v_actor  uuid := crm.current_user_id();
  v_lead   record;
  v_visit  uuid;
begin
  select id, caller_id, counsellor_id, team_id, status
    into v_lead
    from crm.leads where id = p_lead_id;

  if v_lead is null then
    raise exception 'no such lead, or it is not yours to see'
      using errcode = 'no_data_found';
  end if;

  if v_lead.status in ('won', 'lost', 'invalid', 'handed_off') then
    raise exception 'this lead is closed - a visit cannot be booked on it'
      using errcode = 'check_violation';
  end if;

  if p_expected_at is null then
    raise exception 'a walk-in needs the day they are coming in'
      using errcode = 'check_violation';
  end if;

  -- The counsellor must actually be a counsellor (or admin standing in).
  if not exists (select 1 from crm.users u
                  where u.id = p_counsellor_id
                    and u.role in ('counsellor', 'admin')
                    and u.is_active) then
    raise exception 'walk-ins are counselled by a counsellor'
      using errcode = 'check_violation';
  end if;

  insert into crm.walkin_visits
    (lead_id, team_id, caller_id, counsellor_id, assigned_by,
     status, expected_at, notes)
  values
    (p_lead_id, v_lead.team_id,
     -- Credit for the walk-in follows the lead's caller. A counsellor
     -- booking a visit on a lead they own themselves takes the credit
     -- honestly, because there is no caller to take it from.
     coalesce(v_lead.caller_id, v_actor),
     p_counsellor_id, v_actor, 'expected', p_expected_at, p_note)
  returning id into v_visit;

  return v_visit;
end
$$;

comment on function crm.assign_walkin(uuid, uuid, timestamptz, text) is
  'The caller''s door: book this lead in to see a counsellor on a named day.
   Credit for the walk-in stays with the lead''s caller. Invoker rights, so
   RLS decides whose leads may be booked.';

grant execute on function crm.assign_walkin(uuid, uuid, timestamptz, text) to crm_app;

create or replace function crm.record_walkin_arrival(
  p_lead_id       uuid,
  p_counsellor_id uuid default null,
  p_note          text default null
) returns uuid
  language plpgsql
as $$
declare
  v_actor uuid  := crm.current_user_id();
  v_role  text  := crm.current_user_role()::text;
  v_lead  record;
  v_visit uuid;
  v_cns   uuid;
begin
  select id, caller_id, counsellor_id, team_id, status
    into v_lead
    from crm.leads where id = p_lead_id;

  if v_lead is null then
    raise exception 'no such lead, or it is not yours to see'
      using errcode = 'no_data_found';
  end if;

  -- Whoever is at the desk, unless another counsellor is named. A caller
  -- cannot counsel, so a caller marking an arrival falls through to the lead's
  -- own counsellor and then to their team lead - the same default
  -- crm.transfer_lead and /leads/:id/qualify already use. Demanding a name
  -- from the caller would mean a client standing in reception while somebody
  -- works out who to put on the form.
  v_cns := coalesce(p_counsellor_id,
                    case when v_role in ('counsellor', 'admin') then v_actor end,
                    v_lead.counsellor_id,
                    (select u.id
                       from crm.team_memberships tm
                       join crm.users u on u.id = tm.user_id
                      where tm.team_id = v_lead.team_id
                        and tm.period @> current_date
                        and u.role = 'counsellor' and u.is_active
                      order by tm.rotation_order
                      limit 1));

  if v_cns is null then
    raise exception 'say which counsellor is taking this walk-in - this lead''s team has none'
      using errcode = 'check_violation';
  end if;

  -- An expected visit becomes the arrival rather than a second row; that is
  -- the whole point of booking it in advance.
  select id into v_visit
    from crm.walkin_visits
   where lead_id = p_lead_id and status = 'expected'
   order by expected_at limit 1;

  if v_visit is not null then
    update crm.walkin_visits
       set status        = 'arrived',
           arrived_at    = now(),
           counsellor_id = v_cns,
           notes         = coalesce(p_note, notes),
           updated_at    = now()
     where id = v_visit;
    return v_visit;
  end if;

  if exists (select 1 from crm.walkin_visits
              where lead_id = p_lead_id and status = 'arrived') then
    raise exception 'this client is already at the desk'
      using errcode = 'unique_violation';
  end if;

  insert into crm.walkin_visits
    (lead_id, team_id, caller_id, counsellor_id, assigned_by,
     status, arrived_at, notes)
  values
    (p_lead_id, v_lead.team_id, coalesce(v_lead.caller_id, v_actor),
     v_cns, v_actor, 'arrived', now(), p_note)
  returning id into v_visit;

  return v_visit;
end
$$;

comment on function crm.record_walkin_arrival(uuid, uuid, text) is
  'The counsellor''s door: this person is in the office now. Completes the
   booked visit if there is one rather than opening a second, so a booked
   client who turns up is one visit, not two.';

grant execute on function crm.record_walkin_arrival(uuid, uuid, text) to crm_app;

create or replace function crm.record_walkin_response(
  p_visit_id  uuid,
  p_outcome   text,
  p_product_id uuid default null,
  p_notes     text default null,
  p_next_action_at timestamptz default null
) returns crm.walkin_visits
  language plpgsql
as $$
declare
  v_actor uuid := crm.current_user_id();
  v_role  text := crm.current_user_role()::text;
  v_visit crm.walkin_visits;
begin
  select * into v_visit from crm.walkin_visits where id = p_visit_id;
  if v_visit is null then
    raise exception 'no such visit, or it is not yours to see'
      using errcode = 'no_data_found';
  end if;

  -- The counselling response is the counsellor's to give. A caller may book
  -- the visit and mark the arrival; what was said at the desk is not theirs
  -- to write, the same way a caller cannot transfer a lead.
  if v_role not in ('counsellor', 'admin') then
    raise exception 'only the counsellor who took the meeting records its response'
      using errcode = 'insufficient_privilege';
  end if;

  if v_visit.status = 'counselled' and v_visit.outcome = 'converted' then
    raise exception 'this visit converted - the deal is its response'
      using errcode = 'check_violation';
  end if;

  if p_outcome = 'converted' then
    raise exception 'book the deal - a conversion is recorded by the money, never by hand'
      using errcode = 'check_violation';
  end if;

  if p_outcome not in ('thinking', 'revisit', 'not_interested', 'not_eligible', 'no_show') then
    raise exception 'unknown counselling outcome: %', p_outcome
      using errcode = 'check_violation';
  end if;

  update crm.walkin_visits
     set status        = case when p_outcome = 'no_show' then 'no_show' else 'counselled' end,
         outcome       = p_outcome,
         product_id    = coalesce(p_product_id, product_id),
         notes         = coalesce(p_notes, notes),
         counsellor_id = coalesce(counsellor_id, v_actor),
         arrived_at    = case when p_outcome = 'no_show' then arrived_at
                              else coalesce(arrived_at, now()) end,
         counselled_at = case when p_outcome = 'no_show' then null else now() end,
         updated_at    = now()
   where id = p_visit_id
  returning * into v_visit;

  -- The lead keeps moving. "Thinking" and "revisit" are live leads with a
  -- date; "not interested" and "not eligible" close honestly. Nothing is
  -- left open without a next action - that guarantee holds here too.
  if p_outcome in ('not_interested', 'not_eligible') then
    update crm.leads
       set status = 'lost',
           lost_reason = 'Counselled in office: ' || p_outcome,
           closed_at = coalesce(closed_at, now()),
           next_action_at = null,
           next_action_note = 'Closed after counselling',
           updated_at = now()
     where id = v_visit.lead_id
       and status not in ('won', 'lost', 'invalid', 'handed_off');
  else
    update crm.leads
       set next_action_at = coalesce(p_next_action_at, now() + interval '1 day'),
           next_action_note = case p_outcome
             when 'revisit'  then 'Coming back in - counselling follow-up'
             when 'no_show'  then 'Did not come in - rebook the visit'
             else 'Thinking it over after counselling - follow up'
           end,
           walkin_expected_at = case
             when p_outcome = 'revisit' then coalesce(p_next_action_at, walkin_expected_at)
             else walkin_expected_at
           end,
           updated_at = now()
     where id = v_visit.lead_id
       and status not in ('won', 'lost', 'invalid', 'handed_off');
  end if;

  return v_visit;
end
$$;

comment on function crm.record_walkin_response(uuid, text, uuid, text, timestamptz) is
  'The counsellor feeds back what happened at the desk. A conversion is never
   typed here - booking the deal sets it, so the ratio and the money can never
   disagree. Refuses a caller with 42501, exactly like crm.transfer_lead.';

grant execute on function crm.record_walkin_response(uuid, text, uuid, text, timestamptz)
  to crm_app;

-- ---------------------------------------------------------------------------
-- Backfill. Every walk-in already recorded becomes a counselled visit, so
-- the ratio has history from the day this ships rather than starting at zero
-- and reading as a collapse in performance.
--
-- The outcome is what the lead actually did: won leads with a deal are
-- converted (deal and product carried across), everything else is recorded
-- as 'thinking' - the honest reading of "they came in and we have no record
-- of what was said".
--
-- The lead-touching trigger is off for the duration. This is bookkeeping
-- about visits that already happened, and it must not re-open closed leads,
-- re-stage live ones, or write a walkin_arrived event dated today for a visit
-- that happened in July.
-- ---------------------------------------------------------------------------
alter table crm.walkin_visits disable trigger walkin_visits_touch_lead;

insert into crm.walkin_visits
  (lead_id, team_id, caller_id, counsellor_id, assigned_by, status,
   expected_at, arrived_at, counselled_at, outcome, product_id, deal_id, notes,
   created_at)
select
  l.id, l.team_id, l.caller_id, l.counsellor_id, null, 'counselled',
  l.walkin_expected_at, l.walked_in_at,
  coalesce(d.booked_at, l.walked_in_at),
  case when d.id is not null then 'converted' else 'thinking' end,
  d.product_id, d.id,
  'Backfilled from the lead''s walk-in date when visits became rows (0069).',
  l.walked_in_at
from crm.leads l
left join lateral (
  select dd.id, dd.product_id, dd.booked_at
    from crm.deals dd
   where dd.lead_id = l.id and dd.status = 'booked'
   order by dd.booked_at limit 1
) d on true
where l.walked_in_at is not null;

alter table crm.walkin_visits enable trigger walkin_visits_touch_lead;

comment on column crm.walkin_visits.outcome is
  'What the counsellor said happened. ''converted'' is written by the deal
   trigger only - crm.record_walkin_response refuses it by hand.';

comment on column crm.walkin_visits.caller_id is
  'Who put this client in the building. Answers "who called the maximum
   walk-ins" - deliberately NOT the person who greeted them, so a counsellor
   at the desk cannot take a caller''s walk-in.';
