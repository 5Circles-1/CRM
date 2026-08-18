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
  // The untouched-lead sweeper and the cross-team mover are no longer
  // scheduled: the floor's rule (0049) is that a lead stays with its caller
  // until a counsellor transfers it by hand. The engine functions remain in
  // the database, gated on their settings, in case that rule is ever reversed.
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
    name: 'close_stale_shifts',
    // The belt to auto_logout_idle's braces: any shift still open from a
    // previous day is closed at that day's honest end. Start shift also
    // calls this per-user, so the floor self-heals even if jobs are down.
    everyMs: 10 * 60_000,
    sql: 'select crm.close_stale_shifts(null)',
  },
  {
    name: 'auto_logout_idle',
    // Runs around the clock on purpose: the forgotten logout happens at
    // 18:40, and a shiftHoursOnly gate would leave the chair "occupied"
    // until the next morning's first tick.
    everyMs: 10 * 60_000,
    sql: 'select crm.auto_logout_idle(100)',
  },
  {
    name: 'send_due_reminders',
    // Every five minutes, all week: the engine decides for itself which slot
    // is due from the settings clock and its own log, so a restart at 09:33
    // still delivers the 09:30 brief instead of skipping the day. Not
    // shiftHoursOnly - the 20:30 end-of-day slot is after the floor closes.
    everyMs: 5 * 60_000,
    sql: 'select crm.send_due_reminders()',
  },
  {
    name: 'send_retap_reminders',
    // Hourly is plenty: the function itself enforces the every-N-days cadence
    // per person from the last notification it actually sent, so running it
    // often costs nothing and a missed hour never skips somebody's turn.
    everyMs: 60 * 60_000,
    sql: 'select crm.send_retap_reminders()',
    shiftHoursOnly: true,
  },
  {
    name: 'purge_expired_sessions',
    everyMs: 6 * 60 * 60_000,
    sql: 'select crm.purge_expired_sessions()',
  },
  {
    name: 'check_lead_intake',
    // The floor lost two days of Meta leads to a silent importer. This is the
    // watchdog: while the floor is open, no leads arriving or a source that
    // cannot import raises an admin notification within the hour.
    everyMs: 10 * 60_000,
    sql: 'select crm.check_lead_intake()',
  },
];

/**
 * Mon-Sat, 09:00-19:00 IST - a little either side of the 09:30-18:30 shift.
 *
 * Sunday matters as much as the hours: the gate used to check the hour only,
 * so every shift-hours job ran happily through the team's day off, sweeping
 * and reassigning leads nobody was there to take.
 */
function withinShiftHours(now = new Date()): boolean {
  const istDay = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', weekday: 'short' }).format(now);
  if (istDay === 'Sun') return false;
  const istHour = Number(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Kolkata',
      hour: '2-digit',
      hour12: false,
    }).format(now),
  );
  return istHour >= 9 && istHour < 19;
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
      await this.heartbeat(job.name, Date.now() - started, null);
    } catch (err) {
      // A failing job must not take the API down with it.
      this.log.error({ err, job: job.name }, 'job failed');
      await this.heartbeat(job.name, Date.now() - started,
        err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * Leave a mark, every run, success or failure.
   *
   * Without this the only evidence a job existed was a log line nobody reads,
   * so "has the importer run today?" could not be answered from inside the
   * product - which is how a stopped lead feed went unnoticed for two days.
   * A failed heartbeat is logged and swallowed: recording the run must never
   * be the thing that breaks the run.
   */
  private async heartbeat(name: string, ms: number, error: string | null): Promise<void> {
    try {
      await this.db.withUser(this.serviceUserId, (q) =>
        q.query('select crm.record_job_run($1, $2, $3)', [name, ms, error]),
      );
    } catch (err) {
      this.log.warn({ err, job: name }, 'could not record job heartbeat');
    }
  }

  stop(): void {
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
  }
}
