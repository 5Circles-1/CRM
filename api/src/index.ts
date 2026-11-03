import { loadConfig } from './config.ts';
import { buildServer } from './server.ts';

const config = loadConfig();
const app = await buildServer(config);

// Scheduled sheet sync: only when Google credentials are configured. Every
// run is idempotent, so overlapping or repeated syncs can never duplicate a
// lead - the worst case of a slow run is a skipped tick.
let ingestTimer: NodeJS.Timeout | null = null;
const serviceUserId = process.env.SERVICE_USER_ID;
const hasSheetCreds =
  Boolean(process.env.GOOGLE_SERVICE_ACCOUNT_JSON) ||
  Boolean(process.env.GOOGLE_APPLICATION_CREDENTIALS);

if (serviceUserId && hasSheetCreds) {
  const { IngestWorker } = await import('./ingest/worker.ts');
  const worker = new IngestWorker(app.db, serviceUserId);
  const intervalMin = Number(process.env.INGEST_INTERVAL_MINUTES ?? 5);
  let running = false;

  const syncOnce = async (): Promise<void> => {
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
  };

  // Let an admin pull every sheet from the Admin screen without shell access.
  app.decorate('syncSheetsNow', async () => worker.runAll());

  // Run once at boot rather than waiting out the first interval: a restart
  // after an outage should pull the backlog immediately.
  void syncOnce();
  ingestTimer = setInterval(() => void syncOnce(), intervalMin * 60_000);
  ingestTimer.unref();
  app.log.info({ everyMinutes: intervalMin }, 'Google Sheet sync scheduled');
} else {
  app.log.warn(
    'scheduled sheet sync is off (set SERVICE_USER_ID and Google credentials to enable it) - '
      + 'the Admin screen can still sync a source on demand and import CSVs',
  );
}

const shutdown = async (signal: string): Promise<void> => {
  app.log.info({ signal }, 'shutting down');
  if (ingestTimer) clearInterval(ingestTimer);
  await app.close();
  process.exit(0);
};

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ port: config.port, host: config.host });
