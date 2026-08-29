-- 0061_leave_is_not_a_demotion.sql
--
-- The owner: "one of my callers was on leave for 5 days but when she came
-- back, suddenly her leads stopped coming today - all the leads dropped into
-- [the other caller's] CRM."
--
-- That is exactly what 0051 was built to do, and it was wrong.
--
-- 0051 picks each team's ACE - who then holds distribution.ace_share_pct
-- (66.7%) of that team's fresh leads - by SUMMING seven completed calendar
-- days of work. Days off are rows of zeroes in v_person_performance, not
-- missing rows, so five days of approved leave is arithmetically identical
-- to five days of sitting at the desk doing nothing. The best caller on the
-- floor came back to a two-day total against a colleague's seven-day total,
-- lost the seat automatically, and with it two thirds of the fresh leads.
-- tier.min_dials_to_rank (20 dials IN THE WINDOW) then bolted the door: after
-- a week away she could not reach the threshold for days, so she could not
-- win the seat back even by out-working everyone.
--
-- Nobody did anything wrong and no screen said a word. That is the worst
-- kind of bug: a policy nobody chose, applied silently, to the person least
-- able to see it.
--
-- The rule from here - ranking judges RATE, over days actually worked:
--
--   1. A caller's window is the days they were PRESENT, not the days on the
--      calendar. Every component is divided by days present, so the ranking
--      compares "how good are they on a day they work", which is the thing
--      the owner actually meant by "the member who does the best calls".
--   2. tier.min_dials_to_rank keeps its name, its value and its meaning
--      ("dials over the window") but is measured at the person's own rate:
--      the bar is what they WOULD hit in a full window at the pace they
--      really worked. A quiet week still promotes no one; a short week no
--      longer disqualifies anyone.
--   3. The ranking only writes a tier for callers it actually MEASURED
--      (tier.min_days_to_rank present days, default 2). Someone away for the
--      whole window keeps the tier they earned - absence is not evidence.
--      An ACE returning from leave therefore returns AS the ACE, and the
--      first completed day back settles the seat on merit.
--   4. Expired admin pins are still cleared on every run, for everyone,
--      measured or not - 0026's contract does not depend on attendance.
--
-- And the silence is fixed too: v_lead_flow now carries each caller's tier
-- and their actual target share of today's fresh leads, so "why is she
-- getting nothing?" is answerable from the Floor screen instead of from a
-- migration file. It also finally names RESTRICTED as a flow status - a
-- restricted caller has been reading "receiving leads" while receiving none.

insert into crm.settings (key, value, description) values
  ('tier.min_days_to_rank', '2'::jsonb,
   'Days actually present in the window before the daily ranking will judge a caller at all. Below it their tier stands unchanged - leave, sick days and training days must never demote anyone.')
on conflict (key) do nothing;

update crm.settings
   set description = 'Dials a caller needs over a full window before they can be promoted to ACE, measured at the rate they actually worked (dials per present day x window). Below it, nobody is - a quiet week promotes no one, but a short week disqualifies no one.'
 where key = 'tier.min_dials_to_rank';

-- ---------------------------------------------------------------------------
-- Days a person actually worked, by the same bar the attendance tab uses
-- (0059): real logged time, or on the floor right now. A caller who dialled
-- worked, whatever attendance says - a forgotten Start shift is a clerical
-- slip, and this ranking must not turn a clerical slip into a pay cut.
-- ---------------------------------------------------------------------------
create or replace function crm.days_present(
  p_user_id uuid, p_from date, p_to date)   -- [p_from, p_to), completed days
  returns int
  language sql stable
as $$
  select count(*)::int from (
    select ad.business_date
      from crm.v_attendance_day ad
     where ad.user_id = p_user_id
       and ad.business_date >= p_from and ad.business_date < p_to
       and (ad.logged_minutes >= crm.setting_int('attendance.min_present_minutes', 60)
            or ad.currently_logged_in)
    union
    select crm.ist_date(ca.started_at)
      from crm.call_attempts ca
     where ca.user_id = p_user_id
       and crm.ist_date(ca.started_at) >= p_from
       and crm.ist_date(ca.started_at) <  p_to
  ) d
$$;

comment on function crm.days_present is
  'Business days in [from, to) on which this person actually worked: real
   logged time by attendance.min_present_minutes, or any dial recorded. The
   denominator every rate-based judgement of a person must divide by, so that
   a day off never reads as a day of doing nothing.';

grant execute on function crm.days_present(uuid, date, date) to crm_app;

-- ---------------------------------------------------------------------------
-- The daily ACE pick, on rates.
-- ---------------------------------------------------------------------------
create or replace function crm.rank_performance_tiers()
  returns int
  language plpgsql
  security definer
  set search_path = crm, public
as $$
declare
  v_window   int := crm.setting_int('tier.rank_window_days', 7);
  v_min      int := crm.setting_int('tier.min_dials_to_rank', 20);
  v_min_days int := crm.setting_int('tier.min_days_to_rank', 2);
  v_to       date := crm.ist_date(now());
  v_from     date := v_to - v_window;
  v_changed  int := 0;
begin
  -- An expired pin is a lapsed decision and is cleared whatever else happens,
  -- including for callers this run will not judge. tier_of() already reads an
  -- expired pin as standard; this is the row catching up with the truth.
  update crm.performance_tiers
     set tier = 'standard', pinned_by = null, pin_reason = null,
         pin_expires_at = null, updated_at = now()
   where pinned_by is not null
     and pin_expires_at is not null
     and pin_expires_at <= now();

  if not crm.setting_bool('tier.auto_rank', true) then
    return 0;
  end if;

  with w as (
    select crm.setting_num('leaderboard.weight_deals', 25)      as deals,
           crm.setting_num('leaderboard.weight_revenue', 25)    as revenue,
           crm.setting_num('leaderboard.weight_connects', 15)   as connects,
           crm.setting_num('leaderboard.weight_dials', 10)      as dials,
           crm.setting_num('leaderboard.weight_interested', 10) as interested,
           crm.setting_num('leaderboard.weight_walkins', 10)    as walkins,
           crm.setting_num('leaderboard.weight_talk', 5)        as talk
  ),
  -- Totals over the completed-day window, per current team, exactly as
  -- before - and beside them the number of days the person was actually
  -- there to earn them.
  sums as (
    select p.user_id,
           crm.team_of(p.user_id, current_date)  as team_id,
           sum(p.dials)::numeric        as dials,
           sum(p.connects)::numeric     as connects,
           sum(p.interested)::numeric   as interested,
           sum(p.walked_in)::numeric    as walked_in,
           sum(p.deals)::numeric        as deals,
           sum(p.revenue)::numeric      as revenue,
           sum(p.talk_seconds)::numeric as talk_seconds,
           crm.days_present(p.user_id, v_from, v_to) as days_present
      from crm.v_person_performance p
      join crm.users u on u.id = p.user_id and u.role = 'caller' and u.is_active
     where p.day >= v_from
       and p.day <  v_to
       and crm.team_of(p.user_id, current_date) is not null
     group by p.user_id
  ),
  -- THE FIX. Everything below this line compares per-working-day rates, so a
  -- caller who was there two days is measured against how a colleague works
  -- on a day - never against how much a colleague accumulated while she was
  -- on leave. Only callers with enough measured days are judged at all.
  rates as (
    select s.user_id, s.team_id, s.days_present,
           s.dials        / greatest(s.days_present, 1) as dials,
           s.connects     / greatest(s.days_present, 1) as connects,
           s.interested   / greatest(s.days_present, 1) as interested,
           s.walked_in    / greatest(s.days_present, 1) as walked_in,
           s.deals        / greatest(s.days_present, 1) as deals,
           s.revenue      / greatest(s.days_present, 1) as revenue,
           s.talk_seconds / greatest(s.days_present, 1) as talk_seconds
      from sums s
     where s.days_present >= greatest(v_min_days, 1)
  ),
  tops as (
    select team_id,
           max(dials) as dials, max(connects) as connects,
           max(interested) as interested, max(walked_in) as walked_in,
           max(deals) as deals, max(revenue) as revenue,
           max(talk_seconds) as talk_seconds
      from rates group by team_id
  ),
  -- The exact leaderboard formula the floor already sees as points and stars,
  -- normalised within the team. One formula everywhere, or "best" would mean
  -- different things on different screens.
  pts as (
    select r.user_id, r.team_id, r.dials,
             coalesce(r.deals        / nullif(t.deals, 0), 0)        * w.deals
           + coalesce(r.revenue      / nullif(t.revenue, 0), 0)      * w.revenue
           + coalesce(r.connects     / nullif(t.connects, 0), 0)     * w.connects
           + coalesce(r.dials        / nullif(t.dials, 0), 0)        * w.dials
           + coalesce(r.interested   / nullif(t.interested, 0), 0)   * w.interested
           + coalesce(r.walked_in    / nullif(t.walked_in, 0), 0)    * w.walkins
           + coalesce(r.talk_seconds / nullif(t.talk_seconds, 0), 0) * w.talk
           as points
      from rates r
      join tops t using (team_id)
      cross join w
  ),
  ranked as (
    select user_id, points, dials,
           rank() over (partition by team_id order by points desc) as rnk
      from pts
  ),
  decided as (
    select user_id,
           -- The dial floor at the person's own pace: what they would have
           -- dialled over a whole window working the way they actually did.
           case when rnk = 1 and points > 0 and dials * v_window >= v_min
                then 'ace' else 'standard' end as new_tier
      from ranked
  ),
  applied as (
    insert into crm.performance_tiers (user_id, tier, updated_at)
    select user_id, new_tier, now() from decided
    on conflict (user_id) do update
       set tier = excluded.tier,
           updated_at = now()
     -- A live pin still outranks the ranking. Expired ones were cleared above.
     where crm.performance_tiers.pinned_by is null
    returning 1
  )
  select count(*) into v_changed from applied;

  return v_changed;
end
$$;

comment on function crm.rank_performance_tiers() is
  'The daily ACE pick: each team''s best caller PER DAY PRESENT over the last
   completed days becomes ACE and holds distribution.ace_share_pct of fresh
   leads. Rates, never totals - a day of leave is not a day of doing nothing.
   A caller with fewer than tier.min_days_to_rank measured days is not judged
   and keeps the tier they earned. Live admin pins outrank it; expired pins
   are cleared for everyone; RESTRICTED is never set automatically. Runs on
   the scheduler; idempotent within a day because the window is completed
   days only.';

revoke all on function crm.rank_performance_tiers() from public;
grant execute on function crm.rank_performance_tiers() to crm_app;

-- ---------------------------------------------------------------------------
-- The share, on screen. A caller's target slice of their team's fresh leads
-- right now, computed by the same rule crm.next_caller_for_team applies when
-- it hands out the next lead - so the number on the Floor page is the number
-- the engine is actually using, not a second implementation that will drift.
-- ---------------------------------------------------------------------------
create or replace function crm.fresh_share_pct(p_user_id uuid)
  returns numeric
  language plpgsql stable
as $$
declare
  v_require_shift boolean := crm.setting_bool('distribution.require_on_shift', true);
  v_ace_share numeric := crm.setting_num('distribution.ace_share_pct', 66.7) / 100.0;
  v_team   uuid := crm.team_of(p_user_id, current_date);
  v_pool_n int;
  v_ace_n  int;
  v_mine   boolean;
begin
  if v_team is null or crm.tier_of(p_user_id) = 'restricted' then
    return 0;
  end if;

  select count(*), count(*) filter (where crm.tier_of(ec.user_id) = 'ace'),
         bool_or(ec.user_id = p_user_id)
    into v_pool_n, v_ace_n, v_mine
    from crm.eligible_callers(v_team) ec
   where (ec.on_shift or not v_require_shift)
     and crm.tier_of(ec.user_id) <> 'restricted';

  -- Off the floor is not a share of nothing, it is no share: the engine
  -- cannot pick them until they press Start shift.
  if not coalesce(v_mine, false) or coalesce(v_pool_n, 0) = 0 then
    return 0;
  end if;

  -- No ACE on the floor, or nobody BUT ACEs: either way the deficit targets
  -- are identical and rotation splits the leads evenly. Reporting 33.4% each
  -- to two ACEs alone on the floor would be arithmetic from the formula
  -- rather than a description of what the floor will actually see.
  if v_ace_n = 0 or v_ace_n = v_pool_n then
    return round(100.0 / v_pool_n, 1);
  elsif crm.tier_of(p_user_id) = 'ace' then
    return round(100.0 * v_ace_share / v_ace_n, 1);
  else
    return round(100.0 * (1 - v_ace_share) / (v_pool_n - v_ace_n), 1);
  end if;
end
$$;

comment on function crm.fresh_share_pct is
  'The share of their team''s fresh leads this caller is currently targeted
   for, by the same rule the distribution engine applies. 0 means the engine
   cannot reach them at all - off the floor, in no team, or RESTRICTED.';

grant execute on function crm.fresh_share_pct(uuid) to crm_app;

-- ---------------------------------------------------------------------------
-- Lead flow, with the two columns that would have answered the owner's
-- question in one glance, and a verdict that stops lying about RESTRICTED.
-- ---------------------------------------------------------------------------
create or replace view crm.v_lead_flow as
select
  u.id                                  as user_id,
  u.full_name,
  u.is_active,
  tm.team_id,
  t.name                                as team_name,
  tm.rotation_order,
  (tm.team_id is not null)              as has_team_today,
  crm.is_on_shift(u.id)                 as on_shift,
  -- Open book and today's intake.
  (select count(*) from crm.leads l
    where l.caller_id = u.id
      and l.status not in ('won','lost','invalid','nurture','handed_off')) as open_leads,
  (select count(*) from crm.leads l
    where l.caller_id = u.id
      and crm.ist_date(l.created_at) = crm.ist_date(now()))               as leads_today,
  -- The last time the engine handed this caller anything.
  (select max(de.decided_at) from crm.distribution_events de
    where de.caller_id = u.id)                                            as last_lead_at,
  -- How many times today the engine looked at this caller and moved on.
  (select count(*) from crm.distribution_events de
    where crm.ist_date(de.decided_at) = crm.ist_date(now())
      and de.passed_over @> jsonb_build_array(jsonb_build_object('user_id', u.id::text))) as passed_over_today,
  -- The one-line verdict the admin actually needs.
  case
    when not u.is_active         then 'inactive'
    when tm.team_id is null      then 'no_team'
    when crm.tier_of(u.id) = 'restricted' then 'restricted'
    when not crm.is_on_shift(u.id) then 'off_shift'
    else 'receiving'
  end                                   as flow_status,
  -- Appended, not inserted: CREATE OR REPLACE VIEW may only add columns at
  -- the end, and dropping this view would take the Floor page's whole panel
  -- down with it on a live deploy.
  crm.tier_of(u.id)                     as tier,
  crm.fresh_share_pct(u.id)             as fresh_share_pct,
  -- Days actually worked inside the ranking's own window: the number that
  -- decides whether the ranking is allowed to judge them today at all.
  crm.days_present(u.id,
                   crm.ist_date(now()) - crm.setting_int('tier.rank_window_days', 7),
                   crm.ist_date(now()))  as days_present_in_window
from crm.users u
left join crm.team_memberships tm
  on tm.user_id = u.id and tm.period @> current_date
left join crm.teams t on t.id = tm.team_id
where u.role = 'caller';

comment on view crm.v_lead_flow is
  'Distribution eligibility per caller, with the share each is actually
   targeted for. flow_status names the first rule that stops leads reaching
   them: inactive, no_team (not in any team today), restricted (barred from
   fresh leads by tier), off_shift (skipped while distribution.require_on_shift
   is true), or receiving. fresh_share_pct and tier exist because a share
   silently moving between callers is exactly the failure this view is for.';

grant select on crm.v_lead_flow to crm_app;

-- Re-run the pick now on the new rule, so the correction applies from the
-- very next distribution rather than the scheduler's next tick.
select crm.rank_performance_tiers();
