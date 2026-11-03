import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { badRequest, notFound } from '../http/errors.ts';

/**
 * Leads: the one list screen and the write paths behind it.
 *
 * Every rule (who may move a lead, what an outcome does to the stage, the
 * qualified handover) lives in SQL functions; these handlers validate input,
 * call the function, and let the error handler map SQLSTATEs. The API never
 * filters by ownership - the whole floor sees the whole pipeline by design,
 * and RLS guarantees a session is present at all.
 */

const OUTCOMES = ['qualified', 'call_back', 'not_answered', 'switched_off', 'not_qualified'] as const;
const STAGES = ['new', 'calling', 'qualified', 'converted', 'not_qualified'] as const;

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'use YYYY-MM-DD');

const listQuery = z.object({
  q: z.string().trim().max(100).optional(),
  stage: z.enum([...STAGES, 'open'] as const).optional(),
  assigned: z.string().max(40).optional(), // uuid, 'me', or 'none'
  source: z.string().uuid().optional(),
  due: z.enum(['overdue', 'today']).optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
  offset: z.coerce.number().int().min(0).default(0),
});

export async function leadRoutes(app: FastifyInstance): Promise<void> {
  app.get('/leads', async (req) => {
    const user = req.requireUser();
    const query = listQuery.parse(req.query);

    const where: string[] = [];
    const params: unknown[] = [];
    const add = (clause: string, value: unknown): void => {
      params.push(value);
      where.push(clause.replace('?', `$${params.length}`));
    };

    if (query.q) {
      const digits = query.q.replace(/[^0-9]/g, '');
      params.push(query.q);
      const qi = params.length;
      if (digits.length >= 4) {
        // Mostly digits: they typed a phone number, in whatever format.
        params.push(`%${digits}%`);
        where.push(`(full_name ilike '%' || $${qi} || '%' or phone_e164 like $${params.length})`);
      } else {
        where.push(
          `(full_name ilike '%' || $${qi} || '%' or email::text ilike '%' || $${qi} || '%' or city ilike '%' || $${qi} || '%')`,
        );
      }
    }
    if (query.stage === 'open') where.push('is_open');
    else if (query.stage) add('stage = ?::crm.lead_stage', query.stage);

    if (query.assigned === 'me') add('assigned_to = ?', user.id);
    else if (query.assigned === 'none') where.push('assigned_to is null');
    else if (query.assigned) {
      if (!z.string().uuid().safeParse(query.assigned).success) {
        throw badRequest('assigned must be a user id, "me" or "none"');
      }
      add('assigned_to = ?', query.assigned);
    }

    if (query.source) add('source_id = ?', query.source);
    if (query.due === 'overdue') where.push(`due_bucket = 'overdue'`);
    if (query.due === 'today') where.push(`due_bucket in ('overdue', 'today')`);
    if (query.from) add('received_on >= ?', query.from);
    if (query.to) add('received_on <= ?', query.to);

    const whereSql = where.length ? `where ${where.join(' and ')}` : '';

    return req.tx(async (q) => {
      const total = await q.one<{ n: number }>(
        `select count(*) as n from crm.v_lead_list ${whereSql}`,
        params,
      );
      const rows = await q.many(
        `select * from crm.v_lead_list ${whereSql}
          order by created_at desc
          limit $${params.length + 1} offset $${params.length + 2}`,
        [...params, query.limit, query.offset],
      );
      return { total: total?.n ?? 0, leads: rows };
    });
  });

  app.get('/leads/:id', async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return req.tx(async (q) => {
      const lead = await q.one('select * from crm.v_lead_list where id = $1', [id]);
      if (!lead) throw notFound('lead not found');
      const activities = await q.many(
        `select a.id, a.kind, a.outcome, a.note, a.meta, a.created_at,
                u.full_name as user_name
           from crm.activities a
           left join crm.users u on u.id = a.user_id
          where a.lead_id = $1
          order by a.created_at desc
          limit 500`,
        [id],
      );
      return { lead, activities };
    });
  });

  app.post('/leads', async (req, reply) => {
    const user = req.requireUser();
    const body = z
      .object({
        fullName: z.string().trim().max(200).optional(),
        phone: z.string().trim().min(5).max(30),
        email: z.string().trim().email().max(200).optional().or(z.literal('').transform(() => undefined)),
        city: z.string().trim().max(100).optional(),
        note: z.string().trim().max(2000).optional(),
        assignedTo: z.string().uuid().optional(),
        sourceId: z.string().uuid().optional(),
      })
      .parse(req.body);

    const result = await req.tx(async (q) => {
      const norm = await q.one<{ phone: string | null }>(
        'select crm.normalise_phone($1) as phone',
        [body.phone],
      );
      if (!norm?.phone) throw badRequest(`"${body.phone}" is not a dialable phone number`);

      const existing = await q.one<{ id: string; full_name: string | null; stage: string }>(
        `select id, full_name, stage from crm.leads
          where phone_e164 = $1
            and (stage in ('new', 'calling', 'qualified')
                 or created_at > now() - make_interval(days => crm.setting_int('lead.dedupe_window_days', 90)))
          order by (stage in ('new', 'calling', 'qualified')) desc, created_at desc
          limit 1`,
        [norm.phone],
      );
      if (existing) return { existing };

      const sourceId =
        body.sourceId ??
        (await q.one<{ id: string }>(`select id from crm.lead_sources where name = 'Manual'`))?.id;
      if (!sourceId) throw badRequest('no source given and no "Manual" source exists');

      const lead = await q.one<{ id: string }>(
        `insert into crm.leads (source_id, full_name, phone_e164, phone_raw, email, city, assigned_to)
         values ($1, nullif($2, ''), $3, $4, $5, nullif($6, ''), $7)
         returning id`,
        [sourceId, body.fullName ?? '', norm.phone, body.phone, body.email ?? null, body.city ?? '', body.assignedTo ?? null],
      );

      if (body.note) {
        await q.query(
          `insert into crm.activities (lead_id, user_id, kind, note) values ($1, $2, 'note', $3)`,
          [lead!.id, user.id, body.note],
        );
      }

      return { lead: await q.one('select * from crm.v_lead_list where id = $1', [lead!.id]) };
    });

    if ('existing' in result && result.existing) {
      // The UI opens the existing lead from this payload, so the duplicate is
      // one click away instead of a dead end.
      return reply.status(409).send({
        error: 'duplicate',
        message: `${result.existing.full_name ?? 'A lead'} already has this number — open that lead instead of creating a second one.`,
        leadId: result.existing.id,
      });
    }
    return result.lead;
  });

  /** Log a call. The one way an outcome enters the system. */
  app.post('/leads/:id/call', async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z
      .object({
        outcome: z.enum(OUTCOMES),
        note: z.string().trim().max(2000).optional(),
        nextFollowUpAt: z.string().datetime({ offset: true }).optional(),
      })
      .parse(req.body);

    return req.tx(async (q) => {
      await q.query('select crm.log_call($1, $2, $3, $4)', [
        id,
        body.outcome,
        body.note ?? null,
        body.nextFollowUpAt ?? null,
      ]);
      return q.one('select * from crm.v_lead_list where id = $1', [id]);
    });
  });

  app.post('/leads/:id/note', async (req) => {
    const user = req.requireUser();
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z.object({ note: z.string().trim().min(1).max(2000) }).parse(req.body);
    return req.tx(async (q) => {
      const lead = await q.one('select id from crm.leads where id = $1', [id]);
      if (!lead) throw notFound('lead not found');
      await q.query(
        `insert into crm.activities (lead_id, user_id, kind, note) values ($1, $2, 'note', $3)`,
        [id, user.id, body.note],
      );
      return { ok: true };
    });
  });

  app.post('/leads/:id/assign', async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z.object({ userId: z.string().uuid() }).parse(req.body);
    return req.tx(async (q) => {
      await q.query('select crm.assign_lead($1, $2)', [id, body.userId]);
      return q.one('select * from crm.v_lead_list where id = $1', [id]);
    });
  });

  /** Invite sent / confirmed / converted. */
  app.post('/leads/:id/checkpoint', async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z
      .object({
        kind: z.enum(['template_sent', 'confirmed', 'converted']),
        on: z.boolean(),
      })
      .parse(req.body);
    return req.tx(async (q) => {
      await q.query('select crm.set_checkpoint($1, $2, $3)', [id, body.kind, body.on]);
      return q.one('select * from crm.v_lead_list where id = $1', [id]);
    });
  });

  app.post('/leads/:id/reopen', async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return req.tx(async (q) => {
      await q.query('select crm.reopen_lead($1)', [id]);
      return q.one('select * from crm.v_lead_list where id = $1', [id]);
    });
  });

  /** The people a lead can be given to, for pickers. */
  app.get('/leads/meta/options', async (req) => {
    req.requireUser();
    return req.tx(async (q) => {
      const users = await q.many(
        `select id, full_name, role from crm.users
          where is_active and not is_service
          order by role, rotation_order, full_name`,
      );
      const sources = await q.many(
        `select id, name from crm.lead_sources where is_active order by name`,
      );
      return { users, sources };
    });
  });
}
