import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { badRequest } from '../http/errors.ts';

/**
 * One endpoint, one payload, everything the Dashboard screen shows.
 *
 * Two kinds of number live here and they are deliberately separate:
 *  - RANGE numbers answer "what happened between these dates" (leads in,
 *    calls made, conversions) and the funnel follows the cohort of leads
 *    RECEIVED in the range, so each stage is a subset of the one before it.
 *  - NOW numbers answer "what needs attention this minute" (open, overdue,
 *    unassigned) and ignore the range entirely.
 *
 * Visible to everyone on the floor - transparency is the product.
 */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'use YYYY-MM-DD');

export async function dashboardRoutes(app: FastifyInstance): Promise<void> {
  app.get('/dashboard', async (req) => {
    req.requireUser();
    const query = z
      .object({ from: isoDate.optional(), to: isoDate.optional() })
      .parse(req.query);

    return req.tx(async (q) => {
      const range = await q.one<{ from_d: string; to_d: string }>(
        `select coalesce($1::date, crm.ist_date(now()) - 6) as from_d,
                coalesce($2::date, crm.ist_date(now()))     as to_d`,
        [query.from ?? null, query.to ?? null],
      );
      const { from_d: from, to_d: to } = range!;
      if (from > to) throw badRequest('"from" must not be after "to"');

      const totals = await q.one(
        `select
           (select count(*) from crm.leads where crm.ist_date(created_at) between $1 and $2) as leads_in,
           (select count(*) from crm.activities
             where kind = 'call' and crm.ist_date(created_at) between $1 and $2)             as calls,
           (select count(*) from crm.leads
             where qualified_at is not null and crm.ist_date(qualified_at) between $1 and $2) as qualified,
           (select count(*) from crm.leads
             where converted_at is not null and crm.ist_date(converted_at) between $1 and $2) as converted,
           (select count(*) from crm.leads
             where stage = 'not_qualified' and crm.ist_date(closed_at) between $1 and $2)     as not_qualified,
           (select count(*) from crm.leads
             where template_sent_at is not null and crm.ist_date(template_sent_at) between $1 and $2) as invites_sent,
           (select count(*) from crm.leads
             where confirmed_at is not null and crm.ist_date(confirmed_at) between $1 and $2) as confirmed`,
        [from, to],
      );

      const now = await q.one(
        `select
           count(*) filter (where is_open)                            as open_now,
           count(*) filter (where due_bucket = 'overdue')             as overdue_now,
           count(*) filter (where due_bucket in ('overdue', 'today')) as due_today,
           count(*) filter (where is_open and assigned_to is null)    as unassigned_now,
           count(*) filter (where stage = 'new')                      as untouched_now
           from crm.v_lead_list`,
      );

      // The funnel follows leads RECEIVED in the range, wherever they are now.
      const funnel = await q.one(
        `select
           count(*)                                          as received,
           count(*) filter (where call_count > 0)            as contacted,
           count(*) filter (where qualified_at is not null)  as qualified,
           count(*) filter (where template_sent_at is not null) as invite_sent,
           count(*) filter (where confirmed_at is not null)  as confirmed,
           count(*) filter (where converted_at is not null)  as converted
           from crm.leads
          where crm.ist_date(created_at) between $1 and $2`,
        [from, to],
      );

      const bySource = await q.many(
        `select s.name as source,
                count(l.id)                                           as leads,
                count(l.id) filter (where l.call_count > 0)           as contacted,
                count(l.id) filter (where l.qualified_at is not null) as qualified,
                count(l.id) filter (where l.converted_at is not null) as converted
           from crm.lead_sources s
           left join crm.leads l
             on l.source_id = s.id and crm.ist_date(l.created_at) between $1 and $2
          group by s.name, s.is_active
          having count(l.id) > 0 or s.is_active
          order by leads desc, s.name`,
        [from, to],
      );

      const byDay = await q.many(
        `select d::date as day,
                (select count(*) from crm.leads where crm.ist_date(created_at) = d)        as leads_in,
                (select count(*) from crm.activities
                  where kind = 'call' and crm.ist_date(created_at) = d)                    as calls,
                (select count(*) from crm.leads
                  where qualified_at is not null and crm.ist_date(qualified_at) = d)       as qualified,
                (select count(*) from crm.leads
                  where converted_at is not null and crm.ist_date(converted_at) = d)       as converted
           from generate_series($1::date, $2::date, interval '1 day') d
          order by d`,
        [from, to],
      );

      // Who did what: calls split by outcome, plus the live book each person
      // carries right now. The admin reads this; so can everyone else.
      const byPerson = await q.many(
        `select u.id, u.full_name, u.role,
                coalesce(a.calls, 0)          as calls,
                coalesce(a.qualified, 0)      as qualified_calls,
                coalesce(a.call_backs, 0)     as call_backs,
                coalesce(a.not_answered, 0)   as not_answered,
                coalesce(a.not_qualified, 0)  as not_qualified_calls,
                coalesce(c.converted, 0)      as conversions,
                coalesce(b.open_now, 0)       as open_now,
                coalesce(b.overdue_now, 0)    as overdue_now
           from crm.users u
           left join (
             select user_id,
                    count(*)                                        as calls,
                    count(*) filter (where outcome = 'qualified')   as qualified,
                    count(*) filter (where outcome = 'call_back')   as call_backs,
                    count(*) filter (where outcome in ('not_answered', 'switched_off')) as not_answered,
                    count(*) filter (where outcome = 'not_qualified') as not_qualified
               from crm.activities
              where kind = 'call' and crm.ist_date(created_at) between $1 and $2
              group by user_id
           ) a on a.user_id = u.id
           left join (
             select user_id, count(*) as converted
               from crm.activities
              where kind = 'checkpoint'
                and meta->>'checkpoint' = 'converted' and (meta->>'on')::boolean
                and crm.ist_date(created_at) between $1 and $2
              group by user_id
           ) c on c.user_id = u.id
           left join (
             select assigned_to,
                    count(*) filter (where is_open)                as open_now,
                    count(*) filter (where due_bucket = 'overdue') as overdue_now
               from crm.v_lead_list
              group by assigned_to
           ) b on b.assigned_to = u.id
          where u.is_active and not u.is_service
          order by u.role, u.rotation_order, u.full_name`,
        [from, to],
      );

      return { from, to, totals, now, funnel, bySource, byDay, byPerson };
    });
  });
}
