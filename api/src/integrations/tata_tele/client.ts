/**
 * Tata Tele Smartflo API client (v1).
 *
 * Smartflo is both the floor's dialler and its call sensor: click_to_call
 * bridges the agent's phone to the client's, and /call/records says what
 * really happened. This client speaks exactly three surfaces - click-to-call,
 * CDRs, and the user/agent roster - and nothing else. Smartflo's lead ids,
 * dispositions, broadcasts and dialler campaigns are deliberately absent:
 * Smartflo is never a second CRM.
 *
 * Auth is the part that bites. Smartflo issues JWTs from /auth/login that
 * expire in an hour, and rotates the login password itself every 90 days -
 * so the client logs in lazily, refreshes before expiry, and retries exactly
 * once on a 401 in case the token died early. A static portal-issued token is
 * also accepted (TATA_TELE_API_TOKEN); with one of those there is nothing to
 * refresh, and a 401 means the token itself is dead. Either way the failure
 * surfaces as authFailed, which the health view names as what it is.
 *
 * Every request goes through one queue that spaces starts and honours 429
 * Retry-After with backoff, so bursts from anywhere in the process (the
 * scheduled sync, a floor of callers clicking Call) share one account-wide
 * budget instead of racing each other. Nothing in this file may call fetch
 * directly.
 */

const sleepMs = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class TataTeleApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }

  /** 401/403 from Smartflo: the login or token has expired or is wrong. */
  get authFailed(): boolean {
    return this.status === 401 || this.status === 403;
  }
}

/**
 * Serialises calls and spaces their STARTS by `minIntervalMs`, so bursts from
 * anywhere in the process share one account-wide budget.
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

/** Credentials, from the environment only - never from the database. */
export type TataTeleAuth =
  | { kind: 'token'; token: string }
  | { kind: 'login'; email: string; password: string };

export interface TataTeleClientOptions {
  auth: TataTeleAuth;
  /** e.g. https://api-smartflo.tatateleservices.com/v1/ - from crm.settings. */
  baseUrl: string;
  minIntervalMs?: number;
  /** Test seams; production uses the real clock and fetch. */
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/** A raw Smartflo row. Passed to SQL as-is; the database does the mapping. */
export type TataTeleRawRow = Record<string, unknown>;

export interface CdrWindow {
  /** "YYYY-MM-DD HH:mm:ss" wall-clock in the Smartflo account timezone. */
  fromDate: string;
  toDate: string;
}

const PAGE_SIZE = 100;

export class TataTeleClient {
  private readonly auth: TataTeleAuth;
  private readonly queue: RateLimitQueue;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  /** Updated from crm.settings by the worker each run; a settings change
   *  needs no restart. */
  baseUrl: string;

  private accessToken: string | null = null;
  private tokenExpiresAt = 0;

  constructor(opts: TataTeleClientOptions) {
    this.auth = opts.auth;
    this.baseUrl = opts.baseUrl;
    this.queue = new RateLimitQueue(opts.minIntervalMs ?? 300, {
      sleep: opts.sleep,
      now: opts.now,
    });
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleep = opts.sleep ?? sleepMs;
    this.now = opts.now ?? Date.now;

    if (opts.auth.kind === 'token') {
      // A portal token may already carry the scheme word.
      this.accessToken = opts.auth.token.replace(/^Bearer\s+/i, '');
      this.tokenExpiresAt = Infinity;
    }
  }

  private url(path: string): string {
    const base = this.baseUrl.endsWith('/') ? this.baseUrl : `${this.baseUrl}/`;
    return new URL(path.replace(/^\//, ''), base).toString();
  }

  /**
   * Smartflo JWTs live one hour. Refresh a minute early; on login-based auth
   * a 401 mid-flight drops the cache so the retry logs in again.
   */
  private async ensureToken(): Promise<string> {
    const auth = this.auth;
    if (this.accessToken && this.now() < this.tokenExpiresAt) return this.accessToken;
    if (auth.kind === 'token') return this.accessToken ?? '';

    const res = await this.queue.run(() =>
      this.fetchImpl(this.url('auth/login'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: auth.email, password: auth.password }),
      }),
    );
    const body = (await res.json().catch(() => null)) as
      | { access_token?: string; expires_in?: number; message?: string }
      | null;
    if (!res.ok || !body?.access_token) {
      throw new TataTeleApiError(
        res.ok ? 401 : res.status,
        body?.message ?? `Smartflo login failed with ${res.status}`,
      );
    }
    this.accessToken = body.access_token;
    const ttlSec = Number(body.expires_in ?? 3600);
    this.tokenExpiresAt = this.now() + Math.max(60, ttlSec - 60) * 1000;
    return this.accessToken;
  }

