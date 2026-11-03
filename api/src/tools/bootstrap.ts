/**
 * One-time production bootstrap: the first admin, the System service account,
 * and the three lead sources.
 *
 * An empty production database has zero users, and creating users through the
 * API requires an admin session - chicken and egg. This tool breaks the loop.
 * Run it ONCE, connected as the database owner (RLS does not gate the owner),
 * then never use that connection string for the app itself - the server
 * refuses it anyway.
 *
 *   DATABASE_URL="postgresql://postgres@/crm?host=/var/run/postgresql" \
 *   node --experimental-strip-types src/tools/bootstrap.ts \
 *     --admin-email you@company.in \
 *     --admin-name "Your Name" \
 *     --admin-password 'a-long-temporary-password'
 *
 * Safe to re-run: everything upserts by natural key. Prints SERVICE_USER_ID
 * for the app's environment file.
 */
import pg from 'pg';
import { hashPassword } from '../auth/credentials.ts';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const adminEmail = arg('admin-email');
const adminName = arg('admin-name');
const adminPassword = arg('admin-password');
const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl || !adminEmail || !adminName || !adminPassword) {
  console.error(
    'usage: DATABASE_URL=<owner connection> bootstrap.ts --admin-email E --admin-name N --admin-password P',
  );
  process.exit(2);
}
if (adminPassword.length < 10) {
  console.error('the admin password must be at least 10 characters');
  process.exit(2);
}

const client = new pg.Client({ connectionString: databaseUrl });
await client.connect();

try {
  await client.query('begin');

  const admin = await client.query<{ id: string }>(
    `insert into crm.users (full_name, email, role)
     values ($1, $2, 'admin')
     on conflict (email) do update set full_name = excluded.full_name, role = 'admin'
     returning id`,
    [adminName, adminEmail],
  );
  const adminId = admin.rows[0]!.id;

  const hash = await hashPassword(adminPassword);
  await client.query('select crm.set_password($1, $2, true)', [adminId, hash]);

  // The service account background jobs run as. No credentials row, so no one
  // can ever log in as it; is_service hides it from pickers and dashboards.
  const service = await client.query<{ id: string }>(
    `insert into crm.users (full_name, email, role, is_service, rotation_order)
     values ('System', 'system@internal.invalid', 'admin', true, 999)
     on conflict (email) do update set is_service = true
     returning id`,
  );

  for (const name of ['Meta', 'ChatGPT', 'Manual']) {
    await client.query(
      `insert into crm.lead_sources (name) values ($1) on conflict (name) do nothing`,
      [name],
    );
  }

  await client.query('commit');

  console.log(`admin ready: ${adminName} <${adminEmail}> (temporary password, change at first login)`);
  console.log(`SERVICE_USER_ID=${service.rows[0]!.id}`);
  console.log('sources ready: Meta, ChatGPT, Manual (set sheet ids in Admin → Sources)');
} catch (err) {
  await client.query('rollback').catch(() => {});
  throw err;
} finally {
  await client.end();
}
