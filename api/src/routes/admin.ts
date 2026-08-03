import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { hashPassword } from '../auth/credentials.ts';
import { notFound } from '../http/errors.ts';

const uuid = z.string().uuid();

/**
 * Ops and admin surface: users, teams, sources, and the settings that hold
 * every tunable number in the system.
 */
export async function adminRoutes(app: FastifyInstance): Promise<void> {
  app.get('/admin/settings', async (req) => {
    req.requireRole('admin', 'ops', 'counsellor', 'viewer');
    return req.tx((q) =>
      q.many(`select key, value, description, updated_at from crm.settings order by key`),
    );
  });

  /**
   * Changing a target is an ops action, not a deploy. Every write here lands in
   * crm.audit_log with the actor, because "who moved the dial target" is a
   * question that gets asked the day after payout.
   */
  app.put('/admin/settings/:key', async (req) => {
    const user = req.requireRole('admin');
    const { key } = z.object({ key: z.string().min(1).max(100) }).parse(req.params);
    const body = z.object({ value: z.union([z.string(), z.number(), z.boolean()]) }).parse(req.body);

    // Store the JSON value with its type intact. Coercing everything to a
    // string would make crm.setting_int() read "95" instead of 95 and quietly
    // fall back to its default.
    const row = await req.tx((q) =>
      q.one(
        `update crm.settings
            set value = $2::jsonb, updated_by = $3, updated_at = now()
          where key = $1
          returning key, value, description`,
        [key, JSON.stringify(body.value), user.id],
      ),
    );
    if (!row) throw notFound(`no setting named ${key}`);
    return row;
  });

  app.get('/admin/users', async (req) => {
    req.requireRole('admin', 'ops', 'counsellor');
    return req.tx((q) =>
      q.many(
        `select u.id, u.full_name, u.email, u.role, u.employee_code, u.is_active,
                u.dialing_msisdn, crm.team_of(u.id, current_date) as team_id,
                t.name as team_name, tm.rotation_order
           from crm.users u
           left join crm.team_memberships tm
             on tm.user_id = u.id and tm.period @> current_date
           left join crm.teams t on t.id = tm.team_id
          order by u.role, u.full_name`,
      ),
    );
  });

  app.post('/admin/users', async (req, reply) => {
    req.requireRole('admin');
    const body = z
      .object({
        fullName: z.string().min(1).max(120),
        email: z.string().email(),
        role: z.enum(['caller', 'counsellor', 'ops', 'admin', 'viewer']),
        employeeCode: z.string().max(30).optional(),
        dialingMsisdn: z.string().max(20).optional(),
        teamId: uuid.optional(),
        rotationOrder: z.number().int().min(1).optional(),
        temporaryPassword: z.string().min(10).max(200),
      })
      .parse(req.body);

    const created = await req.tx(async (q) => {
      const user = await q.one<{ id: string }>(
        `insert into crm.users (full_name, email, role, employee_code, dialing_msisdn)
         values ($1, $2, $3, $4, crm.normalise_phone($5))
         returning id, full_name, email, role`,
        [body.fullName, body.email, body.role, body.employeeCode ?? null, body.dialingMsisdn ?? null],
      );

      if (body.teamId) {
        await q.query(
          `insert into crm.team_memberships (user_id, team_id, rotation_order)
           values ($1, $2, coalesce($3, (
             select coalesce(max(rotation_order), 0) + 1
               from crm.team_memberships where team_id = $2 and period @> current_date
           )))`,
          [user!.id, body.teamId, body.rotationOrder ?? null],
        );
      }
      return user;
    });

    // Credentials are set outside the RLS transaction: crm_app cannot touch
    // crm.user_credentials directly, only through the SECURITY DEFINER function.
    const hash = await hashPassword(body.temporaryPassword);
    await app.db.withoutUser((q) =>
      q.query('select crm.set_password($1, $2, true)', [created!.id, hash]),
    );

    return reply.status(201).send(created);
  });

  app.post('/admin/users/:id/deactivate', async (req) => {
    req.requireRole('admin');
    const { id } = z.object({ id: uuid }).parse(req.params);

    // The trigger in migration 0013 revokes live sessions as a side effect, so
    // a deactivated user is logged out immediately rather than at token expiry.
    const row = await req.tx((q) =>
      q.one(
        `update crm.users set is_active = false, deactivated_at = now()
          where id = $1 and is_active
          returning id, full_name, is_active, deactivated_at`,
        [id],
      ),
    );
    if (!row) throw notFound('no active user with that id');
    return row;
  });

  app.post('/admin/users/:id/reset-password', async (req) => {
    req.requireRole('admin');
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = z.object({ temporaryPassword: z.string().min(10).max(200) }).parse(req.body);

    const hash = await hashPassword(body.temporaryPassword);
    await app.db.withoutUser((q) => q.query('select crm.set_password($1, $2, true)', [id, hash]));
    return { ok: true, mustChangeOnNextLogin: true };
  });

  app.get('/admin/teams', async (req) => {
    req.requireRole('admin', 'ops', 'counsellor');
    return req.tx((q) =>
      q.many(
        `select t.id, t.name, t.code, t.rotation_order, t.is_active,
                (select count(*) from crm.team_memberships tm
                  join crm.users u on u.id = tm.user_id
                 where tm.team_id = t.id and tm.period @> current_date
                   and u.role = 'caller' and u.is_active) as caller_count
           from crm.teams t order by t.rotation_order`,
      ),
    );
  });

  app.get('/admin/sources', async (req) => {
    req.requireRole('admin', 'ops');
    return req.tx((q) =>
      q.many(
        `select id, name, spreadsheet_id, worksheet_name, column_map,
                pinned_team_id, default_priority, is_active, last_synced_at
           from crm.lead_sources order by name`,
      ),
    );
  });

  app.get('/admin/quarantine', async (req) => {
    req.requireRole('admin', 'ops');
    return req.tx((q) =>
      q.many(
        `select ir.id, ir.source_id, ls.name as source_name, ir.source_row_key,
                ir.reject_reason, ir.payload, ir.created_at
           from crm.ingested_rows ir
           join crm.lead_sources ls on ls.id = ir.source_id
          where ir.status = 'quarantined'
          order by ir.created_at desc limit 500`,
      ),
    );
  });

  /** Audit trail for one record. */
  app.get('/admin/audit/:table/:rowId', async (req) => {
    req.requireRole('admin');
    const { table, rowId } = z
      .object({ table: z.string().max(64), rowId: z.string().max(128) })
      .parse(req.params);
    return req.tx((q) =>
      q.many(
        `select a.action, a.changed, a.before, a.occurred_at, u.full_name as actor
           from crm.audit_log a
           left join crm.users u on u.id = a.actor_id
          where a.table_name = $1 and a.row_id = $2
          order by a.occurred_at desc limit 200`,
        [table, rowId],
      ),
    );
  });
}
