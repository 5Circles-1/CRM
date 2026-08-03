import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { badRequest, notFound } from '../http/errors.ts';

const uuid = z.string().uuid();
const money = z.number().positive().max(99_999_999);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/**
 * Deals, instalments, payments and promises - the "money collected" half of
 * the CRM's job. Deliberately lean: servicing the client after payment belongs
 * to the advisory pipeline. What must exist here is what the counsellor
 * dashboard and the breakeven thermometer are built on, plus the collections
 * queue the closer chases.
 */
export async function dealRoutes(app: FastifyInstance): Promise<void> {
  app.get('/products', async (req) => {
    req.requireUser();
    return req.tx((q) =>
      q.many(
        `select id, name, code, list_price_inr, is_sebi_regulated
           from crm.products where is_active order by name`,
      ),
    );
  });

  /**
   * Book a deal on a lead. The database trigger closes the lead as won and
   * takes it out of the calling pipeline; the unique partial index rejects a
   * second open deal on the same lead as a 409.
   */
  app.post('/leads/:id/deals', async (req, reply) => {
    const user = req.requireRole('counsellor', 'admin');
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = z
      .object({
        productId: uuid,
        bookedAmount: money,
        discountAmount: z.number().min(0).max(99_999_999).default(0),
        instalments: z
          .array(z.object({ dueDate: isoDate, amount: money }))
          .min(1)
          .max(12),
      })
      .parse(req.body);

    // Compare in paise so 24999.99 + 0.01 style float drift cannot slip a
    // mismatched schedule through.
    const paise = (n: number) => Math.round(n * 100);
    const scheduled = body.instalments.reduce((acc, i) => acc + paise(i.amount), 0);
    if (scheduled !== paise(body.bookedAmount)) {
      throw badRequest(
        `instalments (${(scheduled / 100).toFixed(2)}) must sum to the booked amount (${body.bookedAmount.toFixed(2)})`,
      );
    }

    const result = await req.tx(async (q) => {
      const lead = await q.one<{ id: string; caller_id: string | null; team_id: string | null }>(
        'select id, caller_id, team_id from crm.leads where id = $1',
        [id],
      );
      if (!lead) throw notFound('lead not found');

      const deal = await q.one<{ id: string }>(
        `insert into crm.deals
           (lead_id, product_id, counsellor_id, setter_id, team_id,
            booked_amount, discount_amount)
         values ($1, $2, $3, $4, $5, $6, $7)
         returning id, booked_amount, discount_amount, booked_at`,
        [id, body.productId, user.id, lead.caller_id, lead.team_id, body.bookedAmount, body.discountAmount],
      );

      const instalments = await q.many(
        `insert into crm.instalments (deal_id, seq, due_date, amount)
         select $1, i.seq, i.due_date::date, i.amount
           from jsonb_to_recordset($2::jsonb)
                  as i(seq int, due_date text, amount numeric)
         returning id, seq, due_date, amount, status`,
        [
          deal!.id,
          JSON.stringify(
            body.instalments.map((i, ix) => ({ seq: ix + 1, due_date: i.dueDate, amount: i.amount })),
          ),
        ],
      );

      return { deal, instalments };
    });

    return reply.status(201).send(result);
  });

  /**
   * The collections queue: every open instalment, most urgent first, with the
   * latest open promise alongside. This is the screen the counsellor works -
   * collection accountability stays with whoever closed the deal.
   */
  app.get('/collections/due', async (req) => {
    req.requireRole('counsellor', 'admin', 'ops', 'viewer');
    return req.tx((q) =>
      q.many(
        `select i.id as instalment_id, i.seq, i.due_date, i.amount, i.paid_amount, i.status,
                (i.due_date < crm.ist_date(now())) as is_late,
                d.id as deal_id, d.booked_amount, d.counsellor_id,
                u.full_name as counsellor_name,
                l.id as lead_id, l.full_name, l.phone_e164,
                pr.promised_date, pr.promised_amount, pr.confidence,
                (select count(*) from crm.instalments i2 where i2.deal_id = d.id) as instalment_count
           from crm.instalments i
           join crm.deals d on d.id = i.deal_id and d.status = 'booked'
           join crm.users u on u.id = d.counsellor_id
           join crm.leads l on l.id = d.lead_id
           left join lateral (
             select p.promised_date, p.promised_amount, p.confidence
               from crm.promises_to_pay p
              where p.instalment_id = i.id and p.outcome is null
              order by p.created_at desc limit 1
           ) pr on true
          where i.status in ('due', 'part_paid', 'overdue')
          order by i.due_date asc, i.seq asc
          limit 500`,
      ),
    );
  });

  app.post('/deals/:id/payments', async (req, reply) => {
    const user = req.requireRole('counsellor', 'admin', 'ops');
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = z
      .object({
        instalmentId: uuid,
        amount: money,
        mode: z.enum(['upi', 'card', 'netbanking', 'cash', 'cheque', 'neft', 'other']),
        reference: z.string().max(120).optional(),
      })
      .parse(req.body);

    const result = await req.tx(async (q) => {
      const inst = await q.one<{ amount: string; paid_amount: string }>(
        'select amount, paid_amount from crm.instalments where id = $1 and deal_id = $2',
        [body.instalmentId, id],
      );
      if (!inst) throw notFound('instalment not found on that deal');

      const outstanding = Number(inst.amount) - Number(inst.paid_amount);
      if (body.amount > outstanding + 0.005) {
        throw badRequest(
          `payment of ${body.amount.toFixed(2)} exceeds the outstanding ${outstanding.toFixed(2)} on this instalment`,
        );
      }

      const payment = await q.one(
        `insert into crm.payments (deal_id, instalment_id, amount, mode, reference, recorded_by)
         values ($1, $2, $3, $4, $5, $6)
         returning id, amount, paid_at, mode, reference`,
        [id, body.instalmentId, body.amount, body.mode, body.reference ?? null, user.id],
      );
      // The payment trigger has already rolled the amount up; read it back.
      const instalment = await q.one(
        'select id, seq, amount, paid_amount, status from crm.instalments where id = $1',
        [body.instalmentId],
      );
      return { payment, instalment };
    });

    return reply.status(201).send(result);
  });

  /**
   * Promise-to-pay: structured, not a note. Broken promises are marked by the
   * nightly job and show up per client and per counsellor.
   */
  app.post('/instalments/:id/promise', async (req, reply) => {
    const user = req.requireRole('counsellor', 'admin', 'ops');
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = z
      .object({
        promisedDate: isoDate,
        amount: money,
        confidence: z.enum(['high', 'medium', 'low']),
      })
      .parse(req.body);

    const row = await req.tx(async (q) => {
      const inst = await q.one('select id from crm.instalments where id = $1', [id]);
      if (!inst) throw notFound('instalment not found');
      return q.one(
        `insert into crm.promises_to_pay
           (instalment_id, promised_date, promised_amount, confidence, captured_by)
         values ($1, $2, $3, $4, $5)
         returning id, promised_date, promised_amount, confidence`,
        [id, body.promisedDate, body.amount, body.confidence, user.id],
      );
    });

    return reply.status(201).send(row);
  });
}
