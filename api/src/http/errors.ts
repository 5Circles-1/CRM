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
 * The rules that matter are enforced in Postgres - who may move a lead, a
 * call-back needs a time, the activity log is append-only. Those surface as
 * SQLSTATEs, and turning them into status codes here means the API cannot
 * drift out of step with the rules it exposes. Every RAISE in the schema
 * carries an errcode for exactly this reason: a bare raise is P0001, which is
 * in no map and reaches the floor as "something went wrong".
 */
const PG_STATUS: Record<string, { status: number; code: string }> = {
  '42501': { status: 403, code: 'forbidden' }, // insufficient_privilege
  '23514': { status: 409, code: 'constraint_violation' }, // check_violation
  '23505': { status: 409, code: 'duplicate' }, // unique_violation
  '23503': { status: 409, code: 'missing_reference' }, // foreign_key_violation
  '23502': { status: 400, code: 'missing_field' }, // not_null_violation
  '2201G': { status: 400, code: 'bad_request' }, // invalid_argument
  P0002: { status: 404, code: 'not_found' }, // no_data_found: absent, or fenced off by RLS
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
  fullName: 'Full name',
  newPassword: 'New password',
  currentPassword: 'Current password',
  nextFollowUpAt: 'Next follow-up',
  assignedTo: 'Assigned to',
  rotationOrder: 'Rotation order',
  spreadsheetId: 'Spreadsheet',
  worksheetName: 'Worksheet tab',
};

const humanField = (path: string): string =>
  FIELD_LABELS[path] ?? path.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase());

/**
 * Say what a violated unique index means, in the terms of the thing being
 * done. "duplicate key value violates unique constraint" names an index, not
 * a cause.
 */
const CONSTRAINT_MESSAGES: Record<string, string> = {
  users_email_key:
    'An account with that email address already exists. It may be deactivated — reactivate it instead of creating a second one.',
  leads_one_live_per_phone_idx:
    'A live lead with that phone number already exists — open it from the Leads screen instead of creating a second one.',
  lead_sources_name_key: 'A source with that name already exists.',
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

    // Zod and Fastify schema failures: always send a human-readable message.
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
        // These messages are written for the person on the floor - "a
        // call-back needs the date and time the client asked for" is exactly
        // what the UI should show. The exception is a unique violation, which
        // names an index nobody outside the schema has heard of.
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
