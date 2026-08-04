/**
 * One-time production bootstrap: teams, the first admin, and the ops service
 * account that background jobs and ingestion run as.
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
 *     --admin-password 'a-long-temporary-password' \
 *     --teams "Team A,Team B"
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
const teamsArg = arg('teams') ?? 'Team A,Team B';
const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl || !adminEmail || !adminName || !adminPassword) {
  console.error(
    'usage: DATABASE_URL=<owner connection> bootstrap.ts --admin-email E --admin-name N --admin-password P [--teams "Team A,Team B"]',
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

  // Teams, in the order given.
  //
  // Look up by name first rather than relying on ON CONFLICT: crm.teams has
  // three separate unique constraints (name, code, and rotation_order among
  // active teams), so a blind upsert on `name` throws when an unrelated team
  // already holds the rotation slot or a colliding code. Deriving rotation
  // order from max()+1 also means a second run with a longer team list simply
  // appends instead of colliding.
  const teamNames = teamsArg.split(',').map((t) => t.trim()).filter(Boolean);
  for (const [index, name] of teamNames.entries()) {
    const existing = await client.query('select 1 from crm.teams where name = $1', [name]);
    if (existing.rowCount && existing.rowCount > 0) continue;

    const base = name.replace(/[^A-Za-z0-9]/g, '').slice(0, 6).toUpperCase() || `T${index + 1}`;
    let code = base;
    for (let attempt = 2; ; attempt += 1) {
      const taken = await client.query('select 1 from crm.teams where code = $1', [code]);
      if (!taken.rowCount) break;
      code = `${base}${attempt}`.slice(0, 8);
    }

    await client.query(
      `insert into crm.teams (name, code, rotation_order)
       values ($1, $2, coalesce((select max(rotation_order) from crm.teams), 0) + 1)`,
      [name, code],
    );
  }

  // No employee_code here. It is unique, optional, and purely cosmetic - the
  // admin sets real codes in the UI. Hardcoding one made a second bootstrap
  // under a different admin email fail on users_employee_code_key, which is
  // exactly when you least want the tool to break.
  const adminRow = await client.query<{ id: string }>(
    `insert into crm.users (full_name, email, role)
     values ($1, $2, 'admin')
     on conflict (email) do update
       set full_name = excluded.full_name, role = 'admin',
           is_active = true, deactivated_at = null
     returning id`,
    [adminName, adminEmail],
  );
  const adminId = adminRow.rows[0]!.id;

  const hash = await hashPassword(adminPassword);
  // must_change = true: the password typed on this command line is temporary
  // by construction (it is now in shell history).
  await client.query('select crm.set_password($1, $2, true)', [adminId, hash]);

  const opsRow = await client.query<{ id: string }>(
    `insert into crm.users (full_name, email, role)
     values ('Scheduler Service', 'service-ops@crm.internal', 'ops')
     on conflict (email) do update set is_active = true, deactivated_at = null
     returning id`,
  );
  const opsId = opsRow.rows[0]!.id;
  // No password: the service account can never log in interactively.

  await client.query('commit');

  const teams = await client.query('select name, code, rotation_order from crm.teams order by rotation_order');

  console.log('bootstrap complete\n');
  console.log('teams:');
  for (const t of teams.rows) console.log(`  ${t.rotation_order}. ${t.name} (${t.code})`);
  console.log(`\nadmin login: ${adminEmail}`);
  console.log('  (the password you passed is TEMPORARY - the UI forces a change at first login)\n');
  console.log('add this to the app environment file:');
  console.log(`  SERVICE_USER_ID=${opsId}`);
} catch (err) {
  await client.query('rollback').catch(() => {});
  throw err;
} finally {
  await client.end();
}
