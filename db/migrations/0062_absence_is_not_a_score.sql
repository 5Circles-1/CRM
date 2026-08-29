-- 0062_absence_is_not_a_score.sql
--
-- The owner, after 0061: "in case a caller remains absent that should not
-- affect the ranking, because if they do not log into the CRM they are not
-- receiving any leads."
--
-- Exactly right, and 0061 only fixed one of the three places it was wrong.
-- The rule is now stated once and applied everywhere:
--
--     A day nobody worked is not a bad day. It is not a day.
--
-- Where it was still broken:
--
--   1. THE LEADERBOARD (/performance/overall - "Overall standings" on the
--      Floor page, and the star rating). Ranked on summed totals over the
--      window, so a week's leave dropped a caller down the board for the
--      same arithmetic reason 0061 fixed in the ACE pick. Worse, the two
--      now disagreed: the ACE seat was decided on rate while the board the
--      floor reads was decided on volume, and CLAUDE.md's own rule is that
--      "best" must not mean different things on different screens.
--
--   2. THE DAILY SCORE. crm.snapshot_scores() writes a row for every active
--      caller and counsellor every day. Four caller components - dials,
--      connect rate, talk time, qualification - are deliberately ALWAYS
--      applicable, so that doing none of them scores zero rather than
--      nothing. On a day the person was not there, that is the wrong
--      answer: it recorded a hard 0 out of 100. Five days of leave put five
--      zeroes into the seven-day rolling average on the caller's own My
--      Score page, which is Requirement 7 - the screen that exists for
--      self-reflection - and into every trend built on it.
--
--   3. TWO DEFINITIONS OF "PRESENT". 0061 introduced one inside
--      crm.days_present(). This migration lifts it out into a single
--      primitive both it and the score use, so presence cannot drift.
--
-- What this does NOT change: the volume trophies (Most calls, Most revenue)
-- stay on raw totals. "Most calls this month" meaning most calls is a fact,
-- not a ranking, and nobody's leads depend on it.

-- ---------------------------------------------------------------------------
-- 1. One definition of "present", and only one.
--
-- SECURITY DEFINER on purpose. Presence is already floor-wide readable (the
-- attendance RLS policy says so in as many words) and this returns a single
-- boolean - but the "or they dialled" arm reads call_attempts, which IS
-- row-restricted. Left as invoker-rights, a counsellor asking whether a
-- team-mate worked on Tuesday would get a different answer than an admin
-- asking the same question, and a denominator that changes with who is
-- looking is not a denominator.
-- ---------------------------------------------------------------------------
create or replace function crm.was_present(p_user_id uuid, p_date date)
  returns boolean
  language sql stable
  security definer
  set search_path = crm, public
as $$
  select
    -- Real logged time, by the same bar the attendance tab uses (0059) - or
    -- on the floor right now, because today is still being earned.
    exists (
      select 1 from crm.v_attendance_day ad
       where ad.user_id = p_user_id and ad.business_date = p_date
         and (ad.logged_minutes >= crm.setting_int('attendance.min_present_minutes', 60)
              or ad.currently_logged_in)
    )
    -- Or they did the job, whatever the attendance row says. A forgotten
    -- Start shift is a clerical slip; it must never read as a day off.
    or exists (
      select 1 from crm.call_attempts ca
       where ca.user_id = p_user_id and crm.ist_date(ca.started_at) = p_date
    )
    or exists (
      select 1 from crm.deals d
       where d.counsellor_id = p_user_id and crm.ist_date(d.booked_at) = p_date
    )
$$;

comment on function crm.was_present is
  'Did this person work on this business day? Real logged time above
   attendance.min_present_minutes (or on the floor right now), or any dial,
   or any deal they closed. The single definition of presence: every rate,
   average and ranking divides by days that pass this test, so that a day off
   never reads as a day of doing nothing.';

grant execute on function crm.was_present(uuid, date) to crm_app;

-- Redefined on top of the primitive - same answer, one source.
create or replace function crm.days_present(
  p_user_id uuid, p_from date, p_to date)   -- [p_from, p_to)
  returns int
  language sql stable
  security definer
  set search_path = crm, public
as $$
  select count(*)::int
    from generate_series(p_from, p_to - 1, interval '1 day') d
   where crm.was_present(p_user_id, d::date)
$$;

grant execute on function crm.days_present(uuid, date, date) to crm_app;

