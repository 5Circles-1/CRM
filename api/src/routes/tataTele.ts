import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { badGateway, badRequest, conflict, notFound, unauthorized } from '../http/errors.ts';
import { TataTeleApiError } from '../integrations/tata_tele/client.ts';

/**
 * Tata Tele Smartflo surface: the click-to-call that places a call for the
 * floor, the webhook Smartflo pushes call records to, the health readout,
 * and the on-demand reconcile.
 *
 * The webhook is the one route in the product a stranger can reach, so its
 * rules are strict: reject on a bad secret before doing anything else, parse
 * with zod like every other route, and write only through
 * Database.withUser(serviceUserId) into crm.ingest_tata_tele_cdrs - the same
 * single door the scheduled pull uses, so idempotency and quarantine behave
 * identically however a row arrives.
 */

/** The Secret configured alongside the webhook URL in the Smartflo portal is
 *  accepted wherever an integrator can put it: appended to the webhook URL as
 *  ?secret=, or in a header. Comparison is constant-time. */
function secretMatches(supplied: unknown, expected: string): boolean {
  if (typeof supplied !== 'string' || supplied.length === 0) return false;
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

const uuid = z.string().uuid();
const rawRow = z.record(z.unknown());

const digitsOnly = (s: string): string => s.replace(/[^0-9]/g, '');

export async function tataTeleRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Click-to-call: Smartflo rings the caller's own phone first, then bridges
   * the client - back-to-back dialling with no number ever typed by hand.
   *
   * The lead is read under the requester's RLS, so the destination number
   * always comes from a lead this user is allowed to work: a lead they
   * cannot see is a 404 here exactly as it is everywhere else, and the API
   * never accepts a raw phone number from the browser.
   */
  app.post('/leads/:id/call', async (req) => {
    const user = req.requireRole('caller', 'counsellor', 'admin');
    const { id } = z.object({ id: uuid }).parse(req.params);

    const ctx = await req.tx(async (q) => {
      const lead = await q.one<{ id: string; phone_e164: string; full_name: string | null }>(
        'select id, phone_e164, full_name from crm.leads where id = $1',
        [id],
      );
      if (!lead) throw notFound('lead not found');
      const me = await q.one<{ dialing_msisdn: string | null }>(
        'select dialing_msisdn from crm.users where id = $1',
        [user.id],
      );
      const cfg = await q.one<{ enabled: boolean; caller_id: string; base_url: string }>(
        `select crm.setting_bool('tata_tele.enabled', false)          as enabled,
                crm.setting_text('tata_tele.caller_id', '')           as caller_id,
                crm.setting_text('tata_tele.base_url',
                  'https://api-smartflo.tatateleservices.com/v1/')    as base_url`,
      );
      return { lead, me: me!, cfg: cfg! };
    });

    if (!ctx.cfg.enabled) {
      throw conflict(
        'Tata Tele calling is switched off - an admin can turn it on in Admin > Settings (tata_tele.enabled)',
      );
    }
    if (!app.tataTele) {
      throw badRequest(
        'Tata Tele calling is not configured on this server - set TATA_TELE_LOGIN_EMAIL and '
          + 'TATA_TELE_LOGIN_PASSWORD (or TATA_TELE_API_TOKEN) in the API environment',
      );
    }
    if (!ctx.me.dialing_msisdn) {
      throw badRequest(
        'you have no Dialing number set, so Smartflo does not know which phone to ring first - '
          + 'an admin can set it on Admin > Users',
      );
    }

    app.tataTele.baseUrl = ctx.cfg.base_url;

    /** One row per click, success or refusal: a click that never became a
     *  call is data the health panel counts, not silence. */
    const record = (fields: {
      refId?: string | null;
      status: 'requested' | 'failed';
      reason?: string;
    }) =>
      req
        .tx(async (q) => {
          await q.query(
            `insert into crm.telephony_calls
               (lead_id, user_id, agent_msisdn, destination_msisdn,
                provider_ref_id, status, failure_reason)
             values ($1, $2, $3, $4, $5, $6, $7)`,
            [
              ctx.lead.id, user.id, ctx.me.dialing_msisdn, ctx.lead.phone_e164,
              fields.refId ?? null, fields.status, fields.reason ?? null,
            ],
          );
          if (fields.status === 'requested') {
            await q.query(
              `insert into crm.lead_events (lead_id, event_type, actor_id, payload)
               values ($1, 'click_to_call', $2, $3::jsonb)`,
              [ctx.lead.id, user.id, JSON.stringify({ ref_id: fields.refId ?? null })],
            );
          }
        })
        .catch((err) => req.log.warn({ err }, 'could not record click-to-call'));

    try {
      const placed = await app.tataTele.clickToCall({
        agentNumber: digitsOnly(ctx.me.dialing_msisdn),
        destinationNumber: digitsOnly(ctx.lead.phone_e164),
        ...(ctx.cfg.caller_id ? { callerId: ctx.cfg.caller_id } : {}),
      });
      await record({ refId: placed.refId, status: 'requested' });
      return {
        ok: true,
        refId: placed.refId,
        message: `Smartflo is ringing your phone first - ${
          ctx.lead.full_name ?? 'the client'
        } is dialled the moment you answer.`,
      };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await record({ status: 'failed', reason });
      if (err instanceof TataTeleApiError) {
        throw badGateway(
          err.authFailed
            ? 'Smartflo refused the CRM\'s login, so the call was not placed - the server '
              + 'credentials may have expired (Smartflo rotates passwords every 90 days). Tell your admin.'
            : `Smartflo could not place the call: ${err.message}`,
        );
      }
      throw badGateway('Smartflo could not be reached - the call was not placed. Try again, and tell your admin if it continues.');
    }
  });

  /**
   * The push half. Smartflo webhooks send one JSON object per call event
   * (configure content-type application/json in the portal); an array is
   * accepted too so a relay can batch. Field names are whatever variables
   * the portal template maps - the ingester reads them tolerantly.
   */
  app.post('/integrations/tata-tele/webhook', async (req) => {
    const expected = process.env.TATA_TELE_WEBHOOK_SECRET;
    const supplied =
      (req.query as Record<string, unknown> | null)?.secret ??
      req.headers['x-tata-tele-secret'] ??
      req.headers['x-webhook-secret'] ??
      req.headers['secret'] ??
      (req.headers.authorization?.startsWith('Bearer ')
        ? req.headers.authorization.slice(7)
        : undefined);

    // An unconfigured secret reads the same as a wrong one: this endpoint
    // admits nobody until TATA_TELE_WEBHOOK_SECRET is deliberately set.
    if (!expected || !secretMatches(supplied, expected)) {
      req.log.warn({ configured: Boolean(expected) }, 'tata tele webhook rejected');
      throw unauthorized('bad webhook secret');
    }

    const serviceUserId = process.env.SERVICE_USER_ID;
    if (!serviceUserId) {
      throw conflict('SERVICE_USER_ID is not set on this server, so webhook rows have no ingest identity');
    }

    const parsed = z.union([z.array(rawRow).max(2000), rawRow]).parse(req.body ?? {});
    const rows = (Array.isArray(parsed) ? parsed : [parsed]).filter(
      (r) => Object.keys(r).length > 0,
    );

    const started = Date.now();
    try {
      const counts = rows.length
        ? await app.db.withUser(serviceUserId, (q) =>
            q.one('select * from crm.ingest_tata_tele_cdrs($1::jsonb)', [JSON.stringify(rows)]),
          )
        : { seen: 0, inserted: 0, updated: 0, matched: 0, linked: 0, skipped: 0, quarantined: 0 };

      // The heartbeat is what lets v_tata_tele_health treat webhook delivery
      // as proof of life even when the pull is not configured.
      await app.db.withUser(serviceUserId, (q) =>
        q.query('select crm.record_job_run($1, $2, $3)', ['tata_tele_webhook', Date.now() - started, null]),
      );
      return { received: rows.length, ...counts };
    } catch (err) {
      await app.db
        .withUser(serviceUserId, (q) =>
          q.query('select crm.record_job_run($1, $2, $3)', [
            'tata_tele_webhook',
            Date.now() - started,
            err instanceof Error ? err.message : String(err),
          ]),
        )
        .catch(() => {});
      throw err;
    }
  });

  /**
   * Is cloud calling alive? The one row of v_tata_tele_health, plus the
   * agent roster and open quarantine - which RLS trims to what the viewer is
   * allowed to see (quarantine payloads carry raw call data, so they are
   * admin/ops only; the roster is floor-management reading).
   */
  app.get('/integrations/tata-tele/health', async (req) => {
    req.requireRole('counsellor', 'admin', 'ops', 'viewer');
    return req.tx(async (q) => {
      const health = await q.one('select * from crm.v_tata_tele_health');
      const agents = await q.many(
        `select ta.agent_msisdn, ta.agent_id, ta.agent_name, ta.extension,
                ta.user_status, ta.refreshed_at, ta.user_id,
                u.full_name as user_name
           from crm.tata_tele_agents ta
           left join crm.users u on u.id = ta.user_id
          order by (ta.user_id is null) desc, ta.agent_name nulls last`,
      );
      const quarantine = await q.many(
        `select id, external_id, agent_identifier, reason, received_at, last_seen_at
           from crm.telephony_quarantine
          where resolved_at is null
          order by last_seen_at desc
          limit 50`,
      );
      return {
        ...(health ?? {}),
        agents,
        quarantine,
        // So the panel can say "set the credentials on the server" instead of
        // showing a sync that mysteriously never runs.
        credentials_configured: Boolean(app.tataTele),
        webhook_secret_configured: Boolean(process.env.TATA_TELE_WEBHOOK_SECRET),
        webhook_path: '/integrations/tata-tele/webhook',
      };
    });
  });

  /** Pull from Smartflo right now; optionally deeper than the usual window. */
  app.post('/integrations/tata-tele/sync', async (req) => {
    req.requireRole('admin', 'ops');
    const body = z
      .object({
        hours: z.number().int().min(1).max(4000).optional(),
      })
      .parse(req.body ?? {});

    if (!app.tataTeleSyncNow) {
      throw badRequest(
        'the Tata Tele sync is not configured on this server - it needs SERVICE_USER_ID and '
          + 'TATA_TELE_LOGIN_EMAIL/TATA_TELE_LOGIN_PASSWORD (or TATA_TELE_API_TOKEN) in the API environment',
      );
    }
    const summary = await app.tataTeleSyncNow(body.hours);
    if (!summary) {
      throw conflict('tata_tele.enabled is off - turn it on in Admin > Settings first');
    }
    return summary;
  });
}
