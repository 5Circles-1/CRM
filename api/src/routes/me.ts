import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { logLeadAccess } from '../http/context.ts';

const uuid = z.string().uuid();

/**
 * The caller's own screens: their day, their attendance, their score.
 * Requirements 4, 6 and 7.
 */
export async function meRoutes(app: FastifyInstance): Promise<void> {
  app.get('/me', async (req) => {
    const user = req.requireUser();
    return req.tx(async (q) => {
      const row = await q.one(
        `select u.id, u.full_name, u.email, u.role, u.employee_code,
                crm.team_of(u.id, current_date) as team_id,
                t.name as team_name,
                crm.is_on_shift(u.id) as on_shift
           from crm.users u
           left join crm.teams t on t.id = crm.team_of(u.id, current_date)
          where u.id = $1`,
        [user.id],
      );
      return row;
    });
  });

  /**
   * Requirement 4: the caller's pipeline for the day.
   *
   * Ordering is the point of this endpoint. Immediate leads that have never
   * been touched come first, then whatever is most overdue, then the day's
   * scheduled work. The caller should be able to work top to bottom without
   * making a single prioritisation decision.
   */
  app.get('/me/day', async (req) => {
    const user = req.requireUser();
    const query = z
      .object({ bucket: z.enum(['immediate', 'overdue', 'callback', 'fresh', 'scheduled']).optional() })
      .parse(req.query);

    return req.tx(async (q) => {
      const rows = await q.many<{ lead_id: string }>(
        `select *
           from crm.v_my_day
          where caller_id = $1
            and ($2::text is null or bucket = $2)
          order by case bucket
                     when 'immediate' then 0
                     when 'overdue'   then 1
                     when 'callback'  then 2
                     when 'fresh'     then 3
                     else 4
                   end,
                   minutes_overdue desc,
                   next_action_at asc`,
        [user.id, query.bucket ?? null],
      );

      await logLeadAccess(q, user.id, rows.map((r) => r.lead_id), 'list', req.ip);
      return { count: rows.length, leads: rows };
    });
  });

  /**
   * My whole open pipeline, bucketed - not just today.
   *
   * /me/day deliberately stops at midnight; it is the day's work list. This is
   * the answer to "what do I owe anyone this week", which had no screen at all:
   * a follow-up agreed for Thursday was invisible from Monday night until
   * Thursday morning.
   */
  app.get('/me/pipeline', async (req) => {
    const user = req.requireUser();
    const query = z
      .object({
        bucket: z
          .enum(['immediate', 'overdue', 'callback', 'callback_upcoming', 'fresh',
                 'followup_today', 'followup_upcoming'])
          .optional(),
        limit: z.coerce.number().int().min(1).max(500).default(200),
      })
      .parse(req.query);

    return req.tx(async (q) => {
      const [counts, rows] = await Promise.all([
        q.many<{ bucket: string; count: number }>(
          `select bucket, count(*)::int as count
             from crm.v_my_pipeline
            where caller_id = $1 or counsellor_id = $1
            group by bucket`,
          [user.id],
        ),
        q.many<{ lead_id: string }>(
          `select * from crm.v_my_pipeline
            where (caller_id = $1 or counsellor_id = $1)
              and ($2::text is null or bucket = $2)
            order by case bucket
                       when 'immediate'         then 0
                       when 'overdue'           then 1
                       when 'callback'          then 2
                       when 'fresh'             then 3
                       when 'followup_today'    then 4
                       when 'callback_upcoming' then 5
                       else 6
                     end,
                     minutes_overdue desc,
                     next_action_at asc
            limit $3`,
          [user.id, query.bucket ?? null, query.limit],
        ),
      ]);

      await logLeadAccess(q, user.id, rows.map((r) => r.lead_id), 'list', req.ip);
      return {
        counts: Object.fromEntries(counts.map((c) => [c.bucket, Number(c.count)])),
        total: counts.reduce((a, c) => a + Number(c.count), 0),
        leads: rows,
      };
    });
  });

  /**
   * Outcome mix — what happened to the calls, as a part-to-whole.
   *
   * Summed from crm.v_person_performance rather than call_attempts directly,
   * because that view already carries the visibility rule. Reading the attempts
   * table would show a caller the outcomes of calls a colleague made on a lead
   * that has since been reassigned to them.
   */
  app.get('/outcomes', async (req) => {
    req.requireUser();
    const { days, userId } = z
      .object({
        days: z.coerce.number().int().min(1).max(90).default(7),
        userId: uuid.optional(),
      })
      .parse(req.query);

    const row = await req.tx((q) =>
      q.one(
        `select
           coalesce(sum(dials), 0)::int            as dials,
           coalesce(sum(connects), 0)::int         as connects,
           coalesce(sum(interested), 0)::int       as interested,
           coalesce(sum(not_interested), 0)::int   as not_interested,
           coalesce(sum(callbacks_booked), 0)::int as callbacks_booked,
           coalesce(sum(visits_promised), 0)::int  as visits_promised,
           coalesce(sum(not_answered), 0)::int     as not_answered,
           coalesce(sum(job_enquiries), 0)::int    as job_enquiries,
           coalesce(sum(walked_in), 0)::int        as walked_in,
           coalesce(sum(deals), 0)::int            as deals,
           coalesce(sum(talk_seconds), 0)::bigint  as talk_seconds
         from crm.v_person_performance
        where day > crm.ist_date(now()) - $1::int
          and ($2::uuid is null or user_id = $2)`,
        [days, userId ?? null],
      ),
    );
    return row;
  });

  /**
   * Daily totals across everyone this user can see, for the trend line.
   *
   * Separate from /me/performance, which is one person. A counsellor wants the
   * team's shape over time, not five overlapping lines.
   */
  app.get('/performance/daily', async (req) => {
    req.requireUser();
    const { days, userId } = z
      .object({
        days: z.coerce.number().int().min(1).max(90).default(14),
        userId: uuid.optional(),
      })
      .parse(req.query);

    return req.tx((q) =>
      q.many(
        `select day,
                sum(dials)::int          as dials,
                sum(connects)::int       as connects,
                sum(interested)::int     as interested,
                sum(not_interested)::int as not_interested,
                sum(walked_in)::int      as walked_in,
                sum(deals)::int          as deals,
                sum(talk_seconds)::bigint as talk_seconds
           from crm.v_person_performance
          where day > crm.ist_date(now()) - $1::int
            and ($2::uuid is null or user_id = $2)
          group by day order by day`,
        [days, userId ?? null],
      ),
    );
  });

  /**
   * The handful of settings the browser itself needs.
   *
   * These live in crm.settings with everything else, but /admin/settings is
   * admin-only - so reading them from there would have meant the poll interval
   * silently never applied to callers, who are the people being interrupted.
   * Nothing here is sensitive: it is how often to poll and what may pop up.
   */
  app.get('/meta/ui-settings', async (req) => {
    req.requireUser();
    const rows = await req.tx((q) =>
      q.many<{ key: string; value: unknown }>(
        `select key, value from crm.settings
          where key in ('alerts.poll_seconds', 'alerts.popup_kinds',
                        'alerts.repeat_minutes', 'ui.refresh_seconds',
                        'sla.untouched_reassign_minutes')`,
      ),
    );
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  });

  /**
   * Everyone's leaderboard icon, in one map.
   *
   * Separate from /admin/users because the board is visible to every role, and
   * an avatar is presentation, not PII - it carries nothing the name on the
   * same card does not.
   */
  app.get('/users/avatars', async (req) => {
    req.requireUser();
    const rows = await req.tx((q) =>
      q.many<{ id: string; avatar_url: string }>(
        `select id, avatar_url from crm.users
          where is_active and avatar_url is not null`,
      ),
    );
    return Object.fromEntries(rows.map((r) => [r.id, r.avatar_url]));
  });

  /**
   * The overall standings: one number per person across every metric.
   *
   * Each metric is normalised against the best on the floor in the window and
   * weighted; the weights live in crm.settings (leaderboard.weight_*) so ops
   * can re-balance what "best overall" means without a deploy. A metric nobody
   * scored on contributes nothing rather than dividing by zero, and someone
   * with no activity at all is left off the board rather than shown at 0.
   */
  app.get('/performance/overall', async (req) => {
    req.requireUser();
    const { days } = z
      .object({ days: z.coerce.number().int().min(1).max(90).default(1) })
      .parse(req.query);

    return req.tx((q) =>
      q.many(
        `with w as (
           select crm.setting_num('leaderboard.weight_deals', 25)      as deals,
                  crm.setting_num('leaderboard.weight_revenue', 25)    as revenue,
                  crm.setting_num('leaderboard.weight_connects', 15)   as connects,
                  crm.setting_num('leaderboard.weight_dials', 10)      as dials,
                  crm.setting_num('leaderboard.weight_interested', 10) as interested,
                  crm.setting_num('leaderboard.weight_walkins', 10)    as walkins,
                  crm.setting_num('leaderboard.weight_talk', 5)        as talk
         ),
         sums as (
           select user_id, full_name, role,
                  sum(dials)::numeric        as dials,
                  sum(connects)::numeric     as connects,
                  sum(interested)::numeric   as interested,
                  sum(walked_in)::numeric    as walked_in,
                  sum(deals)::numeric        as deals,
                  sum(revenue)::numeric      as revenue,
                  sum(talk_seconds)::numeric as talk_seconds
             from crm.v_person_performance
            where day > crm.ist_date(now()) - $1::int
            group by user_id, full_name, role
           having sum(dials) > 0 or sum(deals) > 0 or sum(walked_in) > 0
         ),
         tops as (
           select max(dials) as dials, max(connects) as connects,
                  max(interested) as interested, max(walked_in) as walked_in,
                  max(deals) as deals, max(revenue) as revenue,
                  max(talk_seconds) as talk_seconds
             from sums
         )
         select s.user_id, s.full_name, s.role,
                s.dials::int, s.connects::int, s.interested::int, s.walked_in::int,
                s.deals::int, s.revenue, s.talk_seconds::bigint,
                round(
                    coalesce(s.deals        / nullif(t.deals, 0), 0)        * w.deals
                  + coalesce(s.revenue      / nullif(t.revenue, 0), 0)      * w.revenue
                  + coalesce(s.connects     / nullif(t.connects, 0), 0)     * w.connects
                  + coalesce(s.dials        / nullif(t.dials, 0), 0)        * w.dials
                  + coalesce(s.interested   / nullif(t.interested, 0), 0)   * w.interested
                  + coalesce(s.walked_in    / nullif(t.walked_in, 0), 0)    * w.walkins
                  + coalesce(s.talk_seconds / nullif(t.talk_seconds, 0), 0) * w.talk
                , 1) as overall_points,
                rank() over (order by
                    coalesce(s.deals        / nullif(t.deals, 0), 0)        * w.deals
                  + coalesce(s.revenue      / nullif(t.revenue, 0), 0)      * w.revenue
                  + coalesce(s.connects     / nullif(t.connects, 0), 0)     * w.connects
                  + coalesce(s.dials        / nullif(t.dials, 0), 0)        * w.dials
                  + coalesce(s.interested   / nullif(t.interested, 0), 0)   * w.interested
                  + coalesce(s.walked_in    / nullif(t.walked_in, 0), 0)    * w.walkins
                  + coalesce(s.talk_seconds / nullif(t.talk_seconds, 0), 0) * w.talk
                  desc) as rank
           from sums s, tops t, w
          order by overall_points desc, s.full_name`,
        [days],
      ),
    );
  });

  /**
   * My own numbers, day by day.
   *
   * Requirement 7 is self-reflection, so this exists for the caller first. The
   * counsellor and admin views below are the same view with more reach, which
   * RLS grants them - not a second query with different rules in it.
   */
  app.get('/me/performance', async (req) => {
    const user = req.requireUser();
    const { days } = z.object({ days: z.coerce.number().int().min(1).max(90).default(14) })
      .parse(req.query);
    return req.tx((q) =>
      q.many(
        `select * from crm.v_person_performance
          where user_id = $1 and day > crm.ist_date(now()) - $2::int
          order by day desc`,
        [user.id, days],
      ),
    );
  });

  /**
   * Everyone this user is allowed to see, summed over the window.
   *
   * A caller gets themselves, a counsellor gets their team, an admin gets the
   * floor - and none of that is decided here. The ORDER BY is the answer to
   * "who brought in the most walk-ins", which was the question that prompted it.
   */
  app.get('/performance', async (req) => {
    req.requireUser();
    const { days, sort } = z
      .object({
        days: z.coerce.number().int().min(1).max(90).default(7),
        sort: z
          .enum(['dials', 'connects', 'interested', 'walked_in', 'deals', 'revenue', 'talk_seconds'])
          .default('connects'),
      })
      .parse(req.query);

    return req.tx((q) =>
      q.many(
        `select user_id, full_name, role,
                sum(dials)::int            as dials,
                sum(connects)::int         as connects,
                sum(interested)::int       as interested,
                sum(not_interested)::int   as not_interested,
                sum(not_answered)::int     as not_answered,
                sum(callbacks_booked)::int as callbacks_booked,
                sum(visits_promised)::int  as visits_promised,
                sum(walked_in)::int        as walked_in,
                sum(whatsapp_sent)::int    as whatsapp_sent,
                sum(job_enquiries)::int    as job_enquiries,
                sum(talk_seconds)::bigint  as talk_seconds,
                sum(deals)::int            as deals,
                sum(assisted_deals)::int   as assisted_deals,
                sum(revenue)               as revenue,
                case when sum(dials) > 0
                     then round(100.0 * sum(connects) / sum(dials), 1) end    as connect_rate,
                case when sum(connects) > 0
                     then round(100.0 * sum(interested) / sum(connects), 1) end as interest_rate,
                case when sum(connects) > 0
                     then round(100.0 * sum(deals) / sum(connects), 1) end   as conversion_rate
           from crm.v_person_performance
          where day > crm.ist_date(now()) - $1::int
          group by user_id, full_name, role
         having sum(dials) > 0 or sum(deals) > 0 or sum(walked_in) > 0
          order by ${sort === 'revenue' ? 'sum(revenue)' : `sum(${sort})`} desc, full_name`,
        [days],
      ),
    );
  });

  /**
   * Everything demanding this person's attention, newest deadline first.
   *
   * No ownership filter here on purpose - RLS decides what a caller can see and
   * what a counsellor can see, so this one endpoint serves both without the
   * route needing to know the difference.
   */
  app.get('/me/alerts', async (req) => {
    req.requireUser();
    return req.tx(async (q) => {
      const alerts = await q.many(
        `select kind, severity, lead_id, lead_name, phone_e164, due_at, title, callback_id,
                round(extract(epoch from (now() - due_at)) / 60)::int as minutes_late
           from crm.v_my_alerts
          order by case severity when 'critical' then 0 when 'warning' then 1 else 2 end,
                   due_at asc
          limit 100`,
      );
      return {
        count: alerts.length,
        critical: alerts.filter((a) => (a as { severity: string }).severity === 'critical').length,
        alerts,
      };
    });
  });

  /** Counts for the header chips, without pulling the whole list. */
  app.get('/me/day/summary', async (req) => {
    const user = req.requireUser();
    return req.tx((q) =>
      q.one(
        `select
           count(*)                                        as total,
           count(*) filter (where bucket = 'immediate')    as immediate,
           count(*) filter (where bucket = 'overdue')      as overdue,
           count(*) filter (where bucket = 'callback')     as callbacks,
           count(*) filter (where bucket = 'fresh')        as fresh
         from crm.v_my_day where caller_id = $1`,
        [user.id],
      ),
    );
  });

  /**
   * Requirement 7. Own trend first, rank second - the score is meant for
   * self-reflection, and a number presented as a league table becomes
   * something to game rather than something to learn from.
   */
  app.get('/me/score', async (req) => {
    const user = req.requireUser();
    const { days } = z.object({ days: z.coerce.number().int().min(1).max(90).default(14) }).parse(req.query);

    return req.tx(async (q) => {
      const history = await q.many(
        `select score_date, total, own_7day_avg, team_avg_that_day,
                change_vs_last_week, rank_in_team, components
           from crm.v_my_score
          where user_id = $1 and score_date > current_date - $2::int
          order by score_date desc`,
        [user.id, days],
      );
      return { latest: history[0] ?? null, history };
    });
  });

  /** Requirement 6: the caller's own attendance. */
  app.get('/me/attendance', async (req) => {
    const user = req.requireUser();
    const { days } = z.object({ days: z.coerce.number().int().min(1).max(90).default(30) }).parse(req.query);

    return req.tx((q) =>
      q.many(
        `select business_date, first_login_at, last_activity_at, session_count,
                logged_minutes, expected_minutes, shortfall_minutes,
                is_late, met_hours, currently_logged_in
           from crm.v_attendance_day
          where user_id = $1 and business_date > current_date - $2::int
          order by business_date desc`,
        [user.id, days],
      ),
    );
  });
}
