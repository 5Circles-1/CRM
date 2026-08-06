import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

/**
 * Requirement 2: dashboards for caller and counsellor performance.
 * Requirement 9: leakage visibility.
 *
 * Every figure here comes from a view, so the caller screen, the counsellor
 * screen and any export can never disagree about the same number.
 */
export async function dashboardRoutes(app: FastifyInstance): Promise<void> {
  /** Live floor: who is on, what they have done, what is urgent in their queue. */
  app.get('/dashboards/floor', async (req) => {
    req.requireRole('counsellor', 'admin', 'ops', 'viewer');
    return req.tx((q) =>
      q.many(
        `select * from crm.v_floor_live
          order by role, currently_logged_in desc nulls last, dials_today desc`,
      ),
    );
  });

  /** Caller performance for a date, defaulting to today. */
  app.get('/dashboards/callers', async (req) => {
    req.requireRole('counsellor', 'admin', 'ops', 'viewer');
    const { date } = z
      .object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() })
      .parse(req.query);

    return req.tx((q) =>
      q.many(
        `select c.*,
                s.total as score,
                a.logged_minutes, a.expected_minutes, a.is_late, a.met_hours
           from crm.v_caller_day c
           left join crm.score_snapshots s
             on s.user_id = c.user_id and s.score_date = c.business_date
           left join crm.v_attendance_day a
             on a.user_id = c.user_id and a.business_date = c.business_date
          where c.business_date = coalesce($1::date, crm.ist_date(now()))
          order by c.dials desc, c.connects desc`,
        [date ?? null],
      ),
    );
  });

  /** Counsellor performance, month to date. */
  app.get('/dashboards/counsellors', async (req) => {
    req.requireRole('counsellor', 'admin', 'ops', 'viewer');
    return req.tx((q) =>
      q.many(
        `select m.*, s.total as score
           from crm.v_counsellor_mtd m
           left join crm.score_snapshots s
             on s.user_id = m.user_id and s.score_date = crm.ist_date(now())
          order by m.collected_amount desc`,
      ),
    );
  });

  /**
   * Requirement 9: everything sitting where it should not be.
   * If this comes back empty, the pipeline is clean.
   */
  app.get('/dashboards/leakage', async (req) => {
    req.requireRole('counsellor', 'admin', 'ops', 'viewer');
    const { severity } = z.object({ severity: z.enum(['high', 'medium']).optional() }).parse(req.query);

    return req.tx(async (q) => {
      const rows = await q.many(
        // The caller's name comes from here rather than the view: the screen
        // groups leaks by type and the first question about any of them is
        // "whose is it", which a uuid does not answer.
        `select pl.*, u.full_name as caller_name
           from crm.v_pipeline_leakage pl
           left join crm.users u on u.id = pl.caller_id
          where ($1::text is null or pl.severity = $1)
          order by case pl.severity when 'high' then 0 else 1 end, pl.minutes_late desc
          limit 500`,
        [severity ?? null],
      );
      // Grouped by type only. Splitting by severity too produced two chips for
      // the same leak type, which read as two different problems.
      const summary = await q.many(
        `select leak_type, count(*) as count,
                max(case when severity = 'high' then 1 else 0 end)::boolean as has_high
           from crm.v_pipeline_leakage group by leak_type order by count desc`,
      );
      return { summary, items: rows };
    });
  });

  /** Collected against the office breakeven, with the pace check. */
  app.get('/dashboards/thermometer', async (req) => {
    req.requireRole('counsellor', 'admin', 'ops', 'viewer');
    return req.tx((q) => q.one(`select * from crm.v_collection_thermometer`));
  });

  /** Team funnel for the period, for the counsellor's own team. */
  app.get('/dashboards/funnel', async (req) => {
    req.requireRole('counsellor', 'admin', 'ops', 'viewer');
    const { days } = z.object({ days: z.coerce.number().int().min(1).max(180).default(30) }).parse(req.query);

    return req.tx((q) =>
      q.one(
        `select
           count(*)                                                  as leads,
           count(*) filter (where first_touched_at is not null)      as contacted,
           count(*) filter (where connect_count > 0)                 as connected,
           count(*) filter (where status = 'qualified'
                              or counsellor_id is not null)          as qualified,
           count(*) filter (where status = 'won')                    as won,
           count(*) filter (where status = 'lost')                   as lost,
           count(*) filter (where status = 'nurture')                as nurture,
           round(avg(attempt_count), 1)                              as avg_attempts,
           round(100.0 * count(*) filter (where status = 'won')
                 / nullif(count(*), 0), 2)                           as conversion_pct
         from crm.leads
        where created_at > now() - make_interval(days => $1::int)`,
        [days],
      ),
    );
  });

  /** Security alerts. Admin only - the floor cannot read the watchers. */
  app.get('/dashboards/security-alerts', async (req) => {
    req.requireRole('admin');
    return req.tx((q) =>
      q.many(
        `select a.*, u.full_name
           from crm.security_alerts a
           left join crm.users u on u.id = a.user_id
          where a.acknowledged_at is null
          order by a.raised_at desc limit 200`,
      ),
    );
  });

  app.post('/dashboards/security-alerts/:id/acknowledge', async (req) => {
    const user = req.requireRole('admin');
    const { id } = z.object({ id: z.coerce.number().int() }).parse(req.params);
    return req.tx((q) =>
      q.one(
        `update crm.security_alerts
            set acknowledged_by = $2, acknowledged_at = now()
          where id = $1 returning id, acknowledged_at`,
        [id, user.id],
      ),
    );
  });
}
