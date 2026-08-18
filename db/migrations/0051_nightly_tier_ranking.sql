-- 0051_nightly_tier_ranking.sql
--
-- "Tomorrow when the team logs in, the maximum leads should go to the member
-- who does the best calls."
--
-- The machinery for that has existed since 0026: an ACE-tier caller holds a
-- guaranteed distribution.ace_share_pct (66.7%) of their team's fresh leads.
-- What never existed was anything that DECIDES who is ACE - the table sat
-- empty, everyone defaulted to STANDARD, and the share never applied. The
-- training pages promised a "nightly ranking"; this is that ranking, real.
--
-- The rule, deliberately simple enough to say out loud on the floor:
--
--   Each team's best caller over the last tier.rank_window_days COMPLETED
--   days - by the same overall points the leaderboard and the star rating
--   already show - is ACE for today, provided they made at least
--   tier.min_dials_to_rank dials in the window. Everyone else is STANDARD.
--
-- Three deliberate boundaries:
--   - Completed days only. Every run inside one day computes the same
--     answer, so the pick flips overnight - never at 2pm mid-distribution.
--   - An admin pin outranks the ranking until it expires (0026's contract).
--     An EXPIRED pin is cleared and the seat returns to the ranking.
--   - The ranking never sets RESTRICTED. Cutting someone to zero fresh leads
--     is a personnel decision; it stays a human pin with a reason and expiry.

insert into crm.settings (key, value, description) values
  ('tier.auto_rank', 'true'::jsonb,
   'Rank each team''s callers daily and set the best to ACE. false freezes tiers as they are.'),
  ('tier.rank_window_days', '7'::jsonb,
   'How many completed days of work the daily ACE ranking looks at.'),
  ('tier.min_dials_to_rank', '20'::jsonb,
   'Dials a caller needs in the window before they can be promoted to ACE. Below it, nobody is - a quiet week promotes no one.')
on conflict (key) do nothing;

create or replace function crm.rank_performance_tiers()
  returns int
  language plpgsql
  security definer
  set search_path = crm, public
as $$
declare
  v_window  int := crm.setting_int('tier.rank_window_days', 7);
  v_min     int := crm.setting_int('tier.min_dials_to_rank', 20);
  v_changed int := 0;
begin
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
  -- Active callers' sums over the completed-day window, per current team.
  sums as (
    select p.user_id,
           crm.team_of(p.user_id, current_date)  as team_id,
           sum(p.dials)::numeric        as dials,
           sum(p.connects)::numeric     as connects,
           sum(p.interested)::numeric   as interested,
           sum(p.walked_in)::numeric    as walked_in,
           sum(p.deals)::numeric        as deals,
           sum(p.revenue)::numeric      as revenue,
           sum(p.talk_seconds)::numeric as talk_seconds
      from crm.v_person_performance p
      join crm.users u on u.id = p.user_id and u.role = 'caller' and u.is_active
     where p.day >= crm.ist_date(now()) - v_window
       and p.day <  crm.ist_date(now())
       and crm.team_of(p.user_id, current_date) is not null
     group by p.user_id
  ),
  tops as (
    select team_id,
           max(dials) as dials, max(connects) as connects,
           max(interested) as interested, max(walked_in) as walked_in,
           max(deals) as deals, max(revenue) as revenue,
           max(talk_seconds) as talk_seconds
      from sums group by team_id
  ),
  -- The exact leaderboard formula the floor already sees as points and stars,
  -- normalised within the team. One formula everywhere, or "best" would mean
  -- different things on different screens.
  pts as (
    select s.user_id, s.team_id, s.dials,
             coalesce(s.deals        / nullif(t.deals, 0), 0)        * w.deals
           + coalesce(s.revenue      / nullif(t.revenue, 0), 0)      * w.revenue
           + coalesce(s.connects     / nullif(t.connects, 0), 0)     * w.connects
           + coalesce(s.dials        / nullif(t.dials, 0), 0)        * w.dials
           + coalesce(s.interested   / nullif(t.interested, 0), 0)   * w.interested
           + coalesce(s.walked_in    / nullif(t.walked_in, 0), 0)    * w.walkins
           + coalesce(s.talk_seconds / nullif(t.talk_seconds, 0), 0) * w.talk
           as points
      from sums s
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
           case when rnk = 1 and points > 0 and dials >= v_min
                then 'ace' else 'standard' end as new_tier
      from ranked
  ),
  applied as (
    insert into crm.performance_tiers (user_id, tier, updated_at)
    select user_id, new_tier, now() from decided
    on conflict (user_id) do update
       set tier = excluded.tier,
           -- An expired pin is cleared here; a live pin is skipped below.
           pinned_by = null, pin_reason = null, pin_expires_at = null,
           updated_at = now()
     where crm.performance_tiers.pinned_by is null
        or (crm.performance_tiers.pin_expires_at is not null
            and crm.performance_tiers.pin_expires_at <= now())
    returning 1
  )
  select count(*) into v_changed from applied;

  return v_changed;
end
$$;

comment on function crm.rank_performance_tiers() is
  'The daily ACE pick: each team''s best caller over the last completed days
   (leaderboard points, minimum dials) becomes ACE and holds the guaranteed
   distribution.ace_share_pct of fresh leads. Live admin pins outrank it;
   expired pins are cleared; RESTRICTED is never set automatically. Runs on
   the scheduler; idempotent within a day because the window is completed
   days only.';

revoke all on function crm.rank_performance_tiers() from public;
grant execute on function crm.rank_performance_tiers() to crm_app;

-- Seed the first pick right now, so the share applies from the very next
-- distribution rather than the scheduler's first tick.
select crm.rank_performance_tiers();
