import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { logLeadAccess } from '../http/context.ts';
import { badRequest, notFound } from '../http/errors.ts';

const uuid = z.string().uuid();

/**
 * Call outcomes, in the order the floor should read them.
 *
 * The labels live here, but the VALUES are checked against the database enum
 * by a test - the enum is the real definition, and a list maintained in two
 * places drifts the first time somebody adds an outcome in SQL only.
 */
export const DISPOSITIONS: Array<{ value: string; label: string; terminal?: true; followUp?: true }> = [
  { value: 'connected_interested', label: 'Connected — interested', followUp: true },
  { value: 'callback_requested', label: 'Connected — asked to call back', followUp: true },
  { value: 'will_visit', label: 'Will visit the office', followUp: true },
  { value: 'will_call_back_self', label: 'Will call us back themselves' },
  { value: 'disconnected_after_intro', label: 'Disconnected after introduction' },
  { value: 'connected_not_interested', label: 'Connected — not interested (closes lead)', terminal: true },
  { value: 'not_answered', label: 'Not answered' },
  { value: 'incoming_unavailable', label: 'Incoming unavailable' },
  { value: 'busy', label: 'Busy' },
  { value: 'switched_off', label: 'Switched off' },
  { value: 'wrong_person', label: 'Wrong person' },
  { value: 'language_barrier', label: 'Language barrier' },
  { value: 'job_enquiry', label: 'Job enquiry — not a client (closes lead)', terminal: true },
  { value: 'invalid_number', label: 'Invalid number (closes lead)', terminal: true },
  { value: 'do_not_call', label: 'Do not call (closes lead)', terminal: true },
];

const dispositionSchema = z.enum(
  DISPOSITIONS.map((d) => d.value) as [string, ...string[]],
);

/**
 * One outcome, or a comma-separated group of them. "Busy or switched off"
 * is one list in the floor's head - busy, switched off, incoming
 * unavailable - and filtering on a single value silently showed only the
 * busy third of it.
 */
const DISPOSITION_VALUES = new Set(DISPOSITIONS.map((d) => d.value));
const dispositionListSchema = z
  .string()
  .refine(
    (s) => {
      const parts = s.split(',').map((p) => p.trim()).filter(Boolean);
      return parts.length > 0 && parts.every((p) => DISPOSITION_VALUES.has(p));
    },
    { message: 'unknown outcome in lastDisposition' },
  );

/** Dispositions that close a lead, and so need no follow-up action. */
const TERMINAL = new Set(DISPOSITIONS.filter((d) => d.terminal).map((d) => d.value));

