import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import type { Config } from './config.ts';
import { Database } from './db/pool.ts';
import { contextPlugin } from './http/context.ts';
import { registerErrorHandler } from './http/errors.ts';
import { authRoutes } from './routes/auth.ts';
import { meRoutes } from './routes/me.ts';
import { leadRoutes } from './routes/leads.ts';
import { transferRoutes } from './routes/transfers.ts';
import { attendanceRoutes } from './routes/attendance.ts';
import { dashboardRoutes } from './routes/dashboards.ts';
import { adminRoutes } from './routes/admin.ts';
import { ingestRoutes } from './routes/ingest.ts';

export async function buildServer(config: Config, db?: Database): Promise<FastifyInstance> {
  const database = db ?? new Database(config.databaseUrl);

  // Boot-time guard: a role that bypasses RLS turns every policy in migration
  // 0012 into decoration, and the failure is silent - everything works and
  // everyone sees everything. Refuse to start instead.
  await database.assertNotBypassingRls();

  const app = Fastify({
    logger: { level: config.logLevel },
    trustProxy: true,
    bodyLimit: 1_000_000,
  });

  registerErrorHandler(app);

  await app.register(cookie);
  await app.register(contextPlugin, { db: database, cookieName: config.cookieName });

  app.get('/health', async () => ({ ok: true }));

  await app.register(async (scope) => {
    await authRoutes(scope, {
      cookieName: config.cookieName,
      secureCookies: config.secureCookies,
    });
    await meRoutes(scope);
    await leadRoutes(scope);
    await transferRoutes(scope);
    await attendanceRoutes(scope);
    await dashboardRoutes(scope);
    await adminRoutes(scope);
    await ingestRoutes(scope);
  });

  app.addHook('onClose', async () => {
    if (!db) await database.close();
  });

  return app;
}
