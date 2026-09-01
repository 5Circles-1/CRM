/**
 * Callyzer Business API v2.2 client.
 *
 * Callyzer's rate limit is one request per two seconds, account-wide, with
 * 429 + Retry-After past it. That is not a footnote - it is the main
 * constraint on this integration, so every request goes through one queue
 * that spaces starts and honours Retry-After with backoff. Nothing in this
 * file may call fetch directly.
 *
 * The base URL is version-pinned (v2.2 made call_method/call_mode mandatory;
 * a client written against v2.1 silently starts failing), and it comes from
 * crm.settings like every other tunable. The token is a long-lived
 * account-wide secret and comes only from the environment.
 *
 * Deliberately absent: Callyzer's Lead APIs. This client can read call logs
 * and the handset roster, and nothing else - Callyzer is a sensor, never a
 * second CRM.
 */

const sleepMs = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class CallyzerApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }

  /** Callyzer's 403 means "subscription expired", not "forbidden". */
  get subscriptionExpired(): boolean {
    return this.status === 403;
  }
}

/**
 * Serialises calls and spaces their STARTS by `minIntervalMs`, so bursts from
 * anywhere in the process (scheduled sync, an admin's backfill click) share
 * one account-wide budget instead of racing each other into 429s.
 */
export class RateLimitQueue {
  private chain: Promise<unknown> = Promise.resolve();
  private lastStart = -Infinity;

  private readonly minIntervalMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(
    minIntervalMs: number,
    hooks: { sleep?: (ms: number) => Promise<void>; now?: () => number } = {},
  ) {
    this.minIntervalMs = minIntervalMs;
    this.sleep = hooks.sleep ?? sleepMs;
    this.now = hooks.now ?? Date.now;
  }

  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.chain.then(async () => {
      const wait = this.lastStart + this.minIntervalMs - this.now();
      if (wait > 0) await this.sleep(wait);
      this.lastStart = this.now();
      return fn();
    });
    // The chain must survive a failed call, or one 500 would jam the queue
    // for the life of the process.
    this.chain = result.catch(() => undefined);
    return result;
  }
}

export interface CallyzerClientOptions {
  apiKey: string;
  /** e.g. https://api1.callyzer.co/api/v2.2/ - from crm.settings. */
  baseUrl: string;
  minIntervalMs?: number;
  /** Test seams; production uses the real clock and fetch. */
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/** A raw Callyzer row. Passed to SQL as-is; the database does the mapping. */
export type CallyzerRawRow = Record<string, unknown>;

export interface CallLogWindow {
  /** UNIX seconds, UTC - filters on Callyzer's synced_at. */
  syncedFrom: number;
  syncedTo: number;
}

/**
 * v2.2 requires exactly one call_method and one call_mode per request, so
 * covering the log takes one paged sweep per combination. PhoneCall+Video is
 * not a thing an Android call log produces, so three sweeps cover everything.
 */
export const CALL_METHOD_COMBOS: ReadonlyArray<{ method: string; mode: string }> = [
  { method: 'PhoneCall', mode: 'Voice' },
  { method: 'WhatsAppCall', mode: 'Voice' },
  { method: 'WhatsAppCall', mode: 'Video' },
];

const PAGE_SIZE = 100; // Callyzer's maximum and default

export class CallyzerClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly queue: RateLimitQueue;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(opts: CallyzerClientOptions) {
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl.endsWith('/') ? opts.baseUrl : `${opts.baseUrl}/`;
    this.queue = new RateLimitQueue(opts.minIntervalMs ?? 2000, {
      sleep: opts.sleep,
      now: opts.now,
    });
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleep = opts.sleep ?? sleepMs;
  }

  /**
   * One rate-limited request. 429 waits out Retry-After (or backs off
   * 2/4/8/16s when the header is missing) and retries up to four times;
   * everything else surfaces as CallyzerApiError with Callyzer's own message,
   * which for 403 is the one that matters: "Your subscription has expired."
   */
  private async request<T>(path: string, init: RequestInit): Promise<T> {
    const url = new URL(path.replace(/^\//, ''), this.baseUrl).toString();

    for (let attempt = 0; ; attempt += 1) {
      const res = await this.queue.run(() =>
        this.fetchImpl(url, {
          ...init,
          headers: {
            authorization: `Bearer ${this.apiKey}`,
            'content-type': 'application/json',
            ...init.headers,
          },
        }),
      );

      if (res.status === 429 && attempt < 4) {
        const retryAfter = Number(res.headers.get('retry-after'));
        const waitMs = retryAfter > 0 ? retryAfter * 1000 : 2 ** (attempt + 1) * 1000;
        await this.sleep(waitMs);
        continue;
      }

      const body = (await res.json().catch(() => null)) as { message?: string; result?: unknown } | null;
      if (!res.ok) {
        throw new CallyzerApiError(res.status, body?.message ?? `Callyzer replied ${res.status}`);
      }
      return (body ?? {}) as T;
    }
  }

  /** The rows out of Callyzer's {result, message} envelope, whatever nesting. */
  private static rows(body: { result?: unknown }): CallyzerRawRow[] {
    const result = body?.result;
    if (Array.isArray(result)) return result as CallyzerRawRow[];
    if (result && typeof result === 'object') {
      const inner = (result as Record<string, unknown>).call_logs ?? (result as Record<string, unknown>).data;
      if (Array.isArray(inner)) return inner as CallyzerRawRow[];
    }
    return [];
  }

  /** GET /employee/get, paged. The whole handset roster. */
  async fetchEmployees(): Promise<CallyzerRawRow[]> {
    const all: CallyzerRawRow[] = [];
    for (let page = 1; ; page += 1) {
      const body = await this.request<{ result?: unknown }>(
        `employee/get?page_no=${page}&page_size=${PAGE_SIZE}`,
        { method: 'GET' },
      );
      const rows = CallyzerClient.rows(body);
      all.push(...rows);
      if (rows.length < PAGE_SIZE) return all;
    }
  }

  /**
   * POST /call-log/history over a synced_at window, one paged sweep per
   * method/mode combination, delivering each page to `onPage` as it arrives
   * so a long backfill lands incrementally rather than all-or-nothing.
   */
  async fetchCallLogs(
    window: CallLogWindow,
    onPage: (rows: CallyzerRawRow[]) => Promise<void>,
  ): Promise<{ pages: number; rows: number }> {
    let pages = 0;
    let total = 0;

    for (const combo of CALL_METHOD_COMBOS) {
      for (let page = 1; ; page += 1) {
        const body = await this.request<{ result?: unknown }>('call-log/history', {
          method: 'POST',
          body: JSON.stringify({
            synced_from: window.syncedFrom,
            synced_to: window.syncedTo,
            call_method: combo.method,
            call_mode: combo.mode,
            page_no: page,
          }),
        });
        const rows = CallyzerClient.rows(body);
        if (rows.length > 0) {
          pages += 1;
          total += rows.length;
          await onPage(rows);
        }
        if (rows.length < PAGE_SIZE) break;
      }
    }

    return { pages, rows: total };
  }
}
