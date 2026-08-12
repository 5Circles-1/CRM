import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Training content: markdown files on disk, read once at boot.
 *
 * The text lives in git rather than the database so a rule change and the
 * training that explains it land in the same commit and go through the same
 * review. The database stores only who acknowledged what.
 *
 * A module's "version" is the SHA-256 of its file. Edit the file and every
 * acknowledgement of it goes stale automatically - nobody has to remember to
 * bump a number, and nobody can quietly change a rule without the floor being
 * asked to re-read it.
 */

export interface QuizQuestion {
  q: string;
  options: string[];
  answer: number;
  why?: string;
}

export interface TrainingModule {
  slug: string;
  title: string;
  audience: string;
  order: number;
  summary: string;
  /** Markdown, with {{setting:key}} placeholders still in place. */
  body: string;
  quiz: QuizQuestion[];
  version: string;
}

export interface RegistryEntry {
  key: string;
  area: string;
  label: string;
  does: string;
  when: string;
}

const CONTENT_DIR = path.join(import.meta.dirname, '..', '..', 'content');

/** Minimal frontmatter reader: `key: value` lines between --- fences. */
function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
  if (!raw.startsWith('---')) return { meta: {}, body: raw };
  const end = raw.indexOf('\n---', 3);
  if (end === -1) return { meta: {}, body: raw };

  const meta: Record<string, string> = {};
  for (const line of raw.slice(4, end).split('\n')) {
    const colon = line.indexOf(':');
    if (colon > 0) meta[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
  }
  return { meta, body: raw.slice(end + 4).trim() };
}

/** Pull the trailing ```quiz fenced block out of the body. */
function extractQuiz(body: string): { body: string; quiz: QuizQuestion[] } {
  const start = body.indexOf('```quiz');
  if (start === -1) return { body, quiz: [] };
  const end = body.indexOf('```', start + 7);
  if (end === -1) return { body, quiz: [] };

  try {
    const quiz = JSON.parse(body.slice(start + 7, end)) as QuizQuestion[];
    return { body: (body.slice(0, start) + body.slice(end + 3)).trim(), quiz };
  } catch {
    // A malformed quiz must never take the module down with it.
    return { body: (body.slice(0, start) + body.slice(end + 3)).trim(), quiz: [] };
  }
}

let cachedModules: TrainingModule[] | null = null;
let cachedRegistry: RegistryEntry[] | null = null;

export function loadModules(): TrainingModule[] {
  if (cachedModules) return cachedModules;

  const dir = path.join(CONTENT_DIR, 'training');
  const modules = readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .map((file) => {
      const raw = readFileSync(path.join(dir, file), 'utf8');
      const { meta, body: withQuiz } = parseFrontmatter(raw);
      const { body, quiz } = extractQuiz(withQuiz);
      return {
        // The numeric prefix orders the files on disk; it is not part of the id.
        slug: file.replace(/\.md$/, '').replace(/^\d+-/, ''),
        title: meta.title ?? file,
        audience: meta.audience ?? 'all',
        order: Number(meta.order ?? 99),
        summary: meta.summary ?? '',
        body,
        quiz,
        version: createHash('sha256').update(raw).digest('hex').slice(0, 16),
      };
    })
    .sort((a, b) => a.order - b.order);

  cachedModules = modules;
  return modules;
}

export function loadRegistry(): RegistryEntry[] {
  if (cachedRegistry) return cachedRegistry;
  const raw = readFileSync(path.join(CONTENT_DIR, 'ui-registry.json'), 'utf8');
  cachedRegistry = (JSON.parse(raw) as { entries: RegistryEntry[] }).entries;
  return cachedRegistry;
}

/**
 * Replace {{setting:key}} with the live value from crm.settings.
 *
 * This is what stops the training drifting from the system it describes: the
 * page cannot state a stale SLA, because it does not contain one.
 */
export function interpolateSettings(body: string, settings: Map<string, unknown>): string {
  return body.replace(/\{\{setting:([a-z0-9_.]+)\}\}/gi, (_m, key: string) => {
    const value = settings.get(key);
    if (value === undefined || value === null) return '(not set)';
    return typeof value === 'string' ? value : JSON.stringify(value);
  });
}

/** Plain-text search across titles, summaries and bodies. */
export function searchModules(
  modules: TrainingModule[],
  term: string,
): Array<{ slug: string; title: string; hits: string[] }> {
  const needle = term.trim().toLowerCase();
  if (needle.length < 2) return [];

  return modules
    .map((m) => {
      const hits: string[] = [];
      for (const line of `${m.summary}\n${m.body}`.split('\n')) {
        const at = line.toLowerCase().indexOf(needle);
        if (at === -1) continue;
        // A window around the match reads better than the whole line.
        hits.push(
          (at > 40 ? '…' : '') +
            line.slice(Math.max(0, at - 40), at + needle.length + 90).trim() +
            (line.length > at + needle.length + 90 ? '…' : ''),
        );
        if (hits.length === 3) break;
      }
      return { slug: m.slug, title: m.title, hits };
    })
    .filter((r) => r.hits.length > 0);
}
