import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { conflict } from '../http/errors.ts';

/**
 * Requirement 6: a 9-hour login (09:30-18:30 IST) visible per person per day.
 *
 * Sessions rather than a single login/logout pair, because the real pattern is
 * login, lunch, logout, re-login. The database's exclusion constraint stops a
 * user being logged in twice at once, which is how hours get inflated.
 */
export async function attendanceRoutes(app: FastifyInstance): Promise<void> {
  app.post('/attendance/login', async (req, reply) => {
    const user = req.requireUser();

    const row = await req.tx(async (q) => {
      const open = await q.one<{ id: string; started_at: Date }>(
        `select id, started_at from crm.attendance_sessions
          where user_id = $1 and ended_at is null`,
        [user.id],
      );
      if (open) throw conflict('already logged in');

      return q.one(
        `insert into crm.attendance_sessions (user_id, source, ip_address, user_agent)
         values ($1, $2, $3, $4)
         returning id, started_at, business_date`,
        [user.id, req.headers['x-client'] === 'mobile' ? 'mobile' : 'web', req.ip, req.headers['user-agent'] ?? null],
      );
    });

    return reply.status(201).send(row);
  });

  app.post('/attendance/logout', async (req) => {
    const user = req.requireUser();
    const row = await req.tx((q) =>
      q.one(
        `update crm.attendance_sessions
            set ended_at = now()
          where user_id = $1 and ended_at is null
          returning id, started_at, ended_at,
                    round(extract(epoch from (ended_at - started_at)) / 60)::int as minutes`,
        [user.id],
      ),
    );
    if (!row) throw conflict('no open attendance session');
    return row;
  });

  /** Today's floor attendance. Counsellors see their team; admins see everyone. */
  app.get('/attendance/today', async (req) => {
    req.requireRole('counsellor', 'admin', 'ops', 'viewer');
    return req.tx((q) =>
      q.many(
        `select * from crm.v_attendance_day
          where business_date = crm.ist_date(now())
          order by currently_logged_in desc, logged_minutes desc`,
      ),
    );
  });

  app.get('/attendance/day/:date', async (req) => {
    req.requireRole('counsellor', 'admin', 'ops', 'viewer');
    const { date } = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).parse(req.params);
    return req.tx((q) =>
      q.many(
        `select * from crm.v_attendance_day
          where business_date = $1::date
          order by logged_minutes desc`,
        [date],
      ),
    );
  });
}
