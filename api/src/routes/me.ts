import type { FastifyInstance } from 'fastify';

/**
 * Who am I, and what is due.
 *
 * Reminders are not a separate engine: an open lead always carries
 * next_follow_up_at, and "my reminders" is simply my open leads bucketed by
 * that one date. Clearing a reminder means doing the work - logging the call
 * moves the date, so the row leaves the list on its own.
 */
export async function meRoutes(app: FastifyInstance): Promise<void> {
  app.get('/me', async (req) => {
    const user = req.requireUser();
    return req.tx(async (q) => {
      const row = await q.one<{
        id: string;
        full_name: string;
        email: string;
        role: string;
      }>('select id, full_name, email, role from crm.users where id = $1', [user.id]);
      return row;
    });
  });

  /**
   * The reminder buckets. A caller or follow-up person sees their own plus
   * anything unassigned (an unassigned lead must never be invisible); an
   * admin sees the whole floor's, each row naming its owner.
   */
  app.get('/reminders', async (req) => {
    const user = req.requireUser();
    const mineOnly = user.role !== 'admin';

    return req.tx(async (q) => {
      const rows = await q.many(
        `select *
           from crm.v_lead_list
          where is_open
            and next_follow_up_at < now() + interval '7 days'
            and ($1::boolean is false or assigned_to = $2 or assigned_to is null)
          order by next_follow_up_at asc
          limit 400`,
        [mineOnly, user.id],
      );
      return {
        overdue: rows.filter((r) => r.due_bucket === 'overdue'),
        today: rows.filter((r) => r.due_bucket === 'today'),
        upcoming: rows.filter((r) => r.due_bucket === 'upcoming'),
      };
    });
  });

  /**
   * What should pop right now: my open leads whose follow-up time has just
   * arrived. The client shows each lead once (it remembers what it has shown),
   * so this endpoint stays a dumb, honest read.
   */
  app.get('/reminders/due', async (req) => {
    const user = req.requireUser();
    return req.tx(async (q) => {
      const rows = await q.many(
        `select id, full_name, phone_e164, next_follow_up_at, follow_up_note, last_outcome
           from crm.v_lead_list
          where is_open
            and assigned_to = $1
            and next_follow_up_at <= now()
            and next_follow_up_at > now() - interval '12 hours'
          order by next_follow_up_at asc
          limit 20`,
        [user.id],
      );
      return { due: rows };
    });
  });
}
