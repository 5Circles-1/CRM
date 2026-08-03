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
  ingestTimer = setInterval(async () => {
    if (running) return;
    running = true;
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
    } catch (err) {
      app.log.error({ err }, 'sheet sync failed');
    } finally {
      running = false;
    }
  }, intervalMin * 60_000);
  ingestTimer.unref();
  app.log.info({ everyMinutes: intervalMin }, 'Google Sheet sync scheduled');
} else if (serviceUserId) {
  app.log.warn('no Google credentials configured - sheet sync is off; use the Admin > Ingestion screen or the ingest CLI');
}

const shutdown = async (signal: string): Promise<void> => {
  app.log.info({ signal }, 'shutting down');
  scheduler?.stop();
  if (ingestTimer) clearInterval(ingestTimer);
  await app.close();
  process.exit(0);
};

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ port: config.port, host: config.host });
