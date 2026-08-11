import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { notFound } from '../http/errors.ts';

const uuid = z.string().uuid();

/**
 * Advisory clients: everyone who has actually PAID, with the two checkpoints
 * that gate paid advisory - MITC done, KYC signed - and the subscription end.
 *
 * A register and a checklist only. Service delivery stays in the advisory
 * pipeline; this exists so nobody has to ask "did we complete MITC for them?"
 * with money already collected.
 */
export async function advisoryRoutes(app: FastifyInstance): Promise<void> {
  app.get('/advisory', async (req) => {
    req.requireRole('admin', 'ops', 'counsellor', 'viewer');
    const { status } = z
      .object({ status: z.enum(['active', 'expired', 'refunded']).optional() })
      .parse(req.query);
    return req.tx((q) =>
      q.many(
        `select * from crm.v_advisory_clients
          where ($1::text is null or client_status = $1)
          order by (mitc_done_at is null or kyc_done_at is null) desc, booked_at desc`,
        [status ?? null],
      ),
    );
  });

  app.put('/advisory/:dealId', async (req) => {
    const user = req.requireRole('admin', 'counsellor');
    const { dealId } = z.object({ dealId: uuid }).parse(req.params);
    const body = z
      .object({
        mitcDone: z.boolean().optional(),
        kycDone: z.boolean().optional(),
        subscriptionEndsAt: z.string().datetime({ offset: true }).nullable().optional(),
      })
      .parse(req.body);

    const row = await req.tx((q) =>
      q.one(
        `insert into crm.advisory_checkpoints (deal_id, mitc_done_at, mitc_by, kyc_done_at, kyc_by, subscription_ends_at)
         values ($1,
                 case when $2 then now() end, case when $2 then $4::uuid end,
                 case when $3 then now() end, case when $3 then $4::uuid end,
                 $5)
         on conflict (deal_id) do update set
           mitc_done_at = case when $2 is null then crm.advisory_checkpoints.mitc_done_at
                               when $2 then coalesce(crm.advisory_checkpoints.mitc_done_at, now()) end,
           mitc_by      = case when $2 is null then crm.advisory_checkpoints.mitc_by
                               when $2 then coalesce(crm.advisory_checkpoints.mitc_by, $4::uuid) end,
           kyc_done_at  = case when $3 is null then crm.advisory_checkpoints.kyc_done_at
                               when $3 then coalesce(crm.advisory_checkpoints.kyc_done_at, now()) end,
           kyc_by       = case when $3 is null then crm.advisory_checkpoints.kyc_by
                               when $3 then coalesce(crm.advisory_checkpoints.kyc_by, $4::uuid) end,
           subscription_ends_at = coalesce($5, crm.advisory_checkpoints.subscription_ends_at),
           updated_at = now()
         returning *`,
        [dealId, body.mitcDone ?? null, body.kycDone ?? null, user.id,
         body.subscriptionEndsAt ?? null],
      ),
    );
    if (!row) throw notFound('no paying client with that deal id');
    return row;
  });
}
