import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { notFound } from '../http/errors.ts';
import { paidOnToTimestamp } from '../http/paid-on.ts';

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

  /**
   * Add a paying client by hand.
   *
   * The automatic path stays the guarantee: money recorded puts a client in
   * both books, so nobody is forgotten. This is for clients who arrived
   * outside it - an offline sale, a migrated record, a payment taken before
   * the CRM existed. It builds the same lead, deal and payment the normal
   * path builds, so the client behaves identically everywhere.
   */
  app.post('/advisory/manual', async (req, reply) => {
    req.requireRole('admin', 'ops', 'counsellor');
    const body = z
      .object({
        fullName: z.string().min(1).max(120),
        phone: z.string().min(6).max(20),
        productId: uuid,
        amount: z.number().positive().max(100000000),
        paidAt: z.string().datetime({ offset: true }).optional(),
        mode: z.enum(['upi', 'card', 'netbanking', 'cash', 'cheque', 'neft', 'other']).default('other'),
        mentorId: uuid.nullable().optional(),
        note: z.string().max(300).optional(),
        counsellorId: uuid.nullable().optional(),
        sourceId: uuid.nullable().optional(),
        // What was actually received now. Omitted means paid in full, which
        // is what every caller meant before the split existed.
        paidAmount: z.number().positive().max(100000000).optional(),
        balanceDueOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      })
      .parse(req.body);

    const row = await req.tx((q) =>
      q.one<{ deal_id: string }>(
        `select crm.add_manual_client($1, $2, $3, $4::numeric, $5, $6, $7, $8, $9, $10,
                                      $11::numeric, $12::date) as deal_id`,
        [
          body.fullName.trim(), body.phone.trim(), body.productId, body.amount,
          body.paidAt ?? new Date().toISOString(), body.mode,
          body.mentorId ?? null, body.note?.trim() || null,
          body.counsellorId ?? null, body.sourceId ?? null,
          body.paidAmount ?? null, body.balanceDueOn ?? null,
        ],
      ),
    );
    reply.code(201);
    return row;
  });

  /**
   * Everything the manual-entry form needs to name how a client arrived:
   * the counsellors who could have converted them (with their team, because
   * the deal follows the counsellor's team) and the lead sources.
   */
  app.get('/advisory/entry-options', async (req) => {
    req.requireRole('admin', 'ops', 'counsellor');
    return req.tx(async (q) => {
      const counsellors = await q.many(
        `select u.id, u.full_name, t.name as team_name
           from crm.users u
           left join crm.team_memberships tm
                  on tm.user_id = u.id and tm.period @> current_date
           left join crm.teams t on t.id = tm.team_id
          where u.role = 'counsellor' and u.is_active
          order by u.full_name`,
      );
      const sources = await q.many(
        `select id, name from crm.lead_sources order by name`,
      );
      return { counsellors, sources };
    });
  });

  /**
   * Is this phone number already a client? Called by the Add-a-client form
   * while the number is typed, so the person at the desk learns the truth
   * BEFORE filling the rest - not from a refusal at the end. The function is
   * definer-rights so the answer holds across the team fence; the route just
   * shapes it.
   */
  app.get('/advisory/lookup', async (req) => {
    req.requireRole('admin', 'ops', 'counsellor');
    const { phone } = z.object({ phone: z.string().min(6).max(20) }).parse(req.query);
    const row = await req.tx((q) =>
      q.one<{ found: Record<string, unknown> | null }>(
        `select crm.lookup_client_by_phone($1) as found`,
        [phone.trim()],
      ),
    );
    return { found: row?.found ?? null };
  });

  /** Products, for the manual-add form. */
  app.get('/advisory/products', async (req) => {
    req.requireRole('admin', 'ops', 'counsellor', 'mentor', 'viewer');
    return req.tx((q) =>
      q.many(`select id, name, list_price_inr from crm.products order by name`),
    );
  });

  /**
   * Correct a client record. The rules live in crm.edit_client: identity on
   * any client, money and credit only on hand-entered deals, every change
   * appended to the lead's history. The route just passes the form through
   * and maps the database's plain-words refusals to status codes.
   */
  app.put('/advisory/:dealId/details', async (req) => {
    req.requireRole('admin', 'ops', 'counsellor');
    const { dealId } = z.object({ dealId: uuid }).parse(req.params);
    const body = z
      .object({
        fullName: z.string().min(1).max(120).optional(),
        phone: z.string().min(6).max(20).optional(),
        productId: uuid.optional(),
        amount: z.number().positive().max(100000000).optional(),
        counsellorId: uuid.optional(),
        sourceId: uuid.optional(),
        paidOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        mode: z.enum(['upi', 'card', 'netbanking', 'cash', 'cheque', 'neft', 'other']).optional(),
        reference: z.string().max(300).optional(),
        paidAmount: z.number().positive().max(100000000).optional(),
        balanceDueOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      })
      .parse(req.body);

    return req.tx(async (q) => {
      await q.one(
        `select crm.edit_client($1, $2, $3, $4, $5::numeric, $6, $7, $8, $9, $10,
                                $11::numeric, $12::date)`,
        [dealId, body.fullName?.trim() ?? null, body.phone?.trim() ?? null,
         body.productId ?? null, body.amount ?? null,
         body.counsellorId ?? null, body.sourceId ?? null,
         // Never-future timestamp: today means "now", a past day pins to
         // midday IST so the date never slips when rendered back in IST.
         paidOnToTimestamp(body.paidOn),
         body.mode ?? null, body.reference ?? null,
         body.paidAmount ?? null, body.balanceDueOn ?? null],
      );
      // Read back through the invoker-rights view; an edit that moved the
      // client to the other team can legitimately vanish from a counsellor's
      // own fence, so absence here is not an error.
      const row = await q.one(`select * from crm.v_advisory_clients where deal_id = $1`, [dealId]);
      return { ok: true, client: row ?? null };
    });
  });

  app.put('/advisory/:dealId', async (req) => {
    const user = req.requireRole('admin', 'counsellor');
    const { dealId } = z.object({ dealId: uuid }).parse(req.params);
    const body = z
      .object({
        mitcDone: z.boolean().optional(),
        kycDone: z.boolean().optional(),
        groupAdded: z.boolean().optional(),
        subscriptionEndsAt: z.string().datetime({ offset: true }).nullable().optional(),
      })
      .parse(req.body);

    const row = await req.tx((q) =>
      q.one(
        `insert into crm.advisory_checkpoints
           (deal_id, mitc_done_at, mitc_by, kyc_done_at, kyc_by,
            group_added_at, group_added_by, subscription_ends_at)
         values ($1,
                 case when $2 then now() end, case when $2 then $4::uuid end,
                 case when $3 then now() end, case when $3 then $4::uuid end,
                 case when $6 then now() end, case when $6 then $4::uuid end,
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
           group_added_at = case when $6 is null then crm.advisory_checkpoints.group_added_at
                                 when $6 then coalesce(crm.advisory_checkpoints.group_added_at, now()) end,
           group_added_by = case when $6 is null then crm.advisory_checkpoints.group_added_by
                                 when $6 then coalesce(crm.advisory_checkpoints.group_added_by, $4::uuid) end,
           subscription_ends_at = coalesce($5, crm.advisory_checkpoints.subscription_ends_at),
           updated_at = now()
         returning *`,
        [dealId, body.mitcDone ?? null, body.kycDone ?? null, user.id,
         body.subscriptionEndsAt ?? null, body.groupAdded ?? null],
      ),
    );
    if (!row) throw notFound('no paying client with that deal id');
    return row;
  });
}
