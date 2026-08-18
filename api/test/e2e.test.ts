/**
 * End-to-end: a real Chromium drives the real UI against the real database.
 *
 * Flows covered, one per persona:
 *   caller     - log in, see My Day, open a lead, log a call with a callback
 *   counsellor - see the floor, transfer a Not Answered lead from the queue
 *   admin      - see the breakeven thermometer with the grossed-up numbers
 *
 * Run with: npm run test:e2e   (needs Postgres up, like npm test)
 */
import { after, before, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import type { FastifyInstance } from 'fastify';
import type { AddressInfo } from 'node:net';
import {
  apiUrl,
  auth,
  EMAILS,
  fixtureSql,
  login,
  rebuildTestDatabase,
  seedPasswords,
  TEST_PASSWORD,
  USERS,
} from './helpers.ts';
import { Database } from '../src/db/pool.ts';
import { buildServer } from '../src/server.ts';

const SHOTS = process.env.E2E_SHOT_DIR ?? path.join(import.meta.dirname, 'shots');

let db: Database;
let app: FastifyInstance;
let browser: Browser;
let page: Page;
let base: string;

async function signIn(email: string): Promise<void> {
  await page.goto(`${base}/ui/`);
  await page.waitForSelector('[data-testid=login-email]');
  await page.fill('[data-testid=login-email]', email);
  await page.fill('[data-testid=login-password]', TEST_PASSWORD);
  await page.click('[data-testid=login-submit]');
  await page.waitForSelector('.sidebar');
}

async function signOut(): Promise<void> {
  await page.click('#logout-btn');
  await page.waitForSelector('[data-testid=login-email]');
}

before(async () => {
  mkdirSync(SHOTS, { recursive: true });
  rebuildTestDatabase();

  db = new Database(apiUrl());
  await seedPasswords(db);

  app = await buildServer(
    {
      port: 0,
      host: '127.0.0.1',
      databaseUrl: apiUrl(),
      cookieName: 'crm_session',
      secureCookies: false, // plain http in the test
      logLevel: 'silent',
    },
    db,
  );
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;

  // Everyone on the floor, then a sheet of leads through the real pipeline.
  fixtureSql(`
    insert into crm.attendance_sessions (user_id, started_at)
    select id, now() - interval '2 hours' from crm.users where role in ('caller', 'counsellor');
  `);
  // The first-login guided tour overlays the whole screen and would swallow
  // every click in these flows. Everyone here has "already taken" it.
  fixtureSql(`update crm.users set tour_completed_at = now();`);
  const ops = await login(app, EMAILS.ops);
  const csv = [
    'Full Name,Phone Number,City,campaign_name',
    'Asha Rao,9811200001,Pune,Aug-Equity',
    'Vikram Shah,9811200002,Mumbai,Aug-Equity',
    'Neha Gupta,9811200003,Delhi,Aug-Equity',
    'Rohit Iyer,9811200004,Bengaluru,Aug-Equity',
    'Meena Pillai,9811200005,Kochi,Aug-Equity',
    'Arjun Nair,9811200006,Chennai,Aug-Equity',
  ].join('\n');
  const res = await app.inject({
    method: 'POST',
    url: '/ingest/sources/33333333-0000-0000-0000-000000000001/csv',
    headers: auth(ops),
    payload: { csv },
  });
  assert.equal(res.json().created, 6, 'fixture: sheet import should create 6 leads');

  // One lead of caller A1 with a Not Answered streak, for the transfer queue.
  fixtureSql(`
    insert into crm.call_attempts (lead_id, user_id, disposition, duration_seconds, is_verified)
    select l.id, l.caller_id, 'not_answered', 0, true
      from (select id, caller_id from crm.leads
             where caller_id = '${USERS.callerA1}' order by created_at limit 1) l,
           generate_series(1, 4);
  `);

  try {
    browser = await chromium.launch();
  } catch {
    // The environment pre-installs Chromium outside playwright's registry.
    browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  }
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
});

after(async () => {
  await browser?.close();
  await app?.close();
  await db?.close();
});

it('caller: sees the day queue and logs a call with a callback', async () => {
  await signIn(EMAILS.callerA1);

  await page.waitForSelector('[data-testid=day-chips]');
  const cards = await page.locator('.leadcard').count();
  assert.ok(cards >= 1, 'caller A1 should have leads in the day queue');
  await page.screenshot({ path: path.join(SHOTS, '1-caller-my-day.png'), fullPage: true });

  await page.locator('.leadcard').first().click();
  await page.waitForSelector('[data-testid=log-call-btn]');
  await page.click('[data-testid=log-call-btn]');
  await page.waitForSelector('[data-testid=disposition]');

  await page.selectOption('[data-testid=disposition]', 'callback_requested');
  await page.fill('[data-testid=duration]', '95');
  await page.screenshot({ path: path.join(SHOTS, '2-caller-log-call.png') });
  await page.click('[data-testid=save-call]');

  // String-bodied so it typechecks under the node lib (it runs in the page).
  await page.waitForFunction(
    `(document.querySelector('[data-testid=lead-status]')?.textContent || '').includes('callback')`,
  );
  const next = await page.locator('[data-testid=next-action]').textContent();
  assert.ok(next && next.trim() !== '—', 'the callback became the lead next action');

  await signOut();
});

it('counsellor: sees the floor and transfers a Not Answered lead', async () => {
  await signIn(EMAILS.counsellorA);

  await page.waitForSelector('[data-testid=floor-live]');
  await page.waitForSelector('[data-testid=transfer-queue]');
  await page.screenshot({ path: path.join(SHOTS, '3-counsellor-floor.png'), fullPage: true });

  const before = await page.locator('[data-testid=transfer-queue] tbody tr').count();
  assert.ok(before >= 1, 'the NA-streak lead should be in the transfer queue');

  await page.locator('[data-testid=transfer-go]').first().click();
  await page.waitForFunction(
    `document.querySelectorAll('[data-testid=transfer-queue] tbody tr').length < ${before}`,
  );

  const moved = fixtureSql(`
    select count(*) from crm.lead_transfers where transferred_by = '${USERS.counsellorA}';
  `).trim();
  assert.equal(moved, '1', 'the transfer must be recorded with the counsellor as the actor');

  await signOut();
});

it('admin: the breakeven thermometer shows the grossed-up numbers', async () => {
  await signIn(EMAILS.admin);
  await page.click('a[data-nav="#/dash"]');

  await page.waitForSelector('[data-testid=thermometer]');
  const floorText = await page.locator('[data-testid=daily-floor]').textContent();
  assert.ok(floorText?.includes('28,000'), `daily collection floor should read ₹28,000, got: ${floorText}`);

  const body = await page.locator('[data-testid=thermometer]').textContent();
  assert.ok(body?.includes('8,23,529'), 'required booking must gross up to ₹8,23,529 (en-IN grouping)');

  await page.screenshot({ path: path.join(SHOTS, '4-admin-dashboards.png'), fullPage: true });
  await signOut();
});

it('admin: the performance charts render with real marks and a table beneath', async () => {
  await signIn(EMAILS.admin);
  await page.goto(`${base}/ui/#/people`);

  // A chart that throws leaves an empty panel, which looks like "no data" -
  // so assert on the marks, not on the container.
  await page.waitForSelector('.viz-svg', { timeout: 20000 });
  const lines = await page.locator('.viz-svg path[stroke-width="2"]').count();
  assert.ok(lines >= 2, `expected a line per series, found ${lines}`);

  const slices = await page.locator('.viz-donut-svg path').count();
  assert.ok(slices >= 2, `expected donut segments, found ${slices}`);

  // The relief rule: three of the categorical colours sit below 3:1 on white,
  // so the numbers must be readable without telling the colours apart.
  const legend = await page.locator('.viz-donut .viz-legend').first().innerText();
  assert.match(legend, /%/, 'every slice must carry its value, not just a colour');
  await page.waitForSelector('table.table');

  // Axis labels must fit the gutter. "00000" is what a clipped rupee label
  // looks like, and it reads as a rendering fault rather than a number.
  // innerText is empty on SVG <text>; textContent is what actually renders.
  const yLabels = await page.locator('.viz-svg text').evaluateAll(
    (nodes) => nodes.map((n) => (n.textContent ?? '').trim()),
  );
  assert.ok(yLabels.length > 0, 'the axis must be labelled at all');
  assert.ok(!yLabels.some((t) => /^0{3,}$/.test(t)), `clipped axis label: ${yLabels.join('|')}`);

  await page.screenshot({ path: path.join(SHOTS, '5-performance-charts.png'), fullPage: true });
  await signOut();
});

it('caller: sees only their own numbers on the performance page', async () => {
  await signIn(EMAILS.callerA1);
  await page.goto(`${base}/ui/#/people`);
  await page.waitForSelector('table.table', { timeout: 20000 });

  const names = await page.locator('table.table tbody tr td:first-child').allInnerTexts();
  for (const n of names) {
    assert.equal(n.trim(), 'Caller A1', `a caller must not see ${n} on their own dashboard`);
  }
  await signOut();
});

it('caller: the re-tap filters narrow the lead list', async () => {
  await signIn(EMAILS.callerA1);
  await page.goto(`${base}/ui/#/leads`);
  await page.waitForSelector('#presets', { timeout: 20000 });

  await page.click('button[data-preset="Did not answer"]');
  await page.waitForTimeout(700);

  // Either rows that all show that outcome, or an honest empty state - never
  // the whole lead book, which is what "the filter does nothing" looks like.
  const empty = await page.locator('#results .empty').count();
  if (empty === 0) {
    const outcomes = await page.locator('#results tbody tr td:nth-child(4)').allInnerTexts();
    for (const o of outcomes) {
      assert.match(o.trim(), /not answered/i, `filter leaked a "${o}" row`);
    }
  }
  await signOut();
});

it('caller: a lead page shows its own pipeline, and Back restores the list as it was', async () => {
  await signIn(EMAILS.callerA1);
  await page.goto(`${base}/ui/#/leads`);
  await page.waitForSelector('#presets', { timeout: 20000 });

  // Work from a real search, the way the floor uses Find lead. Phone search
  // matches the tail of the number, so ask the database for one A1 owns.
  const tail = fixtureSql(`
    select right(phone_e164, 6) from crm.leads
     where caller_id = '${USERS.callerA1}'
       and status not in ('won', 'lost', 'invalid')
     order by created_at limit 1;`).trim();
  await page.fill('[data-testid=lead-search]', tail);
  await page.waitForSelector('#results a[href^="#/lead/"]', { timeout: 20000 });

  await page.locator('#results a[href^="#/lead/"]').first().click();

  // Every lead carries its own pipeline - the journey strip - from day one;
  // the first call fills it in.
  await page.waitForSelector('[data-testid=lead-journey]', { timeout: 20000 });
  const journey = await page.locator('[data-testid=lead-journey]').innerText();
  assert.match(journey, /1st call/i, 'the journey names its stages');
  assert.match(journey, /Lead in/i, 'and starts where the lead started');
  await page.screenshot({ path: path.join(SHOTS, '8-lead-journey.png'), fullPage: true });

  // Back returns to the SAME list - search and results intact - never to the
  // main page. This was the floor's complaint about Find lead.
  await page.click('[data-testid=back-btn]');
  await page.waitForSelector('#presets', { timeout: 20000 });
  assert.equal(await page.inputValue('[data-testid=lead-search]'), tail,
    'the search text must survive the round trip');
  await page.waitForSelector('#results a[href^="#/lead/"]', { timeout: 20000 });

  await signOut();
});

it('caller: reads a training module, answers the check, and acknowledges it', async () => {
  await signIn(EMAILS.callerA1);
  // A first-login tour may be showing; it must never block the app.
  await page.evaluate(() => (document.querySelector('#tour-skip') as HTMLElement | null)?.click());

  await page.goto(`${base}/ui/#/training`);
  await page.waitForSelector('.tmod', { timeout: 20000 });

  const cards = await page.locator('.tmod').count();
  assert.ok(cards >= 10, `expected the full academy, saw ${cards} modules`);

  // The distribution module is the one that must quote live configuration.
  await page.goto(`${base}/ui/#/training/how-leads-are-distributed`);
  await page.waitForSelector('.md', { timeout: 20000 });

  const body = await page.locator('.md').innerText();
  assert.ok(!body.includes('{{setting:'), 'an un-substituted placeholder reached the page');
  assert.match(body, /66\.7%/, 'the live ACE share should be rendered into the text');

  // Answering the check marks itself, right or wrong.
  await page.click('.qq[data-q="0"] .chip[data-o="1"]');
  await page.waitForTimeout(150);
  const why = await page.locator('.qq[data-q="0"] .qwhy').innerText();
  assert.match(why, /correct/i, `expected the correct answer to be marked: "${why}"`);

  // Acknowledgement is gated on the checkbox.
  assert.ok(await page.locator('#t-ack').isDisabled(), 'acknowledge must start disabled');
  await page.check('#t-understood');
  assert.ok(!(await page.locator('#t-ack').isDisabled()), 'ticking should enable it');
  await page.click('#t-ack');

  await page.waitForSelector('.tmod', { timeout: 20000 });
  const read = await page
    .locator('.tmod:has-text("How leads are distributed") .badge')
    .allInnerTexts();
  assert.ok(read.some((t) => /read/i.test(t)), `expected a read badge, saw ${read.join('|')}`);

  await page.screenshot({ path: path.join(SHOTS, '7-training.png'), fullPage: true });
  await signOut();
});

it('admin: the Data tab parks old leads behind a two-step button', async () => {
  // A lead old enough to archive, created here so no earlier flow depends on
  // it. This test runs last on purpose: parking is the end of the story.
  fixtureSql(`
    insert into crm.leads (source_id, full_name, phone_e164, caller_id, team_id,
                           status, next_action_at, created_at)
    values ('33333333-0000-0000-0000-000000000001', 'E2E Ancient', '+919811299001',
            '${USERS.callerA1}', crm.team_of('${USERS.callerA1}', current_date),
            'working', now(), '2026-08-01 10:00:00+05:30');
  `);

  await signIn(EMAILS.admin);
  await page.goto(`${base}/ui/#/admin`);
  await page.click('button[data-tab="data"]');

  await page.waitForSelector('[data-testid=archive-check]');
  await page.fill('[name=cutoff]', '2026-08-15');
  await page.click('[data-testid=archive-check]');

  // Step one: an honest count, nothing moved yet.
  await page.waitForSelector('[data-testid=archive-go]');
  const still = fixtureSql(
    `select pool is null from crm.leads where full_name = 'E2E Ancient';`,
  ).trim();
  assert.equal(still, 't', 'the check step must move nothing');
  await page.screenshot({ path: path.join(SHOTS, '9-admin-archive.png'), fullPage: true });

  // Step two: the real thing.
  await page.click('[data-testid=archive-go]');
  await page.waitForFunction(
    `document.querySelector('#arch-result')?.textContent?.includes('parked in Previous months')`,
  );
  const parked = fixtureSql(
    `select status || ' ' || coalesce(pool, '-') from crm.leads
      where full_name = 'E2E Ancient';`,
  ).trim();
  assert.equal(parked, 'nurture previous_month', 'the old lead is parked, not deleted');

  await signOut();
});
