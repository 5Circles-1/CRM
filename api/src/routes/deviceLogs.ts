import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { notFound } from '../http/errors.ts';

const uuid = z.string().uuid();

const entrySchema = z.object({
  /** Stable per-device row identity; re-uploads are idempotent on it. */
  deviceRowKey: z.string().min(1).max(128),
  msisdn: z.string().min(4).max(32),
  direction: z.enum(['outgoing', 'incoming', 'missed', 'rejected']),
  startedAt: z.coerce.date(),
  durationSeconds: z.number().int().min(0).max(4 * 3600),
});

/**
 * The Android call-log sync contract.
 *
 * Callers dial from personal SIMs, so the CRM cannot observe calls directly.
 * The companion app reads the device call log and posts it here; rows whose
 * number matches a lead the caller can see get `matched_lead_id` set. When the
 * caller then logs the call in the UI, the matching device row is offered as
 * a pre-fill and its id lands on the attempt - which is what flips
 * `is_verified` and keeps dial counts honest.
 *
 * Privacy note, deliberately enforced by RLS rather than convention: a
 * caller's raw device log is visible only to them and admin. Matching runs
 * under the caller's own RLS, so a personal call that matches nothing is
 * stored but surfaces nowhere.
 */
export async function deviceLogRoutes(app: FastifyInstance): Promise<void> {
  app.post('/device-logs/sync', async (req) => {
    const user = req.requireRole('caller', 'counsellor', 'admin');
    const body = z.object({ entries: z.array(entrySchema).min(1).max(500) }).parse(req.body);

    return req.tx(async (q) => {
      const rows = await q.many<{ matched_lead_id: string | null }>(
        `insert into crm.device_call_logs
           (user_id, device_row_key, counterparty_msisdn, direction,
            started_at, duration_seconds, matched_lead_id)
         select $1, e.device_row_key, crm.normalise_phone(e.msisdn), e.direction,
                e.started_at, e.duration_seconds,
                -- Runs under the uploader's RLS: only leads they can see match.
                (select l.id from crm.leads l
                  where l.phone_e164 = crm.normalise_phone(e.msisdn)
                  order by l.created_at desc limit 1)
           from jsonb_to_recordset($2::jsonb)
                  as e(device_row_key text, msisdn text, direction text,
                       started_at timestamptz, duration_seconds int)
         on conflict (user_id, device_row_key) do nothing
         returning matched_lead_id`,
        [
          user.id,
          JSON.stringify(
            body.entries.map((e) => ({
              device_row_key: e.deviceRowKey,
              msisdn: e.msisdn,
              direction: e.direction,
              started_at: e.startedAt.toISOString(),
              duration_seconds: e.durationSeconds,
            })),
          ),
        ],
      );

      return {
        received: body.entries.length,
        inserted: rows.length,
        matched: rows.filter((r) => r.matched_lead_id !== null).length,
      };
    });
  });

  /**
   * The most recent synced device call to this lead's number that no logged
   * attempt has claimed yet. The log-call form uses it to pre-fill duration
   * and attach the device row, which is what makes the attempt verified.
   *
   * Whether the row came from the in-house app or Callyzer makes no
   * difference here - that is the point of both writing one table. Two
   * Callyzer-specific rules do apply:
   *  - a WhatsApp call may only verify a dial when
   *    callyzer.count_whatsapp_calls is on (targets were baselined on phone
   *    calls; the rows are stored either way);
   *  - the recording link goes to counsellors and admin for coaching, never
   *    to the caller themselves - shown one's own recordings, coaching turns
   *    into surveillance theatre and invites tampering requests.
   */
  app.get('/leads/:id/device-log-suggestion', async (req) => {
    const user = req.requireUser();
    const { id } = z.object({ id: uuid }).parse(req.params);

    return req.tx(async (q) => {
      const lead = await q.one<{ phone_e164: string }>(
        'select phone_e164 from crm.leads where id = $1',
        [id],
      );
      if (!lead) throw notFound('lead not found');

      const suggestion = await q.one<{ recording_url?: string | null }>(
        `select d.id, d.started_at, d.duration_seconds, d.direction,
                d.source, d.call_method, d.recording_url
           from crm.device_call_logs d
          where d.user_id = $1
            and d.counterparty_msisdn = $2
            and d.started_at > now() - interval '24 hours'
            and (coalesce(d.call_method, 'PhoneCall') <> 'WhatsAppCall'
                 or crm.setting_bool('callyzer.count_whatsapp_calls', false))
            and not exists (
              select 1 from crm.call_attempts ca where ca.device_log_id = d.id
            )
          order by d.started_at desc
          limit 1`,
        [user.id, lead.phone_e164],
      );

      if (suggestion && !['counsellor', 'admin'].includes(user.role)) {
        suggestion.recording_url = null;
      }
      return { suggestion };
    });
  });
}