  /**
   * One rate-limited, authenticated request. 429 waits out Retry-After (or
   * backs off 2/4/8/16s) and retries up to four times; a 401 under
   * login-based auth re-logs-in and retries once - Smartflo tokens can die
   * before their advertised hour. Everything else surfaces as
   * TataTeleApiError with Smartflo's own message.
   */
  private async request<T>(path: string, init: RequestInit, reauth = true): Promise<T> {
    const token = await this.ensureToken();

    for (let attempt = 0; ; attempt += 1) {
      const res = await this.queue.run(() =>
        this.fetchImpl(this.url(path), {
          ...init,
          headers: {
            authorization: `Bearer ${token}`,
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

      if (res.status === 401 && this.auth.kind === 'login' && reauth) {
        this.accessToken = null;
        this.tokenExpiresAt = 0;
        return this.request(path, init, false);
      }

      const body = (await res.json().catch(() => null)) as
        | { message?: string; success?: boolean }
        | null;
      if (!res.ok) {
        throw new TataTeleApiError(res.status, body?.message ?? `Smartflo replied ${res.status}`);
      }
      return (body ?? {}) as T;
    }
  }

  /**
   * POST /click_to_call: Smartflo rings the agent first, then bridges the
   * client. Returns ref_id, Smartflo's own correlation key - its webhook
   * echoes it, which is how the CDR finds the click that placed it.
   */
  async clickToCall(params: {
    agentNumber: string;
    destinationNumber: string;
    callerId?: string;
  }): Promise<{ refId: string | null; message: string }> {
    const body = await this.request<{ success?: boolean; message?: string; ref_id?: string }>(
      'click_to_call',
      {
        method: 'POST',
        body: JSON.stringify({
          agent_number: params.agentNumber,
          destination_number: params.destinationNumber,
          // Only the value 1 is supported; the call is originated async.
          async: 1,
          ...(params.callerId ? { caller_id: params.callerId } : {}),
        }),
      },
    );
    if (body.success === false) {
      throw new TataTeleApiError(200, body.message ?? 'Smartflo refused the call');
    }
    return { refId: body.ref_id ?? null, message: body.message ?? 'queued' };
  }

  /** GET /users, paged on last_seen_id. The whole agent roster. */
  async fetchUsers(): Promise<TataTeleRawRow[]> {
    const all: TataTeleRawRow[] = [];
    let lastSeenId: number | null = null;
    for (let page = 0; page < 100; page += 1) {
      const qs = new URLSearchParams({ limit: String(PAGE_SIZE) });
      if (lastSeenId !== null) qs.set('last_seen_id', String(lastSeenId));
      const body = await this.request<{
        has_more?: boolean;
        last_seen_id?: number;
        data?: unknown;
      }>(`users?${qs}`, { method: 'GET' });

      const rows = Array.isArray(body.data) ? (body.data as TataTeleRawRow[]) : [];
      all.push(...rows);
      if (!body.has_more || rows.length === 0) return all;
      lastSeenId = body.last_seen_id ?? null;
      if (lastSeenId === null) return all;
    }
    return all;
  }

  /**
   * GET /call/records over a wall-clock window, paged, delivering each page
   * to `onPage` as it arrives so a long backfill lands incrementally rather
   * than all-or-nothing.
   */
  async fetchCdrs(
    window: CdrWindow,
    onPage: (rows: TataTeleRawRow[]) => Promise<void>,
  ): Promise<{ pages: number; rows: number }> {
    let pages = 0;
    let total = 0;

    for (let page = 1; ; page += 1) {
      const qs = new URLSearchParams({
        from_date: window.fromDate,
        to_date: window.toDate,
        page: String(page),
        limit: String(PAGE_SIZE),
      });
      const body = await this.request<{ results?: unknown }>(`call/records?${qs}`, {
        method: 'GET',
      });
      const rows = Array.isArray(body.results) ? (body.results as TataTeleRawRow[]) : [];
      if (rows.length > 0) {
        pages += 1;
        total += rows.length;
        await onPage(rows);
      }
      if (rows.length < PAGE_SIZE) break;
    }

    return { pages, rows: total };
  }
}

/** The credentials the environment offers, or null when none are set. */
export function tataTeleAuthFromEnv(env = process.env): TataTeleAuth | null {
  if (env.TATA_TELE_API_TOKEN) return { kind: 'token', token: env.TATA_TELE_API_TOKEN };
  if (env.TATA_TELE_LOGIN_EMAIL && env.TATA_TELE_LOGIN_PASSWORD) {
    return { kind: 'login', email: env.TATA_TELE_LOGIN_EMAIL, password: env.TATA_TELE_LOGIN_PASSWORD };
  }
  return null;
}
