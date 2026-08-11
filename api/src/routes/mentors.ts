import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { badRequest, notFound } from '../http/errors.ts';

const uuid = z.string().uuid();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/**
 * Mentors: paying clients kept warm. The book lists every client with real
 * money recorded; the touchpoint log is append-only and signed; the health
 * chip is computed in crm.v_mentor_book from rules documented in the training
 * module, never maintained by hand.
 *
 * Counsellors and viewers read the book too - upsell-flagged clients are
 * their warm pipeline - but only mentors (and admin/ops) may log touchpoints,
 * and only an admin may assign a client to a mentor.
 */
export async function mentorRoutes(app: FastifyInstance): Promise<void> {
  app.get('/mentors/book', async (req) => {
    req.requireRole('mentor', 'counsellor', 'admin', 'ops', 'viewer');
    const f = z
      .object({
        health: z.enum(['green', 'amber', 'red']).optional(),
        mentorId: uuid.optional(),
        unassigned: z.coerce.boolean().optional(),
        untouchedDays: z.coerce.number().int().min(1).max(365).optional(),
        status: z.enum(['active', 'expired', 'refunded']).optional(),
        upsell: z.enum(['high', 'medium', 'low']).optional(),
        q: z.string().max(80).optional(),
      })
      .parse(req.query);

    return req.tx(async (qy) => {
      const clients = await qy.many(
        `select * from crm.v_mentor_book
          where ($1::text is null or health = $1)
            and ($2::uuid is null or mentor_id = $2)
            and (not $3::boolean or mentor_id is null)
            and ($4::int  is null or days_since_touch >= $4)
            and ($5::text is null or client_status = $5)
            and ($6::text is null or upsell_potential = $6)
            and ($7::text is null
                 or full_name ilike '%' || $7 || '%'
                 or phone_e164 like '%' || $7 || '%')
          order by case health when 'red' then 0 when 'amber' then 1 else 2 end,
                   days_since_touch desc nulls last, full_name
          limit 1000`,
        [
          f.health ?? null, f.mentorId ?? null, f.unassigned ?? false,
          f.untouchedDays ?? null, f.status ?? null, f.upsell ?? null,
          f.q?.trim() || null,
        ],
      );
      const mentors = await qy.many(
        `select id, full_name from crm.users
          where role = 'mentor' and is_active order by full_name`,
      );
      return { clients, mentors };
    });
  });

  /** One client: the book row plus their full touchpoint timeline. */
  app.get('/mentors/:dealId/timeline', async (req) => {
    req.requireRole('mentor', 'counsellor', 'admin', 'ops', 'viewer');
    const { dealId } = z.object({ dealId: uuid }).parse(req.params);
    return req.tx(async (qy) => {
      const client = await qy.one(
        `select * from crm.v_mentor_book where deal_id = $1`, [dealId],
      );
      if (!client) throw notFound('no paying client with that deal id');
      const touchpoints = await qy.many(
        `select t.*, u.full_name as mentor_name
           from crm.mentor_touchpoints t
           left join crm.users u on u.id = t.mentor_id
          where t.deal_id = $1
          order by t.touched_on desc, t.id desc`,
        [dealId],
      );
      return { client, touchpoints };
    });
  });

  /** Log a touchpoint. Three taps: channel, outcome, upsell - rest optional. */
  app.post('/mentors/:dealId/touchpoints', async (req, reply) => {
    const user = req.requireRole('mentor', 'admin', 'ops');
    const { dealId } = z.object({ dealId: uuid }).parse(req.params);
    const body = z
      .object({
        touchedOn: isoDate.optional(),
        channel: z.enum(['call', 'whatsapp', 'email', 'in_person', 'video']),
        outcome: z.enum([
          'reached_positive', 'reached_neutral', 'reached_concern',
          'no_answer', 'rescheduled',
        ]),
        note: z.string().max(2000).optional(),
        upsell: z.enum(['high', 'medium', 'low', 'none']).default('none'),
        upsellNote: z.string().max(500).optional(),
        nextTouchOn: isoDate.optional(),
      })
      .parse(req.body);

    const row = await req.tx(async (qy) => {
      // Admin and ops can see every deal, paid or not; the book only lists
      // paid ones. Anchoring the insert on the book keeps the two in step.
      const inBook = await qy.one(
        `select 1 as ok from crm.v_mentor_book where deal_id = $1`, [dealId],
      );
      if (!inBook) throw notFound('no paying client with that deal id');

      const dates = await qy.one<{ today: string; ok: boolean }>(
        `select crm.ist_date(now())::text as today,
                coalesce($1::date <= crm.ist_date(now()), true) as ok`,
        [body.touchedOn ?? null],
      );
      if (!dates?.ok) throw badRequest('a touchpoint cannot be dated in the future');

      return qy.one(
        `insert into crm.mentor_touchpoints
           (deal_id, mentor_id, touched_on, channel, outcome, note,
            upsell, upsell_note, next_touch_on)
         values ($1, $2, coalesce($3::date, crm.ist_date(now())), $4, $5, $6, $7, $8, $9::date)
         returning *`,
        [
          dealId, user.id, body.touchedOn ?? null, body.channel, body.outcome,
          body.note?.trim() || null, body.upsell,
          body.upsellNote?.trim() || null, body.nextTouchOn ?? null,
        ],
      );
    });
    reply.code(201);
    return row;
  });

  /** Assign (or unassign) the client's mentor. A personnel act: admin only. */
  app.put('/mentors/:dealId/assign', async (req) => {
    req.requireRole('admin');
    const { dealId } = z.object({ dealId: uuid }).parse(req.params);
    const { mentorId } = z
      .object({ mentorId: uuid.nullable() })
      .parse(req.body);

    return req.tx(async (qy) => {
      if (mentorId) {
        const target = await qy.one<{ role: string }>(
          `select role from crm.users where id = $1 and is_active`, [mentorId],
        );
        if (!target || target.role !== 'mentor') {
          throw badRequest('clients can only be assigned to an active mentor');
        }
      }
      const inBook = await qy.one(
        `select 1 as ok from crm.v_mentor_book where deal_id = $1`, [dealId],
      );
      if (!inBook) throw notFound('no paying client with that deal id');

      return qy.one(
        `insert into crm.advisory_checkpoints (deal_id, mentor_id)
         values ($1, $2)
         on conflict (deal_id) do update
           set mentor_id = $2, updated_at = now()
         returning deal_id, mentor_id`,
        [dealId, mentorId],
      );
    });
  });
}
