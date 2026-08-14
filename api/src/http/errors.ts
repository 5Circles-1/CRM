import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const badRequest = (m: string) => new HttpError(400, 'bad_request', m);
export const unauthorized = (m = 'not authenticated') => new HttpError(401, 'unauthorized', m);
export const forbidden = (m = 'not permitted') => new HttpError(403, 'forbidden', m);
export const notFound = (m = 'not found') => new HttpError(404, 'not_found', m);
export const conflict = (m: string) => new HttpError(409, 'conflict', m);

/**
 * Map the database's own guarantees onto HTTP.
 *
 * The rules that matter in this system are enforced in Postgres - the transfer
 * authority check, the transfer cap, the "an open lead always has a next
 * action" constraint, the append-only triggers. Those surface as SQLSTATEs, and
 * turning them into sensible status codes here means the API cannot drift out
 * of step with the rules it is meant to expose.
 */
const PG_STATUS: Record<string, { status: number; code: string }> = {
  '42501': { status: 403, code: 'forbidden' }, // insufficient_privilege
  '23514': { status: 409, code: 'constraint_violation' }, // check_violation
  '23505': { status: 409, code: 'duplicate' }, // unique_violation
  '23503': { status: 409, code: 'missing_reference' }, // foreign_key_violation
  '23502': { status: 400, code: 'missing_field' }, // not_null_violation
  '23P01': { status: 409, code: 'overlap' }, // exclusion_violation
  '2201G': { status: 400, code: 'bad_request' }, // invalid_argument
  'P0002': { status: 404, code: 'not_found' }, // no_data_found: absent, or fenced off by RLS
  '38000': { status: 409, code: 'append_only' }, // raised by tg_append_only
  '57014': { status: 503, code: 'query_timeout' }, // statement_timeout
};

interface PgErrorish {
  code?: string;
  message?: string;
  detail?: string;
}

/**
 * Field names in errors are read by whoever is filling the form, not by the
 * programmer who named the property.
 */
const FIELD_LABELS: Record<string, string> = {
  temporaryPassword: 'Temporary password',
  newPassword: 'New password',
  currentPassword: 'Current password',
  fullName: 'Full name',
  dialingMsisdn: 'Dialing SIM',
  employeeCode: 'Employee code',
  bookedAmount: 'Booked amount',
  discountAmount: 'Discount',
  promisedDate: 'Promised date',
  scheduledAt: 'Scheduled time',
  callbackAt: 'Callback time',
  durationSeconds: 'Talk time',
  listPriceInr: 'List price',
  toCallerId: 'Caller',
  productId: 'Product',
  instalmentId: 'Instalment',
};

const humanField = (path: string): string =>
  FIELD_LABELS[path] ?? path.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase());

/**
 * Say what a violated unique index means, in the terms of the thing being done.
 *
 * "duplicate key value violates unique constraint users_email_key" is accurate
 * and useless: it names an index, not a cause. Nothing here is ever hard
 * deleted, so the usual reason an email is taken is a deactivated account -
 * which is a different action (reactivate) rather than a different email.
 */
const CONSTRAINT_MESSAGES: Record<string, string> = {
  users_email_key:
    'An account with that email address already exists. It may be deactivated — reactivate it instead of creating a second one.',
  users_employee_code_key: 'That employee code is already used by another account.',
  leads_one_live_per_phone_idx:
    'A live lead with that phone number already exists — open it from Find lead instead of creating a second one.',
  products_code_key: 'That product code is already in use.',
  teams_code_key: 'That team code is already in use.',
};

export const constraintMessage = (raw: string | undefined): string | null => {
  if (!raw) return null;
  const named = Object.keys(CONSTRAINT_MESSAGES).find((name) => raw.includes(name));
  return named ? CONSTRAINT_MESSAGES[named]! : null;
};

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((err: unknown, req: FastifyRequest, reply: FastifyReply) => {
    if (err instanceof HttpError) {
      return reply.status(err.status).send({ error: err.code, message: err.message });
    }

    // Zod and Fastify schema failures.
    //
    // Always send a human-readable `message`. Returning only the raw `issues`
    // array left the UI with nothing to show but the status code, so a
    // password two characters too short surfaced to the admin as "HTTP 400".
    const anyErr = err as {
      name?: string;
      issues?: Array<{ path?: Array<string | number>; message?: string }>;
      statusCode?: number;
      message?: string;
    };
    if (anyErr?.name === 'ZodError') {
      const issues = anyErr.issues ?? [];
      const message =
        issues
          .map((i) => {
            const field = (i.path ?? []).join('.');
            return field ? `${humanField(field)}: ${i.message}` : i.message;
          })
          .filter(Boolean)
          .join('; ') || 'the details supplied are not valid';
      return reply.status(400).send({ error: 'validation_failed', message, issues });
    }

    const pgErr = err as PgErrorish;
    if (pgErr?.code && PG_STATUS[pgErr.code]) {
      const mapped = PG_STATUS[pgErr.code]!;
      req.log.info({ pgcode: pgErr.code, msg: pgErr.message }, 'database rule rejected the request');
      return reply.status(mapped.status).send({
        error: mapped.code,
        // These messages are written for the operator - "only a counsellor or
        // admin may transfer a lead" is exactly what the UI should show. The
        // exception is a unique violation, which names an index nobody outside
        // the schema has heard of.
        message:
          constraintMessage(pgErr.message) ??
          pgErr.message ??
          'the database rejected this operation',
      });
    }

    if (anyErr?.statusCode && anyErr.statusCode < 500) {
      return reply.status(anyErr.statusCode).send({ error: 'bad_request', message: anyErr.message });
    }

    req.log.error({ err }, 'unhandled error');
    return reply.status(500).send({ error: 'internal_error', message: 'something went wrong' });
  });
}