-- ---------------------------------------------------------------------------
-- 2. One standings formula, used by every screen that ranks people.
--
-- Deliberately INVOKER rights. crm.v_person_performance decides whose numbers
-- the asker may see - a caller sees only themselves, a counsellor their team,
-- an admin everyone - and that must keep working. Called from inside a
-- SECURITY DEFINER engine (the ACE pick) it sees the whole floor, which is
-- what that engine needs; called from a route it sees exactly what the
-- requester is allowed to. One function, correct in both.
-- ---------------------------------------------------------------------------
create or replace function crm.rate_standings(
  p_days          int,
  p_scope         text    default 'floor',   -- 'floor' | 'team'
  p_include_today boolean default true,
  p_roles         text[]  default array['caller', 'counsellor'],
  p_min_days      int     default 1          -- measured days before we judge
) returns table (
  user_id       uuid,
  full_name     text,
  role          crm.user_role,
  team_id       uuid,
  days_present  int,
  dials         bigint,
  connects      bigint,
  interested    bigint,
  walked_in     bigint,
  deals         bigint,
  revenue       numeric,
  talk_seconds  bigint,
  dials_per_day numeric,
  points        numeric,
  rank          int
)
language sql stable
as $$
  with bounds as (
    select
      case when p_include_today then crm.ist_date(now()) - p_days + 1
           else crm.ist_date(now()) - p_days end                as d_from,
      case when p_include_today then crm.ist_date(now()) + 1
           else crm.ist_date(now()) end                         as d_to
  ),
  w as (
    select crm.setting_num('leaderboard.weight_deals', 25)      as deals,
           crm.setting_num('leaderboard.weight_revenue', 25)    as revenue,
           crm.setting_num('leaderboard.weight_connects', 15)   as connects,
           crm.setting_num('leaderboard.weight_dials', 10)      as dials,
           crm.setting_num('leaderboard.weight_interested', 10) as interested,
           crm.setting_num('leaderboard.weight_walkins', 10)    as walkins,
           crm.setting_num('leaderboard.weight_talk', 5)        as talk
  ),
  sums as (
    select p.user_id, p.full_name, p.role,
           crm.team_of(p.user_id, current_date)  as team_id,
           sum(p.dials)::bigint        as dials,
           sum(p.connects)::bigint     as connects,
           sum(p.interested)::bigint   as interested,
           sum(p.walked_in)::bigint    as walked_in,
           sum(p.deals)::bigint        as deals,
           sum(p.revenue)::numeric     as revenue,
           sum(p.talk_seconds)::bigint as talk_seconds,
           crm.days_present(p.user_id, b.d_from, b.d_to) as days_present
      from crm.v_person_performance p
      cross join bounds b
     where p.day >= b.d_from and p.day < b.d_to
       and p.role::text = any (p_roles)
     group by p.user_id, p.full_name, p.role, b.d_from, b.d_to
    having sum(p.dials) > 0 or sum(p.deals) > 0 or sum(p.walked_in) > 0
  ),
  -- Judge nobody the window did not measure. Below the bar the row is not
  -- ranked LAST, it is not ranked at all - being ranked last for being on
  -- leave is the whole bug.
  eligible as (
    select * from sums s
     where s.days_present >= greatest(p_min_days, 1)
       and (p_scope <> 'team' or s.team_id is not null)
  ),
  -- THE FIX, in one word: per day. Every component is divided by the days
  -- the person was actually there to earn it, so the comparison is "how good
  -- are they on a day they work" rather than "how much did they accumulate
  -- while a colleague was away".
  rates as (
    select e.*,
           e.dials::numeric        / greatest(e.days_present, 1) as r_dials,
           e.connects::numeric     / greatest(e.days_present, 1) as r_connects,
           e.interested::numeric   / greatest(e.days_present, 1) as r_interested,
           e.walked_in::numeric    / greatest(e.days_present, 1) as r_walked_in,
           e.deals::numeric        / greatest(e.days_present, 1) as r_deals,
           e.revenue               / greatest(e.days_present, 1) as r_revenue,
           e.talk_seconds::numeric / greatest(e.days_present, 1) as r_talk,
           case when p_scope = 'team' then e.team_id end         as part
      from eligible e
  ),
  tops as (
    select part,
           max(r_dials) as dials, max(r_connects) as connects,
           max(r_interested) as interested, max(r_walked_in) as walked_in,
           max(r_deals) as deals, max(r_revenue) as revenue,
           max(r_talk) as talk
      from rates group by part
  ),
  scored as (
    select r.user_id, r.full_name, r.role, r.team_id, r.days_present,
           r.dials, r.connects, r.interested, r.walked_in, r.deals,
           r.revenue, r.talk_seconds, r.r_dials, r.part,
           round(
               coalesce(r.r_deals      / nullif(t.deals, 0), 0)      * w.deals
             + coalesce(r.r_revenue    / nullif(t.revenue, 0), 0)    * w.revenue
             + coalesce(r.r_connects   / nullif(t.connects, 0), 0)   * w.connects
             + coalesce(r.r_dials      / nullif(t.dials, 0), 0)      * w.dials
             + coalesce(r.r_interested / nullif(t.interested, 0), 0) * w.interested
             + coalesce(r.r_walked_in  / nullif(t.walked_in, 0), 0)  * w.walkins
             + coalesce(r.r_talk       / nullif(t.talk, 0), 0)       * w.talk
           , 1) as points
      from rates r
      join tops t on t.part is not distinct from r.part
      cross join w
  )
  select user_id, full_name, role, team_id, days_present,
         dials, connects, interested, walked_in, deals, revenue, talk_seconds,
         round(r_dials, 2) as dials_per_day,
         points,
         rank() over (partition by part order by points desc)::int as rank
    from scored
   order by points desc, full_name
$$;

