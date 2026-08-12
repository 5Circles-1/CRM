import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { notFound } from '../http/errors.ts';
import {
  interpolateSettings,
  loadModules,
  loadRegistry,
  searchModules,
} from '../training/content.ts';

/**
 * The Training academy.
 *
 * Content comes from files (see src/training/content.ts); the database holds
 * acknowledgements. A module's version is its content hash, so editing a
 * module automatically marks every existing acknowledgement stale and the
 * floor is asked to re-read it.
 */
export async function trainingRoutes(app: FastifyInstance): Promise<void> {
  /** Every module, with my acknowledgement state against the current text. */
  app.get('/training', async (req) => {
    const user = req.requireUser();
    const modules = loadModules();

    return req.tx(async (q) => {
      const acks = await q.many<{ module_slug: string; version: string; acked_at: string }>(
        `select module_slug, version, acked_at from crm.training_acks where user_id = $1`,
        [user.id],
      );
      const byslug = new Map(acks.map((a) => [a.module_slug, a]));

      const list = modules.map((m) => {
        const ack = byslug.get(m.slug);
        return {
          slug: m.slug,
          title: m.title,
          audience: m.audience,
          order: m.order,
          summary: m.summary,
          version: m.version,
          quizLength: m.quiz.length,
          // Mine if it is for everyone or for my role - but every module is
          // readable by everyone, which is the point of a shared rulebook.
          isMyTrack: m.audience === 'all' || m.audience === user.role,
          ackedAt: ack?.acked_at ?? null,
          // Acknowledged an older wording: it needs reading again.
          stale: ack ? ack.version !== m.version : false,
        };
      });

      return {
        modules: list,
        outstanding: list.filter((m) => m.isMyTrack && (!m.ackedAt || m.stale)).length,
        tourCompleted: Boolean(
          (await q.one<{ tour_completed_at: string | null }>(
            `select tour_completed_at from crm.users where id = $1`, [user.id],
          ))?.tour_completed_at,
        ),
      };
    });
  });

  /** Search every module at once. */
  app.get('/training/search', async (req) => {
    req.requireUser();
    const { q: term } = z.object({ q: z.string().min(2).max(60) }).parse(req.query);
    return { results: searchModules(loadModules(), term) };
  });

  /** The UI glossary — also the source of every tooltip in the app. */
  app.get('/training/registry', async (req) => {
    req.requireUser();
    return { entries: loadRegistry() };
  });

  /** Admin compliance matrix: who has read what, and who is stale. */
  app.get('/training/compliance', async (req) => {
    req.requireRole('admin', 'ops', 'counsellor');
    const modules = loadModules();
    const current = new Map(modules.map((m) => [m.slug, m.version]));

    return req.tx(async (q) => {
      const rows = await q.many<{
        user_id: string; full_name: string; role: string;
        module_slug: string | null; version: string | null; acked_at: string | null;
        quiz_score: number | null;
      }>(`select * from crm.v_training_compliance`);

      const people = new Map<string, {
        userId: string; fullName: string; role: string;
        acked: Record<string, { at: string; stale: boolean; score: number | null }>;
      }>();

      for (const r of rows) {
        if (!people.has(r.user_id)) {
          people.set(r.user_id, {
            userId: r.user_id, fullName: r.full_name, role: r.role, acked: {},
          });
        }
        if (r.module_slug && r.acked_at) {
          people.get(r.user_id)!.acked[r.module_slug] = {
            at: r.acked_at,
            stale: current.get(r.module_slug) !== r.version,
            score: r.quiz_score,
          };
        }
      }

      const list = [...people.values()].map((p) => {
        const required = modules.filter((m) => m.audience === 'all' || m.audience === p.role);
        const done = required.filter((m) => p.acked[m.slug] && !p.acked[m.slug]!.stale);
        return { ...p, required: required.length, done: done.length };
      });

      return {
        modules: modules.map((m) => ({ slug: m.slug, title: m.title, audience: m.audience })),
        people: list.sort((a, b) => a.done / (a.required || 1) - b.done / (b.required || 1)),
      };
    });
  });

  /**
   * One module, with the live configuration substituted in.
   *
   * Reading the settings here is what keeps the page honest: it cannot quote a
   * stale SLA because it does not contain one until this moment.
   */
  app.get('/training/:slug', async (req) => {
    const user = req.requireUser();
    const { slug } = z.object({ slug: z.string().max(80) }).parse(req.params);
    const mod = loadModules().find((m) => m.slug === slug);
    if (!mod) throw notFound('no such training module');

    return req.tx(async (q) => {
      const settings = await q.many<{ key: string; value: unknown }>(
        `select key, value from crm.settings`,
      );
      const map = new Map(settings.map((s) => [s.key, s.value]));

      const ack = await q.one<{ version: string; acked_at: string }>(
        `select version, acked_at from crm.training_acks
          where user_id = $1 and module_slug = $2`,
        [user.id, slug],
      );

      return {
        slug: mod.slug,
        title: mod.title,
        audience: mod.audience,
        summary: mod.summary,
        version: mod.version,
        body: interpolateSettings(mod.body, map),
        // The answers are needed to mark the quiz in the browser. This is a
        // comprehension check, not an exam - there is nothing to protect.
        quiz: mod.quiz,
        ackedAt: ack?.acked_at ?? null,
        stale: ack ? ack.version !== mod.version : false,
      };
    });
  });

  /** "I have read and understood" — signed against the exact text read. */
  app.post('/training/:slug/ack', async (req) => {
    const user = req.requireUser();
    const { slug } = z.object({ slug: z.string().max(80) }).parse(req.params);
    const { quizScore } = z
      .object({ quizScore: z.number().int().min(0).max(100).optional() })
      .parse(req.body ?? {});

    const mod = loadModules().find((m) => m.slug === slug);
    if (!mod) throw notFound('no such training module');

    return req.tx((q) =>
      q.one(
        `insert into crm.training_acks (user_id, module_slug, version, quiz_score)
         values ($1, $2, $3, $4)
         on conflict (user_id, module_slug) do update
           set version = excluded.version,
               quiz_score = excluded.quiz_score,
               acked_at = now()
         returning module_slug, version, quiz_score, acked_at`,
        [user.id, slug, mod.version, quizScore ?? null],
      ),
    );
  });

  /** The guided tour has been seen. Stored per person, not per browser. */
  app.post('/training/tour/complete', async (req) => {
    req.requireUser();
    return req.tx((q) => q.one(`select crm.complete_tour() as tour_completed_at`));
  });
}
