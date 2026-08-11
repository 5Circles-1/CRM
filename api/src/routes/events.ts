import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { badRequest, notFound } from '../http/errors.ts';

const uuid = z.string().uuid();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const KINDS = ['in_office', 'online', 'external'] as const;
const STATUSES = ['draft', 'published', 'live', 'completed', 'cancelled'] as const;
const ATTENDEE = ['invited', 'confirmed', 'attended', 'no_show', 'converted'] as const;

/** The lead-selection filter, shared by the preview and the import. */
const filterSchema = z.object({
  statuses: z.array(z.string().max(20)).max(12).optional(),
  sourceId: uuid.optional(),
  ownerId: uuid.optional(),
  teamId: uuid.optional(),
  city: z.string().max(60).optional(),
  campaign: z.string().max(120).optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  limit: z.number().int().min(1).max(5000).default(5000),
});

type Filter = z.infer<typeof filterSchema>;

/** Positional arguments for both SQL functions, in one place so they agree. */
const filterArgs = (f: Filter) => [
  f.statuses?.length ? f.statuses : null,
  f.sourceId ?? null,
  f.ownerId ?? null,
  f.teamId ?? null,
  f.city?.trim() || null,
  f.campaign?.trim() || null,
  f.from ?? null,
  f.to ?? null,
];

/**
 * Events and their rosters.
 *
 * The whole floor reads events; admins and counsellors create and edit them.
 * Importing leads copies them onto the roster - crm.import_leads_to_event
 * never touches the original lead, and the preview count comes from the same
 * predicate as the import, so what you are shown is what you get.
 */
