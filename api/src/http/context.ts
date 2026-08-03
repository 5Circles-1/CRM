import type { FastifyInstance, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import type { Database, Querier } from '../db/pool.ts';
import { resolveSession, type AuthedUser, type Role } from '../auth/credentials.ts';
import { forbidden, unauthorized } from './errors.ts';

declare module 'fastify' {
  interface FastifyRequest {
    /** Null until the auth hook has run and a valid session was presented. */
    user: AuthedUser | null;
    /** Run queries as the authenticated user, inside one RLS transaction. */
    tx<T>(fn: (q: Querier) => Promise<T>): Promise<T>;
    requireUser(): AuthedUser;
    requireRole(...roles: Role[]): AuthedUser;
  }
  interface FastifyInstance {
    db: Database;
  }
}

/**
 * Paths served without a session: health, login, and the UI shell. The UI is
 * static files only - every piece of data it renders comes from the API under
 * a session, so serving the shell publicly exposes markup, not records.
 */
function isPublicPath(url: string): boolean {
  const path = url.split('?')[0] ?? '';
  return (
    path === '/health' ||
    path === '/auth/login' ||
    path === '/' ||
    path === '/favicon.ico' ||
    path === '/ui' ||
    path.startsWith('/ui/')
  );
}

function bearerFrom(req: FastifyRequest): string | null {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice(7).trim() || null;
  return null;
}

export const contextPlugin = fp(
  async (app: FastifyInstance, opts: { db: Database; cookieName: string }) => {
    const { db, cookieName } = opts;
    app.decorate('db', db);

    app.decorateRequest('user', null);

    app.decorateRequest('tx', function <T>(this: FastifyRequest, fn: (q: Querier) => Promise<T>) {
      const user = this.user;
      if (!user) throw unauthorized();
      return db.withUser(user.id, fn);
    });

    app.decorateRequest('requireUser', function (this: FastifyRequest) {
      if (!this.user) throw unauthorized();
      return this.user;
    });

    app.decorateRequest('requireRole', function (this: FastifyRequest, ...roles: Role[]) {
      const user = this.requireUser();
      if (!roles.includes(user.role)) {
        throw forbidden(`this action requires one of: ${roles.join(', ')}`);
      }
      return user;
    });

    app.addHook('onRequest', async (req) => {
      if (isPublicPath(req.url)) return;

      const token = (req.cookies?.[cookieName] as string | undefined) ?? bearerFrom(req);
      if (!token) throw unauthorized();

      const userId = await resolveSession(db, token);
      if (!userId) throw unauthorized('session expired or revoked');

      // Role and name come from the database on every request rather than from
      // the token, so a role change or deactivation takes effect immediately
      // instead of at the next login.
      const profile = await db.withUser(userId, (q) =>
        q.one<{ id: string; role: Role; full_name: string }>(
          'select id, role, full_name from crm.users where id = $1',
          [userId],
        ),
      );
      if (!profile) throw unauthorized('user no longer active');

      req.user = { id: profile.id, role: profile.role, fullName: profile.full_name };
    });
  },
  { name: 'crm-context' },
);

/**
 * Record that a user opened a lead record.
 *
 * This is what makes a quiet bulk scrape detectable - crm.detect_bulk_access()
 * reads it. Call it wherever lead PII leaves the API.
 */
export async function logLeadAccess(
  q: Querier,
  userId: string,
  leadIds: readonly string[],
  context: 'detail' | 'list' | 'export' | 'api',
  ip: string | null,
): Promise<void> {
  if (leadIds.length === 0) return;
  await q.query(
    `insert into crm.lead_access_log (user_id, lead_id, context, ip_address)
     select $1, unnest($2::uuid[]), $3, $4`,
    [userId, leadIds, context, ip],
  );
}
