import type { FastifyBaseLogger } from 'fastify';
import type { Database } from '../db/pool.ts';

/**
 * The engines are database functions; this just calls them on a cadence.
 *
 * Keeping the logic in Postgres rather than here means a missed tick delays
 * work but never corrupts it - every one of these is idempotent and derives
 * its own state, so running twice or running late is safe.
 */

export interface Job {
  name: string;
  everyMs: number;
  sql: string;
  /** Skip outside the working day, for jobs that only matter on the floor. */
  shiftHoursOnly?: boolean;
}

export const JOBS: Job[] = [
  {
    name: 'assign_pending_leads',
    // Leads that arrived while nobody was logged in are held at team level;
    // this is what hands them out at shift start.
    everyMs: 60_000,
    sql: 'select crm.assign_pending_leads(500)',
    shiftHoursOnly: true,
  },
  {
    name: 'reassign_untouched_leads',
    // Every minute, because the whole point is a ten-minute promise. Checking
    // every five would make the real deadline anywhere from 10 to 15 minutes.
    everyMs: 60_000,
    sql: 'select crm.reassign_untouched_leads(200)',
    shiftHoursOnly: true,
  },
  {
    name: 'expire_missed_callbacks',
    everyMs: 5 * 60_000,
    sql: 'select crm.expire_missed_callbacks()',
  },
  {
    name: 'detect_bulk_access',
    everyMs: 5 * 60_000,
    sql: 'select crm.detect_bulk_access()',
  },
  {
    name: 'detect_off_hours_access',
    everyMs: 15 * 60_000,
    sql: 'select crm.detect_off_hours_access()',
  },
  {
    name: 'snapshot_scores',
    // Intraday too, so a caller checking their score mid-afternoon sees
    // something current rather than yesterday's number.
    everyMs: 15 * 60_000,
    sql: 'select crm.snapshot_scores(crm.ist_date(now()))',
  },
  {
    name: 'mark_overdue_instalments',
    everyMs: 60 * 60_000,
    sql: 'select crm.mark_overdue_instalments()',
  },
  {
    name: 'park_exhausted_leads',
    everyMs: 60 * 60_000,
    sql: 'select crm.park_exhausted_leads()',
  },
  {
    name: 'purge_expired_sessions',
    everyMs: 6 * 60 * 60_000,
    sql: 'select crm.purge_expired_sessions()',
  },
];

/** 09:00-20:00 IST, a little either side of the 09:30-18:30 shift. */
function withinShiftHours(now = new Date()): boolean {
  const istHour = Number(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Kolkata',
      hour: '2-digit',
      hour12: false,
    }).format(now),
  );
  return istHour >= 9 && istHour < 20;
}

export class Scheduler {
  private timers: NodeJS.Timeout[] = [];

  private readonly db: Database;
  private readonly serviceUserId: string;
  private readonly log: FastifyBaseLogger;

  constructor(db: Database, serviceUserId: string, log: FastifyBaseLogger) {
    this.db = db;
    this.serviceUserId = serviceUserId;
    this.log = log;
  }

  start(jobs: Job[] = JOBS): void {
    for (const job of jobs) {
      const timer = setInterval(() => {
        void this.run(job);
      }, job.everyMs);
      timer.unref();
      this.timers.push(timer);
    }
    this.log.info({ jobs: jobs.map((j) => j.name) }, 'background jobs started');
  }

  async run(job: Job): Promise<void> {
    if (job.shiftHoursOnly && !withinShiftHours()) return;
    const started = Date.now();
    try {
      const result = await this.db.withUser(this.serviceUserId, (q) => q.query(job.sql));
      const value = result.rows[0] ? Object.values(result.rows[0])[0] : null;
      this.log.debug({ job: job.name, ms: Date.now() - started, result: value }, 'job finished');
    } catch (err) {
      // A failing job must not take the API down with it.
      this.log.error({ err, job: job.name }, 'job failed');
    }
  }

  stop(): void {
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
  }
}
