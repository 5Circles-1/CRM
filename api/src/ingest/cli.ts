/**
 * Ingestion entry point for cron or a worker container.
 *
 *   DATABASE_URL=... SERVICE_USER_ID=... node --experimental-strip-types src/ingest/cli.ts
 *   ... src/ingest/cli.ts --source <uuid>
 *   ... src/ingest/cli.ts --csv leads.csv --source <uuid>
 *
 * Exits non-zero if any source failed, so a scheduler notices.
 */
import { readFile } from 'node:fs/promises';
import { loadConfig } from '../config.ts';
import { Database } from '../db/pool.ts';
import { IngestWorker } from './worker.ts';
import { rowsFromCsv, StaticSheetReader } from './source.ts';

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const config = loadConfig();
const serviceUserId = process.env.SERVICE_USER_ID;
if (!serviceUserId) {
  console.error('SERVICE_USER_ID must be set to a user with the ops role');
  process.exit(2);
}

const db = new Database(config.databaseUrl);
await db.assertNotBypassingRls();

const worker = new IngestWorker(db, serviceUserId);
const sourceId = arg('source');
const csvPath = arg('csv');

try {
  if (csvPath) {
    if (!sourceId) throw new Error('--csv also needs --source <uuid>');
    const rows = rowsFromCsv(await readFile(csvPath, 'utf8'));
    const summary = await worker.runSource(sourceId, new StaticSheetReader(rows, csvPath));
    console.log(JSON.stringify(summary, null, 2));
    process.exit(summary.errors.length > 0 ? 1 : 0);
  }

  const summaries = sourceId ? [await worker.runSource(sourceId)] : await worker.runAll();
  console.log(JSON.stringify(summaries, null, 2));

  const failed = summaries.some((s) => s.errors.length > 0);
  process.exit(failed ? 1 : 0);
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
} finally {
  await db.close();
}
