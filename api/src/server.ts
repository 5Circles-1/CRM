import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
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
import { advisoryRoutes } from './routes/advisory.ts';
import { mentorRoutes } from './routes/mentors.ts';
import { eventRoutes } from './routes/events.ts';
import { trainingRoutes } from './routes/training.ts';
import { ingestRoutes } from './routes/ingest.ts';
import { deviceLogRoutes } from './routes/deviceLogs.ts';
import { dealRoutes } from './routes/deals.ts';
import { messageRoutes } from './routes/messages.ts';

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

  // The web UI: static files under /ui/, same origin as the API so cookies
  // just work and no CORS surface exists. Routing inside the app is
  // hash-based, so no server-side SPA fallback is needed.
  await app.register(fastifyStatic, {
    root: path.join(import.meta.dirname, '..', 'public'),
    prefix: '/ui/',
    index: 'index.html',
    redirect: true,
  });
  app.get('/', async (_req, reply) => reply.redirect('/ui/'));

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
    await advisoryRoutes(scope);
    await mentorRoutes(scope);
    await eventRoutes(scope);
    await trainingRoutes(scope);
    await ingestRoutes(scope);
    await deviceLogRoutes(scope);
    await dealRoutes(scope);
    await messageRoutes(scope);
  });

  app.addHook('onClose', async () => {
    if (!db) await database.close();
  });

  return app;
}
