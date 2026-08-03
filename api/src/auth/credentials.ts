import argon2 from 'argon2';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Database } from '../db/pool.ts';

export type Role = 'caller' | 'counsellor' | 'ops' | 'admin' | 'viewer';

export interface AuthedUser {
  id: string;
  role: Role;
  fullName: string;
}

const ARGON_OPTIONS: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: 19 * 1024,
  timeCost: 2,
  parallelism: 1,
};

export const hashPassword = (plain: string): Promise<string> => argon2.hash(plain, ARGON_OPTIONS);

export const verifyPassword = (hash: string, plain: string): Promise<boolean> =>
  argon2.verify(hash, plain).catch(() => false);

/** Session tokens are random, and only their SHA-256 is ever stored. */
export function issueToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: hashToken(token) };
}

export const hashToken = (token: string): string =>
  createHash('sha256').update(token).digest('hex');

/**
 * A dummy hash to verify against when the email does not exist.
 *
 * Without this, a missing account returns in ~1ms while a real one takes ~50ms,
 * which lets anyone enumerate who works here. Doing the work regardless keeps
 * both paths the same shape.
 */
const DUMMY_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHRzb21lc2FsdA$JXQZ7t7ZDx0mYtCiJ5xJ8Fv2m0K3Q1Z9lJqXJ0uV2xA';

export interface LoginOutcome {
  ok: boolean;
  user?: AuthedUser;
  reason?: 'invalid_credentials' | 'locked';
  mustChangePassword?: boolean;
}

interface AuthRow {
  user_id: string | null;
  role: Role | null;
  full_name: string | null;
  password_hash: string | null;
  is_locked: boolean | null;
  must_change: boolean | null;
}

export async function attemptLogin(
  db: Database,
  email: string,
  password: string,
): Promise<LoginOutcome> {
  return db.withoutUser(async (q) => {
    const row = await q.one<AuthRow>(
      `select (crm.auth_lookup($1)).*`,
      [email],
    );

    if (!row?.user_id || !row.password_hash) {
      // Same work as the success path, so timing does not reveal the account.
      await verifyPassword(DUMMY_HASH, password);
      return { ok: false, reason: 'invalid_credentials' as const };
    }

    if (row.is_locked) {
      return { ok: false, reason: 'locked' as const };
    }

    const valid = await verifyPassword(row.password_hash, password);
    await q.query('select crm.auth_record_attempt($1, $2)', [row.user_id, valid]);

    if (!valid) return { ok: false, reason: 'invalid_credentials' as const };

    return {
      ok: true,
      user: { id: row.user_id, role: row.role as Role, fullName: row.full_name ?? '' },
      mustChangePassword: row.must_change ?? false,
    };
  });
}

export async function createSession(
  db: Database,
  userId: string,
  ip: string | null,
  userAgent: string | null,
): Promise<{ token: string; expiresAt: Date }> {
  const { token, hash } = issueToken();
  const expiresAt = await db.withoutUser(async (q) => {
    const row = await q.one<{ session_create: Date }>(
      'select crm.session_create($1, $2, $3, $4) as session_create',
      [userId, hash, ip, userAgent],
    );
    return row!.session_create;
  });
  return { token, expiresAt };
}

export async function resolveSession(db: Database, token: string): Promise<string | null> {
  return db.withoutUser(async (q) => {
    const row = await q.one<{ session_resolve: string | null }>(
      'select crm.session_resolve($1) as session_resolve',
      [hashToken(token)],
    );
    return row?.session_resolve ?? null;
  });
}

export async function revokeSession(db: Database, token: string): Promise<void> {
  await db.withoutUser((q) => q.query('select crm.session_revoke($1)', [hashToken(token)]));
}

/** Constant-time string compare for CSRF tokens and similar. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
