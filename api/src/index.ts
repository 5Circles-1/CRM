import { loadConfig } from './config.ts';
import { buildServer } from './server.ts';
import { Scheduler } from './jobs/scheduler.ts';

const config = loadConfig();
const app = await buildServer(config);

// Background jobs run as the ops service account; the engines they call are
// SECURITY DEFINER system actions (migration 0014).
const serviceUserId = process.env.SERVICE_USER_ID;
let scheduler: Scheduler | null = null;

if (serviceUserId) {
  scheduler = new Scheduler(app.db, serviceUserId, app.log);
  scheduler.start();
} else {
  app.log.warn(
    'SERVICE_USER_ID is not set - background jobs are disabled. ' +
      'Lead assignment sweeps, callback expiry, scoring and security detection will not run.',
  );
}

// Scheduled sheet sync: only when Google credentials are configured. Every
// run is idempotent, so overlapping or repeated syncs can never duplicate a
// lead - the worst case of a slow run is a skipped tick.
let ingestTimer: NodeJS.Timeout | null = null;
const hasSheetCreds =
  Boolean(process.env.GOOGLE_SERVICE_ACCOUNT_JSON) ||
  Boolean(process.env.GOOGLE_APPLICATION_CREDENTIALS);

if (serviceUserId && hasSheetCreds) {
  const { IngestWorker } = await import('./ingest/worker.ts');
  const worker = new IngestWorker(app.db, serviceUserId);
  const intervalMin = Number(process.env.INGEST_INTERVAL_MINUTES ?? 5);
  let running = false;
  // Every run leaves a heartbeat, so the Floor can show when the importer
  // last ran instead of the floor discovering silence days later.
  const beat = async (ms: number, error: string | null): Promise<void> => {
    try {
      await app.db.withUser(serviceUserId, (q) =>
        q.query('select crm.record_job_run($1, $2, $3)', ['sheet_sync', ms, error]),
      );
    } catch (err) {
      app.log.warn({ err }, 'could not record sheet-sync heartbeat');
    }
  };

  const syncOnce = async (): Promise<void> => {
    if (running) return;
    running = true;
    const started = Date.now();
    try {
      const summaries = await worker.runAll();
      for (const s of summaries) {
        if (s.created > 0 || s.quarantined > 0 || s.errors.length > 0) {
          app.log.info(
            { sourceId: s.sourceId, created: s.created, duplicate: s.duplicate, quarantined: s.quarantined, errors: s.errors.length },
            'sheet sync',
          );
        }
      }
      const failures = summaries.flatMap((s) => s.errors);
      await beat(Date.now() - started, failures.length ? failures.slice(0, 3).join('; ') : null);
    } catch (err) {
      app.log.error({ err }, 'sheet sync failed');
      await beat(Date.now() - started, err instanceof Error ? err.message : String(err));
    } finally {
      running = false;
    }
  };

  // Let an admin pull the sheet from the Floor screen without shell access.
  app.decorate('syncSheetsNow', async () => {
    const started = Date.now();
    try {
      const summaries = await worker.runAll();
      const failures = summaries.flatMap((s) => s.errors);
      await beat(Date.now() - started, failures.length ? failures.slice(0, 3).join('; ') : null);
      return summaries;
    } catch (err) {
      await beat(Date.now() - started, err instanceof Error ? err.message : String(err));
      throw err;
    }
  });

  // Run once at boot rather than waiting out the first interval: a restart
  // after an outage should pull the backlog immediately.
  void syncOnce();
  ingestTimer = setInterval(() => void syncOnce(), intervalMin * 60_000);
  ingestTimer.unref();
  app.log.info({ everyMinutes: intervalMin }, 'Google Sheet sync scheduled');
} else if (serviceUserId) {
  app.log.warn('no Google credentials configured - sheet sync is off; use the Admin > Ingestion screen or the ingest CLI');
}

// Scheduled Callyzer reconcile: only when the API key is configured. The
// webhook (routes/callyzer.ts) works either way; this pull is what makes a
// dropped webhook cost minutes instead of a call recorded as unverified.
// Behaviour (on/off, window, base URL) lives in crm.settings and is re-read
// every run, so flipping callyzer.enabled needs no restart.
let callyzerTimer: NodeJS.Timeout | null = null;

if (serviceUserId && process.env.CALLYZER_API_KEY) {
  const { CallyzerWorker } = await import('./integrations/callyzer/worker.ts');
  const worker = new CallyzerWorker(app.db, serviceUserId, process.env.CALLYZER_API_KEY);
  const intervalMin = Number(process.env.CALLYZER_SYNC_MINUTES ?? 15);
  let running = false;

  const beat = async (ms: number, error: string | null): Promise<void> => {
    try {
      await app.db.withUser(serviceUserId, (q) =>
        q.query('select crm.record_job_run($1, $2, $3)', ['callyzer_sync', ms, error]),
      );
    } catch (err) {
      app.log.warn({ err }, 'could not record callyzer-sync heartbeat');
    }
  };

  const syncOnce = async (): Promise<void> => {
    if (running) return;
    running = true;
    const started = Date.now();
    try {
      const summary = await worker.syncOnce();
      // Disabled in settings is a deliberate quiet, not a run: no heartbeat,
      // or the health panel would show a "working" sync that syncs nothing.
      if (summary) {
        app.log.info({ summary }, 'callyzer sync');
        await beat(Date.now() - started, null);
      }
    } catch (err) {
      app.log.error({ err }, 'callyzer sync failed');
      await beat(Date.now() - started, err instanceof Error ? err.message : String(err));
    } finally {
      running = false;
    }
  };

  // Let an admin reconcile (or backfill deeper) from the screen. Unlike the
  // timer this rethrows, so the screen shows Callyzer's own error - which for
  // a 403 is the one that matters: the subscription has expired.
  app.decorate('callyzerSyncNow', async (hours?: number) => {
    const started = Date.now();
    try {
      const summary = await worker.syncOnce(hours);
      if (summary) await beat(Date.now() - started, null);
      return summary;
    } catch (err) {
      await beat(Date.now() - started, err instanceof Error ? err.message : String(err));
      throw err;
    }
  });

  void syncOnce();
  callyzerTimer = setInterval(() => void syncOnce(), intervalMin * 60_000);
  callyzerTimer.unref();
  app.log.info({ everyMinutes: intervalMin }, 'Callyzer sync scheduled');
} else if (serviceUserId) {
  app.log.info('CALLYZER_API_KEY is not set - the Callyzer pull is off; the webhook still works if CALLYZER_WEBHOOK_SECRET is set');
}

const shutdown = async (signal: string): Promise<void> => {
  app.log.info({ signal }, 'shutting down');
  scheduler?.stop();
  if (ingestTimer) clearInterval(ingestTimer);
  if (callyzerTimer) clearInterval(callyzerTimer);
  await app.close();
  process.exit(0);
};

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ port: config.port, host: config.host });
