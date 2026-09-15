import type { FastifyInstance } from 'fastify';
import type { Querier } from '../db/pool.ts';
import { z } from 'zod';
import { logLeadAccess } from '../http/context.ts';
import { badRequest, notFound } from '../http/errors.ts';

const uuid = z.string().uuid();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/**
 * Office visits: the walk-in from the moment it is booked to the moment the
 * counsellor says what happened.
 *
 * Nothing here decides who may do what. The authority rules live in
 * crm.assign_walkin / crm.record_walkin_arrival / crm.record_walkin_response,
 * which raise insufficient_privilege and check_violation for the error handler
 * to map to 403 and 409 - the same shape as transfers. Nothing here filters by
 * ownership either: RLS on crm.leads decides which visits come back, so a
 * visit the user may not see reads as 404, which is correct.
 *
 * The one rule worth restating in this comment because it is invisible in the
 * code: a conversion is never posted to this route. The counsellor books the
 * deal exactly as before and a database trigger marks the visit converted. If
 * this route accepted `outcome: 'converted'`, the ratio would be a second,
 * hand-typed record of the money and the two would part company inside a week.
 */
export async function walkinRoutes(app: FastifyInstance): Promise<void> {
  /**
   * The desk: everyone expected, everyone in the building, everyone counselled
   * today. This is what the Office visits tab opens on.
   */
  app.get('/walkins/desk', async (req) => {
    const user = req.requireUser();
    return req.tx(async (q) => {
      const rows = await q.many<{ lead_id: string }>(
        `select * from crm.v_walkin_desk
          order by case status when 'arrived' then 0 when 'expected' then 1 else 2 end,
                   response_overdue desc,
                   coalesce(arrived_at, expected_at)`,
      );
      if (rows.length) {
        await logLeadAccess(q, user.id, rows.map((r) => r.lead_id), 'list', req.ip);
      }
      const counsellors = await q.many(
        `select u.id, u.full_name,
                (select count(*) from crm.walkin_visits w
                  where w.counsellor_id = u.id and w.status in ('expected','arrived'))::int
                  as open_visits
           from crm.users u
          where u.role = 'counsellor' and u.is_active
          order by u.full_name`,
      );
      return { visits: rows, counsellors };
    });
  });

  /**
   * Every visit in a window, with the conversion analytics built on top.
   *
   * One endpoint, two screens: the Office visits tab renders the whole thing
   * and the Overview tab renders the summary. Every board below is a GROUP BY
   * over the same crm.v_walkin_visits rows, so the funnel, the counsellor
   * board and the product board cannot disagree about what a conversion is.
   */
  app.get('/dashboards/walkins', async (req) => {
    req.requireUser();
    const { from, to } = z
      .object({ from: isoDate.optional(), to: isoDate.optional() })
      .parse(req.query);
    if (from && to && from > to) throw badRequest('"from" must not be after "to"');

    return req.tx(async (q) => {
      // Resolve the window in SQL so "this month" is the IST calendar's month,
      // never the server's UTC one.
      const range = (await q.one<{ from_d: string; to_d: string }>(
        `select coalesce($1::date, date_trunc('month', crm.ist_date(now()))::date)::text as from_d,
                coalesce($2::date, crm.ist_date(now()))::text as to_d`,
        [from ?? null, to ?? null],
      ))!;
      const args = [range.from_d, range.to_d];

      // The funnel. "Promised" is what the phones said in the window; the
      // other three are visits. Deliberately separate numbers: a promise is
      // not a visit, and the gap between them is the thing worth managing.
      const funnel = await q.one(
        `with r as (select $1::date as f, $2::date as t),
         v as (
           select * from crm.v_walkin_visits, r
            where visit_date between r.f and r.t
         )
         select
           (select count(*) from crm.call_attempts a, r
             where a.disposition = 'will_visit'
               and crm.ist_date(a.started_at) between r.f and r.t)::int     as promised,
           (select count(*) from v where has_arrived)::int                  as arrived,
           (select count(*) from v where status = 'expected')::int          as expected,
           (select count(*) from v where status = 'no_show')::int           as no_show,
           (select count(*) from v where counselled_at is not null)::int    as counselled,
           (select count(*) from v where is_converted)::int                 as converted,
           (select count(*) from v where has_arrived and response_overdue)::int
                                                                           as awaiting_response,
           (select coalesce(sum(booked_amount), 0) from v where is_converted)
                                                                           as converted_amount,
           (select coalesce(sum(collected_amount), 0) from v where is_converted)
                                                                           as collected_amount`,
        args,
      );

      // Who converted the most walk-ins. Ordered by conversions, not revenue:
      // the question is who turns a person in a chair into a client.
      const counsellors = await q.many(
        `select counsellor_id as user_id,
                coalesce(counsellor_name, 'Not recorded') as full_name,
                count(*) filter (where has_arrived)::int  as visits,
                count(*) filter (where is_converted)::int as converted,
                coalesce(sum(booked_amount) filter (where is_converted), 0) as booked_amount,
                coalesce(sum(collected_amount) filter (where is_converted), 0) as collected_amount,
                case when count(*) filter (where has_arrived) > 0
                     then round(100.0 * count(*) filter (where is_converted)
                                / count(*) filter (where has_arrived), 1) end as conversion_pct
           from crm.v_walkin_visits
          where visit_date between $1::date and $2::date
            and counsellor_id is not null
          group by counsellor_id, counsellor_name
         having count(*) filter (where has_arrived) > 0
          order by converted desc, booked_amount desc, full_name`,
        args,
      );

      // Which product converts. Counted on the visits that arrived, so the
      // denominator is "pitched in the office" rather than "sold".
      const products = await q.many(
        `select product_id,
                coalesce(product_name, 'Not recorded') as product_name,
                count(*) filter (where has_arrived)::int  as visits,
                count(*) filter (where is_converted)::int as converted,
                coalesce(sum(booked_amount) filter (where is_converted), 0) as booked_amount,
                case when count(*) filter (where has_arrived) > 0
                     then round(100.0 * count(*) filter (where is_converted)
                                / count(*) filter (where has_arrived), 1) end as conversion_pct
           from crm.v_walkin_visits
          where visit_date between $1::date and $2::date
            and has_arrived
          group by product_id, product_name
          order by converted desc, visits desc, product_name`,
        args,
      );

      // Who called the maximum walk-ins. caller_id is who put them in the
      // building, never who greeted them - see the column comment.
      const callers = await q.many(
        `select v.caller_id as user_id,
                coalesce(v.caller_name, 'Not recorded') as full_name,
                u.role::text                             as role,
                count(*) filter (where v.has_arrived)::int  as walkins,
                count(*) filter (where v.status = 'expected')::int as booked_pending,
                count(*) filter (where v.is_converted)::int as converted,
                coalesce(sum(v.booked_amount) filter (where v.is_converted), 0) as booked_amount,
                case when count(*) filter (where v.has_arrived) > 0
                     then round(100.0 * count(*) filter (where v.is_converted)
                                / count(*) filter (where v.has_arrived), 1) end as conversion_pct
           from crm.v_walkin_visits v
           left join crm.users u on u.id = v.caller_id
          where v.visit_date between $1::date and $2::date
            and v.caller_id is not null
          group by v.caller_id, v.caller_name, u.role
         having count(*) filter (where v.has_arrived) > 0
             or count(*) filter (where v.status = 'expected') > 0
          order by walkins desc, converted desc, full_name`,
        args,
      );

      // What was said at the desk on the visits that did not convert. This is
      // the coaching material: "thinking" nine times out of ten is a pitch
      // problem, not a lead problem.
      const outcomes = await q.many(
        `select coalesce(outcome, 'not recorded yet') as outcome, count(*)::int as count
           from crm.v_walkin_visits
          where visit_date between $1::date and $2::date and has_arrived
          group by outcome order by count desc`,
        args,
      );

      const visits = await q.many(
        `select * from crm.v_walkin_visits
          where visit_date between $1::date and $2::date
          order by coalesce(arrived_at, expected_at, created_at) desc
          limit 500`,
        args,
      );

      return {
        from: range.from_d,
        to: range.to_d,
        funnel,
        counsellors,
        products,
        callers,
        outcomes,
        visits,
      };
    });
  });

  /**
   * Door one: the caller books this lead in to see a counsellor.
   *
   * The expected date is required. "Assign a walk-in with no day" is how a
   * promised visit became a vague intention, which 0067 already spent a
   * migration fixing on the call-logging side.
   */
  app.post('/leads/:id/walkin-visit', async (req, reply) => {
    req.requireUser();
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = z
      .object({
        counsellorId: uuid.optional(),
        expectedAt: z.coerce.date(),
        note: z.string().max(1000).optional(),
      })
      .parse(req.body);

    const result = await req.tx(async (q) => {
      const counsellorId = body.counsellorId ?? (await defaultCounsellor(q, id));
      if (!counsellorId) throw badRequest('no counsellor available for this lead’s team');

      const row = await q.one<{ visit: string }>(
        `select crm.assign_walkin($1, $2, $3::timestamptz, $4) as visit`,
        [id, counsellorId, body.expectedAt.toISOString(), body.note?.trim() || null],
      );
      return q.one(`select * from crm.v_walkin_visits where visit_id = $1`, [row!.visit]);
    });

    return reply.status(201).send(result);
  });

  /**
   * Door two: they are in the office now.
   *
   * Completes a booked visit if one exists rather than opening a second, so a
   * client who was expected and turned up is one visit, not two - which is
   * the difference between a ratio and a guess.
   */
  app.post('/leads/:id/walkin-arrival', async (req, reply) => {
    req.requireUser();
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = z
      .object({ counsellorId: uuid.optional(), note: z.string().max(1000).optional() })
      .parse(req.body ?? {});

    const result = await req.tx(async (q) => {
      const row = await q.one<{ visit: string }>(
        `select crm.record_walkin_arrival($1, $2, $3) as visit`,
        [id, body.counsellorId ?? null, body.note?.trim() || null],
      );
      return q.one(`select * from crm.v_walkin_visits where visit_id = $1`, [row!.visit]);
    });

    return reply.status(201).send(result);
  });

  /**
   * The counselling response. Counsellor or admin only - enforced in the
   * function, which returns 42501 for anyone else.
   *
   * 'converted' is not an accepted value here and the function refuses it:
   * book the deal instead. That is not an inconvenience, it is the reason the
   * conversion ratio can be trusted.
   */
  app.post('/walkins/:id/response', async (req) => {
    const user = req.requireUser();
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = z
      .object({
        outcome: z.enum(['thinking', 'revisit', 'not_interested', 'not_eligible', 'no_show']),
        productId: uuid.optional(),
        notes: z.string().max(2000).optional(),
        nextActionAt: z.coerce.date().optional(),
      })
      .parse(req.body);

    // A lead that is still live needs a date to come back on. 'revisit' means
    // a second visit, so it needs one for exactly the reason a will_visit does.
    if (body.outcome === 'revisit' && !body.nextActionAt) {
      throw badRequest('a revisit needs the day they are coming back');
    }

    return req.tx(async (q) => {
      await q.query(`select crm.record_walkin_response($1, $2, $3, $4, $5::timestamptz)`, [
        id,
        body.outcome,
        body.productId ?? null,
        body.notes?.trim() || null,
        body.nextActionAt?.toISOString() ?? null,
      ]);
      const visit = await q.one<{ lead_id: string }>(
        `select * from crm.v_walkin_visits where visit_id = $1`,
        [id],
      );
      if (!visit) throw notFound('no such visit');
      await logLeadAccess(q, user.id, [visit.lead_id], 'detail', req.ip);
      return visit;
    });
  });

  /** Every visit this lead has ever made, for the lead page's timeline. */
  app.get('/leads/:id/walkin-visits', async (req) => {
    req.requireUser();
    const { id } = z.object({ id: uuid }).parse(req.params);
    return req.tx((q) =>
      q.many(
        `select * from crm.v_walkin_visits where lead_id = $1
          order by coalesce(arrived_at, expected_at, created_at) desc`,
        [id],
      ),
    );
  });
}

/** The counsellor who leads this lead's team - the same default /leads/:id/qualify uses. */
async function defaultCounsellor(q: Querier, leadId: string): Promise<string | null> {
  const row = await q.one<{ id: string }>(
    `select u.id
       from crm.leads l
       join crm.team_memberships tm
         on tm.team_id = l.team_id and tm.period @> current_date
       join crm.users u on u.id = tm.user_id
      where l.id = $1 and u.role = 'counsellor' and u.is_active
      order by tm.rotation_order
      limit 1`,
    [leadId],
  );
  return row?.id ?? null;
}
