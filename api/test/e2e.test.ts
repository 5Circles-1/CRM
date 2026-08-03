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
