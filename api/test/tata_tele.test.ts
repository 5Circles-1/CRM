import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  RateLimitQueue,
  TataTeleApiError,
  TataTeleClient,
  tataTeleAuthFromEnv,
} from '../src/integrations/tata_tele/client.ts';

/**
 * The Smartflo client without a database or a network: the rate-limit queue
 * against a virtual clock, and the request loop against a stubbed fetch.
 * The load-bearing parts are the token lifecycle (Smartflo JWTs die hourly
 * and the login password itself rotates every 90 days) and the shared queue
 * that keeps a floor of simultaneous clicks from racing the sync into 429s.
 */

function virtualClock() {
  let t = 0;
  const sleeps: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number): Promise<void> => {
      sleeps.push(ms);
      t += ms;
    },
    sleeps,
  };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

describe('RateLimitQueue', () => {
  it('spaces request starts by the minimum interval', async () => {
    const clock = virtualClock();
    const queue = new RateLimitQueue(300, clock);
    const starts: number[] = [];

    await Promise.all([
      queue.run(async () => starts.push(clock.now())),
      queue.run(async () => starts.push(clock.now())),
      queue.run(async () => starts.push(clock.now())),
    ]);

    assert.deepEqual(starts, [0, 300, 600]);
    assert.deepEqual(clock.sleeps, [300, 300]);
  });

  it('a failed call does not jam the queue', async () => {
    const clock = virtualClock();
    const queue = new RateLimitQueue(300, clock);

    const failed = queue.run(async () => {
      throw new Error('boom');
    });
    const second = queue.run(async () => 'still running');

    await assert.rejects(failed, /boom/);
    assert.equal(await second, 'still running');
  });
});

describe('TataTeleClient auth', () => {
  it('logs in once, sends the bearer token, and reuses it until it expires', async () => {
    const clock = virtualClock();
    const calls: { url: string; auth: string | undefined }[] = [];
    const client = new TataTeleClient({
      auth: { kind: 'login', email: 'crm@5circles.test', password: 'pw' },
      baseUrl: 'https://api.example/v1', // no trailing slash on purpose
      minIntervalMs: 0,
      sleep: clock.sleep,
      now: clock.now,
      fetchImpl: async (url, init) => {
        calls.push({
          url: String(url),
          auth: (init?.headers as Record<string, string>)?.authorization,
        });
        if (String(url).endsWith('/auth/login')) {
          return json(200, { success: true, access_token: 'jwt-1', expires_in: 3600 });
        }
        return json(200, { has_more: false, data: [] });
      },
    });

    await client.fetchUsers();
    await client.fetchUsers();

    const logins = calls.filter((c) => c.url.endsWith('/auth/login'));
    assert.equal(logins.length, 1, 'one login covers many requests');
    const authed = calls.filter((c) => !c.url.endsWith('/auth/login'));
    assert.ok(authed.every((c) => c.auth === 'Bearer jwt-1'));
    assert.match(authed[0]?.url ?? '', /^https:\/\/api\.example\/v1\/users/);
  });

  it('re-logs-in once when a token dies early, and surfaces a second 401 as authFailed', async () => {
    const clock = virtualClock();
    let logins = 0;
    let mode: 'expired-token' | 'dead-password' = 'expired-token';
    const client = new TataTeleClient({
      auth: { kind: 'login', email: 'crm@5circles.test', password: 'pw' },
      baseUrl: 'https://api.example/v1/',
      minIntervalMs: 0,
      sleep: clock.sleep,
      now: clock.now,
      fetchImpl: async (url) => {
        if (String(url).endsWith('/auth/login')) {
          logins += 1;
          if (mode === 'dead-password' && logins > 1) {
            return json(401, { success: false, message: 'These credentials do not match our records.' });
          }
          return json(200, { access_token: `jwt-${logins}`, expires_in: 3600 });
        }
        // The first token is always refused, the second accepted.
        return logins < 2
          ? json(401, { message: 'Token has expired' })
          : json(200, { has_more: false, data: [{ name: 'A' }] });
      },
    });

    const users = await client.fetchUsers();
    assert.equal(users.length, 1, 'the retry after re-login succeeded');
    assert.equal(logins, 2);

    // Now the password itself has rotated: the re-login fails, and the error
    // says so as an auth failure - the alarm the watchdog names by cause.
    mode = 'dead-password';
    const dead = new TataTeleClient({
      auth: { kind: 'login', email: 'crm@5circles.test', password: 'old-pw' },
      baseUrl: 'https://api.example/v1/',
      minIntervalMs: 0,
      sleep: clock.sleep,
      now: clock.now,
      fetchImpl: async () =>
        json(401, { success: false, message: 'These credentials do not match our records.' }),
    });
    await assert.rejects(
      () => dead.fetchUsers(),
      (err: unknown) => err instanceof TataTeleApiError && err.authFailed,
    );
  });

  it('a static portal token is used as-is, with or without the Bearer prefix', async () => {
    let seenAuth: string | undefined;
    const client = new TataTeleClient({
      auth: { kind: 'token', token: 'Bearer static-tok' },
      baseUrl: 'https://api.example/v1/',
      minIntervalMs: 0,
      fetchImpl: async (url, init) => {
        assert.ok(!String(url).endsWith('/auth/login'), 'a static token never logs in');
        seenAuth = (init?.headers as Record<string, string>)?.authorization;
        return json(200, { has_more: false, data: [] });
      },
    });
    await client.fetchUsers();
    assert.equal(seenAuth, 'Bearer static-tok');
  });
});

