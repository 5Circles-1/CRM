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

// Tata Tele Smartflo: one shared client serves click-to-call and the
// scheduled CDR reconcile, so both draw on one rate budget and one login.
// The webhook (routes/tataTele.ts) works without any of this; the pull is
// what makes a dropped webhook cost minutes instead of a call recorded as
// unverified. Behaviour (on/off, window, base URL) lives in crm.settings and
// is re-read every run, so flipping tata_tele.enabled needs no restart.
let tataTeleTimer: NodeJS.Timeout | null = null;

const { tataTeleAuthFromEnv } = await import('./integrations/tata_tele/client.ts');
const tataAuth = tataTeleAuthFromEnv();

if (tataAuth) {
  const { TataTeleClient } = await import('./integrations/tata_tele/client.ts');
  const client = new TataTeleClient({
    auth: tataAuth,
    baseUrl: 'https://api-smartflo.tatateleservices.com/v1/',
  });
  // Click-to-call needs only credentials, not the service account.
  app.decorate('tataTele', client);

  if (serviceUserId) {
    const { TataTeleWorker } = await import('./integrations/tata_tele/worker.ts');
    const worker = new TataTeleWorker(app.db, serviceUserId, client);
    const intervalMin = Number(process.env.TATA_TELE_SYNC_MINUTES ?? 15);
    let running = false;

    const beat = async (ms: number, error: string | null): Promise<void> => {
      try {
        await app.db.withUser(serviceUserId, (q) =>
          q.query('select crm.record_job_run($1, $2, $3)', ['tata_tele_sync', ms, error]),
        );
      } catch (err) {
        app.log.warn({ err }, 'could not record tata-tele-sync heartbeat');
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
          app.log.info({ summary }, 'tata tele sync');
          await beat(Date.now() - started, null);
        }
      } catch (err) {
        app.log.error({ err }, 'tata tele sync failed');
        await beat(Date.now() - started, err instanceof Error ? err.message : String(err));
      } finally {
        running = false;
      }
    };

    // Let an admin reconcile (or backfill deeper) from the screen. Unlike the
    // timer this rethrows, so the screen shows Smartflo's own error - which
    // for a 401 is the one that matters: the login has expired.
    app.decorate('tataTeleSyncNow', async (hours?: number) => {
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
    tataTeleTimer = setInterval(() => void syncOnce(), intervalMin * 60_000);
    tataTeleTimer.unref();
    app.log.info({ everyMinutes: intervalMin }, 'Tata Tele sync scheduled');
  }
} else {
  app.log.info(
    'Tata Tele credentials are not set (TATA_TELE_LOGIN_EMAIL/TATA_TELE_LOGIN_PASSWORD or '
      + 'TATA_TELE_API_TOKEN) - click-to-call and the CDR pull are off; the webhook still works '
      + 'if TATA_TELE_WEBHOOK_SECRET is set',
  );
}

const shutdown = async (signal: string): Promise<void> => {
  app.log.info({ signal }, 'shutting down');
  scheduler?.stop();
  if (ingestTimer) clearInterval(ingestTimer);
  if (tataTeleTimer) clearInterval(tataTeleTimer);
  await app.close();
  process.exit(0);
};

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ port: config.port, host: config.host });
