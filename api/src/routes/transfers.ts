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

      // A star caller who transfers her own lead away can no longer see it
      // (RLS: it now belongs to the receiver), so the read-back returns null.
      // The transfer still happened; report the new owner rather than 500ing.
      const row = await q.one(
        `select id, caller_id, team_id, transfer_count, na_streak,
                next_action_at, next_action_note
           from crm.leads where id = $1`,
        [id],
      );
      return row ?? { id, caller_id: body.toCallerId, transferred: true };
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

  /**
   * Teammates a star caller can hand leads to (their own team, minus
   * themselves). Only for a caller who holds the transfer grant; the rule is
   * also enforced in crm.transfer_lead, this just powers the picker.
   */
  app.get('/me/transfer-targets', async (req) => {
    const user = req.requireUser();
    return req.tx(async (q) => {
      const me = await q.one<{ can_transfer_leads: boolean }>(
        `select can_transfer_leads from crm.users where id = $1`,
        [user.id],
      );
      if (!me?.can_transfer_leads && user.role === 'caller') return [];
      return q.many(
        `select u.id, u.full_name, crm.is_on_shift(u.id) as on_shift,
                (select count(*) from crm.leads l
                  where l.caller_id = u.id
                    and crm.ist_date(l.created_at) = crm.ist_date(now())) as leads_today
           from crm.users u
           join crm.team_memberships tm on tm.user_id = u.id and tm.period @> current_date
          where u.role = 'caller' and u.is_active and u.id <> $1
            and tm.team_id = crm.team_of($1, current_date)
          order by on_shift desc, leads_today asc`,
        [user.id],
      );
    });
  });

  /**
   * Bulk transfer - the star caller (or a counsellor/admin) hands a whole set
   * of their leads to one teammate in a single action. Each lead goes through
   * crm.transfer_lead, so the authority rule and the per-lead cap both hold;
   * leads that fail (already at the cap, not the actor's) are reported, not
   * silently skipped.
   */
  app.post('/leads/transfer-bulk', async (req) => {
    const user = req.requireUser();
    const body = z
      .object({
        leadIds: z.array(uuid).min(1).max(200),
        toCallerId: uuid,
        reason: z.enum(['not_answered_streak', 'language_mismatch', 'caller_unavailable',
                        'load_balance', 'escalation', 'other']).default('load_balance'),
        note: z.string().max(500).optional(),
      })
      .parse(req.body);

    return req.tx(async (q) => {
      let moved = 0;
      const failed: Array<{ leadId: string; reason: string }> = [];
      for (const leadId of body.leadIds) {
        // A savepoint per lead: without it, the first failed transfer aborts
        // the whole transaction and every later lead fails too. This isolates
        // each one so a capped lead does not sink the rest of the batch.
        await q.query('savepoint sp');
        try {
          await q.query('select crm.transfer_lead($1, $2, $3::crm.transfer_reason, $4, $5)', [
            leadId, body.toCallerId, body.reason, user.id, body.note ?? null,
          ]);
          await q.query('release savepoint sp');
          moved += 1;
        } catch (err) {
          await q.query('rollback to savepoint sp');
          failed.push({ leadId, reason: err instanceof Error ? err.message : String(err) });
        }
      }
      return { moved, failed };
    });
  });
}
