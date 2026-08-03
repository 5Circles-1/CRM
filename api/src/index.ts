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

const shutdown = async (signal: string): Promise<void> => {
  app.log.info({ signal }, 'shutting down');
  scheduler?.stop();
  await app.close();
  process.exit(0);
};

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ port: config.port, host: config.host });