export async function eventRoutes(app: FastifyInstance): Promise<void> {
  app.get('/events', async (req) => {
    req.requireUser();
    const { status, from, to } = z
      .object({
        status: z.enum(STATUSES).optional(),
        from: isoDate.optional(),
        to: isoDate.optional(),
      })
      .parse(req.query);

    return req.tx((q) =>
      q.many(
        `select * from crm.v_event_summary
          where ($1::text is null or status::text = $1)
            and ($2::date is null or crm.ist_date(starts_at) >= $2)
            and ($3::date is null or crm.ist_date(starts_at) <= $3)
          order by starts_at desc
          limit 500`,
        [status ?? null, from ?? null, to ?? null],
      ),
    );
  });

  app.get('/events/:id', async (req) => {
    req.requireUser();
    const { id } = z.object({ id: uuid }).parse(req.params);
    const { attendee } = z
      .object({ attendee: z.enum(ATTENDEE).optional() })
      .parse(req.query);

    return req.tx(async (q) => {
      const event = await q.one(`select * from crm.v_event_summary where event_id = $1`, [id]);
      if (!event) throw notFound('no such event');
      const roster = await q.many(
        `select el.*, u.full_name as owner_name
           from crm.event_leads el
           left join crm.users u on u.id = el.follow_up_owner_id
          where el.event_id = $1
            and ($2::text is null or el.status::text = $2)
          order by el.status, el.full_name
          limit 2000`,
        [id, attendee ?? null],
      );
      return { event, roster };
    });
  });

  app.post('/events', async (req, reply) => {
    const user = req.requireRole('admin', 'ops', 'counsellor');
    const body = z
      .object({
        name: z.string().min(1).max(160),
        kind: z.enum(KINDS).default('in_office'),
        status: z.enum(STATUSES).default('draft'),
        startsAt: z.string().datetime({ offset: true }),
        endsAt: z.string().datetime({ offset: true }).nullable().optional(),
        venue: z.string().max(400).optional(),
        meetingLink: z.string().max(500).optional(),
        hostId: uuid.nullable().optional(),
        teamId: uuid.nullable().optional(),
        capacity: z.number().int().min(1).max(100000).nullable().optional(),
        description: z.string().max(4000).optional(),
        bannerUrl: z.string().max(500).optional(),
        audienceTags: z.array(z.string().max(40)).max(20).default([]),
      })
      .parse(req.body);

    const row = await req.tx((q) =>
      q.one(
        `insert into crm.events
           (name, kind, status, starts_at, ends_at, venue, meeting_link,
            host_id, team_id, capacity, description, banner_url, audience_tags, created_by)
         values ($1, $2::crm.event_kind, $3::crm.event_status, $4, $5, $6, $7,
                 $8, $9, $10, $11, $12, $13, $14)
         returning *`,
        [
          body.name.trim(), body.kind, body.status, body.startsAt, body.endsAt ?? null,
          body.venue?.trim() || null, body.meetingLink?.trim() || null,
          body.hostId ?? null, body.teamId ?? null, body.capacity ?? null,
          body.description?.trim() || null, body.bannerUrl?.trim() || null,
          body.audienceTags, user.id,
        ],
      ),
    );
    reply.code(201);
    return row;
  });

  app.put('/events/:id', async (req) => {
    req.requireRole('admin', 'ops', 'counsellor');
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = z
      .object({
        name: z.string().min(1).max(160).optional(),
        kind: z.enum(KINDS).optional(),
        status: z.enum(STATUSES).optional(),
        startsAt: z.string().datetime({ offset: true }).optional(),
        endsAt: z.string().datetime({ offset: true }).nullable().optional(),
        venue: z.string().max(400).nullable().optional(),
        meetingLink: z.string().max(500).nullable().optional(),
        hostId: uuid.nullable().optional(),
        capacity: z.number().int().min(1).max(100000).nullable().optional(),
        description: z.string().max(4000).nullable().optional(),
        audienceTags: z.array(z.string().max(40)).max(20).optional(),
      })
      .parse(req.body);

    const row = await req.tx((q) =>
      q.one(
        `update crm.events set
           name         = coalesce($2, name),
           kind         = coalesce($3::crm.event_kind, kind),
           status       = coalesce($4::crm.event_status, status),
           starts_at    = coalesce($5, starts_at),
           ends_at      = case when $6::boolean then $7 else ends_at end,
           venue        = case when $8::boolean then $9 else venue end,
           meeting_link = case when $10::boolean then $11 else meeting_link end,
           host_id      = case when $12::boolean then $13 else host_id end,
           capacity     = case when $14::boolean then $15 else capacity end,
           description  = case when $16::boolean then $17 else description end,
           audience_tags = coalesce($18, audience_tags)
         where id = $1
         returning *`,
        [
          id, body.name?.trim() ?? null, body.kind ?? null, body.status ?? null,
          body.startsAt ?? null,
          'endsAt' in body, body.endsAt ?? null,
          'venue' in body, body.venue?.trim() ?? null,
          'meetingLink' in body, body.meetingLink?.trim() ?? null,
          'hostId' in body, body.hostId ?? null,
          'capacity' in body, body.capacity ?? null,
          'description' in body, body.description?.trim() ?? null,
          body.audienceTags ?? null,
        ],
      ),
    );
    if (!row) throw notFound('no such event');
    return row;
  });

  /**
   * Preview: how many leads match, and the first page of them. Same predicate
   * the import uses, so the count on the button is the count you get.
   */
  app.post('/events/:id/import/preview', async (req) => {
    req.requireRole('admin', 'ops', 'counsellor');
    const { id } = z.object({ id: uuid }).parse(req.params);
    const f = filterSchema.parse(req.body ?? {});

    return req.tx(async (q) => {
      const rows = await q.many(
        `select * from crm.event_import_candidates($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [...filterArgs(f), id, f.limit],
      );
      return { matched: rows.length, sample: rows.slice(0, 25) };
    });
  });

  app.post('/events/:id/import', async (req) => {
    req.requireRole('admin', 'ops', 'counsellor');
    const { id } = z.object({ id: uuid }).parse(req.params);
    const f = filterSchema.parse(req.body ?? {});

    return req.tx(async (q) => {
      const row = await q.one<{ added: number }>(
        `select crm.import_leads_to_event($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) as added`,
        [id, ...filterArgs(f), f.limit],
      );
      const event = await q.one(`select * from crm.v_event_summary where event_id = $1`, [id]);
      return { added: row?.added ?? 0, event };
    });
  });

  /** Work a roster row: attendance, follow-up owner, notes. Callers may too. */
  app.put('/events/:id/roster/:rosterId', async (req) => {
    req.requireUser();
    const { id, rosterId } = z.object({ id: uuid, rosterId: uuid }).parse(req.params);
    const body = z
      .object({
        status: z.enum(ATTENDEE).optional(),
        followUpOwnerId: uuid.nullable().optional(),
        notes: z.string().max(2000).nullable().optional(),
        inviteSent: z.boolean().optional(),
        followedUp: z.boolean().optional(),
      })
      .parse(req.body);

    const row = await req.tx((q) =>
      q.one(
        `update crm.event_leads set
           status = coalesce($3::crm.attendee_status, status),
           -- Attendance stamps itself the first time the status says so.
           attended_at = case when $3 in ('attended', 'converted')
                              then coalesce(attended_at, now()) else attended_at end,
           invite_sent_at = case when $4::boolean then coalesce(invite_sent_at, now())
                                 else invite_sent_at end,
           followed_up_at = case when $5::boolean then coalesce(followed_up_at, now())
                                 else followed_up_at end,
           follow_up_owner_id = case when $6::boolean then $7 else follow_up_owner_id end,
           notes = case when $8::boolean then $9 else notes end
         where id = $2 and event_id = $1
         returning *`,
        [
          id, rosterId, body.status ?? null,
          body.inviteSent ?? false, body.followedUp ?? false,
          'followUpOwnerId' in body, body.followUpOwnerId ?? null,
          'notes' in body, body.notes?.trim() ?? null,
        ],
      ),
    );
    if (!row) throw notFound('no such attendee on this event');
    return row;
  });

  /** Add one person to the roster by hand - a walk-up who was never a lead. */
  app.post('/events/:id/roster', async (req, reply) => {
    const user = req.requireRole('admin', 'ops', 'counsellor', 'caller');
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = z
      .object({
        fullName: z.string().min(1).max(120),
        phone: z.string().min(6).max(20),
        city: z.string().max(60).optional(),
      })
      .parse(req.body);

    const row = await req.tx(async (q) => {
      const phone = await q.one<{ e164: string | null }>(
        `select crm.normalise_phone($1) as e164`, [body.phone],
      );
      if (!phone?.e164) throw badRequest('that phone number is not dialable');
      return q.one(
        `insert into crm.event_leads
           (event_id, full_name, phone_e164, city, source_name, added_by)
         values ($1, $2, $3, $4, 'Added by hand', $5)
         returning *`,
        [id, body.fullName.trim(), phone.e164, body.city?.trim() || null, user.id],
      );
    });
    reply.code(201);
    return row;
  });

  /** The post-event task list: everyone who came or did not, still unworked. */
  app.get('/events/followups/open', async (req) => {
    req.requireUser();
    return req.tx((q) =>
      q.many(
        `select * from crm.v_event_followups
          order by starts_at desc, full_name limit 500`,
      ),
    );
  });
}
