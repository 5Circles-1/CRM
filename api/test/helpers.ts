import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { Database } from '../src/db/pool.ts';
import { buildServer } from '../src/server.ts';
import { hashPassword } from '../src/auth/credentials.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');

export const TEST_DB = process.env.TEST_DB ?? 'crm_api_test';
export const PGHOST = process.env.PGHOST ?? '/tmp';
export const PGPORT = process.env.PGPORT ?? '55432';
export const PGSUPERUSER = process.env.PGUSER ?? 'postgres';

/** Login role for the API. Inherits crm_app: no BYPASSRLS, owns nothing. */
const API_ROLE = 'crm_api_test_role';
const API_PASSWORD = 'test-only-password';

export const TEST_PASSWORD = 'correct-horse-battery';

/** Seeded user ids, from db/seed/seed.sql. */
export const USERS = {
  admin: '22222222-0000-0000-0000-00000000000a',
  ops: '22222222-0000-0000-0000-00000000000b',
  founder: '22222222-0000-0000-0000-00000000000c',
  callerA1: '22222222-0000-0000-0000-000000000001',
  callerA2: '22222222-0000-0000-0000-000000000002',
  callerB1: '22222222-0000-0000-0000-000000000003',
  callerB2: '22222222-0000-0000-0000-000000000004',
  counsellorA: '22222222-0000-0000-0000-000000000005',
  counsellorB: '22222222-0000-0000-0000-000000000006',
  mentor: '22222222-0000-0000-0000-00000000000d',
} as const;

export const EMAILS = {
  admin: 'admin@5circles.test',
  ops: 'ops@5circles.test',
  callerA1: 'a1@5circles.test',
  callerA2: 'a2@5circles.test',
  callerB1: 'b1@5circles.test',
  counsellorA: 'ca@5circles.test',
  counsellorB: 'cb@5circles.test',
  mentor: 'mentor@5circles.test',
} as const;

export const SOURCES = {
  meta: '33333333-0000-0000-0000-000000000001',
  website: '33333333-0000-0000-0000-000000000002',
} as const;

function psql(database: string, sql: string): string {
  return execFileSync(
    'psql',
    ['-v', 'ON_ERROR_STOP=1', '-h', PGHOST, '-p', PGPORT, '-U', PGSUPERUSER, '-d', database, '-tAc', sql],
    { encoding: 'utf8' },
  );
}

export function superuserUrl(database = TEST_DB): string {
  return `postgresql://${PGSUPERUSER}@/${database}?host=${PGHOST}&port=${PGPORT}`;
}

export function apiUrl(database = TEST_DB): string {
  return `postgresql://${API_ROLE}:${API_PASSWORD}@/${database}?host=${PGHOST}&port=${PGPORT}`;
}

/**
 * Rebuild the test database from migrations + seed, then give the seeded users
 * passwords so the API's own login path can be exercised.
 */
export function rebuildTestDatabase(): void {
  execFileSync(path.join(REPO, 'db/rebuild.sh'), [], {
    env: { ...process.env, PGHOST, PGPORT, PGUSER: PGSUPERUSER, CRM_DB: TEST_DB },
    stdio: 'pipe',
  });

  // Roles are cluster-wide, so create once and reuse.
  psql(
    'postgres',
    `do $$ begin
       if not exists (select 1 from pg_roles where rolname = '${API_ROLE}') then
         create role ${API_ROLE} login password '${API_PASSWORD}' in role crm_app;
       end if;
     end $$;`,
  );
  psql(TEST_DB, `grant usage on schema crm to ${API_ROLE};`);
}

/**
 * Give every seeded user the same password.
 *
 * Note this works through crm.set_password even though the API role cannot
 * touch crm.user_credentials directly - that is the SECURITY DEFINER boundary
 * from migration 0013 doing its job.
 */
export async function seedPasswords(db: Database): Promise<void> {
  const hash = await hashPassword(TEST_PASSWORD);
  for (const id of Object.values(USERS)) {
    await db.withoutUser((q) => q.query('select crm.set_password($1, $2, false)', [id, hash]));
  }
}

export interface TestHarness {
  app: FastifyInstance;
  db: Database;
  close(): Promise<void>;
}

export async function startHarness(): Promise<TestHarness> {
  const db = new Database(apiUrl());
  await seedPasswords(db);

  const app = await buildServer(
    {
      port: 0,
      host: '127.0.0.1',
      databaseUrl: apiUrl(),
      cookieName: 'crm_session',
      secureCookies: false,
      logLevel: 'silent',
    },
    db,
  );
  await app.ready();

  return {
    app,
    db,
    async close() {
      await app.close();
      await db.close();
    },
  };
}

/** Log in and return a bearer token. */
export async function login(app: FastifyInstance, email: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email, password: TEST_PASSWORD },
  });
  if (res.statusCode !== 200) {
    throw new Error(`login failed for ${email}: ${res.statusCode} ${res.body}`);
  }
  return res.json().token as string;
}

export const auth = (token: string) => ({ authorization: `Bearer ${token}` });

/** Run arbitrary SQL as superuser, for test fixtures RLS would otherwise block. */
export function fixtureSql(sql: string): string {
  return psql(TEST_DB, sql);
}

let leadSeq = 0;

/**
 * Create a fresh lead owned by `callerId`.
 *
 * Tests that need a lead in a particular state make their own rather than
 * picking one out of the seed - otherwise an earlier test moving a lead to
 * 'callback' silently breaks a later one.
 */
export function makeLeadFor(callerId: string, name = 'Fixture Lead'): string {
  leadSeq += 1;
  const phone = `+9199${String(700000 + leadSeq).padStart(8, '0')}`;
  // psql prints the command tag ("INSERT 0 1") after the returned row, so take
  // the first line rather than the whole output.
  return fixtureSql(`
    insert into crm.leads (source_id, full_name, phone_e164, caller_id, team_id, status)
    values ('${SOURCES.meta}', '${name} ${leadSeq}', '${phone}',
            '${callerId}', crm.team_of('${callerId}', current_date), 'working')
    returning id;
  `)
    .trim()
    .split('\n')[0]!
    .trim();
}
