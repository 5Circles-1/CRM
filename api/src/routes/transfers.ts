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
    // The team name rides along so the "Give to" picker can put this lead's
    // own team first by name - an admin's queue spans every team, and a
    // hand-off that crosses one should say so before it is clicked.
    return req.tx((q) =>
      q.many(
        `select c.*, t.name as team_name
           from crm.v_transfer_candidates c
           left join crm.teams t on t.id = c.team_id
          order by c.na_streak desc, c.attempt_count desc`,
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

  /**
   * Who a lead may be handed to, with current load so the choice is informed.
   *
   * This list must offer exactly the set crm.transfer_lead() will accept —
   * every active caller — because a picker narrower than the rule it fronts is
   * a rule living in a second place. It used to inner-join today's team
   * membership and compare it to crm.current_user_team(), which broke twice:
   * an ADMIN holds no team membership at all, so the comparison was
   * `= NULL`, the list came back empty, and every Transfer button on Floor
   * answered "No caller available to receive it" while the floor was full;
   * and a counsellor could never hand a lead across teams even though
   * transfer_lead does exactly that (it re-stamps team_id to the new caller's
   * team). A caller whose membership row had lapsed vanished the same way.
   *
   * Team is returned rather than filtered on, so the UI can put the lead's own
   * team first and name the move when it crosses one. RESTRICTED callers stay
   * on the list on purpose: the tier stops the *engine* handing them fresh
   * leads, not a human handing them a specific one.
   */
  app.get('/transfers/targets', async (req) => {
    req.requireRole('counsellor', 'admin');
    return req.tx((q) =>
      q.many(
        `select u.id, u.full_name,
                tm.team_id,
                t.name as team_name,
                coalesce(pt.tier, 'standard') as tier,
                crm.is_on_shift(u.id) as on_shift,
                (select count(*) from crm.leads l
                  where l.caller_id = u.id
                    and l.status not in ('won','lost','invalid','nurture','handed_off')) as open_leads,
                (select count(*) from crm.leads l
                  where l.caller_id = u.id
                    and crm.ist_date(l.created_at) = crm.ist_date(now())) as leads_today
           from crm.users u
           left join crm.team_memberships tm
             on tm.user_id = u.id and tm.period @> current_date
           left join crm.teams t on t.id = tm.team_id
           left join crm.performance_tiers pt on pt.user_id = u.id
          where u.role = 'caller' and u.is_active
          order by on_shift desc, leads_today asc, u.full_name`,
      ),
    );
  });
}
