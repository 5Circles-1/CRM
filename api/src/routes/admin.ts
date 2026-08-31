import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { hashPassword } from '../auth/credentials.ts';
import { normaliseSpreadsheetId, rowsFromCsv } from '../ingest/source.ts';
import { mapRow } from '../ingest/worker.ts';
import { badRequest, notFound } from '../http/errors.ts';

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
                u.dialing_msisdn, u.avatar_url,
                crm.team_of(u.id, current_date) as team_id,
                t.name as team_name, tm.rotation_order,
                crm.tier_of(u.id) as tier,
                (pt.pinned_by is not null
                 and (pt.pin_expires_at is null or pt.pin_expires_at > now())) as tier_pinned,
                pt.pin_reason as tier_pin_reason,
                pt.pin_expires_at as tier_pin_expires_at
           from crm.users u
           left join crm.team_memberships tm
             on tm.user_id = u.id and tm.period @> current_date
           left join crm.teams t on t.id = tm.team_id
           left join crm.performance_tiers pt on pt.user_id = u.id
          order by u.role, u.full_name`,
      ),
    );
  });

  /**
   * Pin a caller's tier, or hand it back to the daily ranking.
   *
   * The ranking (crm.rank_performance_tiers) decides ACE automatically; a pin
   * is the human override - it needs a reason, it can expire, and it lands in
   * the audit log via the performance_tiers audit trigger. mode 'auto' clears
   * the pin so the next ranking run owns the seat again.
   */
  app.put('/admin/users/:id/tier', async (req) => {
    const actor = req.requireRole('admin');
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = z
      .discriminatedUnion('mode', [
        z.object({ mode: z.literal('auto') }),
        z.object({
          mode: z.literal('pin'),
          tier: z.enum(['ace', 'standard', 'restricted']),
          reason: z.string().trim().min(3).max(300),
          expiresAt: z.coerce.date().nullable().optional(),
        }),
      ])
      .parse(req.body);

    return req.tx(async (q) => {
      const target = await q.one<{ role: string }>(
        `select role from crm.users where id = $1 and is_active`, [id],
      );
      if (!target) throw notFound('no active user with that id');
      if (target.role !== 'caller') {
        throw badRequest('tiers apply to callers - they shape fresh-lead distribution');
      }

      if (body.mode === 'auto') {
        // Reset to standard NOW rather than leaving the pinned value to
        // linger until the next ranking run - un-pinning a RESTRICTED caller
        // must not keep them blocked for another fifteen minutes.
        await q.query(
          `update crm.performance_tiers
              set tier = 'standard',
                  pinned_by = null, pin_reason = null, pin_expires_at = null,
                  updated_at = now()
            where user_id = $1`,
          [id],
        );
        return { userId: id, mode: 'auto' };
      }

      const row = await q.one(
        `insert into crm.performance_tiers
           (user_id, tier, pinned_by, pin_reason, pin_expires_at, updated_at)
         values ($1, $2, $3, $4, $5, now())
         on conflict (user_id) do update
            set tier = excluded.tier, pinned_by = excluded.pinned_by,
                pin_reason = excluded.pin_reason,
                pin_expires_at = excluded.pin_expires_at, updated_at = now()
         returning user_id, tier, pin_reason, pin_expires_at`,
        [id, body.tier, actor.id, body.reason, body.expiresAt ?? null],
      );
      return { mode: 'pin', ...row };
    });
  });

  app.post('/admin/users', async (req, reply) => {
    req.requireRole('admin');
    const body = z
      .object({
        fullName: z.string().min(1).max(120),
        email: z.string().email(),
        role: z.enum(['caller', 'counsellor', 'mentor', 'ops', 'admin', 'viewer']),
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

  /**
   * Bring a deactivated account back.
   *
   * Without this the only route back was a second account on a new email, which
   * splits one person's history across two rows - their leads, calls and scores
   * stay behind on the account nobody uses.
   *
   * The password is deliberately not restored: whoever is reactivating should
   * set a fresh one through reset-password, because the reason for the original
   * deactivation is not recorded here.
   */
  app.post('/admin/users/:id/reactivate', async (req) => {
    req.requireRole('admin');
    const { id } = z.object({ id: uuid }).parse(req.params);
    const row = await req.tx((q) =>
      q.one(
        `update crm.users set is_active = true, deactivated_at = null
          where id = $1 and not is_active
          returning id, full_name, email, role, is_active`,
        [id],
      ),
    );
    if (!row) throw notFound('no deactivated user with that id');
    return row;
  });

  /**
   * Set or clear a person's Dialing SIM after creation.
   *
   * This number is how device call logs - the in-house app's and Callyzer's
   * alike - are matched back to a person, so it is the fix for a Callyzer
   * number showing as unmapped: set it here and the next sync re-ingests the
   * quarantined calls. Kept as its own small route because it is the ONE
   * mapping fact; there is deliberately no second table to edit.
   */
  app.put('/admin/users/:id/dialing-msisdn', async (req) => {
    req.requireRole('admin');
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = z.object({ dialingMsisdn: z.string().max(20).nullable() }).parse(req.body);

    if (body.dialingMsisdn !== null) {
      const norm = await req.tx((q) =>
        q.one<{ normalise_phone: string | null }>('select crm.normalise_phone($1) as normalise_phone', [
          body.dialingMsisdn,
        ]),
      );
      if (!norm?.normalise_phone) {
        throw badRequest(`"${body.dialingMsisdn}" is not a dialable number`);
      }
    }

    const row = await req.tx((q) =>
      q.one(
        `update crm.users set dialing_msisdn = crm.normalise_phone($2)
          where id = $1
          returning id, full_name, dialing_msisdn`,
        [id, body.dialingMsisdn],
      ),
    );
    if (!row) throw notFound('no user with that id');
    return row;
  });

  /**
   * Set or clear a person's leaderboard icon.
   *
   * The image arrives as a data URL the browser has already downsized, and is
   * stored inline on the user row - no file store to run or leak. The format
   * allow-list plus the size cap (matching the DB check constraint) keeps this
   * from becoming an arbitrary-file upload with extra steps.
   */
  app.put('/admin/users/:id/avatar', async (req) => {
    req.requireRole('admin');
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = z
      .object({
        dataUrl: z
          .string()
          .max(200_000)
          .regex(/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/)
          .nullable(),
      })
      .parse(req.body);

    const row = await req.tx((q) =>
      q.one(
        `update crm.users set avatar_url = $2, updated_at = now()
          where id = $1
          returning id, full_name, (avatar_url is not null) as has_avatar`,
        [id, body.dataUrl],
      ),
    );
    if (!row) throw notFound('no user with that id');
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

  const sourceBody = z.object({
    name: z.string().min(1).max(120),
    spreadsheetId: z.string().max(120).optional(),
    worksheetName: z.string().max(120).optional(),
    columnMap: z.record(z.string()).optional(),
    pinnedTeamId: uuid.nullable().optional(),
    defaultPriority: z.enum(['immediate', 'normal']).default('normal'),
    isActive: z.boolean().default(true),
  });

  app.post('/admin/sources', async (req, reply) => {
    req.requireRole('admin', 'ops');
    const body = sourceBody.parse(req.body);
    const row = await req.tx((q) =>
      q.one(
        `insert into crm.lead_sources
           (name, spreadsheet_id, worksheet_name, column_map, pinned_team_id, default_priority, is_active)
         values ($1, $2, $3, coalesce($4::jsonb, '{}'::jsonb), $5, $6, $7)
         returning id, name, spreadsheet_id, worksheet_name, column_map, default_priority, is_active`,
        [
          body.name,
          body.spreadsheetId ? normaliseSpreadsheetId(body.spreadsheetId) : null,
          body.worksheetName ?? null,
          body.columnMap ? JSON.stringify(body.columnMap) : null,
          body.pinnedTeamId ?? null,
          body.defaultPriority,
          body.isActive,
        ],
      ),
    );
    return reply.status(201).send(row);
  });

  app.put('/admin/sources/:id', async (req) => {
    req.requireRole('admin', 'ops');
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = sourceBody.partial().parse(req.body);

    // Unpinning a source is `pinnedTeamId: null`, which coalesce() cannot tell
    // apart from "field not supplied". Send the intent separately so a sheet
    // pinned to one team can be handed back to the alternating rotation.
    const unpin = 'pinnedTeamId' in (req.body as object) && body.pinnedTeamId == null;

    const row = await req.tx((q) =>
      q.one(
        `update crm.lead_sources set
           name             = coalesce($2, name),
           spreadsheet_id   = coalesce($3, spreadsheet_id),
           worksheet_name   = coalesce($4, worksheet_name),
           column_map       = coalesce($5::jsonb, column_map),
           pinned_team_id   = case when $9 then null else coalesce($6, pinned_team_id) end,
           default_priority = coalesce($7::crm.lead_priority, default_priority),
           is_active        = coalesce($8, is_active),
           updated_at       = now()
         where id = $1
         returning id, name, spreadsheet_id, worksheet_name, column_map,
                   pinned_team_id, default_priority, is_active`,
        [
          id,
          body.name ?? null,
          body.spreadsheetId ? normaliseSpreadsheetId(body.spreadsheetId) : null,
          body.worksheetName ?? null,
          body.columnMap ? JSON.stringify(body.columnMap) : null,
          body.pinnedTeamId ?? null,
          body.defaultPriority ?? null,
          body.isActive ?? null,
          unpin,
        ],
      ),
    );
    if (!row) throw notFound('no source with that id');
    return row;
  });

  app.post('/admin/products', async (req, reply) => {
    req.requireRole('admin');
    const body = z
      .object({
        name: z.string().min(1).max(120),
        code: z.string().min(1).max(30),
        listPriceInr: z.number().positive().max(99_999_999),
        isSebiRegulated: z.boolean().default(true),
      })
      .parse(req.body);
    const row = await req.tx((q) =>
      q.one(
        `insert into crm.products (name, code, list_price_inr, is_sebi_regulated)
         values ($1, $2, $3, $4)
         returning id, name, code, list_price_inr, is_sebi_regulated, is_active`,
        [body.name, body.code, body.listPriceInr, body.isSebiRegulated],
      ),
    );
    return reply.status(201).send(row);
  });

  app.post('/admin/products/:id/deactivate', async (req) => {
    req.requireRole('admin');
    const { id } = z.object({ id: uuid }).parse(req.params);
    const row = await req.tx((q) =>
      q.one(
        `update crm.products set is_active = false where id = $1 and is_active
         returning id, name, is_active`,
        [id],
      ),
    );
    if (!row) throw notFound('no active product with that id');
    return row;
  });

  /**
   * Park everything older than a date - the "clean CRM" button.
   *
   * The SQL function owns the rules (admin gate re-checked inside, clients
   * and recently-worked leads untouched, nothing deleted); this handler only
   * shapes the request. dryRun counts what would move, so the button can say
   * "this will park 117 leads" before anything happens.
   */
  app.post('/admin/archive-leads', async (req) => {
    req.requireRole('admin', 'ops');
    const body = z
      .object({
        before: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'before must be YYYY-MM-DD'),
        dryRun: z.boolean().default(false),
      })
      .parse(req.body);

    const row = await req.tx((q) =>
      q.one<{ archived: number }>(
        `select crm.archive_leads_before($1::date, $2) as archived`,
        [body.before, body.dryRun],
      ),
    );
    return { cutoff: body.before, dryRun: body.dryRun, archived: Number(row!.archived) };
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

  /**
   * Upload a previous month's records, team-wise and month-wise.
   *
   * These are history, not live leads: they land parked in the previous-month
   * pool (status nurture, no caller, no SLA clock) so they never clog the
   * calling queue, and the counsellor works them from the Previous-months tab
   * when they choose. Excel exports to CSV in one click, so the same paste box
   * as normal ingestion takes them; the team and month are chosen here rather
   * than guessed from the file.
   */
  app.post('/admin/history/import', async (req) => {
    const user = req.requireRole('admin', 'ops');
    const body = z
      .object({
        csv: z.string().min(1).max(20_000_000),
        teamId: uuid,
        // The calendar month these records belong to, as YYYY-MM.
        month: z.string().regex(/^\d{4}-\d{2}$/),
        columnMap: z.record(z.string()).optional(),
      })
      .parse(req.body);

    const rows = rowsFromCsv(body.csv);
    if (rows.length === 0) throw badRequest('no data rows found in the CSV');

    const monthStart = `${body.month}-01`;
    const batch = `${body.month}-${Date.now().toString(36)}`;

    return req.tx(async (q) => {
      const team = await q.one<{ id: string }>(
        `select id from crm.teams where id = $1 and is_active`,
        [body.teamId],
      );
      if (!team) throw badRequest('unknown or inactive team');

      let created = 0;
      let duplicate = 0;
      let skipped = 0;
      const errors: string[] = [];

      for (const row of rows) {
        try {
          const { mapped, extra } = mapRow(row.values, body.columnMap ?? {});
          const rawPhone = mapped.phone ?? '';
          const norm = await q.one<{ normalise_phone: string | null }>(
            'select crm.normalise_phone($1) as normalise_phone',
            [rawPhone],
          );
          const phone = norm?.normalise_phone ?? null;
          if (!phone) {
            skipped += 1;
            continue;
          }
          // De-duplicate against EVERY live lead, not just this month's pool.
          // The old check only looked inside the same imported month, so the
          // same person uploaded in January's sheet (Team A) and February's
          // sheet (Team B) became two live leads - one in each team's book.
          // If any live row exists - live pipeline or another month's pool -
          // this row is a duplicate of it, wherever it is. Only people whose
          // every earlier lead is terminal get a fresh pool row.
          const exists = await q.one<{ id: string }>(
            `select id from crm.leads
              where phone_e164 = $1
                and status in ('new', 'working', 'callback', 'qualified', 'negotiation', 'nurture')
              limit 1`,
            [phone],
          );
          if (exists) {
            duplicate += 1;
            continue;
          }
          await q.query(
            `insert into crm.leads
               (full_name, phone_e164, phone_raw, email, city, team_id, status,
                pool, is_historical, imported_month, import_batch, extra)
             values ($1, $2, $3, nullif($4,''), nullif($5,''), $6, 'nurture',
                     'previous_month', true, $7::date, $8, $9)`,
            [
              mapped.full_name ?? null,
              phone,
              rawPhone,
              mapped.email ?? '',
              mapped.city ?? '',
              body.teamId,
              monthStart,
              batch,
              JSON.stringify(extra),
            ],
          );
          created += 1;
        } catch (err) {
          errors.push(`${row.rowKey}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      return { batch, seen: rows.length, created, duplicate, skipped, errors };
    });
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
