import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { IngestWorker } from '../ingest/worker.ts';
import { rowsFromCsv, StaticSheetReader } from '../ingest/source.ts';
import { badRequest, conflict, forbidden, notFound, HttpError } from '../http/errors.ts';

const uuid = z.string().uuid();

/**
 * Turn whatever the sheet reader threw into something an ops person can act
 * on. Google's own messages are good ("Unable to parse range", "The caller
 * does not have permission"); the failure was that they never reached the
 * screen - the route let the error escape as an unhandled 500, which the UI
 * renders as "something went wrong".
 */
function ingestFailure(err: unknown): HttpError {
  const raw =
    (err as { errors?: Array<{ message?: string }> })?.errors?.[0]?.message ??
    (err instanceof Error ? err.message : String(err));

  if (/parse range/i.test(raw)) {
    return conflict(
      `${raw}. Check the worksheet tab name on the source matches the tab in the sheet exactly.`,
    );
  }
  if (/permission|forbidden|403/i.test(raw)) {
    return forbidden(
      `${raw}. Share the sheet with the service account as a Viewer, then try again.`,
    );
  }
  if (/not found|404/i.test(raw)) {
    return notFound(`${raw}. Check the spreadsheet id on the source.`);
  }
  if (/credential|authent|401|invalid_grant/i.test(raw)) {
    return conflict(
      `${raw}. The Google service-account key looks wrong or expired - check GOOGLE_APPLICATION_CREDENTIALS.`,
    );
  }
  return conflict(raw);
}

export async function ingestRoutes(app: FastifyInstance): Promise<void> {
  /** Trigger a sync on demand. The scheduled worker does the same thing. */
  app.post('/ingest/sources/:id/run', async (req) => {
    const user = req.requireRole('ops', 'admin');
    const { id } = z.object({ id: uuid }).parse(req.params);
    const worker = new IngestWorker(app.db, user.id);
    try {
      return await worker.runSource(id);
    } catch (err) {
      req.log.error({ err }, 'sheet sync failed');
      throw ingestFailure(err);
    }
  });

  /**
   * Paste-a-CSV import, for the day the Sheets integration is down or a batch
   * arrives from somewhere else. Same code path as the sheet reader, so it gets
   * the same idempotency, dedupe and quarantine behaviour.
   */
  app.post('/ingest/sources/:id/csv', async (req) => {
    const user = req.requireRole('ops', 'admin');
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = z.object({ csv: z.string().min(1).max(5_000_000) }).parse(req.body);

    const rows = rowsFromCsv(body.csv);
    if (rows.length === 0) throw badRequest('no data rows found in the CSV');

    const worker = new IngestWorker(app.db, user.id);
    return worker.runSource(id, new StaticSheetReader(rows, 'csv-upload'));
  });

  app.get('/ingest/runs', async (req) => {
    req.requireRole('ops', 'admin');
    const { sourceId } = z.object({ sourceId: uuid.optional() }).parse(req.query);
    return req.tx((q) =>
      q.many(
        `select r.*, s.name as source_name
           from crm.ingestion_runs r
           join crm.lead_sources s on s.id = r.source_id
          where ($1::uuid is null or r.source_id = $1)
          order by r.started_at desc limit 50`,
        [sourceId ?? null],
      ),
    );
  });

  /**
   * Re-run a quarantined row after ops has corrected it. Nothing is dropped by
   * the pipeline, so everything that failed validation is still here to fix.
   */
  app.post('/ingest/quarantine/:rowId/replay', async (req) => {
    const user = req.requireRole('ops', 'admin');
    const { rowId } = z.object({ rowId: uuid }).parse(req.params);
    const body = z.object({ values: z.record(z.string()) }).parse(req.body);

    const row = await req.tx((q) =>
      q.one<{ source_id: string; source_row_key: string }>(
        `select source_id, source_row_key from crm.ingested_rows
          where id = $1 and status = 'quarantined'`,
        [rowId],
      ),
    );
    if (!row) throw badRequest('no quarantined row with that id');

    const worker = new IngestWorker(app.db, user.id);
    return worker.runSource(
      row.source_id,
      new StaticSheetReader([{ rowKey: row.source_row_key, values: body.values }], 'replay'),
    );
  });
}
