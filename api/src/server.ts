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
import { dashboardRoutes } from './routes/dashboard.ts';
import { adminRoutes } from './routes/admin.ts';

export async function buildServer(config: Config, db?: Database): Promise<FastifyInstance> {
  const database = db ?? new Database(config.databaseUrl);

  // Boot-time guard: a role that bypasses RLS turns every policy into
  // decoration, and the failure is silent - everything works and everyone
  // sees everything, logged in or not. Refuse to start instead.
  await database.assertNotBypassingRls();

  const app = Fastify({
    logger: { level: config.logLevel },
    trustProxy: true,
    bodyLimit: 4_000_000, // the CSV import arrives as one JSON body
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
      cookieDomain: config.cookieDomain,
    });
    await meRoutes(scope);
    await leadRoutes(scope);
    await dashboardRoutes(scope);
    await adminRoutes(scope);
  });

  app.addHook('onClose', async () => {
    if (!db) await database.close();
  });

  return app;
}
