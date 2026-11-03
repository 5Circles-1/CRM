import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { hashPassword } from '../auth/credentials.ts';
import { badRequest, notFound } from '../http/errors.ts';
import { IngestWorker } from '../ingest/worker.ts';
import { normaliseSpreadsheetId, rowsFromCsv, StaticSheetReader } from '../ingest/source.ts';

/**
 * Admin: the accounts, the sources, the importer. All admin-only - these are
 * the only screens that are not for the whole floor.
 */
export async function adminRoutes(app: FastifyInstance): Promise<void> {
  // ---- users -------------------------------------------------------------

  app.get('/admin/users', async (req) => {
    req.requireRole('admin');
    return req.tx((q) =>
      q.many(
        `select id, full_name, email, role, rotation_order, is_active, created_at
           from crm.users
          where not is_service
          order by is_active desc, role, rotation_order, full_name`,
      ),
    );
  });

  app.post('/admin/users', async (req) => {
    req.requireRole('admin');
    const body = z
      .object({
        fullName: z.string().trim().min(1).max(200),
        email: z.string().trim().email().max(200),
        role: z.enum(['admin', 'caller', 'followup']),
        password: z.string().min(10).max(200),
        rotationOrder: z.coerce.number().int().min(1).max(999).optional(),
      })
      .parse(req.body);

    const hash = await hashPassword(body.password);

    return req.tx(async (q) => {
      const user = await q.one<{ id: string }>(
        `insert into crm.users (full_name, email, role, rotation_order)
         values ($1, $2, $3, coalesce($4,
           (select coalesce(max(rotation_order), 0) + 1 from crm.users
             where role = $3 and not is_service)))
         returning id`,
        [body.fullName, body.email, body.role, body.rotationOrder ?? null],
      );
      // New accounts must set their own password on first login.
      await q.query('select crm.set_password($1, $2, true)', [user!.id, hash]);
      return q.one('select id, full_name, email, role, rotation_order, is_active from crm.users where id = $1', [
        user!.id,
      ]);
    });
  });

  app.put('/admin/users/:id', async (req) => {
    const me = req.requireRole('admin');
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z
      .object({
        fullName: z.string().trim().min(1).max(200).optional(),
        role: z.enum(['admin', 'caller', 'followup']).optional(),
        rotationOrder: z.coerce.number().int().min(1).max(999).optional(),
        isActive: z.boolean().optional(),
      })
      .parse(req.body);

    if (body.isActive === false && id === me.id) {
      throw badRequest('you cannot deactivate your own account');
    }

    return req.tx(async (q) => {
      const row = await q.one(
        `update crm.users
            set full_name      = coalesce($2, full_name),
                role           = coalesce($3, role),
                rotation_order = coalesce($4, rotation_order),
                is_active      = coalesce($5, is_active),
                deactivated_at = case
                  when $5 is false then coalesce(deactivated_at, now())
                  when $5 is true then null
                  else deactivated_at end
          where id = $1 and not is_service
          returning id, full_name, email, role, rotation_order, is_active`,
        [id, body.fullName ?? null, body.role ?? null, body.rotationOrder ?? null, body.isActive ?? null],
      );
      if (!row) throw notFound('user not found');
      return row;
    });
  });

  app.post('/admin/users/:id/password', async (req) => {
    req.requireRole('admin');
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z.object({ password: z.string().min(10).max(200) }).parse(req.body);
    const hash = await hashPassword(body.password);
    // Through the SECURITY DEFINER boundary; a reset password must be changed.
    await req.tx(async (q) => {
      const user = await q.one('select id from crm.users where id = $1 and not is_service', [id]);
      if (!user) throw notFound('user not found');
    });
    await app.db.withoutUser((q) => q.query('select crm.set_password($1, $2, true)', [id, hash]));
    return { ok: true };
  });

  // ---- sources and ingestion ----------------------------------------------

  app.get('/admin/sources', async (req) => {
    req.requireRole('admin');
    return req.tx(async (q) => {
      const sources = await q.many(
        `select s.id, s.name, s.spreadsheet_id, s.worksheet_name, s.column_map,
                s.is_active, s.last_synced_at,
                r.started_at as last_run_at, r.error_text as last_run_error,
                r.rows_created as last_run_created, r.rows_quarantined as last_run_quarantined
           from crm.lead_sources s
           left join lateral (
             select * from crm.ingestion_runs
              where source_id = s.id order by started_at desc limit 1
           ) r on true
          order by s.name`,
      );
      const quarantined = await q.many(
        `select i.id, i.source_id, s.name as source_name, i.payload, i.reject_reason, i.created_at
           from crm.ingested_rows i
           join crm.lead_sources s on s.id = i.source_id
          where i.status = 'quarantined'
          order by i.created_at desc
          limit 100`,
      );
      return { sources, quarantined, syncConfigured: Boolean(app.syncSheetsNow) };
    });
  });

  app.post('/admin/sources', async (req) => {
    req.requireRole('admin');
    const body = z
      .object({
        name: z.string().trim().min(1).max(100),
        spreadsheetId: z.string().trim().max(300).optional(),
        worksheetName: z.string().max(200).optional(),
        columnMap: z.record(z.string()).optional(),
      })
      .parse(req.body);
    return req.tx((q) =>
      q.one(
        `insert into crm.lead_sources (name, spreadsheet_id, worksheet_name, column_map)
         values ($1, nullif($2, ''), nullif($3, ''), coalesce($4, '{}'::jsonb))
         returning *`,
        [
          body.name,
          // What is in the admin's clipboard is the sheet's URL; accept it.
          body.spreadsheetId ? normaliseSpreadsheetId(body.spreadsheetId) : '',
          body.worksheetName ?? '',
          JSON.stringify(body.columnMap ?? {}),
        ],
      ),
    );
  });

  app.put('/admin/sources/:id', async (req) => {
    req.requireRole('admin');
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z
      .object({
        name: z.string().trim().min(1).max(100).optional(),
        spreadsheetId: z.string().trim().max(300).nullable().optional(),
        worksheetName: z.string().max(200).nullable().optional(),
        columnMap: z.record(z.string()).optional(),
        isActive: z.boolean().optional(),
      })
      .parse(req.body);
    return req.tx(async (q) => {
      const row = await q.one(
        `update crm.lead_sources
            set name           = coalesce($2, name),
                spreadsheet_id = case when $6 then nullif($3, '') else spreadsheet_id end,
                worksheet_name = case when $7 then nullif($4, '') else worksheet_name end,
                column_map     = coalesce($5, column_map),
                is_active      = coalesce($8, is_active)
          where id = $1
          returning *`,
        [
          id,
          body.name ?? null,
          body.spreadsheetId ? normaliseSpreadsheetId(body.spreadsheetId) : '',
          body.worksheetName ?? '',
          body.columnMap ? JSON.stringify(body.columnMap) : null,
          body.spreadsheetId !== undefined,
          body.worksheetName !== undefined,
          body.isActive ?? null,
        ],
      );
      if (!row) throw notFound('source not found');
      return row;
    });
  });

  /** Pull one source from its sheet right now, as the acting admin. */
  app.post('/admin/sources/:id/sync', async (req) => {
    const me = req.requireRole('admin');
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const worker = new IngestWorker(app.db, me.id);
    const summary = await worker.runSource(id);
    return summary;
  });

  /**
   * Paste-a-CSV import. Headers map like sheet columns (the usual aliases
   * work: name / phone / email / city / campaign). Same idempotency and
   * quarantine rules as the sheet sync - importing the same file twice can
   * never duplicate a lead.
   */
  app.post('/admin/import', async (req) => {
    const me = req.requireRole('admin');
    const body = z
      .object({
        sourceId: z.string().uuid(),
        csv: z.string().min(1).max(2_000_000),
      })
      .parse(req.body);
    const rows = rowsFromCsv(body.csv);
    if (rows.length === 0) throw badRequest('the CSV has no data rows');
    const worker = new IngestWorker(app.db, me.id);
    return worker.runSource(body.sourceId, new StaticSheetReader(rows, 'csv-import'));
  });
}
