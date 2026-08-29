import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { logLeadAccess } from '../http/context.ts';
import { badRequest, notFound } from '../http/errors.ts';

const uuid = z.string().uuid();

/**
 * The caller's own screens: their day, their attendance, their score.
 * Requirements 4, 6 and 7.
 */
export async function meRoutes(app: FastifyInstance): Promise<void> {
  app.get('/me', async (req) => {
    const user = req.requireUser();
    return req.tx(async (q) => {
      const row = await q.one(
        `select u.id, u.full_name, u.email, u.role, u.employee_code,
                crm.team_of(u.id, current_date) as team_id,
                t.name as team_name,
                crm.is_on_shift(u.id) as on_shift
           from crm.users u
           left join crm.teams t on t.id = crm.team_of(u.id, current_date)
          where u.id = $1`,
        [user.id],
      );
      return row;
    });
  });

  /**
   * Requirement 4: the caller's pipeline for the day.
   *
   * Ordering is the point of this endpoint. Immediate leads that have never
   * been touched come first, then whatever is most overdue, then the day's
   * scheduled work. The caller should be able to work top to bottom without
   * making a single prioritisation decision.
   */
  app.get('/me/day', async (req) => {
    const user = req.requireUser();
    const query = z
      .object({ bucket: z.enum(['immediate', 'overdue', 'callback', 'fresh', 'scheduled']).optional() })
      .parse(req.query);

    return req.tx(async (q) => {
      const rows = await q.many<{ lead_id: string }>(
        `select *
           from crm.v_my_day
          where caller_id = $1
            and ($2::text is null or bucket = $2)
          order by case bucket
                     when 'immediate' then 0
                     when 'overdue'   then 1
                     when 'callback'  then 2
                     when 'fresh'     then 3
                     else 4
                   end,
                   minutes_overdue desc,
                   next_action_at asc`,
        [user.id, query.bucket ?? null],
      );

      await logLeadAccess(q, user.id, rows.map((r) => r.lead_id), 'list', req.ip);
      return { count: rows.length, leads: rows };
    });
  });

  /**
   * My whole open pipeline, bucketed - not just today.
   *
   * /me/day deliberately stops at midnight; it is the day's work list. This is
   * the answer to "what do I owe anyone this week", which had no screen at all:
   * a follow-up agreed for Thursday was invisible from Monday night until
   * Thursday morning.
   */
  app.get('/me/pipeline', async (req) => {
    const user = req.requireUser();
    const query = z
      .object({
        bucket: z
          .enum(['immediate', 'fresh', 'callback', 'will_visit', 'followup_today',
                 'overdue', 'breached', 'callback_upcoming', 'followup_upcoming'])
          .optional(),
        limit: z.coerce.number().int().min(1).max(500).default(200),
      })
      .parse(req.query);

    // queue_owner_id is what the ladder computes: an escalated lead belongs to
    // the counsellor, a normal one to the caller. Filtering on it is what makes
    // a lead leave the caller's list the moment it escalates. Fresh leads sort
    // first, always; breached work sits in its own bucket at the bottom.
    return req.tx(async (q) => {
      const [counts, rows] = await Promise.all([
        q.many<{ bucket: string; count: number }>(
          `select bucket, count(*)::int as count
             from crm.v_my_pipeline
            where queue_owner_id = $1
            group by bucket`,
          [user.id],
        ),
        q.many<{ lead_id: string }>(
          `select * from crm.v_my_pipeline
            where queue_owner_id = $1
              and ($2::text is null or bucket = $2)
            order by case bucket
                       when 'immediate'         then 0
                       when 'fresh'             then 1
                       when 'callback'          then 2
                       when 'will_visit'        then 3
                       when 'followup_today'    then 4
                       when 'overdue'           then 5
                       when 'breached'          then 6
                       when 'callback_upcoming' then 7
                       else 8
                     end,
                     minutes_overdue desc,
                     created_at desc,
                     next_action_at asc
            limit $3`,
          [user.id, query.bucket ?? null, query.limit],
        ),
      ]);

      await logLeadAccess(q, user.id, rows.map((r) => r.lead_id), 'list', req.ip);
      return {
        counts: Object.fromEntries(counts.map((c) => [c.bucket, Number(c.count)])),
        total: counts.reduce((a, c) => a + Number(c.count), 0),
        leads: rows,
      };
    });
  });

  /** The re-tap pool: leads nobody could reach, parked for tapping later. */
  app.get('/me/retap-pool', async (req) => {
    const user = req.requireUser();
    return req.tx(async (q) => {
      const rows = await q.many<{ lead_id: string }>(
        `select * from crm.v_retap_pool
          order by retap_since asc nulls last limit 300`,
      );
      await logLeadAccess(q, user.id, rows.map((r) => r.lead_id), 'list', req.ip);
      return { count: rows.length, leads: rows };
    });
  });

  /**
   * Fresh leads: nobody has ever contacted these.
   *
   * Its own list rather than a slice of the pipeline, because the question
   * "did anything arrive and just sit there?" has to be answerable in one
   * glance, including for leads held with no caller at all - which appear in
   * nobody's personal pipeline.
   */
  app.get('/me/fresh', async (req) => {
    const user = req.requireUser();
    const { scope, flag } = z
      .object({
        scope: z.enum(['mine', 'all']).default('mine'),
        flag: z.enum(['waiting', 'flagged', 'breached']).optional(),
      })
      .parse(req.query);

    return req.tx(async (q) => {
      const rows = await q.many<{ lead_id: string }>(
        `select * from crm.v_fresh_leads
          where ($1::text = 'all' or user_id = $2)
            and ($3::text is null or flag = $3)
          order by case flag when 'breached' then 0 when 'flagged' then 1 else 2 end,
                   minutes_late desc nulls last, age_minutes desc
          limit 500`,
        [scope, user.id, flag ?? null],
      );
      await logLeadAccess(q, user.id, rows.map((r) => r.lead_id), 'list', req.ip);
      const teams = await q.many(`select * from crm.v_fresh_summary order by team_name`);
      return { count: rows.length, leads: rows, teams };
    });
  });

  /**
   * The no-answer pool: still open, still yours, but gone quiet.
   *
   * These leads raise no individual alerts - that is the whole point - so this
   * is the only place they surface as a group. Sorted oldest-silence first,
   * which is the order they are worth calling in.
   */
  app.get('/me/no-answer-pool', async (req) => {
    const user = req.requireUser();
    const { scope } = z
      .object({ scope: z.enum(['mine', 'team']).default('mine') })
      .parse(req.query);

    return req.tx(async (q) => {
      const rows = await q.many<{ lead_id: string }>(
        `select * from crm.v_no_answer_pool
          where ($1::text = 'team' or user_id = $2)
          order by days_since_touch desc nulls last, na_streak desc
          limit 500`,
        [scope, user.id],
      );
      await logLeadAccess(q, user.id, rows.map((r) => r.lead_id), 'list', req.ip);
      const threshold = await q.one<{ n: number }>(
        `select crm.setting_int('alert.na_quiet_after_attempts', 3) as n`,
      );
      return { count: rows.length, threshold: threshold?.n ?? 3, leads: rows };
    });
  });

  /** Leads about to move to the other team unless worked - the warning tab. */
  app.get('/me/cross-team-watch', async (req) => {
    const user = req.requireUser();
    return req.tx(async (q) => {
      const rows = await q.many<{ lead_id: string }>(
        `select * from crm.v_cross_team_watch
          where queue_owner_id = $1
          order by moves_at asc limit 300`,
        [user.id],
      );
      return { count: rows.length, leads: rows };
    });
  });

  /** Pick a parked lead (re-tap or previous-month) back into live work. */
  app.post('/leads/:id/claim', async (req) => {
    const user = req.requireUser();
    const { id } = z.object({ id: uuid }).parse(req.params);
    return req.tx(async (q) => {
      await q.query('select crm.claim_parked_lead($1, $2)', [id, user.id]);
      return q.one(
        `select id, status, pool, caller_id, counsellor_id, escalation_stage,
                next_action_at from crm.leads where id = $1`,
        [id],
      );
    });
  });

  /** Set or clear the per-lead reminder: mute it, or choose a time. */
  app.put('/leads/:id/reminder', async (req) => {
    const user = req.requireUser();
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = z
      .object({
        muted: z.boolean().optional(),
        at: z.coerce.date().nullable().optional(),
        note: z.string().max(200).nullable().optional(),
      })
      .parse(req.body ?? {});

    return req.tx(async (q) => {
      const row = await q.one(
        `update crm.leads
            set reminder_muted = coalesce($2, reminder_muted),
                reminder_at    = case when $3 then $4::timestamptz else reminder_at end,
                reminder_note  = case when $3 then $5 else reminder_note end,
                updated_at = now()
          where id = $1
          returning id, reminder_muted, reminder_at, reminder_note`,
        [
          id,
          body.muted ?? null,
          'at' in body,
          body.at ?? null,
          body.note ?? null,
        ],
      );
      if (!row) throw notFound('lead not found');
      await q.query(
        `insert into crm.lead_events (lead_id, event_type, actor_id, payload)
         values ($1, 'reminder_set', $2, $3)`,
        [id, user.id, JSON.stringify({ muted: body.muted, at: body.at, note: body.note })],
      );
      return row;
    });
  });

  /**
   * The daily accountability brief: what today is costing and the run-rate
   * the rest of the month now needs.
   *
   * The same view the reminder engine reads, so the banner on screen and the
   * notification in the bell can never quote different numbers. Managers also
   * get the team roll-up.
   */
  app.get('/me/brief', async (req) => {
    const user = req.requireUser();
    return req.tx(async (q) => {
      const mine = await q.one(`select * from crm.v_daily_brief where user_id = $1`, [user.id]);
      const teams =
        user.role === 'caller'
          ? []
          : await q.many(`select * from crm.v_team_brief order by team_name`);
      return { brief: mine, teams };
    });
  });

  /** My notifications (cross-team arrivals and the like), newest first. */
  app.get('/me/notifications', async (req) => {
    const user = req.requireUser();
    return req.tx(async (q) => {
      const rows = await q.many(
        `select id, kind, title, body, lead_id, created_at, read_at
           from crm.notifications
          where user_id = $1
          order by (read_at is null) desc, created_at desc
          limit 100`,
        [user.id],
      );
      return { count: rows.length, unread: rows.filter((r) => !(r as { read_at: unknown }).read_at).length, notifications: rows };
    });
  });

  app.post('/me/notifications/read', async (req) => {
    req.requireUser();
    const body = z.object({ id: uuid.optional() }).parse(req.body ?? {});
    return req.tx(async (q) => {
      if (body.id) {
        await q.query(
          `update crm.notifications set read_at = now() where id = $1 and read_at is null`,
          [body.id],
        );
      } else {
        await q.query(`update crm.notifications set read_at = now() where read_at is null`);
      }
      return { ok: true };
    });
  });

  /**
   * Outcome mix — what happened to the calls, as a part-to-whole.
   *
   * Summed from crm.v_person_performance rather than call_attempts directly,
   * because that view already carries the visibility rule. Reading the attempts
   * table would show a caller the outcomes of calls a colleague made on a lead
   * that has since been reassigned to them.
   */
  app.get('/outcomes', async (req) => {
    req.requireUser();
    const { days, userId } = z
      .object({
        days: z.coerce.number().int().min(1).max(90).default(7),
        userId: uuid.optional(),
      })
      .parse(req.query);

    const row = await req.tx((q) =>
      q.one(
        `select
           coalesce(sum(dials), 0)::int            as dials,
           coalesce(sum(connects), 0)::int         as connects,
           coalesce(sum(interested), 0)::int       as interested,
           coalesce(sum(not_interested), 0)::int   as not_interested,
           coalesce(sum(callbacks_booked), 0)::int as callbacks_booked,
           coalesce(sum(visits_promised), 0)::int  as visits_promised,
           coalesce(sum(not_answered), 0)::int     as not_answered,
           coalesce(sum(job_enquiries), 0)::int    as job_enquiries,
           coalesce(sum(walked_in), 0)::int        as walked_in,
           coalesce(sum(deals), 0)::int            as deals,
           coalesce(sum(talk_seconds), 0)::bigint  as talk_seconds
         from crm.v_person_performance
        where day > crm.ist_date(now()) - $1::int
          and ($2::uuid is null or user_id = $2)`,
        [days, userId ?? null],
      ),
    );
    return row;
  });

  /**
   * Daily totals across everyone this user can see, for the trend line.
   *
   * Separate from /me/performance, which is one person. A counsellor wants the
   * team's shape over time, not five overlapping lines.
   */
  app.get('/performance/daily', async (req) => {
    req.requireUser();
    const { days, userId } = z
      .object({
        days: z.coerce.number().int().min(1).max(90).default(14),
        userId: uuid.optional(),
      })
      .parse(req.query);

    return req.tx((q) =>
      q.many(
        `select day,
                sum(dials)::int          as dials,
                sum(connects)::int       as connects,
                sum(interested)::int     as interested,
                sum(not_interested)::int as not_interested,
                sum(walked_in)::int      as walked_in,
                sum(deals)::int          as deals,
                sum(talk_seconds)::bigint as talk_seconds
           from crm.v_person_performance
          where day > crm.ist_date(now()) - $1::int
            and ($2::uuid is null or user_id = $2)
          group by day order by day`,
        [days, userId ?? null],
      ),
    );
  });

  /**
   * The handful of settings the browser itself needs.
   *
   * These live in crm.settings with everything else, but /admin/settings is
   * admin-only - so reading them from there would have meant the poll interval
   * silently never applied to callers, who are the people being interrupted.
   * Nothing here is sensitive: it is how often to poll and what may pop up.
   */
  app.get('/meta/ui-settings', async (req) => {
    req.requireUser();
    const rows = await req.tx((q) =>
      q.many<{ key: string; value: unknown }>(
        `select key, value from crm.settings
          where key in ('alerts.poll_seconds', 'alerts.popup_kinds',
                        'alerts.repeat_minutes', 'alerts.chime',
                        'ui.refresh_seconds',
                        'sla.untouched_reassign_minutes')`,
      ),
    );
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  });

  /**
   * Everyone's leaderboard icon, in one map.
   *
   * Separate from /admin/users because the board is visible to every role, and
   * an avatar is presentation, not PII - it carries nothing the name on the
   * same card does not.
   */
  app.get('/users/avatars', async (req) => {
    req.requireUser();
    const rows = await req.tx((q) =>
      q.many<{ id: string; avatar_url: string }>(
        `select id, avatar_url from crm.users
          where is_active and avatar_url is not null`,
      ),
    );
    return Object.fromEntries(rows.map((r) => [r.id, r.avatar_url]));
  });

  /**
   * The overall standings: one number per person across every metric.
   *
   * The formula lives in crm.rate_standings(), not here, because the nightly
   * ACE pick ranks people too and "best" must not mean one thing on this
   * board and another when the leads are handed out. Weights stay in
   * crm.settings (leaderboard.weight_*) so ops can re-balance without a
   * deploy. A metric nobody scored on contributes nothing rather than
   * dividing by zero, and someone with no activity at all is left off the
   * board rather than shown at 0.
   *
   * Points are computed PER DAY PRESENT. Ranking a caller who worked two
   * days against a colleague's seven totals means leave itself costs them
   * places - which is how a caller returning from five days off silently
   * lost the guaranteed fresh-lead share (0061, 0062). `days_present` rides
   * along so the board can say what each person's number is out of.
   */
  app.get('/performance/overall', async (req) => {
    req.requireUser();
    const { days } = z
      .object({ days: z.coerce.number().int().min(1).max(90).default(1) })
      .parse(req.query);

    return req.tx((q) =>
      q.many(
        `select user_id, full_name, role, days_present,
                dials, connects, interested, walked_in, deals, revenue,
                talk_seconds, points as overall_points, rank
           from crm.rate_standings($1::int, 'floor', true,
                                   array['caller','counsellor'], 1)`,
        [days],
      ),
    );
  });

  /**
   * My own numbers, day by day.
   *
   * Requirement 7 is self-reflection, so this exists for the caller first. The
   * counsellor and admin views below are the same view with more reach, which
   * RLS grants them - not a second query with different rules in it.
   */
  app.get('/me/performance', async (req) => {
    const user = req.requireUser();
    const { days } = z.object({ days: z.coerce.number().int().min(1).max(90).default(14) })
      .parse(req.query);
    return req.tx((q) =>
      q.many(
        `select * from crm.v_person_performance
          where user_id = $1 and day > crm.ist_date(now()) - $2::int
          order by day desc`,
        [user.id, days],
      ),
    );
  });

  /**
   * Everyone this user is allowed to see, summed over the window.
   *
   * A caller gets themselves, a counsellor gets their team, an admin gets the
   * floor - and none of that is decided here. The ORDER BY is the answer to
   * "who brought in the most walk-ins", which was the question that prompted it.
   */
  app.get('/performance', async (req) => {
    req.requireUser();
    const { days, sort } = z
      .object({
        days: z.coerce.number().int().min(1).max(90).default(7),
        sort: z
          .enum(['dials', 'connects', 'interested', 'walked_in', 'deals', 'revenue', 'talk_seconds'])
          .default('connects'),
      })
      .parse(req.query);

    return req.tx((q) =>
      q.many(
        `select user_id, full_name, role,
                sum(dials)::int            as dials,
                sum(connects)::int         as connects,
                sum(interested)::int       as interested,
                sum(not_interested)::int   as not_interested,
                sum(not_answered)::int     as not_answered,
                sum(callbacks_booked)::int as callbacks_booked,
                sum(visits_promised)::int  as visits_promised,
                sum(walked_in)::int        as walked_in,
                sum(whatsapp_sent)::int    as whatsapp_sent,
                sum(job_enquiries)::int    as job_enquiries,
                sum(talk_seconds)::bigint  as talk_seconds,
                sum(deals)::int            as deals,
                sum(assisted_deals)::int   as assisted_deals,
                sum(revenue)               as revenue,
                case when sum(dials) > 0
                     then round(100.0 * sum(connects) / sum(dials), 1) end    as connect_rate,
                case when sum(connects) > 0
                     then round(100.0 * sum(interested) / sum(connects), 1) end as interest_rate,
                case when sum(connects) > 0
                     then round(100.0 * sum(deals) / sum(connects), 1) end   as conversion_rate
           from crm.v_person_performance
          where day > crm.ist_date(now()) - $1::int
          group by user_id, full_name, role
         having sum(dials) > 0 or sum(deals) > 0 or sum(walked_in) > 0
          order by ${sort === 'revenue' ? 'sum(revenue)' : `sum(${sort})`} desc, full_name`,
        [days],
      ),
    );
  });

  /**
   * The bell, and behind it the whole work list.
   *
   * Two scopes, one endpoint. The default - 'bell' - is what rings and what
   * the badge counts: ONLY the kinds in alerts.bell_kinds, which ship as the
   * times a person chose (the client's callback, the owner's own reminder)
   * plus the intake emergency. That is what takes the badge to zero at the
   * end of a clean day. 'work' is everything - the full RLS-scoped list the
   * Alerts tab offers behind one deliberate click, unchanged, so nothing an
   * engine raises is ever unreachable.
   *
   * No ownership filter here on purpose - RLS decides what a caller can see
   * and what a counsellor can see, so this one endpoint serves both without
   * the route needing to know the difference.
   */
  app.get('/me/alerts', async (req) => {
    const user = req.requireUser();
    const { scope } = z
      .object({ scope: z.enum(['bell', 'work']).default('bell') })
      .parse(req.query);

    return req.tx(async (q) => {
      // Lead-derived alerts plus unread notifications folded in, so the same
      // bell and the same popup cover both. A notification carries no lead
      // due-time, so its "age" is how long it has gone unread. owner_name
      // matters because this list is NOT always your own work: a counsellor
      // sees their team's alerts and an admin the floor's - without a name,
      // "59 first calls overdue" is unactionable.
      const alerts = await q.many(
        `with allowed as (
           select coalesce(
             (select array(select jsonb_array_elements_text(value))
                from crm.settings where key = 'alerts.bell_kinds'),
             array['callback_due','callback_soon','custom_reminder','intake_stalled']
           ) as kinds
         )
         select a.* from (
           select a.kind, a.severity, a.lead_id, a.lead_name, a.phone_e164, a.due_at,
                  a.title, a.callback_id,
                  round(extract(epoch from (now() - a.due_at)) / 60)::int as minutes_late,
                  null::uuid as notification_id,
                  a.user_id as owner_id,
                  ou.full_name as owner_name
             from crm.v_my_alerts a
             left join crm.users ou on ou.id = a.user_id
           union all
           select n.kind,
                  case when n.kind = 'intake_stalled' then 'critical'
                       when n.kind = 'intake_recovered' then 'info'
                       else 'warning' end,
                  n.lead_id, l.full_name, l.phone_e164,
                  n.created_at, n.title, null,
                  round(extract(epoch from (now() - n.created_at)) / 60)::int,
                  n.id, n.user_id, nu.full_name
             from crm.notifications n
             left join crm.leads l on l.id = n.lead_id
             left join crm.users nu on nu.id = n.user_id
            where n.read_at is null and n.user_id = $1
         ) a, allowed
          where ($2::text = 'work' or a.kind = any (allowed.kinds))
          order by case severity when 'critical' then 0 when 'warning' then 1 else 2 end,
                   due_at asc
          limit 200`,
        [user.id, scope],
      );
      return {
        count: alerts.length,
        critical: alerts.filter((a) => (a as { severity: string }).severity === 'critical').length,
        alerts,
      };
    });
  });

  /**
   * Clear an alert by dealing with it, not by hiding it.
   *
   * An SLA breach or an overdue follow-up is a lead sitting past its promised
   * time - the only honest ways to make it go away are to move the promise or
   * to close the lead. So "snooze" reschedules the next action on the working
   * clock and says so, rather than silencing a warning while the lead rots.
   * Notification-type alerts have nothing to reschedule and are simply read.
   */
  app.post('/me/alerts/act', async (req) => {
    const user = req.requireUser();
    const body = z
      .object({
        leadId: uuid.optional(),
        notificationId: uuid.optional(),
        action: z.enum(['snooze', 'read']),
        minutes: z.number().int().min(5).max(10080).optional(),
        note: z.string().max(200).optional(),
      })
      .parse(req.body);

    return req.tx(async (q) => {
      if (body.notificationId) {
        await q.query(
          `update crm.notifications set read_at = now()
            where id = $1 and user_id = $2 and read_at is null`,
          [body.notificationId, user.id],
        );
        return { ok: true, kind: 'notification' };
      }

      if (!body.leadId) throw badRequest('an alert needs a lead or a notification to act on');

      if (body.action === 'read') {
        // Acknowledging a lead alert without moving the promise would hide a
        // real breach, so this path is deliberately not offered.
        throw badRequest('a lead alert is cleared by working it or rescheduling it');
      }

      const row = await q.one(
        `update crm.leads
            set next_action_at = crm.add_working_minutes(now(), $2::int),
                next_action_note = coalesce($3, next_action_note),
                updated_at = now()
          where id = $1
          returning id, next_action_at, next_action_note`,
        [body.leadId, body.minutes ?? 60, body.note?.trim() || null],
      );
      if (!row) throw notFound('lead not found');

      // Rescheduling a promise is a decision about a customer. It belongs in
      // the lead's own history, where the next person to open it will see it.
      await q.query(
        `insert into crm.lead_events (lead_id, event_type, actor_id, payload)
         values ($1, 'reminder_set', $2, $3)`,
        [body.leadId, user.id,
         JSON.stringify({ snoozed_minutes: body.minutes ?? 60, note: body.note ?? null })],
      );
      return { ok: true, kind: 'lead', ...row };
    });
  });

  /** Counts for the header chips, without pulling the whole list. */
  app.get('/me/day/summary', async (req) => {
    const user = req.requireUser();
    return req.tx((q) =>
      q.one(
        `select
           count(*)                                        as total,
           count(*) filter (where bucket = 'immediate')    as immediate,
           count(*) filter (where bucket = 'overdue')      as overdue,
           count(*) filter (where bucket = 'callback')     as callbacks,
           count(*) filter (where bucket = 'fresh')        as fresh
         from crm.v_my_day where caller_id = $1`,
        [user.id],
      ),
    );
  });

  /**
   * Requirement 7. Own trend first, rank second - the score is meant for
   * self-reflection, and a number presented as a league table becomes
   * something to game rather than something to learn from.
   */
  app.get('/me/score', async (req) => {
    const user = req.requireUser();
    const { days } = z.object({ days: z.coerce.number().int().min(1).max(90).default(14) }).parse(req.query);

    return req.tx(async (q) => {
      const history = await q.many(
        `select score_date, total, own_7day_avg, team_avg_that_day,
                change_vs_last_week, rank_in_team, components
           from crm.v_my_score
          where user_id = $1 and score_date > current_date - $2::int
          order by score_date desc`,
        [user.id, days],
      );
      return { latest: history[0] ?? null, history };
    });
  });

  /** Requirement 6: the caller's own attendance. */
  app.get('/me/attendance', async (req) => {
    const user = req.requireUser();
    const { days } = z.object({ days: z.coerce.number().int().min(1).max(90).default(30) }).parse(req.query);

    return req.tx((q) =>
      q.many(
        `select business_date, first_login_at, last_activity_at, session_count,
                logged_minutes, expected_minutes, shortfall_minutes,
                is_late, met_hours, currently_logged_in
           from crm.v_attendance_day
          where user_id = $1 and business_date > current_date - $2::int
          order by business_date desc`,
        [user.id, days],
      ),
    );
  });
}
