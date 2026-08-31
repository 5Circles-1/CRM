import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { badRequest, conflict, unauthorized } from '../http/errors.ts';

/**
 * Callyzer integration surface: the webhook Callyzer pushes call logs to, the
 * health readout, and the on-demand reconcile.
 *
 * The webhook is the one route in the product a stranger can reach, so its
 * rules are strict: reject on a bad secret before doing anything else, parse
 * with zod like every other route, and write only through
 * Database.withUser(serviceUserId) into crm.ingest_callyzer_logs - the same
 * single door the scheduled pull uses, so idempotency and quarantine behave
 * identically however a row arrives.
 */

/** Callyzer does not document a signature header, so the Secret configured in
 *  their dashboard is accepted wherever an integrator can put it: appended to
 *  the webhook URL as ?secret=, or in a header. Comparison is constant-time. */
function secretMatches(supplied: unknown, expected: string): boolean {
  if (typeof supplied !== 'string' || supplied.length === 0) return false;
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

const callLogSchema = z.record(z.unknown());

const webhookEmployeeSchema = z
  .object({
    emp_name: z.string().nullish(),
    emp_code: z.union([z.string(), z.number()]).nullish(),
    emp_country_code: z.union([z.string(), z.number()]).nullish(),
    emp_number: z.union([z.string(), z.number()]).nullish(),
    call_logs: z.array(callLogSchema).max(2000).default([]),
  })
  // Callyzer owns this payload and may grow it; unknown keys must not bounce
  // a delivery that carries real calls.
  .passthrough();

export async function callyzerRoutes(app: FastifyInstance): Promise<void> {
  /**
   * The push half. Payload: an array of employees, each with call_logs[].
   * Employee identity lives on the parent object, so it is folded onto each
   * row before the rows go through the one ingest door.
   */
  app.post('/integrations/callyzer/webhook', async (req) => {
    const expected = process.env.CALLYZER_WEBHOOK_SECRET;
    const supplied =
      (req.query as Record<string, unknown> | null)?.secret ??
      req.headers['x-callyzer-secret'] ??
      req.headers['x-webhook-secret'] ??
      req.headers['secret'] ??
      (req.headers.authorization?.startsWith('Bearer ')
        ? req.headers.authorization.slice(7)
        : undefined);

    // An unconfigured secret reads the same as a wrong one: this endpoint
    // admits nobody until CALLYZER_WEBHOOK_SECRET is deliberately set.
    if (!expected || !secretMatches(supplied, expected)) {
      req.log.warn({ configured: Boolean(expected) }, 'callyzer webhook rejected');
      throw unauthorized('bad webhook secret');
    }

    const serviceUserId = process.env.SERVICE_USER_ID;
    if (!serviceUserId) {
      throw conflict('SERVICE_USER_ID is not set on this server, so webhook rows have no ingest identity');
    }

    const employees = z.array(webhookEmployeeSchema).max(500).parse(req.body);
    const rows = employees.flatMap((e) =>
      e.call_logs.map((log) => ({
        emp_name: e.emp_name,
        emp_code: e.emp_code,
        emp_country_code: e.emp_country_code,
        emp_number: e.emp_number,
        ...log,
      })),
    );

    const started = Date.now();
    try {
      const counts = rows.length
        ? await app.db.withUser(serviceUserId, (q) =>
            q.one('select * from crm.ingest_callyzer_logs($1::jsonb)', [JSON.stringify(rows)]),
          )
        : { seen: 0, inserted: 0, updated: 0, matched: 0, quarantined: 0 };

      // The heartbeat is what lets v_callyzer_health treat webhook delivery
      // as proof of life even when the pull is not configured.
      await app.db.withUser(serviceUserId, (q) =>
        q.query('select crm.record_job_run($1, $2, $3)', ['callyzer_webhook', Date.now() - started, null]),
      );
      return { received: rows.length, ...counts };
    } catch (err) {
      await app.db
        .withUser(serviceUserId, (q) =>
          q.query('select crm.record_job_run($1, $2, $3)', [
            'callyzer_webhook',
            Date.now() - started,
            err instanceof Error ? err.message : String(err),
          ]),
        )
        .catch(() => {});
      throw err;
    }
  });

  /**
   * Is handset call verification alive? The one row of v_callyzer_health,
   * plus the roster and open quarantine - which RLS trims to what the viewer
   * is allowed to see (quarantine payloads carry raw personal-call data, so
   * they are admin/ops only; the roster is floor-management reading).
   */
  app.get('/integrations/callyzer/health', async (req) => {
    req.requireRole('counsellor', 'admin', 'ops', 'viewer');
    return req.tx(async (q) => {
      const health = await q.one('select * from crm.v_callyzer_health');
      const employees = await q.many(
        `select ce.emp_msisdn, ce.emp_name, ce.emp_code, ce.app_version,
                ce.last_call_at, ce.last_sync_req_at, ce.refreshed_at,
                ce.user_id, u.full_name as user_name,
                (ce.user_id is not null
                 and ce.last_sync_req_at < now() - make_interval(
                       hours => crm.setting_int('callyzer.handset_stale_hours', 24)))
                  as handset_stale
           from crm.callyzer_employees ce
           left join crm.users u on u.id = ce.user_id
          order by (ce.user_id is null) desc, ce.emp_name nulls last`,
      );
      const quarantine = await q.many(
        `select id, external_id, emp_msisdn, reason, received_at, last_seen_at
           from crm.callyzer_quarantine
          where resolved_at is null
          order by last_seen_at desc
          limit 50`,
      );
      return {
        ...(health ?? {}),
        employees,
        quarantine,
        // So the panel can say "set the key on the server" instead of showing
        // a sync that mysteriously never runs.
        api_key_configured: Boolean(process.env.CALLYZER_API_KEY),
        webhook_secret_configured: Boolean(process.env.CALLYZER_WEBHOOK_SECRET),
        webhook_path: '/integrations/callyzer/webhook',
      };
    });
  });

  /** Pull from Callyzer right now; optionally deeper than the usual window. */
  app.post('/integrations/callyzer/sync', async (req) => {
    req.requireRole('admin', 'ops');
    const body = z
      .object({
        // The API caps a window at 180 days; stay under it.
        hours: z.number().int().min(1).max(4000).optional(),
      })
      .parse(req.body ?? {});

    if (!app.callyzerSyncNow) {
      throw badRequest(
        'the Callyzer sync is not configured on this server - it needs SERVICE_USER_ID and CALLYZER_API_KEY in the API environment',
      );
    }
    const summary = await app.callyzerSyncNow(body.hours);
    if (!summary) {
      throw conflict('callyzer.enabled is off - turn it on in Admin > Settings first');
    }
    return summary;
  });
}
