import { readFileSync } from 'node:fs';

/**
 * The service account's email address - the one a Google Sheet has to be
 * shared with before the CRM can read it.
 *
 * Worth surfacing in the product: when the importer fails with "the caller
 * does not have permission", the fix is to share the sheet with THIS address,
 * and hunting for it meant reading a credentials file over SSH. The email is
 * an identifier, not a secret; nothing else from the credentials is ever read
 * here, and the private key never leaves the file.
 */
export function serviceAccountEmail(): string | null {
  try {
    const inline = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
    if (inline) {
      const parsed = JSON.parse(inline) as { client_email?: string };
      return parsed.client_email ?? null;
    }
    const path = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    if (path) {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as { client_email?: string };
      return parsed.client_email ?? null;
    }
  } catch {
    // A malformed or unreadable credentials file is itself worth knowing, but
    // it must never take the dashboard down - the intake state already says
    // the importer is failing.
    return null;
  }
  return null;
}
