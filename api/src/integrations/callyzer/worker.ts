import type { Database } from '../../db/pool.ts';
import { CallyzerClient, type CallyzerRawRow } from './client.ts';

/**
 * The scheduled Callyzer pull.
 *
 * The webhook is the fast path; this is the reconciler that makes it safe to
 * trust. Webhooks drop, and a dropped webhook is a call that really happened
 * being recorded as unverified - which corrupts precisely the number the CRM
 * exists to keep honest. Every run re-reads the last callyzer.backfill_hours
 * on synced_at; crm.ingest_callyzer_logs upserts, so overlap costs nothing
 * and a missed tick delays data but never loses it.
 *
 * Enablement is checked from crm.settings on every run, so flipping
 * callyzer.enabled is an ops action that needs no restart. The API key alone
 * decides whether this worker exists at all (index.ts), the same split as the
 * sheet importer: credentials from the environment, behaviour from settings.
 */

export interface CallyzerSyncSummary {
  employees: { seen: number; mapped: number; unmapped: number };
  logs: { seen: number; inserted: number; updated: number; matched: number; quarantined: number };
  pages: number;
  windowHours: number;
}

interface LogCounts {
  seen: number;
  inserted: number;
  updated: number;
  matched: number;
  quarantined: number;
}

export class CallyzerWorker {
  private readonly db: Database;
  /** Service account user id with the `ops` role; RLS runs as this user. */
  private readonly opsUserId: string;
  private readonly apiKey: string;
  private readonly clientHooks: { fetchImpl?: typeof fetch; minIntervalMs?: number };

  constructor(
    db: Database,
    opsUserId: string,
    apiKey: string,
    clientHooks: { fetchImpl?: typeof fetch; minIntervalMs?: number } = {},
  ) {
    this.db = db;
    this.opsUserId = opsUserId;
    this.apiKey = apiKey;
    this.clientHooks = clientHooks;
  }

  /**
   * One reconcile pass. Returns null when callyzer.enabled is off - the
   * caller can then tell "did nothing, deliberately" from "ran".
   */
  async syncOnce(hoursOverride?: number): Promise<CallyzerSyncSummary | null> {
    const settings = await this.db.withUser(this.opsUserId, (q) =>
      q.one<{ enabled: boolean; base_url: string; hours: number }>(
        `select crm.setting_bool('callyzer.enabled', false)  as enabled,
                crm.setting_text('callyzer.base_url',
                  'https://api1.callyzer.co/api/v2.2/')      as base_url,
                crm.setting_int('callyzer.backfill_hours', 26) as hours`,
      ),
    );
    if (!settings?.enabled) return null;

    const windowHours = hoursOverride ?? settings.hours;
    const client = new CallyzerClient({
      apiKey: this.apiKey,
      baseUrl: settings.base_url,
      ...this.clientHooks,
    });

    // The roster first: it resolves employee numbers to users, so pulling it
    // before the logs means a freshly-set Dialing SIM verifies this run's
    // calls instead of next run's.
    const employees = await client.fetchEmployees();
    const roster = await this.db.withUser(this.opsUserId, (q) =>
      q.one<{ seen: number; mapped: number; unmapped: number }>(
        'select * from crm.refresh_callyzer_employees($1::jsonb)',
        [JSON.stringify(employees)],
      ),
    );

    const totals: LogCounts = { seen: 0, inserted: 0, updated: 0, matched: 0, quarantined: 0 };
    const nowSec = Math.floor(Date.now() / 1000);
    const { pages } = await client.fetchCallLogs(
      { syncedFrom: nowSec - windowHours * 3600, syncedTo: nowSec },
      async (rows) => {
        const counts = await this.ingest(rows);
        totals.seen += counts.seen;
        totals.inserted += counts.inserted;
        totals.updated += counts.updated;
        totals.matched += counts.matched;
        totals.quarantined += counts.quarantined;
      },
    );

    return {
      employees: roster ?? { seen: 0, mapped: 0, unmapped: 0 },
      logs: totals,
      pages,
      windowHours,
    };
  }

  private async ingest(rows: CallyzerRawRow[]): Promise<LogCounts> {
    const counts = await this.db.withUser(this.opsUserId, (q) =>
      q.one<LogCounts>('select * from crm.ingest_callyzer_logs($1::jsonb)', [
        JSON.stringify(rows),
      ]),
    );
    return counts ?? { seen: 0, inserted: 0, updated: 0, matched: 0, quarantined: 0 };
  }
}
