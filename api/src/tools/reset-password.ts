/**
 * Reset any user's password from the server itself.
 *
 * The lockout this exists for: everyone else's forgotten password is one
 * button for the admin (Admin -> Users -> Reset password) - but when the
 * ADMIN forgets theirs, no screen can help, because every screen is behind
 * the login they have lost. SSH access to the server is the credential that
 * proves they should be let back in.
 *
 *   sudo -u postgres node --experimental-strip-types \
 *     /opt/crm/api/src/tools/reset-password.ts admin@example.com
 *
 * The new password is typed at a prompt, never passed as an argument -
 * arguments land in shell history and `ps` output.
 */
import { createInterface } from 'node:readline/promises';
import pg from 'pg';
import { hashPassword } from '../auth/credentials.ts';

const email = process.argv[2];
if (!email || !email.includes('@')) {
  console.error('usage: reset-password.ts <email>   (new password is prompted)');
  process.exit(1);
}

const rl = createInterface({ input: process.stdin, output: process.stdout });
const password = (await rl.question('New temporary password (min 10 chars): ')).trim();
rl.close();
if (password.length < 10) {
  console.error('too short - 10 characters minimum');
  process.exit(1);
}

const client = new pg.Client({ database: process.env.CRM_DB ?? 'crm' });
await client.connect();
try {
  const { rows } = await client.query(
    'select id, full_name, is_active from crm.users where email = $1',
    [email],
  );
  if (rows.length === 0) {
    console.error(`no user with email ${email}`);
    process.exit(1);
  }
  if (!rows[0].is_active) {
    console.error(`${rows[0].full_name} is deactivated - reactivate first (Admin -> Users)`);
    process.exit(1);
  }
  const hash = await hashPassword(password);
  // Forced change at next login: this tool proves server access, not identity.
  await client.query('select crm.set_password($1, $2, true)', [rows[0].id, hash]);
  console.log(`password reset for ${rows[0].full_name} <${email}> - they must change it at next login`);
} finally {
  await client.end();
}
