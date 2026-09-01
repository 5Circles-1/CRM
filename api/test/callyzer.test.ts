import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  CALL_METHOD_COMBOS,
  CallyzerApiError,
  CallyzerClient,
  RateLimitQueue,
} from '../src/integrations/callyzer/client.ts';

/**
 * The Callyzer client without a database or a network: the rate-limit queue
 * against a virtual clock, and the request loop against a stubbed fetch.
 * Callyzer allows ONE request per two seconds account-wide, so the queue is
 * the load-bearing part of the client - these are the tests that keep it so.
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
    const queue = new RateLimitQueue(2000, clock);
    const starts: number[] = [];

    await Promise.all([
      queue.run(async () => starts.push(clock.now())),
      queue.run(async () => starts.push(clock.now())),
      queue.run(async () => starts.push(clock.now())),
    ]);

    assert.deepEqual(starts, [0, 2000, 4000]);
    assert.deepEqual(clock.sleeps, [2000, 2000]);
  });

  it('does not wait when calls are naturally further apart than the interval', async () => {
    const clock = virtualClock();
    const queue = new RateLimitQueue(2000, clock);

    await queue.run(async () => undefined);
    clock.sleeps.length = 0;
    // Advance time past the interval by "sleeping" outside the queue.
    await clock.sleep(5000);
    clock.sleeps.length = 0;

    await queue.run(async () => undefined);
    assert.deepEqual(clock.sleeps, [], 'no artificial delay when the budget is free');
  });

  it('a failed call does not jam the queue', async () => {
    const clock = virtualClock();
    const queue = new RateLimitQueue(2000, clock);

    const failed = queue.run(async () => {
      throw new Error('boom');
    });
    const second = queue.run(async () => 'still running');

    await assert.rejects(failed, /boom/);
    assert.equal(await second, 'still running');
  });

  it('preserves order: later calls run after earlier ones', async () => {
    const clock = virtualClock();
    const queue = new RateLimitQueue(10, clock);
    const order: number[] = [];
    await Promise.all([
      queue.run(async () => order.push(1)),
      queue.run(async () => order.push(2)),
      queue.run(async () => order.push(3)),
    ]);
    assert.deepEqual(order, [1, 2, 3]);
  });
});

describe('CallyzerClient', () => {
  it('sends the bearer token and unwraps the result envelope', async () => {
    const seen: { url: string; auth: string | undefined }[] = [];
    const client = new CallyzerClient({
      apiKey: 'test-key',
      baseUrl: 'https://api.example/api/v2.2', // no trailing slash on purpose
      minIntervalMs: 0,
      fetchImpl: async (url, init) => {
        seen.push({
          url: String(url),
          auth: (init?.headers as Record<string, string>)?.authorization,
        });
        return json(200, { result: [{ emp_number: '9000000001' }], message: 'Success' });
      },
    });

    const employees = await client.fetchEmployees();
    assert.equal(employees.length, 1);
    assert.equal(seen[0]?.auth, 'Bearer test-key');
    assert.match(seen[0]?.url ?? '', /^https:\/\/api\.example\/api\/v2\.2\/employee\/get/);
  });

  it('waits out a 429 for Retry-After seconds, then succeeds', async () => {
    const clock = virtualClock();
    let calls = 0;
    const client = new CallyzerClient({
      apiKey: 'k',
      baseUrl: 'https://api.example/',
      minIntervalMs: 0,
      sleep: clock.sleep,
      now: clock.now,
      fetchImpl: async () => {
        calls += 1;
        if (calls === 1) return json(429, { message: 'slow down' }, { 'retry-after': '3' });
        return json(200, { result: [] });
      },
    });

    await client.fetchEmployees();
    assert.equal(calls, 2);
    assert.ok(clock.sleeps.includes(3000), `waited the server's own 3s, got ${clock.sleeps}`);
  });

  it('gives up after four 429 retries with the status in the error', async () => {
    const clock = virtualClock();
    let calls = 0;
    const client = new CallyzerClient({
      apiKey: 'k',
      baseUrl: 'https://api.example/',
      minIntervalMs: 0,
      sleep: clock.sleep,
      now: clock.now,
      fetchImpl: async () => {
        calls += 1;
        return json(429, { message: 'Too many requests' });
      },
    });

    await assert.rejects(
      () => client.fetchEmployees(),
      (err: unknown) => err instanceof CallyzerApiError && err.status === 429,
    );
    assert.equal(calls, 5, 'the first try plus four retries');
  });

  it("surfaces Callyzer's 403 as what it really means: subscription expired", async () => {
    const client = new CallyzerClient({
      apiKey: 'k',
      baseUrl: 'https://api.example/',
      minIntervalMs: 0,
      fetchImpl: async () => json(403, { result: null, message: 'Your subscription has expired.' }),
    });

    await assert.rejects(
      () => client.fetchEmployees(),
      (err: unknown) =>
        err instanceof CallyzerApiError &&
        err.subscriptionExpired &&
        /subscription has expired/i.test(err.message),
    );
  });

  it('pages every method/mode combination over the synced window', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const page1 = Array.from({ length: 100 }, (_, i) => ({ id: `r${i}` }));
    const client = new CallyzerClient({
      apiKey: 'k',
      baseUrl: 'https://api.example/api/v2.2/',
      minIntervalMs: 0,
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        bodies.push(body);
        if (body.call_method === 'PhoneCall' && body.page_no === 1) return json(200, { result: page1 });
        if (body.call_method === 'PhoneCall' && body.page_no === 2)
          return json(200, { result: [{ id: 'r100' }, { id: 'r101' }] });
        return json(200, { result: [] });
      },
    });

    const pages: number[] = [];
    const { pages: pageCount, rows } = await client.fetchCallLogs(
      { syncedFrom: 1000, syncedTo: 2000 },
      async (batch) => {
        pages.push(batch.length);
      },
    );

    assert.equal(rows, 102);
    assert.equal(pageCount, 2, 'only non-empty pages are delivered');
    assert.deepEqual(pages, [100, 2]);
    // A full PhoneCall page triggers page 2; the WhatsApp combos stop at one
    // empty page each: 2 + 1 + 1 requests.
    assert.equal(bodies.length, CALL_METHOD_COMBOS.length + 1);
    for (const body of bodies) {
      assert.equal(body.synced_from, 1000);
      assert.equal(body.synced_to, 2000);
      assert.ok(typeof body.call_method === 'string' && typeof body.call_mode === 'string',
        'v2.2 requires call_method and call_mode on every request');
    }
  });
});
