import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

const uuid = z.string().uuid();
const month = z.string().regex(/^\d{4}-\d{2}$/);

/**
 * Individual targets: revenue for a counsellor, walk-ins for a caller.
 *
 * No role check on the read. RLS decides whose progress comes back - a caller
 * reading this gets their own row and a counsellor their team's - which is the
 * same rule the performance screens have always used. The write is guarded
 * inside crm.set_user_target (counsellor/admin, never backwards into a closed
 * month), so the route maps the SQLSTATE rather than restating the rule.
 */
export async function targetRoutes(app: FastifyInstance): Promise<void> {
  /** Everyone's target and progress for a month, defaulting to this one. */
  app.get('/targets', async (req) => {
    req.requireUser();
    const { month: m } = z.object({ month: month.optional() }).parse(req.query);
    return req.tx(async (q) => {
      const rows = await q.many(`select * from crm.user_target_progress($1::date)`, [
        m ? `${m}-01` : null,
      ]);
      const settings = await q.one(
        `select crm.setting_int('walkin.monthly_target_per_caller', 10) as default_walkins,
                crm.setting_num('finance.monthly_breakeven_inr', 700000) as office_breakeven,
                to_char(date_trunc('month', coalesce($1::date, crm.ist_date(now()))),
                        'FMMonth YYYY') as month_label,
                to_char(date_trunc('month', coalesce($1::date, crm.ist_date(now()))),
                        'YYYY-MM') as month`,
        [m ? `${m}-01` : null],
      );
      return { ...(settings ?? {}), people: rows };
    });
  });

  /** My own target and progress — the caller's self-reflection number (R7). */
  app.get('/me/target', async (req) => {
    const user = req.requireUser();
    return req.tx((q) =>
      q.one(`select * from crm.user_target_progress() where user_id = $1`, [user.id]),
    );
  });

  /**
   * Set or clear one person's targets for a month.
   *
   * An explicit null clears that number and the person falls back to their
   * role's default; an omitted field means the same thing, because a target
   * screen that can only ever raise numbers is a screen nobody trusts.
   */
  app.put('/targets/:userId', async (req) => {
    req.requireUser();
    const { userId } = z.object({ userId: uuid }).parse(req.params);
    const body = z
      .object({
        month: month.optional(),
        revenueTarget: z.number().min(0).max(999_999_999).nullable().optional(),
        walkinTarget: z.number().int().min(0).max(10_000).nullable().optional(),
        dailyDialTarget: z.number().int().min(0).max(1000).nullable().optional(),
      })
      .parse(req.body ?? {});

    return req.tx(async (q) => {
      await q.query(`select crm.set_user_target($1, $2::date, $3::numeric, $4::int, $5::int)`, [
        userId,
        body.month ? `${body.month}-01` : null,
        body.revenueTarget ?? null,
        body.walkinTarget ?? null,
        body.dailyDialTarget ?? null,
      ]);
      return q.one(
        `select * from crm.user_target_progress($1::date) where user_id = $2`,
        [body.month ? `${body.month}-01` : null, userId],
      );
    });
  });
}
