import type { Database } from '../../db/pool.ts';
import type { TataTeleClient, TataTeleRawRow } from './client.ts';

/**
 * The scheduled Smartflo CDR pull.
 *
 * The webhook is the fast path; this is the reconciler that makes it safe to
 * trust. Webhooks drop (Smartflo itself retries only twice), and a dropped
 * webhook is a call that really happened being recorded as unverified - which
 * corrupts precisely the number the CRM exists to keep honest. Every run
 * re-reads the last tata_tele.backfill_hours of CDRs;
 * crm.ingest_tata_tele_cdrs upserts, so overlap costs nothing and a missed
 * tick delays data but never loses it.
 *
 * Enablement is checked from crm.settings on every run, so flipping
 * tata_tele.enabled is an ops action that needs no restart. The credentials
 * alone decide whether this worker exists at all (index.ts), the same split
 * as the sheet importer: credentials from the environment, behaviour from
 * settings.
 */

export interface TataTeleSyncSummary {
  agents: { seen: number; mapped: number; unmapped: number };
  cdrs: {
    seen: number;
    inserted: number;
    updated: number;
    matched: number;
    linked: number;
    skipped: number;
    quarantined: number;
  };
  pages: number;
  windowHours: number;
}

type CdrCounts = TataTeleSyncSummary['cdrs'];

const EMPTY: CdrCounts = {
  seen: 0, inserted: 0, updated: 0, matched: 0, linked: 0, skipped: 0, quarantined: 0,
};

/** "YYYY-MM-DD HH:mm:ss" wall-clock in the given IANA zone, as the CDR API expects. */
export function wallClock(d: Date, timeZone: string): string {
  const date = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d);
  const time = new Intl.DateTimeFormat('en-GB', {
    timeZone, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(d);
  return `${date} ${time}`;
}

export class TataTeleWorker {
  private readonly db: Database;
  /** Service account user id with the `ops` role; RLS runs as this user. */
  private readonly opsUserId: string;
  private readonly client: TataTeleClient;

  constructor(db: Database, opsUserId: string, client: TataTeleClient) {
    this.db = db;
    this.opsUserId = opsUserId;
    this.client = client;
  }

  /**
   * One reconcile pass. Returns null when tata_tele.enabled is off - the
   * caller can then tell "did nothing, deliberately" from "ran".
   */
  async syncOnce(hoursOverride?: number): Promise<TataTeleSyncSummary | null> {
    const settings = await this.db.withUser(this.opsUserId, (q) =>
      q.one<{ enabled: boolean; base_url: string; hours: number; tz: string }>(
        `select crm.setting_bool('tata_tele.enabled', false)      as enabled,
                crm.setting_text('tata_tele.base_url',
                  'https://api-smartflo.tatateleservices.com/v1/') as base_url,
                crm.setting_int('tata_tele.backfill_hours', 26)    as hours,
                crm.setting_text('tata_tele.timezone', 'Asia/Kolkata') as tz`,
      ),
    );
    if (!settings?.enabled) return null;

    // The one shared client also serves click-to-call, so the base URL is
    // refreshed here rather than a second client constructed per run.
    this.client.baseUrl = settings.base_url;
    const windowHours = hoursOverride ?? settings.hours;

    // The roster first: it resolves agent numbers for the health panel, so a
    // freshly-set Dialing number shows covered this run instead of next run's.
    const users = await this.client.fetchUsers();
    const roster = await this.db.withUser(this.opsUserId, (q) =>
      q.one<{ seen: number; mapped: number; unmapped: number }>(
        'select * from crm.refresh_tata_tele_agents($1::jsonb)',
        [JSON.stringify(users)],
      ),
    );

    const totals: CdrCounts = { ...EMPTY };
    const to = new Date();
    const from = new Date(to.getTime() - windowHours * 3600_000);
    const { pages } = await this.client.fetchCdrs(
      { fromDate: wallClock(from, settings.tz), toDate: wallClock(to, settings.tz) },
      async (rows) => {
        const counts = await this.ingest(rows);
        for (const key of Object.keys(totals) as Array<keyof CdrCounts>) {
          totals[key] += counts[key];
        }
      },
    );

    return {
      agents: roster ?? { seen: 0, mapped: 0, unmapped: 0 },
      cdrs: totals,
      pages,
      windowHours,
    };
  }

  private async ingest(rows: TataTeleRawRow[]): Promise<CdrCounts> {
    const counts = await this.db.withUser(this.opsUserId, (q) =>
      q.one<CdrCounts>('select * from crm.ingest_tata_tele_cdrs($1::jsonb)', [
        JSON.stringify(rows),
      ]),
    );
    return counts ?? { ...EMPTY };
  }
}
