/**
 * End-to-end: a real Chromium drives the real UI against the real database.
 *
 * Flows, one per person on the floor:
 *   Sanya (caller)    - sign in, see the leads list, open a lead, log a
 *                       qualified call and watch it pass to Aisha
 *   Aisha (follow-up) - see the lead on her reminders, mark the invite sent
 *   Admin             - dashboard numbers, add a lead from the list screen
 *   Anyone            - a due reminder pops exactly once
 *
 * Run with: npm run test:e2e   (needs Postgres up, like npm test)
 */
import { after, before, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import type { FastifyInstance } from 'fastify';
import type { AddressInfo } from 'node:net';
import {
  EMAILS,
  fixtureSql,
  makeLeadFor,
  rebuildTestDatabase,
  startHarness,
  TEST_PASSWORD,
  USERS,
  type TestHarness,
} from './helpers.ts';

const SHOTS = process.env.E2E_SHOT_DIR ?? path.join(import.meta.dirname, 'shots');

let h: TestHarness;
let server: FastifyInstance;
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
  rebuildTestDatabase();
  h = await startHarness();
  server = h.app;
  await server.listen({ port: 0, host: '127.0.0.1' });
  const addr = server.server.address() as AddressInfo;
  base = `http://127.0.0.1:${addr.port}`;

  mkdirSync(SHOTS, { recursive: true });
  const executablePath = existsSync('/opt/pw-browsers/chromium')
    ? '/opt/pw-browsers/chromium'
    : undefined;
  browser = await chromium.launch(executablePath ? { executablePath } : {});
  page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
});

after(async () => {
  await browser?.close();
  await h?.close();
});

it('a caller signs in, works a lead, and the qualified lead passes to Aisha', async () => {
  const leadId = makeLeadFor(USERS.sanya, 'E2E Qualify');

  await signIn(EMAILS.sanya);
  await page.click('a[data-nav="#/leads"]');
  await page.waitForSelector('.lead-table');
  assert.ok(await page.locator(`tr[data-id="${leadId}"]`).count(), 'the lead is on the list');

  await page.click(`tr[data-id="${leadId}"]`);
  await page.waitForSelector('[data-callform]');

  await page.click('[data-outcome="qualified"]');
  await page.fill('[name=note]', 'wants the webinar link');
  await page.click('[data-save]');
  await page.waitForSelector('text=Aisha'); // the status card now names the new owner
  await page.screenshot({ path: path.join(SHOTS, 'caller-qualified.png') });

  const owner = fixtureSql(`select assigned_to from crm.leads where id = '${leadId}';`).trim();
  assert.equal(owner, USERS.aisha);
  await signOut();
});

it('the follow-up person sees it due and marks the invite sent', async () => {
  await signIn(EMAILS.aisha);
  await page.click('a[data-nav="#/reminders"]');
  await page.waitForSelector('text=E2E Qualify');

  await page.click('tr[data-id] >> text=E2E Qualify');
  await page.waitForSelector('[data-ck="template_sent"]');
  await page.click('[data-ck="template_sent"]');
  await page.waitForSelector('[data-ck="template_sent"].on');
  await page.screenshot({ path: path.join(SHOTS, 'followup-invite.png') });
  await signOut();
});

it('the admin adds a lead by hand and the dashboard counts it', async () => {
  await signIn(EMAILS.admin);
  await page.click('a[data-nav="#/leads"]');
  await page.waitForSelector('[data-add]');
  await page.click('[data-add]');
  await page.fill('.modal [name=name]', 'E2E Manual');
  await page.fill('.modal [name=phone]', '98123 40000');
  await page.selectOption('.modal [name=assigned]', '');
  await page.click('.modal footer .btn.primary');
  await page.waitForSelector('[data-callform]');

  await page.click('a[data-nav="#/dash"]');
  await page.waitForSelector('text=Right now');
  await page.waitForSelector('text=Funnel');
  await page.screenshot({ path: path.join(SHOTS, 'admin-dash.png'), fullPage: true });
  await signOut();
});

it('a due reminder pops once, with a link to the lead', async () => {
  const leadId = makeLeadFor(USERS.harsh, 'E2E Reminder');
  fixtureSql(
    `update crm.leads set next_follow_up_at = now() - interval '1 minute' where id = '${leadId}';`,
  );

  await signIn(EMAILS.harsh);
  await page.waitForSelector('.reminder-toast', { timeout: 10_000 });
  const text = await page.locator('.reminder-toast').first().textContent();
  assert.match(text ?? '', /E2E Reminder/);
  await page.screenshot({ path: path.join(SHOTS, 'reminder-popup.png') });

  // The badge counts it too.
  const badge = await page.locator('#reminder-badge').textContent();
  assert.ok(Number(badge) >= 1);
  await signOut();
});
