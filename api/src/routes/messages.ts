import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { notFound } from '../http/errors.ts';

const uuid = z.string().uuid();

/**
 * Team chat: an admin (or ops) floats a message to one team or the whole floor,
 * inside the CRM. It is a broadcast board, not a thread - the point is that the
 * floor never needs a side WhatsApp group to hear "stand-up at 9:30" or "new
 * pricing from Monday". RLS decides who reads what: a floor-wide message is
 * visible to everyone, a team message only to that team.
 */
export async function messageRoutes(app: FastifyInstance): Promise<void> {
  app.get('/messages', async (req) => {
    req.requireUser();
    const { limit } = z
      .object({ limit: z.coerce.number().int().min(1).max(200).default(50) })
      .parse(req.query);
    return req.tx((q) =>
      q.many(
        `select m.id, m.body, m.team_id, m.pinned, m.created_at,
                t.name as team_name, u.full_name as author_name, u.avatar_url as author_avatar
           from crm.team_messages m
           left join crm.teams t on t.id = m.team_id
           left join crm.users u on u.id = m.author_id
          order by m.pinned desc, m.created_at desc
          limit $1`,
        [limit],
      ),
    );
  });

  app.post('/messages', async (req, reply) => {
    const user = req.requireRole('admin', 'ops');
    const body = z
      .object({
        body: z.string().trim().min(1).max(2000),
        teamId: uuid.nullable().optional(),
        pinned: z.boolean().default(false),
      })
      .parse(req.body);

    const row = await req.tx((q) =>
      q.one(
        `insert into crm.team_messages (author_id, team_id, body, pinned)
         values ($1, $2, $3, $4)
         returning id, body, team_id, pinned, created_at`,
        [user.id, body.teamId ?? null, body.body, body.pinned],
      ),
    );
    return reply.status(201).send(row);
  });

  app.post('/messages/:id/pin', async (req) => {
    req.requireRole('admin');
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = z.object({ pinned: z.boolean() }).parse(req.body ?? {});
    const row = await req.tx((q) =>
      q.one(
        `update crm.team_messages set pinned = $2 where id = $1
         returning id, pinned`,
        [id, body.pinned],
      ),
    );
    if (!row) throw notFound('no message with that id');
    return row;
  });
}
