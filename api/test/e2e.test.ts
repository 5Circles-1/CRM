/**
 * End-to-end: a real Chromium drives the real UI against the real database.
 *
 * Flows covered, one per persona:
 *   caller     - log in, see My Day, open a lead, log a call with a callback
 *   counsellor - see the floor, transfer a Not Answered lead from the queue
 *   admin      - see the breakeven thermometer with the grossed-up numbers
 *   admin      - transfer Not Answered leads from the floor, across teams
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

/**
 * The inbound-call door, from where the person answering the phone is sitting.
 *
 * The machinery has existed since 0055 and a button since the Fresh-leads
 * rework - but only on Fresh leads and Find lead, and a caller lands on My
 * Pipeline and never leaves it, so the floor kept reporting that inbound
 * calling "is still not showing". This test is that report: sign in, do not
 * navigate anywhere, and log an inbound call from the landing screen.
 */
it('caller: logs an inbound call from the pipeline they land on, without navigating', async () => {
  await signIn(EMAILS.callerA1);
  await page.waitForSelector('[data-testid=day-chips]');

  const inbound = page.locator('[data-testid=day-inbound]');
  assert.equal(await inbound.count(), 1,
    'the inbound-call button must be on the screen a caller actually lands on');
  await inbound.click();

  await page.waitForSelector('.modal [data-testid=lead-kind]');
  // A caller has exactly one lead-creation door, and it opens on inbound.
  const heading = await page.locator('.modal header h3').textContent();
  assert.ok(/inbound/i.test(heading ?? ''), `modal opened as "${heading}"`);
  assert.ok(await page.locator('.modal [name=followup]').isVisible(),
    'the promised follow-up date is asked for, because it is what makes it ring');

  const phone = `98${Date.now().toString().slice(-8)}`;
  await page.fill('.modal [name=name]', 'Inbound E2E Client');
  await page.fill('.modal [name=phone]', phone);
  await page.screenshot({ path: path.join(SHOTS, '10-caller-inbound-call.png') });
  await page.click('.modal footer button');

  // It lands on the new lead, owned by the caller who answered.
  await page.waitForFunction(`location.hash.startsWith('#/lead/')`);
  await page.waitForSelector('[data-testid=log-call-btn]');
  const body = await page.locator('#outlet').textContent();
  assert.ok(body?.includes('Inbound E2E Client'), 'the logged inbound call opens as a real lead');

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

/**
 * The bug this covers: an ADMIN belongs to no team, and the "Give to" picker
 * used to be scoped to the ACTING user's team. crm.current_user_team() came
 * back NULL, the dropdown rendered with no options at all, and every Transfer
 * button on Floor could only answer "No caller available to receive it" while
 * the floor was full of callers. The dropdown having options is therefore the
 * assertion, not an incidental step on the way to the click.
 */
it('admin: transfers Not Answered leads from the floor, across teams and in bulk', async () => {
  // Team B leads, so the admin is also reaching across a team boundary - the
  // second thing the old scoping made impossible.
  const leadIds = fixtureSql(`
    with picked as (
      select id from crm.leads
       where caller_id = '${USERS.callerB1}' and status in ('new','working','callback')
       order by created_at limit 2
    ), dialled as (
      insert into crm.call_attempts (lead_id, user_id, disposition, duration_seconds, is_verified)
      select p.id, '${USERS.callerB1}', 'not_answered', 0, true
        from picked p, generate_series(1, 4)
      returning lead_id
    )
    select distinct lead_id from dialled;
  `).trim().split('\n').map((s) => s.trim()).filter(Boolean);
  assert.equal(leadIds.length, 2, 'fixture: two Team B leads should now carry an NA streak');

  await signIn(EMAILS.admin);
  await page.waitForSelector('[data-testid=transfer-queue]');

  const options = await page.locator('[data-testid=transfer-queue] tbody tr .t-target option').count();
  assert.ok(options > 0, 'an admin, who is on no team, must still be offered callers to hand a lead to');
  await page.screenshot({ path: path.join(SHOTS, '12-admin-transfer-queue.png'), fullPage: true });

  // Hand the whole list over in one action, the way a floor manager clearing a
  // not-answered pile actually works.
  await page.locator('[data-testid=transfer-bulk-target]').selectOption(USERS.callerA2);
  page.once('dialog', (d) => d.accept());
  await page.locator('[data-testid=transfer-bulk-go]').click();

  await page.waitForFunction(
    `document.querySelectorAll('[data-testid=transfer-queue] tbody tr[data-row]').length === 0`
    + ` || !document.querySelector('[data-testid=transfer-queue]')`,
  );

  for (const leadId of leadIds) {
    const owner = fixtureSql(`select caller_id from crm.leads where id = '${leadId}';`).trim();
    assert.equal(owner, USERS.callerA2, 'the lead moved to the chosen caller, on the other team');
    const team = fixtureSql(`select team_id from crm.leads where id = '${leadId}';`).trim();
    assert.equal(
      team,
      fixtureSql(`select crm.team_of('${USERS.callerA2}', current_date);`).trim(),
      'and it follows them onto their team',
    );
  }

  const byAdmin = fixtureSql(`
    select count(*) from crm.lead_transfers where transferred_by = '${USERS.admin}';
  `).trim();
  assert.equal(byAdmin, '2', 'both transfers are recorded with the admin as the actor');

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

it('admin: the Overview tab shows totals, every member, and the bulk response for a chosen window', async () => {
  await signIn(EMAILS.admin);
  await page.click('a[data-nav="#/overview"]');

  await page.waitForSelector('[data-testid=overview-tiles]');
  const tiles = await page.locator('[data-testid=overview-tiles]').textContent();
  assert.ok(tiles?.includes('Leads in the CRM'), 'the all-time lead count tile renders');
  assert.ok(tiles?.includes('Not answered'), 'the bulk-response tile renders');

  // One row per person who can hold a lead: 4 callers + 2 counsellors seeded.
  await page.waitForSelector('[data-testid=overview-members]');
  const rows = await page.locator('[data-testid=overview-members] tbody tr').count();
  assert.ok(rows >= 6, `expected a row for each of the six seeded members, found ${rows}`);
  const members = await page.locator('[data-testid=overview-members]').textContent();
  assert.ok(members?.includes('Caller A1'), 'the seeded caller appears by name');

  // A custom window applies without a reload: pick Today via the preset chip.
  await page.click('#ov-presets .chip:has-text("Today")');
  await page.waitForSelector('[data-testid=overview-tiles]');

  await page.screenshot({ path: path.join(SHOTS, '11-admin-overview.png'), fullPage: true });
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

it('caller: the Re-tap tab explains itself before it lists anything', async () => {
  await signIn(EMAILS.callerA1);
  await page.goto(`${base}/ui/#/retap`);
  await page.waitForSelector('[data-testid=retap-explainer]');

  // The three questions somebody opening an unfamiliar tab actually has.
  const text = await page.locator('[data-testid=retap-explainer]').innerText();
  assert.match(text, /What it is/i);
  assert.match(text, /Who shows up here/i);
  assert.match(text, /What to do/i);
  // And the one thing that is most often misread: the green leads that are
  // deliberately NOT here.
  assert.match(text, /green light/i);

  await page.screenshot({ path: path.join(SHOTS, '13-retap-explainer.png'), fullPage: true });
  await signOut();
});

/**
 * The whole office-visit loop in one browser: a caller sends a client to a
 * counsellor, the counsellor marks them in, and the counselling response is
 * recorded — then the ratio picks all of it up.
 *
 * This runs the real screens because the ratio is only trustworthy if the
 * three acts behind it are things a person can actually do.
 */
it('office visits: a caller books one, a counsellor takes it and answers for it', async () => {
  await signIn(EMAILS.callerA1);

  // The caller sends one of their own leads in to a counsellor.
  await page.goto(`${base}/ui/#/day`);
  await page.waitForSelector('.leadcard');
  await page.locator('.leadcard').first().click();
  await page.waitForSelector('[data-testid=book-visit-btn]');
  await page.click('[data-testid=book-visit-btn]');
  await page.waitForSelector('[data-testid=visit-save]');
  await page.click('[data-testid=visit-save]');
  await page.waitForSelector('[data-testid=visit-save]', { state: 'detached' });

  // It is on the Expected list, for everyone, straight away.
  await page.goto(`${base}/ui/#/walkins`);
  await page.waitForSelector('[data-testid=walkin-expected] table');
  const expected = await page.locator('[data-testid=walkin-expected] tbody tr').count();
  assert.ok(expected >= 1, 'the booked visit should be on the Expected list');
  await page.screenshot({ path: path.join(SHOTS, '10-walkins-caller.png'), fullPage: true });
  await signOut();

  // The counsellor marks them in and records what was said.
  await signIn(EMAILS.counsellorA);
  await page.goto(`${base}/ui/#/walkins`);
  await page.waitForSelector('[data-testid=walkin-expected] table');
  await page.locator('[data-testid=walkin-expected] button', { hasText: 'They are here' })
    .first().click();
  await page.waitForSelector('[data-testid=record-response]');

  await page.click('[data-testid=record-response]');
  await page.waitForSelector('[data-testid=response-outcome]');
  await page.selectOption('[data-testid=response-outcome]', 'thinking');
  await page.click('[data-testid=response-save]');
  await page.waitForSelector('[data-testid=response-save]', { state: 'detached' });

  await page.waitForSelector('[data-testid=walkin-answered] table');
  const answered = await page.locator('[data-testid=walkin-answered] tbody tr').count();
  assert.ok(answered >= 1, 'the counselled visit should be answered for');

  // And the visit is a visit, not yet a conversion — only money makes one.
  const converted = fixtureSql(
    `select count(*) from crm.walkin_visits where outcome = 'converted';`,
  ).trim();
  assert.equal(converted, '0', 'nothing converts without a deal');
  await page.screenshot({ path: path.join(SHOTS, '11-walkins-counsellor.png'), fullPage: true });
  await signOut();
});

it('targets: an admin sets a caller\u2019s walk-in target and it shows as theirs', async () => {
  await signIn(EMAILS.admin);
  await page.goto(`${base}/ui/#/targets`);
  await page.waitForSelector('[data-testid=targets-callers] table');

  await page.locator('[data-testid=targets-callers] button', { hasText: 'Set target' })
    .first().click();
  await page.waitForSelector('[data-testid=target-walkins]');
  await page.fill('[data-testid=target-walkins]', '18');
  await page.click('[data-testid=target-save]');
  await page.waitForSelector('[data-testid=target-save]', { state: 'detached' });

  await page.waitForSelector('[data-testid=targets-callers] table');
  const stored = fixtureSql(
    `select count(*) from crm.user_targets where monthly_walkin_target = 18;`,
  ).trim();
  assert.equal(stored, '1', 'the target is one person\u2019s number, stored against them');
  await page.screenshot({ path: path.join(SHOTS, '12-targets.png'), fullPage: true });
  await signOut();
});

it('leaderboards: the floor shows callers and counsellors on separate boards', async () => {
  await signIn(EMAILS.admin);
  await page.goto(`${base}/ui/#/floor`);
  await page.waitForSelector('[data-testid=caller-podium], [data-testid=counsellor-podium]');
  const text = await page.locator('.content').innerText();
  assert.ok(text.includes('Callers'), 'a board of callers');
  assert.ok(text.includes('Counsellors'), 'a board of counsellors');
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
  // Clicked immediately, on purpose: this is the race that used to lose the
  // tab - Settings' fetch landing late and wiping whatever the user picked.
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