describe('TataTeleClient requests', () => {
  const tokenAuth = { kind: 'token' as const, token: 'tok' };

  it('waits out a 429 for Retry-After seconds, then succeeds', async () => {
    const clock = virtualClock();
    let calls = 0;
    const client = new TataTeleClient({
      auth: tokenAuth,
      baseUrl: 'https://api.example/v1/',
      minIntervalMs: 0,
      sleep: clock.sleep,
      now: clock.now,
      fetchImpl: async () => {
        calls += 1;
        if (calls === 1) return json(429, { message: 'slow down' }, { 'retry-after': '3' });
        return json(200, { has_more: false, data: [] });
      },
    });

    await client.fetchUsers();
    assert.equal(calls, 2);
    assert.ok(clock.sleeps.includes(3000), `waited the server's own 3s, got ${clock.sleeps}`);
  });

  it('click_to_call sends the documented body and returns the ref_id', async () => {
    let body: Record<string, unknown> = {};
    const client = new TataTeleClient({
      auth: tokenAuth,
      baseUrl: 'https://api.example/v1/',
      minIntervalMs: 0,
      fetchImpl: async (url, init) => {
        assert.match(String(url), /\/v1\/click_to_call$/);
        body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return json(200, { success: true, message: 'Call originated successfully.', ref_id: 'C2C-1' });
      },
    });

    const placed = await client.clickToCall({
      agentNumber: '919000000001',
      destinationNumber: '919811100001',
      callerId: '918069651170',
    });
    assert.equal(placed.refId, 'C2C-1');
    assert.deepEqual(body, {
      agent_number: '919000000001',
      destination_number: '919811100001',
      async: 1,
      caller_id: '918069651170',
    });
    assert.ok(!('call_timeout' in body), 'call_timeout caps the whole call - never sent');
  });

  it('click_to_call treats success:false as a refusal, with Smartflo\'s own words', async () => {
    const client = new TataTeleClient({
      auth: tokenAuth,
      baseUrl: 'https://api.example/v1/',
      minIntervalMs: 0,
      fetchImpl: async () => json(200, { success: false, message: 'Agent not found' }),
    });
    await assert.rejects(
      () => client.clickToCall({ agentNumber: '1', destinationNumber: '2' }),
      (err: unknown) => err instanceof TataTeleApiError && /Agent not found/.test(err.message),
    );
  });

  it('pages CDRs until a short page, delivering each page as it arrives', async () => {
    const seenPages: number[] = [];
    const requested: string[] = [];
    const page1 = Array.from({ length: 100 }, (_, i) => ({ id: `r${i}` }));
    const client = new TataTeleClient({
      auth: tokenAuth,
      baseUrl: 'https://api.example/v1/',
      minIntervalMs: 0,
      fetchImpl: async (url) => {
        requested.push(String(url));
        const page = Number(new URL(String(url)).searchParams.get('page'));
        return json(200, { count: 102, results: page === 1 ? page1 : [{ id: 'r100' }, { id: 'r101' }] });
      },
    });

    const { pages, rows } = await client.fetchCdrs(
      { fromDate: '2026-09-21 00:00:00', toDate: '2026-09-22 10:00:00' },
      async (batch) => {
        seenPages.push(batch.length);
      },
    );

    assert.equal(rows, 102);
    assert.equal(pages, 2);
    assert.deepEqual(seenPages, [100, 2]);
    for (const url of requested) {
      const qs = new URL(url).searchParams;
      assert.equal(qs.get('from_date'), '2026-09-21 00:00:00');
      assert.equal(qs.get('to_date'), '2026-09-22 10:00:00');
    }
  });

  it('pages the user roster on last_seen_id while has_more', async () => {
    const seen: Array<string | null> = [];
    const client = new TataTeleClient({
      auth: tokenAuth,
      baseUrl: 'https://api.example/v1/',
      minIntervalMs: 0,
      fetchImpl: async (url) => {
        const cursor = new URL(String(url)).searchParams.get('last_seen_id');
        seen.push(cursor);
        return cursor === null
          ? json(200, { has_more: true, last_seen_id: 42, data: [{ id: 1 }] })
          : json(200, { has_more: false, data: [{ id: 43 }] });
      },
    });

    const users = await client.fetchUsers();
    assert.equal(users.length, 2);
    assert.deepEqual(seen, [null, '42']);
  });
});

describe('tataTeleAuthFromEnv', () => {
  it('prefers a static token, falls back to login, and null when nothing is set', () => {
    assert.deepEqual(
      tataTeleAuthFromEnv({ TATA_TELE_API_TOKEN: 't' } as NodeJS.ProcessEnv),
      { kind: 'token', token: 't' },
    );
    assert.deepEqual(
      tataTeleAuthFromEnv({
        TATA_TELE_LOGIN_EMAIL: 'e@x', TATA_TELE_LOGIN_PASSWORD: 'p',
      } as NodeJS.ProcessEnv),
      { kind: 'login', email: 'e@x', password: 'p' },
    );
    assert.equal(tataTeleAuthFromEnv({} as NodeJS.ProcessEnv), null);
    assert.equal(
      tataTeleAuthFromEnv({ TATA_TELE_LOGIN_EMAIL: 'e@x' } as NodeJS.ProcessEnv),
      null,
      'half a login is no login',
    );
  });
});
