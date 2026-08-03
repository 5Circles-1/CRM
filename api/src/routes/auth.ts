import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { attemptLogin, createSession, hashPassword, revokeSession } from '../auth/credentials.ts';
import { badRequest, unauthorized } from '../http/errors.ts';

export async function authRoutes(
  app: FastifyInstance,
  opts: { cookieName: string; secureCookies: boolean },
): Promise<void> {
  const cookieOptions = {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: opts.secureCookies,
    path: '/',
  };

  app.post('/auth/login', async (req, reply) => {
    const body = z
      .object({ email: z.string().email(), password: z.string().min(1).max(200) })
      .parse(req.body);

    const outcome = await attemptLogin(app.db, body.email, body.password);

    if (!outcome.ok) {
      // The lockout is worth telling the user about - otherwise they retry,
      // extend the lock, and call the ops team. Everything else is deliberately
      // indistinguishable so accounts cannot be enumerated.
      if (outcome.reason === 'locked') {
        return reply
          .status(423)
          .send({ error: 'account_locked', message: 'too many failed attempts; try again later' });
      }
      throw unauthorized('invalid email or password');
    }

    const { token, expiresAt } = await createSession(
      app.db,
      outcome.user!.id,
      req.ip,
      req.headers['user-agent'] ?? null,
    );

    reply.setCookie(opts.cookieName, token, { ...cookieOptions, expires: expiresAt });

    return {
      user: outcome.user,
      expiresAt,
      mustChangePassword: outcome.mustChangePassword ?? false,
      // Returned for the Android app, which does not use cookies.
      token,
    };
  });

  app.post('/auth/logout', async (req, reply) => {
    const token =
      (req.cookies?.[opts.cookieName] as string | undefined) ??
      (req.headers.authorization?.startsWith('Bearer ')
        ? req.headers.authorization.slice(7)
        : undefined);

    if (token) await revokeSession(app.db, token);
    reply.clearCookie(opts.cookieName, cookieOptions);
    return { ok: true };
  });

  app.post('/auth/change-password', async (req) => {
    const user = req.requireUser();
    const body = z
      .object({
        currentPassword: z.string().min(1),
        newPassword: z.string().min(10).max(200),
      })
      .parse(req.body);

    if (body.currentPassword === body.newPassword) {
      throw badRequest('the new password must be different');
    }

    const outcome = await req.tx(async (q) => {
      const row = await q.one<{ email: string }>('select email from crm.users where id = $1', [
        user.id,
      ]);
      return row;
    });
    if (!outcome) throw unauthorized();

    const check = await attemptLogin(app.db, outcome.email, body.currentPassword);
    if (!check.ok) throw unauthorized('current password is incorrect');

    const hash = await hashPassword(body.newPassword);
    await app.db.withoutUser((q) =>
      q.query('select crm.set_password($1, $2, false)', [user.id, hash]),
    );

    return { ok: true };
  });
}