comment on function crm.rate_standings is
  'The one standings formula. Leaderboard points per person, computed on
   PER-PRESENT-DAY rates so leave never costs anyone a place, normalised
   within the floor or within the team (p_scope) and weighted by the same
   leaderboard.weight_* settings every screen uses. Someone with fewer than
   p_min_days measured days is left out rather than ranked last. Invoker
   rights: v_person_performance decides whose numbers the asker may see.';

grant execute on function crm.rate_standings(int, text, boolean, text[], int) to crm_app;

-- ---------------------------------------------------------------------------
-- 3. The ACE pick, now sharing that one formula instead of restating it.
--    Same behaviour as 0061; one copy of the arithmetic instead of two.
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

  with decided as (
    select s.user_id,
           -- The dial floor at the person's own pace: what they would have
           -- dialled over a whole window working the way they actually did.
           case when s.rank = 1 and s.points > 0
                     and s.dials_per_day * v_window >= v_min
                then 'ace' else 'standard' end as new_tier
      from crm.rate_standings(
             v_window, 'team', false, array['caller'], v_min_days) s
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
   and keeps the tier they earned. Shares crm.rate_standings with the
   leaderboard, so "best" means one thing on every screen. Live admin pins
   outrank it; expired pins are cleared for everyone; RESTRICTED is never set
   automatically.';

revoke all on function crm.rank_performance_tiers() from public;
grant execute on function crm.rank_performance_tiers() to crm_app;

-- ---------------------------------------------------------------------------
-- 4. The daily score: no snapshot for a day nobody worked.
--
-- Four caller components are always applicable by design, so an absent day
-- scored a hard zero and dragged the seven-day average on the caller's own
-- screen. Skipping the day is not hiding anything - the attendance tab
-- already shows, honestly, that they were not there. It stops a day off
-- being recorded as a day of failure.
-- ---------------------------------------------------------------------------
create or replace function crm.snapshot_scores(p_date date default crm.ist_date(now()))
  returns int
  language plpgsql
  -- Re-asserted, not inherited: CREATE OR REPLACE resets every attribute the
  -- new definition does not restate, and 0014 made this SECURITY DEFINER for
  -- a reason - run as the ops invoker it cannot write a score row past RLS,
  -- and the nightly snapshot silently stops happening.
  security definer
  set search_path = crm, pg_temp
as $$
declare
  r        record;
  v_comp   jsonb;
  v_points numeric;
  v_weight numeric;
  v_total  numeric;
  v_count  int := 0;
begin
  for r in
    select id, role from crm.users where is_active and role in ('caller', 'counsellor')
  loop
    if not crm.was_present(r.id, p_date) then
      -- Self-repairing: a zero written before this migration, or written
      -- earlier today before the person's shift began, is removed rather
      -- than left to drag the average. Only a zero - a real score means
      -- something was measured, and that is never ours to delete.
      delete from crm.score_snapshots
       where user_id = r.id and score_date = p_date and total = 0;
      continue;
    end if;

    v_comp := case r.role
                when 'caller' then crm.compute_caller_score(r.id, p_date)
                else crm.compute_counsellor_score(r.id, p_date)
              end;

    -- Rescale over the components that actually applied today.
    select coalesce(sum((v.value ->> 'points')::numeric), 0),
           coalesce(sum((v.value ->> 'weight')::numeric)
                    filter (where (v.value ->> 'applicable')::boolean), 0)
      into v_points, v_weight
      from jsonb_each(v_comp) v;

    v_total := case when v_weight > 0
                    then least(round(100 * v_points / v_weight, 2), 100)
                    else 0 end;

    insert into crm.score_snapshots (user_id, score_date, role, team_id, components, total)
    values (r.id, p_date, r.role, crm.team_of(r.id, p_date), v_comp, v_total)
    on conflict (user_id, score_date) do update
      set components = excluded.components,
          total      = excluded.total,
          team_id    = excluded.team_id,
          computed_at = now();

    v_count := v_count + 1;
  end loop;
  return v_count;
end
$$;

revoke execute on function crm.snapshot_scores(date) from public;
grant execute on function crm.snapshot_scores(date) to crm_app;

comment on function crm.snapshot_scores is
  'One score per person per business day - for the days they worked. A day
   that fails crm.was_present() gets no snapshot, and any zero already
   recorded for it is removed: the four core caller components are always
   applicable by design, so an absent day would otherwise score 0/100 and
   drag the seven-day average on the caller''s own screen.';

-- ---------------------------------------------------------------------------
-- 5. Repair the damage already in the table.
--
-- Only the zeroes, and only on days the person demonstrably was not there.
-- A non-zero score means something was measured and is never deleted.
-- ---------------------------------------------------------------------------
do $$
declare
  v_gone int;
begin
  with dead as (
    delete from crm.score_snapshots s
     where s.total = 0
       and not crm.was_present(s.user_id, s.score_date)
    returning 1
  )
  select count(*) into v_gone from dead;
  raise notice 'absent-day zero scores removed: %', v_gone;
end $$;

-- Recompute today on the new rule so the floor sees the corrected number
-- without waiting for the scheduler's next tick.
select crm.snapshot_scores(crm.ist_date(now()));
select crm.rank_performance_tiers();
