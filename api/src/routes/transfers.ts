import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

const uuid = z.string().uuid();

/**
 * Requirement 8: a lead that went Not Answered can be transferred to another
 * caller by the counsellor, who is also the team lead.
 *
 * Note what is NOT here: any check that the acting user is a counsellor. That
 * rule lives inside crm.transfer_lead(), along with the two-transfer cap, and
 * it raises insufficient_privilege / check_violation which the error handler
 * maps to 403 and 409. Enforcing it a second time in the route would give two
 * places for the rule to live and one of them would eventually be wrong.
 */
export async function transferRoutes(app: FastifyInstance): Promise<void> {
  app.get('/transfers/candidates', async (req) => {
    req.requireRole('counsellor', 'admin');
    return req.tx((q) =>
      q.many(
        `select * from crm.v_transfer_candidates
          order by na_streak desc, attempt_count desc`,
      ),
    );
  });

  app.post('/leads/:id/transfer', async (req) => {
    const user = req.requireUser();
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = z
      .object({
        toCallerId: uuid,
        reason: z.enum([
          'not_answered_streak',
          'language_mismatch',
          'caller_unavailable',
          'load_balance',
          'escalation',
          'other',
        ]),
        note: z.string().max(500).optional(),
      })
      .parse(req.body);

    return req.tx(async (q) => {
      await q.query('select crm.transfer_lead($1, $2, $3::crm.transfer_reason, $4, $5)', [
        id,
        body.toCallerId,
        body.reason,
        user.id,
        body.note ?? null,
      ]);

      return q.one(
        `select id, caller_id, team_id, transfer_count, na_streak,
                next_action_at, next_action_note
           from crm.leads where id = $1`,
        [id],
      );
    });
  });

  /** Who a counsellor can hand a lead to, with current load so the choice is informed. */
  app.get('/transfers/targets', async (req) => {
    req.requireRole('counsellor', 'admin');
    return req.tx((q) =>
      q.many(
        `select u.id, u.full_name,
                crm.is_on_shift(u.id) as on_shift,
                (select count(*) from crm.leads l
                  where l.caller_id = u.id
                    and l.status not in ('won','lost','invalid','nurture','handed_off')) as open_leads,
                (select count(*) from crm.leads l
                  where l.caller_id = u.id
                    and crm.ist_date(l.created_at) = crm.ist_date(now())) as leads_today
           from crm.users u
           join crm.team_memberships tm on tm.user_id = u.id and tm.period @> current_date
          where u.role = 'caller' and u.is_active
            and tm.team_id = crm.current_user_team()
          order by on_shift desc, leads_today asc`,
      ),
    );
  });
}