export async function leadRoutes(app: FastifyInstance): Promise<void> {
  /** The outcome list, so the UI never carries its own copy to drift. */
  app.get('/meta/dispositions', async (req) => {
    req.requireUser();
    return DISPOSITIONS;
  });

  /**
   * Record that a WhatsApp message went to this lead.
   *
   * This is a claim by the caller, not a delivery receipt - the CRM cannot see
   * WhatsApp. It is still worth recording: "did anyone message them" is asked
   * constantly, and the alternative is asking the caller and believing them.
   */
  app.post('/leads/:id/whatsapp', async (req) => {
    const user = req.requireUser();
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = z.object({ sent: z.boolean().default(true) }).parse(req.body ?? {});

    const row = await req.tx((q) =>
      q.one(
        `update crm.leads
            set whatsapp_sent_at = case when $2 then now() else null end,
                whatsapp_sent_by = case when $2 then $3::uuid else null end,
                updated_at = now()
          where id = $1
          returning id, whatsapp_sent_at, whatsapp_sent_by`,
        [id, body.sent, user.id],
      ),
    );
    if (!row) throw notFound('no lead with that id');

    await req.tx((q) =>
      q.query(
        `insert into crm.lead_events (lead_id, event_type, actor_id, payload)
         values ($1, 'note', $2, $3)`,
        [id, user.id, JSON.stringify({ whatsapp_sent: body.sent })],
      ),
    );
    return row;
  });

  /**
   * Set or correct the lead's location.
   *
   * City arrives blank from most Meta lead forms, and the floor asked to be
   * able to fill it in from the call ("where are you calling from?"). One
   * field, recorded in the lead's history like every other change.
   */
  app.put('/leads/:id/city', async (req) => {
    const user = req.requireUser();
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = z
      .object({ city: z.string().trim().max(60).nullable() })
      .parse(req.body ?? {});
    const city = body.city || null;

    return req.tx(async (q) => {
      const row = await q.one(
        `update crm.leads set city = $2, updated_at = now()
          where id = $1
          returning id, city`,
        [id, city],
      );
      if (!row) throw notFound('no lead with that id');
      await q.query(
        `insert into crm.lead_events (lead_id, event_type, actor_id, payload)
         values ($1, 'note', $2, $3)`,
        [id, user.id, JSON.stringify({ city_set: city })],
      );
      return row;
    });
  });

  /**
   * Mark that the lead actually came in.
   *
   * Separate from the will_visit outcome on purpose: a promise to visit and a
   * visit are different numbers, and only one of them turns into revenue.
   */
  app.post('/leads/:id/walkin', async (req) => {
    const user = req.requireUser();
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = z.object({ walkedIn: z.boolean().default(true) }).parse(req.body ?? {});

    const row = await req.tx((q) =>
      q.one(
        `update crm.leads
            set walked_in_at = case when $2 then coalesce(walked_in_at, now()) else null end,
                updated_at = now()
          where id = $1
          returning id, walked_in_at, walkin_expected_at`,
        [id, body.walkedIn],
      ),
    );
    if (!row) throw notFound('no lead with that id');

    await req.tx((q) =>
      q.query(
        `insert into crm.lead_events (lead_id, event_type, actor_id, payload)
         values ($1, 'note', $2, $3)`,
        [id, user.id, JSON.stringify({ walked_in: body.walkedIn })],
      ),
    );
    return row;
  });

  /**
   * Lead detail with its full timeline.
   *
   * No ownership check here on purpose. RLS decides what this user can see, so
   * a lead they do not own simply is not found. Adding a WHERE clause here
   * would duplicate the rule in a second place where it could drift.
   */
  app.get('/leads/:id', async (req) => {
    const user = req.requireUser();
    const { id } = z.object({ id: uuid }).parse(req.params);

    return req.tx(async (q) => {
      const lead = await q.one(`select * from crm.leads where id = $1`, [id]);
      if (!lead) throw notFound('lead not found');

      const [timeline, attempts, callbacks, transfers] = await Promise.all([
        q.many(
          `select event_type, actor_id, payload, occurred_at
             from crm.lead_events where lead_id = $1
            order by occurred_at desc limit 200`,
          [id],
        ),
        q.many(
          // LEFT JOIN to the device row for the Callyzer recording. RLS on
          // device_call_logs decides who gets a row back (owner, admin, and a
          // counsellor on a matched lead); on top of that the recording is
          // withheld from callers below - coaching material, not self-review.
          `select ca.id, ca.started_at, ca.duration_seconds, ca.disposition,
                  ca.is_connect, ca.is_verified, ca.notes, u.full_name as by_name,
                  d.recording_url
             from crm.call_attempts ca
             join crm.users u on u.id = ca.user_id
             left join crm.device_call_logs d on d.id = ca.device_log_id
            where ca.lead_id = $1 order by ca.started_at desc`,
          [id],
        ),
        q.many(
          `select id, scheduled_at, note, status, completed_at
             from crm.callbacks where lead_id = $1 order by scheduled_at desc`,
          [id],
        ),
        q.many(
          // LEFT JOIN on the actor: an automatic reassignment has no human
          // behind it, and an inner join would silently drop exactly the
          // transfers the caller most needs to see explained on the timeline.
          `select lt.created_at, lt.reason, lt.note, lt.is_automatic,
                  fu.full_name as from_name, tu.full_name as to_name,
                  coalesce(bu.full_name, 'Automatic') as by_name
             from crm.lead_transfers lt
             left join crm.users fu on fu.id = lt.from_caller_id
             join crm.users tu on tu.id = lt.to_caller_id
             left join crm.users bu on bu.id = lt.transferred_by
            where lt.lead_id = $1 order by lt.created_at desc`,
          [id],
        ),
      ]);

      if (!['counsellor', 'admin'].includes(user.role)) {
        for (const a of attempts) (a as { recording_url?: string | null }).recording_url = null;
      }

      await logLeadAccess(q, user.id, [id], 'detail', req.ip);
      return { lead, timeline, attempts, callbacks, transfers };
    });
  });

  /** Search within whatever the user is allowed to see. */
  /**
   * A lead entered by hand: walk-past, phone-in, referral.
   *
   * The SQL function owns the rules - duplicate refusal with directions, the
   * caller-assignment check, and fair distribution when nobody is named. The
   * leads_insert policy (admin/ops/counsellor, never caller) is enforced by
   * RLS inside the same transaction; this handler only shapes the request.
   */
  app.post('/leads/manual', async (req, reply) => {
    // Callers are allowed through to SQL, which permits them exactly one
    // thing: logging an inbound call they answered, to themselves. Every
    // other combination is refused inside crm.add_manual_lead, so the
    // fairness guarantee lives in one place.
    req.requireRole('admin', 'ops', 'counsellor', 'caller');
    const body = z
      .object({
        fullName: z.string().min(1).max(120),
        phone: z.string().min(6).max(20),
        city: z.string().max(60).optional(),
        priority: z.enum(['normal', 'immediate']).default('normal'),
        assignTo: uuid.nullable().optional(),
        note: z.string().max(300).optional(),
        // 'inbound' = the client called us. Highest quality on the floor:
        // always immediate, born first-touched, and the follow-up date the
        // client was promised is mandatory and becomes a ringing callback.
        kind: z.enum(['manual', 'inbound']).default('manual'),
        followupAt: z.coerce.date().optional(),
      })
      .parse(req.body);

    const row = await req.tx(async (q) => {
      const created = await q.one<{ lead_id: string }>(
        `select crm.add_manual_lead($1, $2, $3, $4::crm.lead_priority, $5, $6, $7, $8) as lead_id`,
        [
          body.fullName.trim(), body.phone.trim(), body.city?.trim() || null,
          body.priority, body.assignTo ?? null, body.note?.trim() || null,
          body.kind, body.followupAt ?? null,
        ],
      );
      return q.one(
        `select id, full_name, phone_e164, status, priority, caller_id, team_id,
                first_touch_due_at, next_action_at
           from crm.leads where id = $1`,
        [created!.lead_id],
      );
    });
    reply.code(201);
    return row;
  });

  app.get('/leads', async (req) => {
    const user = req.requireUser();
    const query = z
      .object({
        q: z.string().trim().min(2).max(64).optional(),
        status: z.string().optional(),
        // Re-tap filters. "Show me everyone who did not answer" and "show me
        // everyone who asked to be called back" are the two lists a caller
        // actually works from, and neither was reachable before.
        lastDisposition: dispositionListSchema.optional(),
        due: z.enum(['overdue', 'today', 'untouched', 'contacted']).optional(),
        whatsapp: z.enum(['sent', 'not_sent']).optional(),
        // Which follow-up round the lead is on. The old Excel had a column per
        // follow-up (FU1..FU5), and the floor thinks in those terms: "give me
        // everyone due their 3rd follow-up" is a list they worked daily.
        attempts: z.enum(['0', '1', '2', '3', '4', '5plus']).optional(),
        // The "not answered twice in a row" list. A count, not a disposition
        // filter: a lead whose LAST outcome was busy still belongs on it.
        na: z.enum(['2plus']).optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50),
        offset: z.coerce.number().int().min(0).default(0),
      })
      .parse(req.query);

    return req.tx(async (q) => {
      const rows = await q.many<{ id: string }>(
        `select lead_id as id, full_name, phone_e164, city, status, priority,
                next_action_at, next_action_note, attempt_count, connect_count, na_streak,
                caller_id, counsellor_id, created_at, first_touched_at, last_contacted_at,
                last_disposition, last_call_at, last_duration_seconds,
                whatsapp_sent_at, walkin_expected_at, walked_in_at
           from crm.v_lead_history
          -- The phone branch only applies when the query actually contains
          -- digits. Without that guard regexp_replace returns an empty string
          -- and the clause becomes "phone_e164 like '%'", so searching a name
          -- quietly matched every lead the user could see.
          where ($1::text is null
                 or full_name ilike '%' || $1 || '%'
                 or (regexp_replace($1, '[^0-9]', '', 'g') <> ''
                     and phone_e164 like '%' || regexp_replace($1, '[^0-9]', '', 'g')))
            and ($2::text is null or status = $2::crm.lead_status)
            and ($5::text is null or last_disposition = any(string_to_array($5, ',')::crm.disposition[]))
            and ($6::text is null or case $6
                   when 'overdue'   then next_action_at < now()
                   when 'today'     then crm.ist_date(next_action_at) = crm.ist_date(now())
                   when 'untouched' then first_touched_at is null
                   when 'contacted' then first_touched_at is not null
                 end)
            and ($7::text is null or case $7
                   when 'sent'     then whatsapp_sent_at is not null
                   when 'not_sent' then whatsapp_sent_at is null
                 end)
            and ($8::text is null or case $8
                   when '5plus' then attempt_count >= 5
                   else attempt_count = $8::int
                 end)
            and ($9::text is null or na_streak >= 2)
          order by next_action_at asc nulls last, created_at desc
          limit $3 offset $4`,
        [
          query.q ?? null,
          query.status ?? null,
          query.limit,
          query.offset,
          query.lastDisposition ?? null,
          query.due ?? null,
          query.whatsapp ?? null,
          query.attempts ?? null,
          query.na ?? null,
        ],
      );

      await logLeadAccess(q, user.id, rows.map((r) => r.id), 'list', req.ip);
      return { count: rows.length, leads: rows };
    });
  });

  /**
   * Log a call attempt. Requirements 3 and 9.
   *
   * The API refuses a non-terminal disposition that arrives with no follow-up,
   * mirroring the UI rule "you cannot close a call without a next action". The
   * database would not actually let the lead end up without one - the trigger
   * schedules a retry - but failing here gives the caller a clear error instead
   * of silently choosing a follow-up time on their behalf.
   */
  app.post('/leads/:id/calls', async (req, reply) => {
    const user = req.requireUser();
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = z
      .object({
        disposition: dispositionSchema,
        durationSeconds: z.number().int().min(0).max(60 * 60 * 4).default(0),
        startedAt: z.coerce.date().optional(),
        notes: z.string().max(2000).optional(),
        deviceLogId: uuid.optional(),
        // Follow-up, when the disposition is not terminal.
        callbackAt: z.coerce.date().optional(),
        callbackNote: z.string().max(500).optional(),
      })
      .parse(req.body);

    if (body.disposition === 'callback_requested' && !body.callbackAt) {
      throw badRequest('a callback_requested disposition needs callbackAt');
    }
    if (body.callbackAt && body.callbackAt.getTime() < Date.now() - 60_000) {
      throw badRequest('callbackAt must be in the future');
    }
    if (TERMINAL.has(body.disposition) && body.callbackAt) {
      throw badRequest(`disposition ${body.disposition} closes the lead; it cannot carry a callback`);
    }

    const result = await req.tx(async (q) => {
      const attempt = await q.one<{ id: string; is_connect: boolean }>(
        `insert into crm.call_attempts
           (lead_id, user_id, device_log_id, started_at, duration_seconds,
            disposition, notes, is_verified)
         values ($1, $2, $3::uuid, coalesce($4::timestamptz, now()), $5, $6, $7,
                 $3::uuid is not null)
         returning id, is_connect`,
        [
          id,
          user.id,
          body.deviceLogId ?? null,
          body.startedAt ?? null,
          body.durationSeconds,
          body.disposition,
          body.notes ?? null,
        ],
      );
      if (!attempt) throw notFound('lead not found');

      if (body.callbackAt) {
        await q.query(
          `insert into crm.callbacks (lead_id, created_by, assigned_to, scheduled_at, note)
           values ($1, $2, $2, $3, $4)
           on conflict (lead_id) where status = 'pending'
           do update set scheduled_at = excluded.scheduled_at, note = excluded.note`,
          [id, user.id, body.callbackAt, body.callbackNote ?? null],
        );
      }

      const lead = await q.one(
        `select id, status, next_action_at, next_action_note, attempt_count,
                connect_count, na_streak
           from crm.leads where id = $1`,
        [id],
      );
      return { attempt, lead };
    });

    return reply.status(201).send(result);
  });

  /** Requirement 3: set or move a callback without logging a call. */
  app.post('/leads/:id/callbacks', async (req, reply) => {
    const user = req.requireUser();
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = z
      .object({
        scheduledAt: z.coerce.date(),
        note: z.string().max(500).optional(),
      })
      .parse(req.body);

    if (body.scheduledAt.getTime() < Date.now() - 60_000) {
      throw badRequest('scheduledAt must be in the future');
    }

    const row = await req.tx((q) =>
      q.one(
        `insert into crm.callbacks (lead_id, created_by, assigned_to, scheduled_at, note)
         values ($1, $2, $2, $3, $4)
         on conflict (lead_id) where status = 'pending'
         do update set scheduled_at = excluded.scheduled_at, note = excluded.note
         returning id, lead_id, scheduled_at, note, status`,
        [id, user.id, body.scheduledAt, body.note ?? null],
      ),
    );
    if (!row) throw notFound('lead not found');
    return reply.status(201).send(row);
  });

  app.post('/callbacks/:id/cancel', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const row = await req.tx((q) =>
      q.one(
        `update crm.callbacks set status = 'cancelled'
          where id = $1 and status = 'pending'
          returning id, status`,
        [id],
      ),
    );
    if (!row) throw notFound('no pending callback with that id');
    return row;
  });

  /**
   * Requirement 5: immediate leads awaiting first contact.
   * A caller sees their own; a counsellor sees the team's.
   */
  app.get('/queues/immediate', async (req) => {
    const user = req.requireUser();
    return req.tx(async (q) => {
      const rows = await q.many<{ lead_id: string }>(
        `select * from crm.v_immediate_queue
          where ($1::bool or caller_id = $2)
          order by first_touch_due_at asc`,
        [user.role !== 'caller', user.id],
      );
      await logLeadAccess(q, user.id, rows.map((r) => r.lead_id), 'list', req.ip);
      return { count: rows.length, leads: rows };
    });
  });

  /** Mark a lead as ready for the counsellor. Feeds the qualification score. */
  app.post('/leads/:id/qualify', async (req) => {
    const user = req.requireUser();
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = z
      .object({ counsellorId: uuid.optional(), note: z.string().max(1000).optional() })
      .parse(req.body ?? {});

    return req.tx(async (q) => {
      const lead = await q.one<{ id: string; team_id: string | null }>(
        `select id, team_id from crm.leads where id = $1`,
        [id],
      );
      if (!lead) throw notFound('lead not found');

      // Default to the counsellor who leads this lead's team.
      const counsellorId =
        body.counsellorId ??
        (
          await q.one<{ id: string }>(
            `select u.id from crm.users u
               join crm.team_memberships tm
                 on tm.user_id = u.id and tm.period @> current_date
              where tm.team_id = $1 and u.role = 'counsellor' and u.is_active
              order by tm.rotation_order limit 1`,
            [lead.team_id],
          )
        )?.id;

      if (!counsellorId) throw badRequest('no counsellor available for this team');

      const updated = await q.one(
        `update crm.leads
            set counsellor_id = $2,
                status = 'qualified',
                next_action_at = greatest(now() + interval '30 minutes', next_action_at),
                next_action_note = 'Qualified - counsellor to contact'
          where id = $1
          returning id, status, counsellor_id, next_action_at`,
        [id, counsellorId],
      );

      await q.query(
        `insert into crm.lead_events (lead_id, event_type, actor_id, payload)
         values ($1, 'qualified', $2, jsonb_build_object('counsellor_id', $3::uuid, 'note', $4::text))`,
        [id, user.id, counsellorId, body.note ?? null],
      );

      return updated;
    });
  });
}
