import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  auth,
  EMAILS,
  fixtureSql,
  login,
  makeLeadFor,
  rebuildTestDatabase,
  SOURCES,
  startHarness,
  superuserUrl,
  TEST_PASSWORD,
  USERS,
  type TestHarness,
} from './helpers.ts';
import {
  describeRangeFailure,
  errorMessage,
  isRangeFailure,
  normaliseSpreadsheetId,
  resolveWorksheet,
  sheetRange,
} from '../src/ingest/source.ts';
import { DISPOSITIONS } from '../src/routes/leads.ts';
import { Database } from '../src/db/pool.ts';
import { buildServer } from '../src/server.ts';
import { hashPassword } from '../src/auth/credentials.ts';
import http from 'node:http';
import { TataTeleWorker } from '../src/integrations/tata_tele/worker.ts';
import { TataTeleApiError, TataTeleClient } from '../src/integrations/tata_tele/client.ts';

let h: TestHarness;

before(async () => {
  rebuildTestDatabase();
  h = await startHarness();
  // Put every caller AND counsellor on the floor: distribution needs somewhere
  // to send leads, and since absence cover the escalation ladder hands up only
  // to a counsellor who is actually on shift.
  fixtureSql(`
    insert into crm.attendance_sessions (user_id, started_at)
    select id, now() - interval '1 hour' from crm.users
     where role in ('caller', 'counsellor');
  `);
});

after(async () => {
  await h?.close();
});

describe('boot-time RLS guard', () => {
  it('refuses to start on a role that bypasses row-level security', async () => {
    // This is the failure the guard exists to prevent: everything works, and
    // every user silently sees every lead.
    const db = new Database(superuserUrl());
    try {
      await assert.rejects(
        () =>
          buildServer(
            {
              port: 0,
              host: '127.0.0.1',
              databaseUrl: superuserUrl(),
              cookieName: 'crm_session',
              secureCookies: false,
              logLevel: 'silent',
            },
            db,
          ),
        /bypasses row-level security/,
      );
    } finally {
      await db.close();
    }
  });
});

describe('authentication', () => {
  it('rejects a wrong password without revealing whether the account exists', async () => {
    const bad = await h.app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: EMAILS.callerA1, password: 'wrong-password' },
    });
    const missing = await h.app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'nobody@5circles.test', password: 'wrong-password' },
    });

    assert.equal(bad.statusCode, 401);
    assert.equal(missing.statusCode, 401);
    assert.deepEqual(bad.json(), missing.json());
  });

  it('rejects requests with no session', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/me' });
    assert.equal(res.statusCode, 401);
  });

  it('logs in and identifies the user', async () => {
    const token = await login(h.app, EMAILS.callerA1);
    const res = await h.app.inject({ method: 'GET', url: '/me', headers: auth(token) });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().role, 'caller');
    assert.equal(res.json().full_name, 'Caller A1');
  });

  it('revokes the session on logout', async () => {
    const token = await login(h.app, EMAILS.callerA2);
    await h.app.inject({ method: 'POST', url: '/auth/logout', headers: auth(token) });
    const res = await h.app.inject({ method: 'GET', url: '/me', headers: auth(token) });
    assert.equal(res.statusCode, 401);
  });

  it('locks an account after repeated failures', async () => {
    fixtureSql(`
      insert into crm.users (id, full_name, email, role)
      values ('22222222-0000-0000-0000-0000000000f1', 'Lockout Test', 'lockout@5circles.test', 'caller')
      on conflict do nothing;
    `);
    await h.db.withoutUser((q) =>
      q.query(`select crm.set_password('22222222-0000-0000-0000-0000000000f1', 'not-a-real-hash', false)`),
    );

    let last = 0;
    for (let i = 0; i < 6; i += 1) {
      const res = await h.app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: 'lockout@5circles.test', password: `attempt-${i}` },
      });
      last = res.statusCode;
    }
    assert.equal(last, 423, 'the sixth attempt should report the account is locked');
  });

  it('kills live sessions the moment a user is deactivated', async () => {
    fixtureSql(`
      insert into crm.users (id, full_name, email, role)
      values ('22222222-0000-0000-0000-0000000000f2', 'Leaver', 'leaver@5circles.test', 'caller')
      on conflict do nothing;
    `);
    const hash = await hashPassword(TEST_PASSWORD);
    await h.db.withoutUser((q) =>
      q.query(`select crm.set_password('22222222-0000-0000-0000-0000000000f2', $1, false)`, [hash]),
    );

    const token = await login(h.app, 'leaver@5circles.test');
    assert.equal((await h.app.inject({ url: '/me', headers: auth(token) })).statusCode, 200);

    const admin = await login(h.app, EMAILS.admin);
    await h.app.inject({
      method: 'POST',
      url: '/admin/users/22222222-0000-0000-0000-0000000000f2/deactivate',
      headers: auth(admin),
    });

    const after = await h.app.inject({ url: '/me', headers: auth(token) });
    assert.equal(after.statusCode, 401, 'a deactivated user must be logged out immediately');
  });
});

describe('ingestion', () => {
  const CSV = [
    'Full Name,Phone Number,Email,City,campaign_name',
    'Asha Rao,+91 98111 00001,asha@example.com,Pune,Aug-Equity',
    'Vikram Shah,09811100002,vikram@example.com,Mumbai,Aug-Equity',
    'Neha Gupta,9811100003,,Delhi,Aug-Equity',
    'Broken Row,12,bad@example.com,Nowhere,Aug-Equity',
  ].join('\n');

  it('imports a sheet, quarantines undialable rows, and distributes the rest', async () => {
    const ops = await login(h.app, EMAILS.ops);
    const res = await h.app.inject({
      method: 'POST',
      url: '/ingest/sources/33333333-0000-0000-0000-000000000001/csv',
      headers: auth(ops),
      payload: { csv: CSV },
    });

    assert.equal(res.statusCode, 200);
    const summary = res.json();
    assert.equal(summary.seen, 4);
    assert.equal(summary.created, 3);
    assert.equal(summary.quarantined, 1, 'the row with phone "12" must be quarantined, not dropped');

    const teams = fixtureSql(`
      select count(distinct team_id) from crm.leads where campaign_name = 'Aug-Equity';
    `).trim();
    assert.equal(teams, '2', 'leads must alternate across both teams');
  });

  it('is idempotent - re-running the same sheet creates nothing new', async () => {
    const ops = await login(h.app, EMAILS.ops);
    const before = fixtureSql(`select count(*) from crm.leads;`).trim();

    const res = await h.app.inject({
      method: 'POST',
      url: '/ingest/sources/33333333-0000-0000-0000-000000000001/csv',
      headers: auth(ops),
      payload: { csv: CSV },
    });

    assert.equal(res.json().created, 0);
    assert.equal(res.json().duplicate, 4);
    assert.equal(fixtureSql(`select count(*) from crm.leads;`).trim(), before);
  });

  it('treats a repeat enquiry as a buying signal, not a duplicate to discard', async () => {
    const ops = await login(h.app, EMAILS.ops);
    await h.app.inject({
      method: 'POST',
      url: '/ingest/sources/33333333-0000-0000-0000-000000000002/csv',
      headers: auth(ops),
      payload: {
        csv: 'Full Name,Phone Number\nAsha Rao,+919811100001',
      },
    });

    const row = fixtureSql(`
      select reenquiry_count || ':' || priority from crm.leads where phone_e164 = '+919811100001';
    `).trim();
    assert.equal(row, '1:immediate', 're-enquiry should bump the count and raise priority');
  });

  it('a re-enquiry joins the fresh worklist and is told to the owner, never silent', async () => {
    // "In the sheet there are two leads, in the CRM only one reflects" - the
    // dedupe working invisibly is indistinguishable from a lost lead. Owner's
    // rule: every enquiry lands on the Fresh tab (the earlier call may have
    // hit a spam-flagged number), flagged, until the person is dialled again.
    const ops = await login(h.app, EMAILS.ops);
    const res = await h.app.inject({ url: '/me/fresh?scope=all', headers: auth(ops) });
    assert.equal(res.statusCode, 200);

    const hit = res.json().reenquired.find(
      (r: { phone_e164: string }) => r.phone_e164 === '+919811100001',
    );
    assert.ok(hit, 'the re-enquired lead must be listed with the fresh leads');
    assert.equal(hit.reenquiry_count, 1);
    assert.ok(hit.reenquiry_source_name, 'the form the new enquiry came through must be named');
    assert.ok(hit.flag, 'the row carries an in-time/late flag like any fresh lead');

    const notified = fixtureSql(`
      select count(*) from crm.notifications n
        join crm.leads l on l.id = n.lead_id
       where n.kind = 're_enquiry' and l.phone_e164 = '+919811100001'
         and n.user_id = coalesce(l.caller_id, l.counsellor_id);
    `).trim();
    assert.equal(notified, '1', 'the lead owner must be told the person asked again');

    // The row clears the way a fresh lead does: by actually calling the
    // person after they asked again - and only then.
    fixtureSql(`
      insert into crm.call_attempts (lead_id, user_id, disposition, duration_seconds, is_verified)
      select id, caller_id, 'not_answered', 0, true
        from crm.leads where phone_e164 = '+919811100001';
    `);
    const after = await h.app.inject({ url: '/me/fresh?scope=all', headers: auth(ops) });
    assert.ok(
      !after.json().reenquired.some(
        (r: { phone_e164: string }) => r.phone_e164 === '+919811100001',
      ),
      'a call logged after the re-enquiry takes the row off the worklist',
    );
  });

  it('the dashboard states the exact floor-wide waiting count', async () => {
    const ops = await login(h.app, EMAILS.ops);
    const res = await h.app.inject({ url: '/dashboards/fresh-now', headers: auth(ops) });
    assert.equal(res.statusCode, 200);
    const now = res.json();
    assert.equal(
      Number(now.waiting),
      Number(now.fresh) + Number(now.reenquired),
      'the headline number must be exactly fresh plus enquired-again',
    );
    assert.ok(Array.isArray(now.teams), 'the per-team split rides along');
  });

  it('the lead page names who is reaching out', async () => {
    const leadId = makeLeadFor(USERS.callerA1, 'Owner Visible');
    const caller = await login(h.app, EMAILS.callerA1);
    const res = await h.app.inject({ url: `/leads/${leadId}`, headers: auth(caller) });
    assert.equal(res.statusCode, 200);
    const { lead } = res.json();
    assert.ok(lead.caller_name, 'the owner name must ride on the lead payload');
    assert.ok(lead.team_name, 'and the team, so the funnel says whose lead this is');
    fixtureSql(`update crm.leads set status = 'lost', closed_at = now(), next_action_at = null
                 where id = '${leadId}';`);
  });

  it('keeps the quarantined row available for ops to fix', async () => {
    const ops = await login(h.app, EMAILS.ops);
    const res = await h.app.inject({ url: '/admin/quarantine', headers: auth(ops) });
    assert.equal(res.statusCode, 200);
    const rows = res.json();
    assert.ok(rows.length >= 1);
    assert.match(rows[0].reject_reason, /not dialable/);
  });

  it('a parked lead far older than the dedupe window still absorbs a re-enquiry', async () => {
    // This was the duplication bug the floor caught: the window was measured
    // against created_at alone, so a person parked in re-tap for four months
    // came back as a brand-new lead - and distribution handed the copy to the
    // other team.
    fixtureSql(`
      insert into crm.leads (source_id, phone_e164, full_name, status, next_action_at,
                             created_at, pool, retap_since, team_id)
      values ('33333333-0000-0000-0000-000000000001', '+919811100077', 'Old Parked',
              'working', now(), now() - interval '200 days', 'retap',
              now() - interval '120 days', '11111111-0000-0000-0000-000000000001');
    `);

    const ops = await login(h.app, EMAILS.ops);
    const res = await h.app.inject({
      method: 'POST',
      url: '/ingest/sources/33333333-0000-0000-0000-000000000001/csv',
      headers: auth(ops),
      payload: { csv: 'Full Name,Phone Number\nOld Parked,9811100077' },
    });
    assert.equal(res.json().created, 0, 'no new lead may be created');
    assert.equal(res.json().duplicate, 1, 'the enquiry attaches to the old lead');

    const after = fixtureSql(`
      select count(*) || ':' || max(reenquiry_count) || ':' || coalesce(max(pool), 'live')
        from crm.leads where phone_e164 = '+919811100077';
    `).trim();
    assert.equal(after, '1:1:live', 'one lead, re-enquiry counted, pulled out of the parked pool');

    // Take the fixture out of the live views so later tests count their own.
    fixtureSql(`update crm.leads set status = 'lost', closed_at = now(), next_action_at = null
                 where phone_e164 = '+919811100077';`);
  });

  it('history uploads cannot put the same person in both teams\' pools', async () => {
    const admin = await login(h.app, EMAILS.admin);
    const csv = 'Full Name,Phone Number\nHistory Person,9811100088';

    const jan = await h.app.inject({
      method: 'POST', url: '/admin/history/import', headers: auth(admin),
      payload: { csv, teamId: '11111111-0000-0000-0000-000000000001', month: '2026-01' },
    });
    assert.equal(jan.json().created, 1);

    // The same person in February's sheet, uploaded against the OTHER team -
    // exactly how one human ended up in both teams' books.
    const feb = await h.app.inject({
      method: 'POST', url: '/admin/history/import', headers: auth(admin),
      payload: { csv, teamId: '11111111-0000-0000-0000-000000000002', month: '2026-02' },
    });
    assert.equal(feb.json().created, 0, 'the second upload must not create a copy');
    assert.equal(feb.json().duplicate, 1);

    const count = fixtureSql(
      `select count(*) from crm.leads where phone_e164 = '+919811100088';`,
    ).trim();
    assert.equal(count, '1', 'one live lead, one team, however many sheets they appear in');

    fixtureSql(`update crm.leads set status = 'invalid', closed_at = now(), next_action_at = null,
                       pool = null
                 where phone_e164 = '+919811100088';`);
  });
});

describe('row-level security through the API', () => {
  it('does not let a caller read another caller\'s lead', async () => {
    const otherLead = fixtureSql(`
      select l.id from crm.leads l
       where l.caller_id = '${USERS.callerB1}' limit 1;
    `).trim();
    assert.ok(otherLead, 'fixture: caller B1 should own at least one lead');

    const a1 = await login(h.app, EMAILS.callerA1);
    const res = await h.app.inject({ url: `/leads/${otherLead}`, headers: auth(a1) });
    assert.equal(res.statusCode, 404, 'an invisible lead must read as not found');
  });

  it('scopes a caller\'s day to their own pipeline', async () => {
    // Pin a due-now lead of A1's own. The ingested fixtures' retry times land
    // on the working-hours clock, so late in the IST afternoon they drift
    // past midnight and the day view is legitimately empty - which made this
    // test flake by wall clock. It is about RLS scoping, not retry timing.
    const mine = makeLeadFor(USERS.callerA1, 'Day Scope');
    fixtureSql(`update crm.leads set next_action_at = now() where id = '${mine}';`);

    const a1 = await login(h.app, EMAILS.callerA1);
    const res = await h.app.inject({ url: '/me/day', headers: auth(a1) });
    assert.equal(res.statusCode, 200);
    const leads = res.json().leads as Array<{ caller_id: string }>;
    assert.ok(leads.length > 0, 'caller A1 should have a pipeline');
    assert.ok(
      leads.every((l) => l.caller_id === USERS.callerA1),
      'no lead belonging to anyone else may appear',
    );
  });

  it('does not let a caller reach the security alert dashboard', async () => {
    const a1 = await login(h.app, EMAILS.callerA1);
    const res = await h.app.inject({ url: '/dashboards/security-alerts', headers: auth(a1) });
    assert.equal(res.statusCode, 403);
  });

  it('lets a counsellor see their whole team but not the other team', async () => {
    const ca = await login(h.app, EMAILS.counsellorA);
    const res = await h.app.inject({ url: '/leads?limit=100', headers: auth(ca) });
    assert.equal(res.statusCode, 200);

    const visible = (res.json().leads as Array<{ id: string }>).map((l) => l.id);
    const teamB = fixtureSql(`
      select coalesce(string_agg(id::text, ','), '') from crm.leads
       where team_id = '11111111-0000-0000-0000-000000000002';
    `)
      .trim()
      .split(',')
      .filter(Boolean);

    assert.ok(visible.length > 0);
    assert.equal(
      visible.filter((id) => teamB.includes(id)).length,
      0,
      'no Team B lead may appear for the Team A counsellor',
    );
  });

  it('records that a lead record was opened', async () => {
    const a1 = await login(h.app, EMAILS.callerA1);
    const myLead = fixtureSql(`
      select id from crm.leads where caller_id = '${USERS.callerA1}' limit 1;
    `).trim();

    await h.app.inject({ url: `/leads/${myLead}`, headers: auth(a1) });

    const count = fixtureSql(`
      select count(*) from crm.lead_access_log
       where user_id = '${USERS.callerA1}' and lead_id = '${myLead}' and context = 'detail';
    `).trim();
    assert.ok(Number(count) >= 1, 'opening a lead must leave an access record');
  });
});

describe('calling pipeline', () => {
  let leadId: string;

  before(() => {
    leadId = makeLeadFor(USERS.callerA1, 'Pipeline');
  });

  it('refuses a callback disposition with no callback time', async () => {
    const a1 = await login(h.app, EMAILS.callerA1);
    const res = await h.app.inject({
      method: 'POST',
      url: `/leads/${leadId}/calls`,
      headers: auth(a1),
      payload: { disposition: 'callback_requested', durationSeconds: 90 },
    });
    assert.equal(res.statusCode, 400);
    assert.match(res.json().message, /callbackAt/);
  });

  it('logs a call with a callback and moves the lead next action', async () => {
    const a1 = await login(h.app, EMAILS.callerA1);
    const when = new Date(Date.now() + 3 * 60 * 60 * 1000);

    const res = await h.app.inject({
      method: 'POST',
      url: `/leads/${leadId}/calls`,
      headers: auth(a1),
      payload: {
        disposition: 'callback_requested',
        durationSeconds: 120,
        callbackAt: when.toISOString(),
        callbackNote: 'Call after 4pm',
      },
    });

    assert.equal(res.statusCode, 201);
    assert.equal(res.json().lead.status, 'callback');
    assert.equal(
      new Date(res.json().lead.next_action_at).toISOString(),
      when.toISOString(),
      'the callback time becomes the lead next action',
    );
  });

  it('does not count a very short call as a connect', async () => {
    const a1 = await login(h.app, EMAILS.callerA1);
    const target = makeLeadFor(USERS.callerA1, 'Short Call');

    const res = await h.app.inject({
      method: 'POST',
      url: `/leads/${target}/calls`,
      headers: auth(a1),
      payload: { disposition: 'connected_interested', durationSeconds: 5 },
    });

    assert.equal(res.statusCode, 201);
    assert.equal(res.json().lead.connect_count, 0, 'a 5-second call is not a connect');
  });

  it('always leaves an unanswered lead with a future next action', async () => {
    const a1 = await login(h.app, EMAILS.callerA1);
    const target = makeLeadFor(USERS.callerA1, 'No Answer');

    const res = await h.app.inject({
      method: 'POST',
      url: `/leads/${target}/calls`,
      headers: auth(a1),
      payload: { disposition: 'not_answered', durationSeconds: 0 },
    });

    assert.equal(res.statusCode, 201);
    assert.ok(
      new Date(res.json().lead.next_action_at).getTime() > Date.now(),
      'no lead may be left without a forward action',
    );
  });
});

describe('lead transfer', () => {
  let leadId: string;

  before(() => {
    // Build a lead with enough unanswered attempts to qualify.
    leadId = makeLeadFor(USERS.callerA1, 'Transferable');
    fixtureSql(`
      insert into crm.call_attempts (lead_id, user_id, disposition, duration_seconds, is_verified)
      select '${leadId}', '${USERS.callerA1}', 'not_answered', 0, true
        from generate_series(1, 4);
    `);
  });

  it('does not let a caller transfer a lead', async () => {
    const a1 = await login(h.app, EMAILS.callerA1);
    const res = await h.app.inject({
      method: 'POST',
      url: `/leads/${leadId}/transfer`,
      headers: auth(a1),
      payload: { toCallerId: USERS.callerA2, reason: 'not_answered_streak' },
    });
    assert.equal(res.statusCode, 403);
    assert.match(res.json().message, /counsellor or admin/);
  });

  it('lets the counsellor transfer, and hands the lead over cleanly', async () => {
    const ca = await login(h.app, EMAILS.counsellorA);
    const res = await h.app.inject({
      method: 'POST',
      url: `/leads/${leadId}/transfer`,
      headers: auth(ca),
      payload: { toCallerId: USERS.callerA2, reason: 'not_answered_streak', note: 'No answer x4' },
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.json().caller_id, USERS.callerA2);
    assert.equal(res.json().transfer_count, 1);
    assert.equal(res.json().na_streak, 0, 'the streak resets for the new owner');
  });

  it('caps transfers and reports the cap as a conflict', async () => {
    const ca = await login(h.app, EMAILS.counsellorA);
    await h.app.inject({
      method: 'POST',
      url: `/leads/${leadId}/transfer`,
      headers: auth(ca),
      payload: { toCallerId: USERS.callerA1, reason: 'load_balance' },
    });
    const third = await h.app.inject({
      method: 'POST',
      url: `/leads/${leadId}/transfer`,
      headers: auth(ca),
      payload: { toCallerId: USERS.callerA2, reason: 'load_balance' },
    });

    assert.equal(third.statusCode, 409);
    assert.match(third.json().message, /already been transferred/);
  });
});

/**
 * The "Give to" list behind requirement 8's Transfer button.
 *
 * It used to inner-join today's team membership and compare it to
 * crm.current_user_team(). An admin holds no team membership, so the
 * comparison was `= NULL`, the list came back empty, and every Transfer button
 * on Floor could only answer "No caller available to receive it" while the
 * floor was full of callers. The list must offer what crm.transfer_lead()
 * accepts - every active caller - or the rule lives in two places and one of
 * them is wrong.
 */
/**
 * What a refused transfer looks like to the person who clicked Transfer.
 *
 * crm.transfer_lead makes six checks; three of them used to raise bare, which
 * is SQLSTATE P0001, which is in no map in src/http/errors.ts - so an ordinary
 * refusal fell through to the catch-all and the floor read "something went
 * wrong". The same five words for a lead a colleague had already moved, for a
 * target who cannot receive leads, and for a lead id that does not resolve.
 * A 500 also says "this server is broken", which sends people to the wrong
 * place entirely. Migration 0073 gives every refusal a SQLSTATE.
 */
describe('a refused transfer says why', () => {
  let leadId: string;

  before(() => {
    leadId = makeLeadFor(USERS.callerA1, 'Refusable');
  });

  it('never answers a refusal with 500', async () => {
    const ca = await login(h.app, EMAILS.counsellorA);
    const refusals = [
      { label: 'already that caller', leadId: () => leadId, to: USERS.callerA1 },
      { label: 'target is not a caller', leadId: () => leadId, to: USERS.counsellorB },
      { label: 'no such lead', leadId: () => '00000000-0000-0000-0000-0000000000aa', to: USERS.callerA2 },
    ];

    for (const r of refusals) {
      const res = await h.app.inject({
        method: 'POST',
        url: `/leads/${r.leadId()}/transfer`,
        headers: auth(ca),
        payload: { toCallerId: r.to, reason: 'load_balance' },
      });
      assert.notEqual(res.statusCode, 500, `${r.label} must not read as a server crash`);
      assert.doesNotMatch(
        res.json().message ?? '',
        /something went wrong/,
        `${r.label} must say what happened`,
      );
    }
  });

  it('calls a lead already held by that caller a conflict, and names them', async () => {
    const ca = await login(h.app, EMAILS.counsellorA);
    const res = await h.app.inject({
      method: 'POST',
      url: `/leads/${leadId}/transfer`,
      headers: auth(ca),
      payload: { toCallerId: USERS.callerA1, reason: 'load_balance' },
    });

    assert.equal(res.statusCode, 409);
    assert.match(res.json().message, /already with Caller A1/);
    assert.match(res.json().message, /refresh/, 'and says what to do about it');
  });

  it('refuses a target who cannot receive leads, by name', async () => {
    const ca = await login(h.app, EMAILS.counsellorA);
    const res = await h.app.inject({
      method: 'POST',
      url: `/leads/${leadId}/transfer`,
      headers: auth(ca),
      payload: { toCallerId: USERS.counsellorB, reason: 'load_balance' },
    });

    assert.equal(res.statusCode, 409);
    assert.match(res.json().message, /Counsellor B/);
    assert.match(res.json().message, /active caller/);
  });

  it('reads a lead it cannot resolve as 404, not as a crash', async () => {
    const ca = await login(h.app, EMAILS.counsellorA);
    const res = await h.app.inject({
      method: 'POST',
      url: '/leads/00000000-0000-0000-0000-0000000000aa/transfer',
      headers: auth(ca),
      payload: { toCallerId: USERS.callerA2, reason: 'load_balance' },
    });

    assert.equal(res.statusCode, 404);
    assert.match(res.json().message, /no longer exists/);
  });

  it('still names the cap when the cap is what stopped it', async () => {
    const ca = await login(h.app, EMAILS.counsellorA);
    const capped = makeLeadFor(USERS.callerA1, 'Capped');
    for (const to of [USERS.callerA2, USERS.callerA1]) {
      await h.app.inject({
        method: 'POST', url: `/leads/${capped}/transfer`, headers: auth(ca),
        payload: { toCallerId: to, reason: 'load_balance' },
      });
    }
    const third = await h.app.inject({
      method: 'POST', url: `/leads/${capped}/transfer`, headers: auth(ca),
      payload: { toCallerId: USERS.callerA2, reason: 'load_balance' },
    });

    assert.equal(third.statusCode, 409);
    assert.match(third.json().message, /already been transferred 2 times/);
    assert.match(third.json().message, /cap is 2/);
  });
});

describe('transfer targets', () => {
  it('is not empty for an admin, who belongs to no team', async () => {
    const admin = await login(h.app, EMAILS.admin);
    const res = await h.app.inject({ method: 'GET', url: '/transfers/targets', headers: auth(admin) });

    assert.equal(res.statusCode, 200);
    const names = res.json().map((t: { full_name: string }) => t.full_name);
    for (const seeded of ['Caller A1', 'Caller A2', 'Caller B1', 'Caller B2']) {
      assert.ok(
        names.includes(seeded),
        `an admin must be offered every active caller, not the empty set (missing ${seeded})`,
      );
    }
  });

  it('offers a counsellor the other team too, because transfer_lead accepts it', async () => {
    const ca = await login(h.app, EMAILS.counsellorA);
    const res = await h.app.inject({ method: 'GET', url: '/transfers/targets', headers: auth(ca) });

    assert.equal(res.statusCode, 200);
    const names = res.json().map((t: { full_name: string }) => t.full_name);
    assert.ok(names.includes('Caller A1'), 'their own team is offered');
    assert.ok(names.includes('Caller B1'), 'so is the other team - the picker must not be narrower than the rule');
  });

  it('names each target team, so a hand-off across one is visible before it happens', async () => {
    const admin = await login(h.app, EMAILS.admin);
    const res = await h.app.inject({ method: 'GET', url: '/transfers/targets', headers: auth(admin) });

    const rows = res.json() as Array<{ id: string; full_name: string; team_name: string | null; tier: string }>;
    const seeded = rows.filter((t) => t.full_name.startsWith('Caller '));
    assert.equal(seeded.length, 4);
    for (const t of seeded) {
      assert.ok(t.team_name, `${t.full_name} must carry a team name for the picker to group on`);
    }
    for (const t of rows) {
      assert.ok(typeof t.tier === 'string', 'the tier rides along: RESTRICTED is a valid manual target, labelled');
    }
  });

  it('keeps a caller whose team membership has lapsed', async () => {
    // The old inner join dropped them silently - a caller visibly on the floor
    // who simply could not be chosen, with no message saying why. Expire the
    // membership, look, then put it back: every later test on this database
    // reads team membership, and a fixture that does not clean up after itself
    // fails them somewhere else entirely.
    const upper = fixtureSql(
      `select coalesce(upper(period)::text, 'null')
         from crm.team_memberships
        where user_id = '${USERS.callerB2}' and period @> current_date;`,
    ).trim();
    fixtureSql(`
      update crm.team_memberships
         set period = daterange(lower(period), current_date - 1)
       where user_id = '${USERS.callerB2}' and period @> current_date;
    `);
    try {
      const admin = await login(h.app, EMAILS.admin);
      const res = await h.app.inject({ method: 'GET', url: '/transfers/targets', headers: auth(admin) });
      const row = res.json().find((t: { id: string }) => t.id === USERS.callerB2);

      assert.ok(row, 'an active caller with no current membership is still a legal transfer target');
      assert.equal(row.team_name, null, 'and reads as team-less rather than vanishing');
    } finally {
      fixtureSql(`
        update crm.team_memberships
           set period = daterange(lower(period), ${upper === 'null' ? 'null' : `'${upper}'::date`})
         where user_id = '${USERS.callerB2}'
           and upper(period) = current_date - 1;
      `);
    }
  });

  it('hands a lead across teams when that is the choice made', async () => {
    const leadId = makeLeadFor(USERS.callerA1, 'Cross-team');
    const admin = await login(h.app, EMAILS.admin);
    const res = await h.app.inject({
      method: 'POST',
      url: `/leads/${leadId}/transfer`,
      headers: auth(admin),
      payload: { toCallerId: USERS.callerB1, reason: 'caller_unavailable' },
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.json().caller_id, USERS.callerB1);
    assert.equal(
      res.json().team_id,
      fixtureSql(`select crm.team_of('${USERS.callerB1}', current_date);`).trim(),
      'the lead follows the caller onto their team',
    );
  });
});

/**
 * Changing a person's team.
 *
 * Admin -> Users badged a caller with no team ("no team - gets no leads") and
 * then offered nothing to do about it: teamId was accepted only at user
 * creation, so a correction afterwards meant SQL against the live database.
 */
describe('admin: a person\'s team', () => {
  const teamId = (name: string) =>
    fixtureSql(`select id from crm.teams where name = '${name}';`).trim();
  const teamOf = (userId: string) =>
    fixtureSql(`select coalesce(t.name, '<none>')
                  from crm.users u
                  left join crm.team_memberships tm
                    on tm.user_id = u.id and tm.period @> current_date
                  left join crm.teams t on t.id = tm.team_id
                 where u.id = '${userId}';`).trim();

  it('does not let a counsellor move anybody', async () => {
    const ca = await login(h.app, EMAILS.counsellorA);
    const res = await h.app.inject({
      method: 'PUT',
      url: `/admin/users/${USERS.callerA1}/team`,
      headers: auth(ca),
      payload: { teamId: teamId('Team B') },
    });
    assert.equal(res.statusCode, 403);
    assert.equal(teamOf(USERS.callerA1), 'Team A', 'and the refusal changed nothing');
  });

  it('gives a team to somebody who has none', async () => {
    // The exact state the red badge names, and the reason this route exists.
    fixtureSql(`
      update crm.team_memberships
         set period = daterange(lower(period), current_date)
       where user_id = '${USERS.callerB2}' and period @> current_date
         and lower(period) < current_date;
    `);
    assert.equal(teamOf(USERS.callerB2), '<none>', 'fixture: they start with no team');

    const admin = await login(h.app, EMAILS.admin);
    const res = await h.app.inject({
      method: 'PUT',
      url: `/admin/users/${USERS.callerB2}/team`,
      headers: auth(admin),
      payload: { teamId: teamId('Team B') },
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.json().changed, true);
    assert.equal(res.json().from, null);
    assert.equal(teamOf(USERS.callerB2), 'Team B');
  });

  it('corrects a membership made today in place, leaving no empty range behind', async () => {
    // callerB2 joined Team B a moment ago, in the test above. Moving them now
    // is somebody fixing their own mistake: closing that row would leave a
    // zero-length daterange for ever, and the app cannot DELETE it.
    const admin = await login(h.app, EMAILS.admin);
    const res = await h.app.inject({
      method: 'PUT',
      url: `/admin/users/${USERS.callerB2}/team`,
      headers: auth(admin),
      payload: { teamId: teamId('Team A') },
    });

    assert.equal(res.statusCode, 200);
    assert.equal(teamOf(USERS.callerB2), 'Team A');
    assert.equal(
      fixtureSql(`select count(*) from crm.team_memberships
                   where user_id = '${USERS.callerB2}' and isempty(period);`).trim(),
      '0',
      'no zero-length membership row is left behind',
    );
  });

  it('moves an older membership by closing it, keeping who was where when', async () => {
    // Backdate so this is a real move rather than a same-day correction. The
    // spells this suite has already closed are cleared first - the exclusion
    // constraint is doing its job, and a fixture must not reach back over one.
    fixtureSql(`
      delete from crm.team_memberships
       where user_id = '${USERS.callerB2}' and not (period @> current_date);
      update crm.team_memberships
         set period = daterange(current_date - 30, upper(period))
       where user_id = '${USERS.callerB2}' and period @> current_date;
    `);
    const admin = await login(h.app, EMAILS.admin);
    const res = await h.app.inject({
      method: 'PUT',
      url: `/admin/users/${USERS.callerB2}/team`,
      headers: auth(admin),
      payload: { teamId: teamId('Team B') },
    });

    assert.equal(res.statusCode, 200);
    assert.equal(teamOf(USERS.callerB2), 'Team B');
    assert.equal(
      fixtureSql(`select count(*) from crm.team_memberships
                   where user_id = '${USERS.callerB2}';`).trim(),
      '2',
      'the old row stays, closed: a move is a new spell, not an overwrite',
    );
    assert.equal(
      fixtureSql(`select t.name from crm.team_memberships tm
                    join crm.teams t on t.id = tm.team_id
                   where tm.user_id = '${USERS.callerB2}'
                     and tm.period @> (current_date - 1);`).trim(),
      'Team A',
      'and yesterday still reads as Team A',
    );
  });

  it('is a no-op when they are already on that team', async () => {
    const admin = await login(h.app, EMAILS.admin);
    const before = fixtureSql(
      `select count(*) from crm.team_memberships where user_id = '${USERS.callerB2}';`).trim();
    const res = await h.app.inject({
      method: 'PUT',
      url: `/admin/users/${USERS.callerB2}/team`,
      headers: auth(admin),
      payload: { teamId: teamId('Team B') },
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.json().changed, false);
    assert.equal(
      fixtureSql(`select count(*) from crm.team_memberships where user_id = '${USERS.callerB2}';`).trim(),
      before,
      'saving the team they already hold must not stack another membership row',
    );
  });

  it('refuses a team that does not exist', async () => {
    const admin = await login(h.app, EMAILS.admin);
    const res = await h.app.inject({
      method: 'PUT',
      url: `/admin/users/${USERS.callerB2}/team`,
      headers: auth(admin),
      payload: { teamId: '00000000-0000-0000-0000-0000000000ff' },
    });
    assert.equal(res.statusCode, 400);
  });

  it('puts a newcomer at the back of the rotation, like the create route does', async () => {
    const order = fixtureSql(`
      select tm.rotation_order from crm.team_memberships tm
       where tm.user_id = '${USERS.callerB2}' and tm.period @> current_date;
    `).trim();
    const highest = fixtureSql(`
      select max(tm.rotation_order) from crm.team_memberships tm
       where tm.team_id = (select id from crm.teams where name = 'Team B')
         and tm.period @> current_date;
    `).trim();
    assert.equal(order, highest, 'rotation order only breaks ties, so the back of the queue is fair');
  });

  // Put the seed back exactly as the rest of the suite expects to find it:
  // one open Team B membership, opened well before today. Fixtures run as the
  // superuser, so this can DELETE where the application deliberately cannot.
  after(() => {
    fixtureSql(`
      delete from crm.team_memberships where user_id = '${USERS.callerB2}';
      insert into crm.team_memberships (user_id, team_id, rotation_order, period)
      select '${USERS.callerB2}', id, 2, daterange(current_date - 30, null)
        from crm.teams where name = 'Team B';
    `);
  });
});

describe('attendance', () => {
  it('opens and closes a session and reports the minutes', async () => {
    const b1 = await login(h.app, EMAILS.callerB1);

    // The fixture already logged everyone in, so close that first.
    const out = await h.app.inject({
      method: 'POST',
      url: '/attendance/logout',
      headers: auth(b1),
    });
    assert.equal(out.statusCode, 200);
    assert.ok(out.json().minutes >= 0);

    const back = await h.app.inject({
      method: 'POST',
      url: '/attendance/login',
      headers: auth(b1),
    });
    assert.equal(back.statusCode, 201);
  });

  it('refuses a second concurrent login', async () => {
    const b1 = await login(h.app, EMAILS.callerB1);
    const res = await h.app.inject({ method: 'POST', url: '/attendance/login', headers: auth(b1) });
    assert.equal(res.statusCode, 409, 'double login would inflate hours');
  });

  it('reports the 9-hour expectation on the day view', async () => {
    const ca = await login(h.app, EMAILS.counsellorA);
    const res = await h.app.inject({ url: '/attendance/today', headers: auth(ca) });
    assert.equal(res.statusCode, 200);
    const rows = res.json() as Array<{ expected_minutes: number }>;
    assert.ok(rows.length > 0);
    assert.equal(rows[0]!.expected_minutes, 540);
  });
});

describe('dashboards', () => {
  it('gives the counsellor a floor view', async () => {
    const ca = await login(h.app, EMAILS.counsellorA);
    const res = await h.app.inject({ url: '/dashboards/floor', headers: auth(ca) });
    assert.equal(res.statusCode, 200);
    assert.ok((res.json() as unknown[]).length > 0);
  });

  it('reports the breakeven thermometer with the grossed-up booking target', async () => {
    const admin = await login(h.app, EMAILS.admin);
    const res = await h.app.inject({ url: '/dashboards/thermometer', headers: auth(admin) });
    assert.equal(res.statusCode, 200);

    const t = res.json();
    assert.equal(Number(t.monthly_breakeven), 700000);
    assert.equal(Number(t.daily_collection_floor), 28000);
    assert.equal(
      Number(t.required_booking),
      823529,
      'booking target must gross up for 85% collection, not equal the cost',
    );
  });

  it('lists pipeline leakage for the counsellor', async () => {
    const ca = await login(h.app, EMAILS.counsellorA);
    const res = await h.app.inject({ url: '/dashboards/leakage', headers: auth(ca) });
    assert.equal(res.statusCode, 200);
    assert.ok(Array.isArray(res.json().summary));
  });

  it('does not let a caller read the counsellor dashboards', async () => {
    const a1 = await login(h.app, EMAILS.callerA1);
    const res = await h.app.inject({ url: '/dashboards/counsellors', headers: auth(a1) });
    assert.equal(res.statusCode, 403);
  });

  it('gives leadership a date-ranged overview: totals, per person, and the bulk response', async () => {
    const leadId = makeLeadFor(USERS.callerA1, 'Overview');
    const a1 = await login(h.app, EMAILS.callerA1);
    const call = await h.app.inject({
      method: 'POST', url: `/leads/${leadId}/calls`, headers: auth(a1),
      payload: { disposition: 'not_answered', durationSeconds: 0 },
    });
    assert.equal(call.statusCode, 201);

    const admin = await login(h.app, EMAILS.admin);
    const res = await h.app.inject({ url: '/dashboards/overview', headers: auth(admin) });
    assert.equal(res.statusCode, 200);
    const o = res.json();
    assert.ok(o.from <= o.to, 'the default window is a valid range');
    assert.ok(Number(o.totals.leads_all_time) >= Number(o.totals.leads_in_range));
    assert.ok(Number(o.totals.dials) >= 1);

    const na = o.dispositions.find((d: { disposition: string }) => d.disposition === 'not_answered');
    assert.ok(na && Number(na.count) >= 1, 'the bulk response counts the not-answered call');

    const row = o.members.find((m: { user_id: string }) => m.user_id === USERS.callerA1);
    assert.ok(row, 'every caller has a row');
    assert.ok(Number(row.leads_assigned) >= 1, 'the lead counts against its caller');
    assert.ok(Number(row.not_answered) >= 1, 'the response split is per person too');
  });

  it('keeps the overview window honest: an empty week counts nothing in range', async () => {
    const admin = await login(h.app, EMAILS.admin);
    const res = await h.app.inject({
      url: '/dashboards/overview?from=2001-01-01&to=2001-01-07', headers: auth(admin),
    });
    assert.equal(res.statusCode, 200);
    const o = res.json();
    assert.equal(Number(o.totals.leads_in_range), 0);
    assert.equal(Number(o.totals.dials), 0);
    assert.ok(Number(o.totals.leads_all_time) > 0, 'the all-time count ignores the window');
  });

  it('rejects an overview range that runs backwards', async () => {
    const admin = await login(h.app, EMAILS.admin);
    const res = await h.app.inject({
      url: '/dashboards/overview?from=2025-02-01&to=2025-01-01', headers: auth(admin),
    });
    assert.equal(res.statusCode, 400);
  });

  it('does not let a caller read the overview', async () => {
    const a1 = await login(h.app, EMAILS.callerA1);
    const res = await h.app.inject({ url: '/dashboards/overview', headers: auth(a1) });
    assert.equal(res.statusCode, 403);
  });
});

describe('settings', () => {
  it('lets an admin change a target and records who did it', async () => {
    const admin = await login(h.app, EMAILS.admin);
    const res = await h.app.inject({
      method: 'PUT',
      url: '/admin/settings/dial.daily_target_per_caller',
      headers: auth(admin),
      payload: { value: 95 },
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.json().value, 95);

    const actor = fixtureSql(`
      select actor_id from crm.audit_log
       where table_name = 'settings' and row_id = 'dial.daily_target_per_caller'
       order by occurred_at desc limit 1;
    `).trim();
    assert.equal(actor, USERS.admin, 'the change must be attributable');
  });

  it('does not let a counsellor change a target', async () => {
    const ca = await login(h.app, EMAILS.counsellorA);
    const res = await h.app.inject({
      method: 'PUT',
      url: '/admin/settings/dial.daily_target_per_caller',
      headers: auth(ca),
      payload: { value: 1 },
    });
    assert.equal(res.statusCode, 403);
  });
});

describe('web ui shell', () => {
  it('serves the app shell without a session', async () => {
    const res = await h.app.inject({ url: '/ui/' });
    assert.equal(res.statusCode, 200);
    assert.match(res.headers['content-type'] ?? '', /text\/html/);
    assert.match(res.body, /5 Circles CRM/);
  });

  it('still refuses API data without a session', async () => {
    const res = await h.app.inject({ url: '/me/day' });
    assert.equal(res.statusCode, 401);
  });
});

describe('device call-log sync (the Android contract)', () => {
  let leadId: string;
  let leadPhone: string;

  before(() => {
    leadId = makeLeadFor(USERS.callerA1, 'Device Sync');
    leadPhone = fixtureSql(`select phone_e164 from crm.leads where id = '${leadId}';`).trim();
  });

  it('stores entries, matches the lead, and is idempotent on re-upload', async () => {
    const a1 = await login(h.app, EMAILS.callerA1);
    const entries = [
      {
        deviceRowKey: 'dev1:row:1',
        msisdn: leadPhone,
        direction: 'outgoing',
        startedAt: new Date().toISOString(),
        durationSeconds: 222,
      },
      {
        deviceRowKey: 'dev1:row:2',
        msisdn: '+919999888877', // personal call, matches nothing
        direction: 'outgoing',
        startedAt: new Date().toISOString(),
        durationSeconds: 33,
      },
    ];

    const first = await h.app.inject({
      method: 'POST', url: '/device-logs/sync', headers: auth(a1), payload: { entries },
    });
    assert.equal(first.statusCode, 200);
    assert.equal(first.json().inserted, 2);
    assert.equal(first.json().matched, 1, 'the lead call must match, the personal one must not');

    const again = await h.app.inject({
      method: 'POST', url: '/device-logs/sync', headers: auth(a1), payload: { entries },
    });
    assert.equal(again.json().inserted, 0, 're-uploading the same rows must insert nothing');
  });

  it('suggests the device call when logging, and the linked attempt is verified', async () => {
    const a1 = await login(h.app, EMAILS.callerA1);

    const sugg = await h.app.inject({ url: `/leads/${leadId}/device-log-suggestion`, headers: auth(a1) });
    assert.equal(sugg.statusCode, 200);
    const suggestion = sugg.json().suggestion;
    assert.ok(suggestion, 'the synced call should be offered');
    assert.equal(suggestion.duration_seconds, 222);

    const logged = await h.app.inject({
      method: 'POST', url: `/leads/${leadId}/calls`, headers: auth(a1),
      payload: { disposition: 'not_answered', durationSeconds: 0, deviceLogId: suggestion.id },
    });
    assert.equal(logged.statusCode, 201);

    const verified = fixtureSql(
      `select is_verified from crm.call_attempts where device_log_id = '${suggestion.id}';`,
    ).trim();
    assert.equal(verified, 't', 'an attempt linked to a device row is verified');

    const gone = await h.app.inject({ url: `/leads/${leadId}/device-log-suggestion`, headers: auth(a1) });
    assert.equal(gone.json().suggestion, null, 'a claimed device row is not offered twice');
  });
});

describe('deals and collections', () => {
  let leadId: string;
  let dealId: string;
  let firstInstalment: string;

  before(() => {
    leadId = makeLeadFor(USERS.callerA1, 'Deal Lead');
    fixtureSql(`update crm.leads set counsellor_id = '${USERS.counsellorA}', status = 'qualified' where id = '${leadId}';`);
  });

  it('rejects a schedule that does not sum to the booked amount', async () => {
    const ca = await login(h.app, EMAILS.counsellorA);
    const res = await h.app.inject({
      method: 'POST', url: `/leads/${leadId}/deals`, headers: auth(ca),
      payload: {
        productId: '44444444-0000-0000-0000-000000000002',
        bookedAmount: 75000,
        instalments: [{ dueDate: '2026-08-03', amount: 40000 }, { dueDate: '2026-09-02', amount: 30000 }],
      },
    });
    assert.equal(res.statusCode, 400);
    assert.match(res.json().message, /must sum/);
  });

  it('does not let a caller book a deal', async () => {
    const a1 = await login(h.app, EMAILS.callerA1);
    const res = await h.app.inject({
      method: 'POST', url: `/leads/${leadId}/deals`, headers: auth(a1),
      payload: {
        productId: '44444444-0000-0000-0000-000000000002',
        bookedAmount: 75000,
        instalments: [{ dueDate: '2026-08-03', amount: 75000 }],
      },
    });
    assert.equal(res.statusCode, 403);
  });

  it('books a deal, closes the lead, and schedules the instalments', async () => {
    const ca = await login(h.app, EMAILS.counsellorA);
    const res = await h.app.inject({
      method: 'POST', url: `/leads/${leadId}/deals`, headers: auth(ca),
      payload: {
        productId: '44444444-0000-0000-0000-000000000002',
        bookedAmount: 75000,
        discountAmount: 5000,
        instalments: [{ dueDate: '2026-08-03', amount: 40000 }, { dueDate: '2026-09-02', amount: 35000 }],
      },
    });
    assert.equal(res.statusCode, 201);
    dealId = res.json().deal.id;
    firstInstalment = res.json().instalments[0].id;

    const lead = fixtureSql(`select status || ':' || coalesce(next_action_at::text, 'none') from crm.leads where id = '${leadId}';`).trim();
    assert.match(lead, /^won:none$/, 'a booked deal closes the lead and clears its next action');
  });

  it('shows the instalments in the collections queue with a promise', async () => {
    const ca = await login(h.app, EMAILS.counsellorA);

    const promise = await h.app.inject({
      method: 'POST', url: `/instalments/${firstInstalment}/promise`, headers: auth(ca),
      payload: { promisedDate: '2026-08-05', amount: 40000, confidence: 'high' },
    });
    assert.equal(promise.statusCode, 201);

    const due = await h.app.inject({ url: '/collections/due', headers: auth(ca) });
    assert.equal(due.statusCode, 200);
    const row = (due.json() as Array<Record<string, unknown>>).find((r) => r.instalment_id === firstInstalment);
    assert.ok(row, 'the open instalment must appear in the dues queue');
    assert.equal(row!.confidence, 'high', 'the open promise rides along');
    assert.ok(row!.team_name, 'every due row names its team, so the admin can split the book');
  });

  it('records a payment, settles the instalment and the promise', async () => {
    const ca = await login(h.app, EMAILS.counsellorA);

    const over = await h.app.inject({
      method: 'POST', url: `/deals/${dealId}/payments`, headers: auth(ca),
      payload: { instalmentId: firstInstalment, amount: 50000, mode: 'upi' },
    });
    assert.equal(over.statusCode, 400, 'overpaying an instalment is rejected');

    const pay = await h.app.inject({
      method: 'POST', url: `/deals/${dealId}/payments`, headers: auth(ca),
      payload: { instalmentId: firstInstalment, amount: 40000, mode: 'upi', reference: 'UTR123' },
    });
    assert.equal(pay.statusCode, 201);
    assert.equal(pay.json().instalment.status, 'paid');

    const outcome = fixtureSql(`select outcome from crm.promises_to_pay where instalment_id = '${firstInstalment}';`).trim();
    assert.equal(outcome, 'kept', 'paying in full marks the promise kept');

    const mtd = await h.app.inject({ url: '/dashboards/counsellors', headers: auth(ca) });
    const me = (mtd.json() as Array<Record<string, unknown>>).find((r) => r.user_id === USERS.counsellorA);
    assert.equal(Number(me!.collected_amount), 40000, 'the collection lands on the counsellor dashboard');
  });
});

describe('go-live provisioning endpoints', () => {
  it('lets ops create a lead source and import through it immediately', async () => {
    const ops = await login(h.app, EMAILS.ops);
    const created = await h.app.inject({
      method: 'POST', url: '/admin/sources', headers: auth(ops),
      payload: { name: 'Provisioned Source', defaultPriority: 'immediate' },
    });
    assert.equal(created.statusCode, 201);
    const sourceId = created.json().id;

    const run = await h.app.inject({
      method: 'POST', url: `/ingest/sources/${sourceId}/csv`, headers: auth(ops),
      payload: { csv: 'Full Name,Phone Number\nProv Lead,9811400001' },
    });
    assert.equal(run.json().created, 1);

    const lead = fixtureSql(`select priority from crm.leads where phone_e164 = '+919811400001';`).trim();
    assert.equal(lead, 'immediate', 'the source default priority carries onto the lead');
  });

  it('lets admin create a product and a counsellor book against it', async () => {
    const admin = await login(h.app, EMAILS.admin);
    const created = await h.app.inject({
      method: 'POST', url: '/admin/products', headers: auth(admin),
      payload: { name: 'Course L2', code: 'CRS-2', listPriceInr: 20000, isSebiRegulated: false },
    });
    assert.equal(created.statusCode, 201);

    const leadId = makeLeadFor(USERS.callerA1, 'Product Buyer');
    const ca = await login(h.app, EMAILS.counsellorA);
    const deal = await h.app.inject({
      method: 'POST', url: `/leads/${leadId}/deals`, headers: auth(ca),
      payload: {
        productId: created.json().id, bookedAmount: 20000,
        instalments: [{ dueDate: '2026-08-10', amount: 20000 }],
      },
    });
    assert.equal(deal.statusCode, 201);
  });

  it('does not let a caller create sources or products', async () => {
    const a1 = await login(h.app, EMAILS.callerA1);
    const src = await h.app.inject({
      method: 'POST', url: '/admin/sources', headers: auth(a1),
      payload: { name: 'Nope' },
    });
    const prod = await h.app.inject({
      method: 'POST', url: '/admin/products', headers: auth(a1),
      payload: { name: 'Nope', code: 'N', listPriceInr: 1 },
    });
    assert.equal(src.statusCode, 403);
    assert.equal(prod.statusCode, 403);
  });
});

describe('validation errors are readable by the person filling the form', () => {
  it('says the password is too short instead of just returning 400', async () => {
    const admin = await login(h.app, EMAILS.admin);
    const res = await h.app.inject({
      method: 'POST', url: '/admin/users', headers: auth(admin),
      payload: {
        fullName: 'Too Short', email: 'short@5circles.test',
        role: 'counsellor', temporaryPassword: '12345678',
      },
    });

    assert.equal(res.statusCode, 400);
    const body = res.json();
    assert.ok(body.message, 'a validation failure must carry a human-readable message');
    assert.match(body.message, /Temporary password/,
      'the message names the field the way the form labels it');
    assert.match(body.message, /10/, 'the message states the requirement');
  });

  it('names a mistyped email in words, not as a schema path', async () => {
    const admin = await login(h.app, EMAILS.admin);
    const res = await h.app.inject({
      method: 'POST', url: '/admin/users', headers: auth(admin),
      payload: {
        fullName: 'Bad Email', email: 'not-an-email',
        role: 'caller', temporaryPassword: 'long-enough-password',
      },
    });
    assert.equal(res.statusCode, 400);
    assert.match(res.json().message, /Email/);
  });
});

describe('lead source accepts a pasted sheet URL', () => {
  it('stores the id when given the whole browser URL', async () => {
    const ops = await login(h.app, EMAILS.ops);
    const res = await h.app.inject({
      method: 'POST', url: '/admin/sources', headers: auth(ops),
      payload: {
        name: 'Pasted URL Source',
        spreadsheetId:
          'https://docs.google.com/spreadsheets/d/1AbCdEf-GhIjK_lmNoP12345/edit?gid=0#gid=0',
        worksheetName: 'Sheet1',
      },
    });
    assert.equal(res.statusCode, 201);
    assert.equal(res.json().spreadsheet_id, '1AbCdEf-GhIjK_lmNoP12345');
  });

  it('leaves a bare id untouched', async () => {
    const ops = await login(h.app, EMAILS.ops);
    const res = await h.app.inject({
      method: 'POST', url: '/admin/sources', headers: auth(ops),
      payload: { name: 'Bare Id Source', spreadsheetId: '1AbCdEf-GhIjK_lmNoP67890', worksheetName: 'Sheet1' },
    });
    assert.equal(res.statusCode, 201);
    assert.equal(res.json().spreadsheet_id, '1AbCdEf-GhIjK_lmNoP67890');
  });
});

describe('clearing the lead book does not make the sheet re-import itself', () => {
  const CSV = [
    'Full Name,Phone Number',
    'Reset One,+919888800001',
    'Reset Two,+919888800002',
  ].join('\n');

  it('remembers which sheet rows were seen even after their leads are gone', async () => {
    // This is what makes db/ops/reset-leads.sql safe to run. The reset deletes
    // leads and keeps crm.ingested_rows, so history in the sheet stays known
    // and skipped while rows appended afterwards still come through. Delete
    // both and the next sync would put every old lead straight back.
    const ops = await login(h.app, EMAILS.ops);
    const first = await h.app.inject({
      method: 'POST',
      url: '/ingest/sources/33333333-0000-0000-0000-000000000002/csv',
      headers: auth(ops),
      payload: { csv: CSV },
    });
    assert.equal(first.json().created, 2);

    // Exactly what the reset script does to these two rows.
    fixtureSql(`
      alter table crm.lead_events disable trigger lead_events_append_only;
      delete from crm.leads where phone_e164 in ('+919888800001','+919888800002');
      alter table crm.lead_events enable trigger lead_events_append_only;
      update crm.ingested_rows set lead_id = null where lead_id is not null;
    `);

    const again = await h.app.inject({
      method: 'POST',
      url: '/ingest/sources/33333333-0000-0000-0000-000000000002/csv',
      headers: auth(ops),
      payload: { csv: CSV },
    });
    assert.equal(again.json().created, 0, 'old sheet rows must not come back');
    assert.equal(again.json().duplicate, 2);

    const count = fixtureSql(
      `select count(*) from crm.leads where phone_e164 in ('+919888800001','+919888800002');`,
    ).trim();
    assert.equal(count, '0', 'the lead book stays clear');
  });

  it('still takes rows appended to the sheet after the reset', async () => {
    const ops = await login(h.app, EMAILS.ops);
    const res = await h.app.inject({
      method: 'POST',
      url: '/ingest/sources/33333333-0000-0000-0000-000000000002/csv',
      headers: auth(ops),
      payload: { csv: `${CSV}\nReset Three,+919888800003` },
    });
    assert.equal(res.json().created, 1, 'a newly appended row is a new lead');
    assert.equal(res.json().duplicate, 2, 'the rows from before the reset stay skipped');
  });
});

describe('a deactivated account is reactivated, not recreated', () => {
  const EMAIL = 'returner@5circles.test';

  it('explains that the email is taken rather than naming an index', async () => {
    const admin = await login(h.app, EMAILS.admin);
    const first = await h.app.inject({
      method: 'POST', url: '/admin/users', headers: auth(admin),
      payload: {
        fullName: 'Returner', email: EMAIL, role: 'caller',
        temporaryPassword: 'long-enough-password',
      },
    });
    assert.equal(first.statusCode, 201);

    await h.app.inject({
      method: 'POST', url: `/admin/users/${first.json().id}/deactivate`, headers: auth(admin),
    });

    // The old message was "duplicate key value violates unique constraint
    // users_email_key" - true, and no help at all to whoever is filling a form.
    const again = await h.app.inject({
      method: 'POST', url: '/admin/users', headers: auth(admin),
      payload: {
        fullName: 'Returner Again', email: EMAIL, role: 'caller',
        temporaryPassword: 'long-enough-password',
      },
    });
    assert.equal(again.statusCode, 409);
    assert.match(again.json().message, /already exists/);
    assert.match(again.json().message, /deactivated/);
    assert.doesNotMatch(again.json().message, /users_email_key/);
  });

  it('brings the original account back, keeping its id and its history', async () => {
    const admin = await login(h.app, EMAILS.admin);
    const listed = await h.app.inject({ method: 'GET', url: '/admin/users', headers: auth(admin) });
    const user = listed.json().find((u: { email: string }) => u.email === EMAIL);
    assert.equal(user.is_active, false);

    const back = await h.app.inject({
      method: 'POST', url: `/admin/users/${user.id}/reactivate`, headers: auth(admin),
    });
    assert.equal(back.statusCode, 200);
    assert.equal(back.json().is_active, true);
    assert.equal(back.json().id, user.id, 'the same row must come back, not a new one');
  });

  it('refuses to reactivate an account that is already active', async () => {
    const admin = await login(h.app, EMAILS.admin);
    const listed = await h.app.inject({ method: 'GET', url: '/admin/users', headers: auth(admin) });
    const user = listed.json().find((u: { email: string }) => u.email === EMAIL);
    const res = await h.app.inject({
      method: 'POST', url: `/admin/users/${user.id}/reactivate`, headers: auth(admin),
    });
    assert.equal(res.statusCode, 404);
  });

  it('is an admin action - ops cannot bring an account back', async () => {
    const ops = await login(h.app, EMAILS.ops);
    const res = await h.app.inject({
      method: 'POST',
      url: '/admin/users/22222222-0000-0000-0000-0000000000f2/reactivate',
      headers: auth(ops),
    });
    assert.equal(res.statusCode, 403);
  });
});

describe('a lead source can be corrected after it is created', () => {
  it('fixes a mistyped worksheet tab without creating a second source', async () => {
    // Create-only was the whole reason one sheet got wired in five times: a
    // wrong tab name could not be corrected, only worked around.
    const ops = await login(h.app, EMAILS.ops);
    const created = await h.app.inject({
      method: 'POST', url: '/admin/sources', headers: auth(ops),
      payload: { name: 'Typo Source', spreadsheetId: '1TypoSheetId', worksheetName: 'Sheet 1' },
    });
    assert.equal(created.statusCode, 201);

    const fixed = await h.app.inject({
      method: 'PUT', url: `/admin/sources/${created.json().id}`, headers: auth(ops),
      payload: { worksheetName: 'Form Responses 1' },
    });
    assert.equal(fixed.statusCode, 200);
    assert.equal(fixed.json().worksheet_name, 'Form Responses 1');
    assert.equal(fixed.json().spreadsheet_id, '1TypoSheetId', 'the sheet id must survive the edit');
    assert.equal(fixed.json().name, 'Typo Source', 'the name must survive the edit');
  });

  it('deactivating a duplicate does not blank out the rest of the row', async () => {
    // The deactivate button sends only { isActive: false }. If the partial
    // update let the schema defaults through, every other column would be
    // overwritten - silently, and only visible later as a broken source.
    const ops = await login(h.app, EMAILS.ops);
    const created = await h.app.inject({
      method: 'POST', url: '/admin/sources', headers: auth(ops),
      payload: {
        name: 'Duplicate Feed', spreadsheetId: '1DupeSheetId',
        worksheetName: 'Form Responses 1', defaultPriority: 'immediate',
      },
    });
    assert.equal(created.statusCode, 201);

    const off = await h.app.inject({
      method: 'PUT', url: `/admin/sources/${created.json().id}`, headers: auth(ops),
      payload: { isActive: false },
    });
    assert.equal(off.statusCode, 200);
    assert.equal(off.json().is_active, false);
    assert.equal(off.json().name, 'Duplicate Feed');
    assert.equal(off.json().spreadsheet_id, '1DupeSheetId');
    assert.equal(off.json().worksheet_name, 'Form Responses 1');
    assert.equal(off.json().default_priority, 'immediate', 'priority must not reset to normal');
  });

  it('pins a sheet to one team, and can hand it back to the rotation', async () => {
    // "Simon's sheets go to Simon's team" is a pin. Without one, every source
    // alternates across both teams, which is right for a shared Meta feed and
    // wrong for a sheet that belongs to one desk.
    const ops = await login(h.app, EMAILS.ops);
    const teams = await h.app.inject({ method: 'GET', url: '/admin/teams', headers: auth(ops) });
    const teamId = teams.json()[0].id;

    const created = await h.app.inject({
      method: 'POST', url: '/admin/sources', headers: auth(ops),
      payload: { name: 'Pinned Feed', spreadsheetId: '1PinnedSheet', worksheetName: 'Sheet1' },
    });
    const pinned = await h.app.inject({
      method: 'PUT', url: `/admin/sources/${created.json().id}`, headers: auth(ops),
      payload: { pinnedTeamId: teamId },
    });
    assert.equal(pinned.json().pinned_team_id, teamId);

    // An explicit null must unpin. coalesce() cannot tell that apart from a
    // field nobody sent, so this is the case that silently did nothing.
    const unpinned = await h.app.inject({
      method: 'PUT', url: `/admin/sources/${created.json().id}`, headers: auth(ops),
      payload: { pinnedTeamId: null },
    });
    assert.equal(unpinned.json().pinned_team_id, null);
  });

  it('leaves the pin alone when the field is not sent at all', async () => {
    const ops = await login(h.app, EMAILS.ops);
    const teams = await h.app.inject({ method: 'GET', url: '/admin/teams', headers: auth(ops) });
    const teamId = teams.json()[0].id;
    const created = await h.app.inject({
      method: 'POST', url: '/admin/sources', headers: auth(ops),
      payload: {
        name: 'Keeps Its Pin', spreadsheetId: '1KeepsPin',
        worksheetName: 'Sheet1', pinnedTeamId: teamId,
      },
    });
    const renamed = await h.app.inject({
      method: 'PUT', url: `/admin/sources/${created.json().id}`, headers: auth(ops),
      payload: { name: 'Renamed Only' },
    });
    assert.equal(renamed.json().pinned_team_id, teamId, 'a rename must not unpin the source');
  });

  it('a deactivated source is skipped by the scheduled run, not deleted', async () => {
    const ops = await login(h.app, EMAILS.ops);
    const created = await h.app.inject({
      method: 'POST', url: '/admin/sources', headers: auth(ops),
      payload: { name: 'Paused Feed', spreadsheetId: '1PausedSheet', worksheetName: 'Leads' },
    });
    await h.app.inject({
      method: 'PUT', url: `/admin/sources/${created.json().id}`, headers: auth(ops),
      payload: { isActive: false },
    });

    const listed = await h.app.inject({ method: 'GET', url: '/admin/sources', headers: auth(ops) });
    const row = listed.json().find((s: { id: string }) => s.id === created.json().id);
    assert.ok(row, 'the source is still listed - deactivation is not deletion');
    assert.equal(row.is_active, false);
  });
});

describe('Google Sheets range quoting', () => {
  it('quotes a tab name containing a space', () => {
    // Unquoted, Google answers "Unable to parse range: Sheet 1" - which reads
    // like a missing tab and sends you looking in the wrong place.
    assert.equal(sheetRange('Sheet 1'), "'Sheet 1'");
    assert.equal(sheetRange('Meta Lead Ads'), "'Meta Lead Ads'");
  });

  it('quotes simple names too, since quoting is always valid', () => {
    assert.equal(sheetRange('Sheet1'), "'Sheet1'");
  });

  it('escapes a literal quote by doubling it', () => {
    assert.equal(sheetRange("Ayesha's leads"), "'Ayesha''s leads'");
  });

  it('quotes the name verbatim, because a real tab may end in a space', () => {
    // Google Forms creates tabs called "Form Responses 1 ". Trimming here would
    // make the one spelling that is exactly right impossible to request;
    // resolveWorksheet() handles sloppy input instead, with the titles in hand.
    assert.equal(sheetRange('Form Responses 1 '), "'Form Responses 1 '");
  });

  it('still handles ids and URLs', () => {
    assert.equal(
      normaliseSpreadsheetId('https://docs.google.com/spreadsheets/d/1PSbr3U-vXD2/edit#gid=0'),
      '1PSbr3U-vXD2',
    );
  });
});

describe('a missing worksheet tab says which tabs exist', () => {
  it('recognises the range failure Google reports for a missing tab', () => {
    assert.equal(isRangeFailure("Unable to parse range: 'Sheet 1'"), true);
    assert.equal(isRangeFailure('The caller does not have permission'), false);
  });

  it('reads the message out of a Google API error shape', () => {
    assert.equal(
      errorMessage({ errors: [{ message: "Unable to parse range: 'Sheet 1'" }] }),
      "Unable to parse range: 'Sheet 1'",
    );
    assert.equal(errorMessage(new Error('boom')), 'boom');
  });

  it('names the real tabs, which turns a dead end into the answer', () => {
    const message = describeRangeFailure("Unable to parse range: 'Sheet 1'", [
      'Form Responses 1',
      'Leads',
    ]);
    assert.match(message, /Unable to parse range: 'Sheet 1'/);
    assert.match(message, /"Form·Responses·1", "Leads"/);
  });

  it('makes spaces visible, since an invisible one is the whole problem', () => {
    // "Form Responses 1" and "Form Responses 1 " render identically. Printing
    // the list without marking spaces sends someone to copy a name that looks
    // like the one they already typed.
    const message = describeRangeFailure('nope', ['Form Responses 1 ']);
    assert.match(message, /"Form·Responses·1·"/);
  });

  it('does not invent advice when the tab list came back empty', () => {
    // Better the original error than a sentence that lists nothing.
    assert.equal(
      describeRangeFailure("Unable to parse range: 'Sheet 1'", []),
      "Unable to parse range: 'Sheet 1'",
    );
  });
});

describe('a tab name that only differs by invisible characters still resolves', () => {
  const TABS = ['Form Responses 1 ', 'Leads', 'Archive'];

  it('matches through a trailing space, which is how Forms names its tab', () => {
    assert.equal(resolveWorksheet('Form Responses 1', TABS), 'Form Responses 1 ');
  });

  it('matches through a non-breaking space pasted from the browser', () => {
    assert.equal(resolveWorksheet('Form Responses 1', TABS), 'Form Responses 1 ');
  });

  it('matches through a zero-width space, which \\s does not cover', () => {
    // Written as an escape on purpose: a literal U+200B in this file would be
    // invisible to the next person reading the test.
    assert.equal(resolveWorksheet('Form\u200b Responses 1', TABS), 'Form Responses 1 ');
  });

  it('matches through case and doubled spaces', () => {
    assert.equal(resolveWorksheet('form  responses  1', TABS), 'Form Responses 1 ');
  });

  it('prefers an exact hit over a loose one', () => {
    assert.equal(resolveWorksheet('Leads', ['Leads', 'leads ']), 'Leads');
  });

  it('matches "Sheet 1" to a tab actually called "Sheet1"', () => {
    // The real one. A source was configured as "Sheet 1"; the spreadsheet's
    // only tab was "Sheet1". One space, eight failed syncs, and an error that
    // named the tab correctly while still refusing to read it.
    assert.equal(resolveWorksheet('Sheet 1', ['Sheet1']), 'Sheet1');
    assert.equal(resolveWorksheet('Sheet1', ['Sheet 1']), 'Sheet 1');
  });

  it('refuses to guess when two tabs match equally well', () => {
    // Reading the wrong tab silently is worse than saying so: the leads would
    // arrive from a feed nobody chose, and nothing would look broken. This is
    // what makes ignoring whitespace safe rather than reckless.
    assert.equal(resolveWorksheet('leads', ['Leads', 'LEADS']), null);
    assert.equal(resolveWorksheet('Sheet 1', ['Sheet1', 'Sheet 1 ']), null);
  });

  it('returns null when nothing resembles the configured name', () => {
    assert.equal(resolveWorksheet('Sheet 1', TABS), null);
  });
});

describe('the untouched-lead sweeper (ships disabled, logic still covered)', () => {
  it('moves it after the deadline, and off the first caller entirely', async () => {
    // The sweep ships OFF (0049): leads stay with their caller. These tests
    // switch it on so the engine stays correct for the day that is reversed,
    // and the last test in the block returns it to the shipped state.
    fixtureSql(`update crm.settings set value = '10'::jsonb
                 where key = 'sla.untouched_reassign_minutes';`);
    const leadId = makeLeadFor(USERS.callerA1, 'Untouched');
    fixtureSql(`update crm.leads set assigned_at = now() - interval '3 days',
                       first_touched_at = null, attempt_count = 0, status = 'new'
                 where id = '${leadId}';`);

    const moved = fixtureSql(`select crm.reassign_untouched_leads();`).trim();
    assert.equal(moved, '1');

    const after = fixtureSql(`select caller_id from crm.leads where id = '${leadId}';`).trim();
    assert.notEqual(after, USERS.callerA1, 'it must leave the caller who ignored it');

    // "must not reflect in the lost caller's tab" - RLS is what delivers that,
    // so check through the API as the original caller rather than trusting it.
    const a1 = await login(h.app, EMAILS.callerA1);
    const gone = await h.app.inject({ method: 'GET', url: `/leads/${leadId}`, headers: auth(a1) });
    assert.equal(gone.statusCode, 404, 'the lead a caller lost must read as not found');
  });

  it('leaves a lead alone once someone has actually called it', async () => {
    const leadId = makeLeadFor(USERS.callerB1, 'Already Worked');
    fixtureSql(`update crm.leads set assigned_at = now() - interval '30 minutes',
                       first_touched_at = now(), attempt_count = 1
                 where id = '${leadId}';`);
    fixtureSql(`select crm.reassign_untouched_leads();`);
    const after = fixtureSql(`select caller_id from crm.leads where id = '${leadId}';`).trim();
    assert.equal(after, USERS.callerB1, 'a lead being worked must not be taken away');
  });

  it('stops moving a lead nobody wants, rather than circulating it forever', async () => {
    const leadId = makeLeadFor(USERS.callerA1, 'Hot Potato');
    for (let i = 0; i < 4; i += 1) {
      fixtureSql(`update crm.leads set assigned_at = now() - interval '3 days',
                         first_touched_at = null, attempt_count = 0, status = 'new'
                   where id = '${leadId}';`);
      fixtureSql(`select crm.reassign_untouched_leads();`);
    }
    const count = fixtureSql(`select transfer_count from crm.leads where id = '${leadId}';`).trim();
    assert.equal(count, '2', 'the automatic cap must hold at sla.untouched_reassign_max');
  });

  it('records the move as automatic, with no human blamed for it', async () => {
    const row = fixtureSql(
      `select is_automatic || ' ' || coalesce(transferred_by::text, 'null')
         from crm.lead_transfers where is_automatic order by created_at desc limit 1;`,
    ).trim();
    assert.equal(row, 'true null');
  });

  it('is disabled by setting the minutes to zero', async () => {
    const admin = await login(h.app, EMAILS.admin);
    await h.app.inject({
      method: 'PUT', url: '/admin/settings/sla.untouched_reassign_minutes',
      headers: auth(admin), payload: { value: 0 },
    });
    const leadId = makeLeadFor(USERS.callerA1, 'Sweeper Off');
    fixtureSql(`update crm.leads set assigned_at = now() - interval '99 minutes',
                       first_touched_at = null, attempt_count = 0, status = 'new'
                 where id = '${leadId}';`);
    const moved = fixtureSql(`select crm.reassign_untouched_leads();`).trim();
    assert.equal(moved, '0');
    // Zero IS the shipped state now - leave it there.
    await h.app.inject({
      method: 'PUT', url: '/admin/settings/sla.untouched_reassign_minutes',
      headers: auth(admin), payload: { value: 0 },
    });
  });

  it('ships disabled: leads stay with their caller by default', async () => {
    const off = fixtureSql(
      `select value::text from crm.settings where key = 'sla.untouched_reassign_minutes';`,
    ).trim();
    assert.equal(off, '0', 'the sweep must be off unless an admin turns it on');
    const crossTeam = fixtureSql(
      `select value::text from crm.settings where key = 'escalation.cross_team_days';`,
    ).trim();
    assert.equal(crossTeam, '0', 'cross-team moves must be off unless an admin turns them on');
  });
});

describe('alerts tell a caller what needs them', () => {
  it('raises a breached SLA and a due callback, and hides other people\'s', async () => {
    const leadId = makeLeadFor(USERS.callerA1, 'Alerting');
    fixtureSql(`update crm.leads set first_touch_due_at = now() - interval '5 minutes',
                       first_touched_at = null, status = 'new' where id = '${leadId}';`);

    const otherLead = makeLeadFor(USERS.callerB1, 'Not Mine');
    fixtureSql(`update crm.leads set first_touch_due_at = now() - interval '5 minutes',
                       first_touched_at = null, status = 'new' where id = '${otherLead}';`);

    const a1 = await login(h.app, EMAILS.callerA1);
    // scope=work is the full list; the default bell scope carries only what a
    // person scheduled and is covered by its own test below.
    const res = await h.app.inject({ method: 'GET', url: '/me/alerts?scope=work', headers: auth(a1) });
    assert.equal(res.statusCode, 200);

    const ids = res.json().alerts.map((a: { lead_id: string }) => a.lead_id);
    assert.ok(ids.includes(leadId), 'my own breached lead must raise an alert');
    assert.ok(!ids.includes(otherLead), 'another caller\'s alert must not leak');
    assert.ok(res.json().critical >= 1);
  });

  it('marks how late each one is, so the list can be ordered by urgency', async () => {
    const a1 = await login(h.app, EMAILS.callerA1);
    const res = await h.app.inject({ method: 'GET', url: '/me/alerts?scope=work', headers: auth(a1) });
    const breach = res.json().alerts.find((a: { kind: string }) => a.kind === 'sla_breach');
    assert.ok(breach, 'expected a breach alert');
    assert.ok(Number(breach.minutes_late) >= 4, `expected a positive lateness, got ${breach.minutes_late}`);
  });
});

describe('re-tap filters', () => {
  it('finds the leads whose last outcome was Not Answered', async () => {
    const leadId = makeLeadFor(USERS.callerA1, 'Did Not Answer');
    const a1 = await login(h.app, EMAILS.callerA1);
    await h.app.inject({
      method: 'POST', url: `/leads/${leadId}/calls`, headers: auth(a1),
      payload: { disposition: 'not_answered', durationSeconds: 0, nextActionAt: new Date(Date.now() + 3.6e6).toISOString() },
    });

    const res = await h.app.inject({
      method: 'GET', url: '/leads?lastDisposition=not_answered', headers: auth(a1),
    });
    assert.equal(res.statusCode, 200);
    const ids = res.json().leads.map((l: { id: string }) => l.id);
    assert.ok(ids.includes(leadId));
  });

  it('one chip covers the whole unreachable family: busy, switched off, incoming unavailable', async () => {
    const busyLead = makeLeadFor(USERS.callerA1, 'Was Busy');
    const offLead = makeLeadFor(USERS.callerA1, 'Was Switched Off');
    const a1 = await login(h.app, EMAILS.callerA1);
    const next = new Date(Date.now() + 3.6e6).toISOString();
    await h.app.inject({
      method: 'POST', url: `/leads/${busyLead}/calls`, headers: auth(a1),
      payload: { disposition: 'busy', durationSeconds: 0, nextActionAt: next },
    });
    await h.app.inject({
      method: 'POST', url: `/leads/${offLead}/calls`, headers: auth(a1),
      payload: { disposition: 'switched_off', durationSeconds: 0, nextActionAt: next },
    });

    // The bug this pins down: the "Busy or switched off" list showed only the
    // busy third of the unreachable family.
    const res = await h.app.inject({
      method: 'GET',
      url: '/leads?lastDisposition=busy,switched_off,incoming_unavailable',
      headers: auth(a1),
    });
    assert.equal(res.statusCode, 200);
    const ids = res.json().leads.map((l: { id: string }) => l.id);
    assert.ok(ids.includes(busyLead), 'the busy lead is on the list');
    assert.ok(ids.includes(offLead), 'and so is the switched-off one');

    // A made-up outcome is refused, never silently ignored.
    const bad = await h.app.inject({
      method: 'GET', url: '/leads?lastDisposition=busy,nonsense', headers: auth(a1),
    });
    assert.equal(bad.statusCode, 400);
  });

  it('does not return a lead whose latest call was something else', async () => {
    const leadId = makeLeadFor(USERS.callerA1, 'Then Answered');
    const a1 = await login(h.app, EMAILS.callerA1);
    const next = new Date(Date.now() + 3.6e6).toISOString();
    await h.app.inject({
      method: 'POST', url: `/leads/${leadId}/calls`, headers: auth(a1),
      payload: { disposition: 'not_answered', durationSeconds: 0, nextActionAt: next },
    });
    // The filter is on the LATEST outcome. A lead that did not answer once and
    // then picked up is not on the "did not answer" list any more.
    await h.app.inject({
      method: 'POST', url: `/leads/${leadId}/calls`, headers: auth(a1),
      payload: { disposition: 'connected_interested', durationSeconds: 120, nextActionAt: next },
    });

    const res = await h.app.inject({
      method: 'GET', url: '/leads?lastDisposition=not_answered', headers: auth(a1),
    });
    const ids = res.json().leads.map((l: { id: string }) => l.id);
    assert.ok(!ids.includes(leadId), 'the latest outcome is what counts');
  });

  it('lists leads never contacted at all', async () => {
    const leadId = makeLeadFor(USERS.callerA1, 'Fresh Never Called');
    const a1 = await login(h.app, EMAILS.callerA1);
    const res = await h.app.inject({ method: 'GET', url: '/leads?due=untouched', headers: auth(a1) });
    const ids = res.json().leads.map((l: { id: string }) => l.id);
    assert.ok(ids.includes(leadId));
  });
});

describe('call outcomes stay in step with the database', () => {
  it('every enum value the database has is offered by the API', async () => {
    // The failure this prevents: an outcome added in SQL that no caller can
    // ever pick, or one offered in the UI that the database rejects at save.
    const inDb = fixtureSql(
      `select enumlabel from pg_enum e join pg_type t on t.oid = e.enumtypid
        where t.typname = 'disposition' order by enumlabel;`,
    ).trim().split('\n').map((s) => s.trim()).filter(Boolean);

    const offered = DISPOSITIONS.map((d) => d.value).sort();
    assert.deepEqual(offered, inDb.sort(), 'the API list and the enum must match exactly');
  });

  it('serves the list to the UI so it carries no copy of its own', async () => {
    const a1 = await login(h.app, EMAILS.callerA1);
    const res = await h.app.inject({ method: 'GET', url: '/meta/dispositions', headers: auth(a1) });
    assert.equal(res.statusCode, 200);
    assert.ok(res.json().some((d: { value: string }) => d.value === 'will_visit'));
  });
});

describe('the new call outcomes', () => {
  const next = () => new Date(Date.now() + 3.6e6).toISOString();

  it('treats a job enquiry as never having been a lead, not as one we lost', async () => {
    // Counting it as lost would quietly wreck every conversion rate on the floor.
    const leadId = makeLeadFor(USERS.callerA1, 'Job Seeker');
    const a1 = await login(h.app, EMAILS.callerA1);
    const res = await h.app.inject({
      method: 'POST', url: `/leads/${leadId}/calls`, headers: auth(a1),
      payload: { disposition: 'job_enquiry', durationSeconds: 45 },
    });
    assert.equal(res.statusCode, 201);
    const row = fixtureSql(`select status from crm.leads where id = '${leadId}';`).trim();
    assert.equal(row, 'invalid');
  });

  it('refuses a promised visit that arrives without the date the client gave', async () => {
    // The owner's rule (0068): the next follow-up date is CHOSEN by the
    // caller from the client's own words, never defaulted by the system.
    const leadId = makeLeadFor(USERS.callerA1, 'Vague Promise');
    const a1 = await login(h.app, EMAILS.callerA1);
    const res = await h.app.inject({
      method: 'POST', url: `/leads/${leadId}/calls`, headers: auth(a1),
      payload: { disposition: 'will_visit', durationSeconds: 120 },
    });
    assert.equal(res.statusCode, 400);
    assert.match(res.json().message, /callbackAt/);
  });

  it('records a promised visit on the exact date the caller chose, and a re-promise moves it', async () => {
    const leadId = makeLeadFor(USERS.callerA1, 'Coming In');
    const a1 = await login(h.app, EMAILS.callerA1);
    const first = new Date(Date.now() + 24 * 3.6e6).toISOString();
    await h.app.inject({
      method: 'POST', url: `/leads/${leadId}/calls`, headers: auth(a1),
      payload: { disposition: 'will_visit', durationSeconds: 120, callbackAt: first },
    });
    let same = fixtureSql(
      `select (walkin_expected_at = '${first}'::timestamptz
               and next_action_at = '${first}'::timestamptz)::text
         from crm.leads where id = '${leadId}';`,
    ).trim();
    assert.equal(same, 'true', 'the chosen date must become both the promise date and the next action');

    // They call again: "come Friday instead". The promise date follows the
    // client, not the first thing they ever said.
    const second = new Date(Date.now() + 72 * 3.6e6).toISOString();
    await h.app.inject({
      method: 'POST', url: `/leads/${leadId}/calls`, headers: auth(a1),
      payload: { disposition: 'will_visit', durationSeconds: 90, callbackAt: second },
    });
    same = fixtureSql(
      `select (walkin_expected_at = '${second}'::timestamptz)::text
         from crm.leads where id = '${leadId}';`,
    ).trim();
    assert.equal(same, 'true', 'a re-promise must move the expected-visit date');
  });

  it('keeps the promise when later calls go unanswered - a will-visit lead never becomes bulk', async () => {
    // The owner's exact complaint: "will visit" on the first call, "not
    // answered" on the second - and the lead used to leave the Will visit
    // list (which keyed on the LAST outcome) and sink into the not-answered
    // bulk pile, then into the breached tab once it sat 48h overdue.
    const leadId = makeLeadFor(USERS.callerA1, 'Promised Then Silent');
    const a1 = await login(h.app, EMAILS.callerA1);
    await h.app.inject({
      method: 'POST', url: `/leads/${leadId}/calls`, headers: auth(a1),
      payload: { disposition: 'will_visit', durationSeconds: 120, callbackAt: next() },
    });
    await h.app.inject({
      method: 'POST', url: `/leads/${leadId}/calls`, headers: auth(a1),
      payload: { disposition: 'not_answered', durationSeconds: 0 },
    });

    // Still on the Will visit list: visit=promised keys on the open promise,
    // not on whatever the phone last did.
    const list = await h.app.inject({
      method: 'GET', url: '/leads?visit=promised', headers: auth(a1),
    });
    assert.equal(list.statusCode, 200);
    assert.ok(
      list.json().leads.some((l: { id: string }) => l.id === leadId),
      'the lead must stay on the visit=promised list after an unanswered dial',
    );

    // Left to rot three days past due - beyond the 48h breach horizon - the
    // open promise still holds the will_visit bucket rather than 'breached'.
    fixtureSql(`update crm.leads set next_action_at = now() - interval '3 days' where id = '${leadId}';`);
    const pipe = await h.app.inject({ method: 'GET', url: '/me/pipeline', headers: auth(a1) });
    const mine = pipe.json().leads.find((l: { lead_id: string }) => l.lead_id === leadId);
    assert.equal(mine?.bucket, 'will_visit', `expected will_visit, got ${mine?.bucket}`);

    // Recording the walk-in resolves the promise; the ordinary rules return.
    await h.app.inject({
      method: 'POST', url: `/leads/${leadId}/walkin`, headers: auth(a1), payload: { walkedIn: true },
    });
    const after = await h.app.inject({
      method: 'GET', url: '/leads?visit=promised', headers: auth(a1),
    });
    assert.ok(
      !after.json().leads.some((l: { id: string }) => l.id === leadId),
      'a recorded walk-in must release the lead from the promised list',
    );
  });

  it('an interested lead is green, stays on the green list, and the attempt cap never parks it', async () => {
    // The owner's rule (0068): a lead with real potential never goes lost or
    // vague on its own - only a person can end it.
    const leadId = makeLeadFor(USERS.callerA1, 'Keen But Unreachable');
    const a1 = await login(h.app, EMAILS.callerA1);
    await h.app.inject({
      method: 'POST', url: `/leads/${leadId}/calls`, headers: auth(a1),
      payload: { disposition: 'connected_interested', durationSeconds: 150, callbackAt: next() },
    });

    const green = await h.app.inject({ method: 'GET', url: '/leads?green=yes', headers: auth(a1) });
    assert.ok(
      green.json().leads.some((l: { id: string }) => l.id === leadId),
      'a positive connect must put the lead on the green list',
    );

    // Eight unanswered dials take it to nine attempts - the count that parks
    // an ordinary lead to nurture. A green one must stay open, with a next
    // action, still on the green list.
    for (let i = 0; i < 8; i++) {
      await h.app.inject({
        method: 'POST', url: `/leads/${leadId}/calls`, headers: auth(a1),
        payload: { disposition: 'not_answered', durationSeconds: 0 },
      });
    }
    // Status may read 'working' or 'callback' (the follow-up booked on the
    // interested call flips it); what matters is that it is NOT parked and
    // still carries a next action.
    const state = fixtureSql(
      `select (status in ('working', 'callback') and next_action_at is not null
               and attempt_count = 9)::text
         from crm.leads where id = '${leadId}';`,
    ).trim();
    assert.equal(state, 'true', 'nine attempts must not park a green lead');

    const still = await h.app.inject({ method: 'GET', url: '/leads?green=yes', headers: auth(a1) });
    assert.ok(
      still.json().leads.some((l: { id: string }) => l.id === leadId),
      'the green light must survive every unanswered dial',
    );
  });

  it('waits days, not an hour, before chasing someone who said they would call', async () => {
    // This is the hourly-nagging complaint: the gap is per outcome and settable.
    const leadId = makeLeadFor(USERS.callerA1, 'Will Ring Us');
    const a1 = await login(h.app, EMAILS.callerA1);
    await h.app.inject({
      method: 'POST', url: `/leads/${leadId}/calls`, headers: auth(a1),
      payload: { disposition: 'will_call_back_self', durationSeconds: 90 },
    });
    const hours = Number(fixtureSql(
      `select round(extract(epoch from (next_action_at - now())) / 3600)
         from crm.leads where id = '${leadId}';`,
    ).trim());
    assert.ok(hours >= 24, `expected at least a day before the chase, got ${hours}h`);
  });

  it('gives a switched-off phone longer than a busy one', async () => {
    const offLead = makeLeadFor(USERS.callerA1, 'Phone Off');
    const a1 = await login(h.app, EMAILS.callerA1);
    await h.app.inject({
      method: 'POST', url: `/leads/${offLead}/calls`, headers: auth(a1),
      payload: { disposition: 'switched_off', durationSeconds: 0 },
    });
    const mins = Number(fixtureSql(
      `select round(extract(epoch from (next_action_at - now())) / 60)
         from crm.leads where id = '${offLead}';`,
    ).trim());
    assert.ok(mins > 60, `a switched-off phone should not be redialled hourly, got ${mins}m`);
  });
});

describe('WhatsApp and walk-ins', () => {
  it('records that a message was sent, and who said so', async () => {
    const leadId = makeLeadFor(USERS.callerA1, 'Messaged');
    const a1 = await login(h.app, EMAILS.callerA1);
    const res = await h.app.inject({
      method: 'POST', url: `/leads/${leadId}/whatsapp`, headers: auth(a1), payload: { sent: true },
    });
    assert.equal(res.statusCode, 200);
    assert.ok(res.json().whatsapp_sent_at);
    assert.equal(res.json().whatsapp_sent_by, USERS.callerA1);
  });

  it('can be un-marked, because people tick things by mistake', async () => {
    const leadId = makeLeadFor(USERS.callerA1, 'Mis-ticked');
    const a1 = await login(h.app, EMAILS.callerA1);
    await h.app.inject({ method: 'POST', url: `/leads/${leadId}/whatsapp`, headers: auth(a1), payload: { sent: true } });
    const off = await h.app.inject({
      method: 'POST', url: `/leads/${leadId}/whatsapp`, headers: auth(a1), payload: { sent: false },
    });
    assert.equal(off.json().whatsapp_sent_at, null);
  });

  it('filters the lead list by whether a message went out', async () => {
    const leadId = makeLeadFor(USERS.callerA1, 'Needs Messaging');
    const a1 = await login(h.app, EMAILS.callerA1);
    const res = await h.app.inject({ method: 'GET', url: '/leads?whatsapp=not_sent', headers: auth(a1) });
    const ids = res.json().leads.map((l: { id: string }) => l.id);
    assert.ok(ids.includes(leadId));
  });

  it('counts a walk-in separately from a promise to visit', async () => {
    const leadId = makeLeadFor(USERS.callerA1, 'Actually Came');
    const a1 = await login(h.app, EMAILS.callerA1);
    const res = await h.app.inject({ method: 'POST', url: `/leads/${leadId}/walkin`, headers: auth(a1) });
    assert.equal(res.statusCode, 200);
    assert.ok(res.json().walked_in_at);
  });
});

describe('performance dashboards', () => {
  it('gives a caller their own numbers', async () => {
    const a1 = await login(h.app, EMAILS.callerA1);
    const res = await h.app.inject({ method: 'GET', url: '/me/performance?days=7', headers: auth(a1) });
    assert.equal(res.statusCode, 200);
    assert.ok(Array.isArray(res.json()));
  });

  it('shows the admin everyone, sortable by walk-ins', async () => {
    const admin = await login(h.app, EMAILS.admin);
    const res = await h.app.inject({
      method: 'GET', url: '/performance?days=7&sort=walked_in', headers: auth(admin),
    });
    assert.equal(res.statusCode, 200);
    const rows = res.json();
    assert.ok(rows.length > 0, 'the admin should see the floor');
    const walkins = rows.map((r: { walked_in: number }) => Number(r.walked_in));
    assert.deepEqual(walkins, [...walkins].sort((a, b) => b - a), 'must come back sorted');
  });

  it('does not let a caller see another caller through it', async () => {
    // RLS draws this line, not the route - which is why it is worth asserting.
    const a1 = await login(h.app, EMAILS.callerA1);
    const res = await h.app.inject({ method: 'GET', url: '/performance?days=7', headers: auth(a1) });
    const others = res.json().filter((r: { user_id: string }) => r.user_id !== USERS.callerA1);
    assert.equal(others.length, 0, 'a caller must only see themselves');
  });

  it('shows a counsellor their own team and not the other one', async () => {
    // The counsellor is the team lead; seeing the other team's numbers would be
    // a peer's performance data, not their own management information.
    const ca = await login(h.app, EMAILS.counsellorA);
    const res = await h.app.inject({ method: 'GET', url: '/performance?days=7', headers: auth(ca) });
    assert.equal(res.statusCode, 200);

    const teamA = fixtureSql(
      `select string_agg(u.id::text, ',') from crm.users u
        where crm.team_of(u.id, current_date)
              = crm.team_of('${USERS.counsellorA}', current_date);`,
    ).trim().split(',');

    for (const row of res.json()) {
      assert.ok(teamA.includes(row.user_id),
        `${row.full_name} is not on the counsellor's team and must not appear`);
    }
  });

  it('reports no rate rather than 0% when there was nothing to divide by', async () => {
    const admin = await login(h.app, EMAILS.admin);
    const res = await h.app.inject({ method: 'GET', url: '/performance?days=7', headers: auth(admin) });
    for (const row of res.json()) {
      if (Number(row.connects) === 0) {
        assert.equal(row.conversion_rate, null,
          'a caller with no connects has no conversion rate, and 0% would rank them unfairly');
      }
    }
  });
});

describe('the UI can read its own poll settings', () => {
  it('serves them to a caller, who is the one being interrupted', async () => {
    const a1 = await login(h.app, EMAILS.callerA1);
    const res = await h.app.inject({ method: 'GET', url: '/meta/ui-settings', headers: auth(a1) });
    assert.equal(res.statusCode, 200);
    assert.ok(res.json()['alerts.poll_seconds'], 'the poll interval must reach a caller');
    assert.ok(Array.isArray(res.json()['alerts.popup_kinds']));
  });
});

describe('the caller can see their whole pipeline, not just today', () => {
  it('shows a follow-up agreed for next week', async () => {
    // The gap the floor found: /me/day stops at midnight, so a lead called on
    // Monday and scheduled for Thursday appeared on no screen in between.
    const leadId = makeLeadFor(USERS.callerA1, 'Next Week');
    fixtureSql(`update crm.leads
                   set next_action_at = now() + interval '6 days',
                       first_touched_at = now(), attempt_count = 1, status = 'working'
                 where id = '${leadId}';`);

    const a1 = await login(h.app, EMAILS.callerA1);
    const day = await h.app.inject({ method: 'GET', url: '/me/day', headers: auth(a1) });
    assert.ok(!day.json().leads.some((l: { lead_id: string }) => l.lead_id === leadId),
      'correctly absent from today');

    const pipe = await h.app.inject({ method: 'GET', url: '/me/pipeline', headers: auth(a1) });
    const row = pipe.json().leads.find((l: { lead_id: string }) => l.lead_id === leadId);
    assert.ok(row, 'but it must be visible somewhere');
    assert.equal(row.bucket, 'followup_upcoming');
  });

  it('separates a follow-up due today from one due later', async () => {
    const todayId = makeLeadFor(USERS.callerA1, 'Due Today');
    fixtureSql(`update crm.leads
                   set next_action_at = now() + interval '2 hours',
                       first_touched_at = now(), attempt_count = 1, status = 'working'
                 where id = '${todayId}';`);
    const a1 = await login(h.app, EMAILS.callerA1);
    const pipe = await h.app.inject({ method: 'GET', url: '/me/pipeline', headers: auth(a1) });
    const row = pipe.json().leads.find((l: { lead_id: string }) => l.lead_id === todayId);
    assert.ok(['followup_today', 'overdue'].includes(row.bucket), `got ${row.bucket}`);
  });

  it('counts every bucket so the tabs can show numbers', async () => {
    const a1 = await login(h.app, EMAILS.callerA1);
    const res = await h.app.inject({ method: 'GET', url: '/me/pipeline', headers: auth(a1) });
    assert.equal(res.statusCode, 200);
    assert.equal(typeof res.json().counts, 'object');
    assert.equal(
      Object.values(res.json().counts as Record<string, number>).reduce((a, b) => a + b, 0),
      res.json().total,
    );
  });

  it('filters to one bucket, which is what the tabs do', async () => {
    const a1 = await login(h.app, EMAILS.callerA1);
    const res = await h.app.inject({
      method: 'GET', url: '/me/pipeline?bucket=followup_upcoming', headers: auth(a1),
    });
    assert.equal(res.statusCode, 200);
    for (const l of res.json().leads) {
      assert.equal(l.bucket, 'followup_upcoming', 'a filtered list must contain only that bucket');
    }
  });

  it('never shows one caller another caller\'s pipeline', async () => {
    const otherId = makeLeadFor(USERS.callerB1, 'Not Yours');
    const a1 = await login(h.app, EMAILS.callerA1);
    const res = await h.app.inject({ method: 'GET', url: '/me/pipeline', headers: auth(a1) });
    assert.ok(!res.json().leads.some((l: { lead_id: string }) => l.lead_id === otherId));
  });
});

describe('alerts are separable by kind', () => {
  it('raises a follow-up that has just come due, distinct from an overdue one', async () => {
    const dueId = makeLeadFor(USERS.callerA1, 'Follow Up Due');
    fixtureSql(`update crm.leads
                   set next_action_at = now() - interval '5 minutes',
                       first_touched_at = now(), attempt_count = 1, status = 'working'
                 where id = '${dueId}';`);

    const lateId = makeLeadFor(USERS.callerA1, 'Follow Up Late');
    fixtureSql(`update crm.leads
                   set next_action_at = now() - interval '3 hours',
                       first_touched_at = now(), attempt_count = 1, status = 'working'
                 where id = '${lateId}';`);

    const a1 = await login(h.app, EMAILS.callerA1);
    const res = await h.app.inject({ method: 'GET', url: '/me/alerts?scope=work', headers: auth(a1) });
    const byLead = Object.fromEntries(
      res.json().alerts.map((a: { lead_id: string; kind: string }) => [a.lead_id, a.kind]),
    );
    assert.equal(byLead[dueId], 'follow_up_due', 'a nudge');
    assert.equal(byLead[lateId], 'action_overdue', 'a problem');
  });

  it('announces a newly assigned lead as its own kind', async () => {
    const leadId = makeLeadFor(USERS.callerA1, 'Just Landed');
    fixtureSql(`update crm.leads
                   set assigned_at = now(), first_touched_at = null, attempt_count = 0,
                       first_touch_due_at = now() + interval '5 minutes', status = 'new'
                 where id = '${leadId}';`);
    const a1 = await login(h.app, EMAILS.callerA1);
    const res = await h.app.inject({ method: 'GET', url: '/me/alerts?scope=work', headers: auth(a1) });
    const kinds = res.json().alerts
      .filter((a: { lead_id: string }) => a.lead_id === leadId)
      .map((a: { kind: string }) => a.kind);
    assert.ok(kinds.includes('new_lead'), `expected new_lead, got ${kinds.join(',')}`);
  });

  it('the bell itself counts only what a person scheduled - the badge can reach zero', async () => {
    // The floor's complaint: 99+ forever, because the badge counted the whole
    // work list. The work list has its own screens; the bell rings for the
    // callback a client asked for, the reminder an owner set, and a real
    // emergency - nothing else.
    const a1 = await login(h.app, EMAILS.callerA1);
    const bell = await h.app.inject({ method: 'GET', url: '/me/alerts', headers: auth(a1) });
    const allowed = new Set(['callback_due', 'callback_soon', 'custom_reminder', 'intake_stalled']);
    for (const a of bell.json().alerts as Array<{ kind: string }>) {
      assert.ok(allowed.has(a.kind), `${a.kind} must not count in the bell`);
    }

    // The same moment, the full list still carries the quiet work - nothing
    // was suppressed, it just stopped ringing.
    const work = await h.app.inject({ method: 'GET', url: '/me/alerts?scope=work', headers: auth(a1) });
    const workKinds = new Set(work.json().alerts.map((a: { kind: string }) => a.kind));
    assert.ok(
      [...workKinds].some((k) => !allowed.has(k as string)),
      'the work scope must still carry the non-ringing kinds',
    );
    assert.ok(work.json().count >= bell.json().count, 'work is a superset of the bell');
  });

  it('only times a person chose interrupt, but nothing is silenced from the bell', async () => {
    // This rule tightened twice, both times on the floor's complaint. Eight
    // kinds used to interrupt; then two; now exactly the two a HUMAN scheduled:
    // the callback the client asked for, and the reminder the lead's owner set
    // for themselves. Everything else still reaches the bell and the Alerts
    // tab in full, which is the distinction that matters: being nagged about
    // a lead and losing a lead are different failures.
    const a1 = await login(h.app, EMAILS.callerA1);
    const cfg = await h.app.inject({ method: 'GET', url: '/meta/ui-settings', headers: auth(a1) });
    const popups = cfg.json()['alerts.popup_kinds'];

    assert.deepEqual([...popups].sort(), ['callback_due', 'custom_reminder']);
    for (const k of ['follow_up_due', 'action_overdue', 'new_lead', 'retap_due', 'callback_soon']) {
      assert.ok(!popups.includes(k), `${k} must not interrupt`);
    }

    // ...and the quiet kinds are still delivered in the work scope, just
    // without a popup and without counting in the bell.
    const alerts = await h.app.inject({ method: 'GET', url: '/me/alerts?scope=work', headers: auth(a1) });
    const kinds = new Set(alerts.json().alerts.map((a: { kind: string }) => a.kind));
    assert.ok(
      [...kinds].some((k) => !popups.includes(k)),
      'non-popup kinds must still be raised as alerts, not suppressed',
    );
  });
});

describe('the leakage board can be worked one problem at a time', () => {
  it('summarises by type only, so one leak is one chip', async () => {
    const cs = await login(h.app, EMAILS.counsellorA);
    const res = await h.app.inject({ method: 'GET', url: '/dashboards/leakage', headers: auth(cs) });
    assert.equal(res.statusCode, 200);
    const types = res.json().summary.map((s: { leak_type: string }) => s.leak_type);
    assert.equal(new Set(types).size, types.length,
      'a leak type must appear once, not once per severity');
  });

  it('names the caller on each leaking lead', async () => {
    const cs = await login(h.app, EMAILS.counsellorA);
    const res = await h.app.inject({ method: 'GET', url: '/dashboards/leakage', headers: auth(cs) });
    const assigned = res.json().items.filter((i: { caller_id: string | null }) => i.caller_id);
    for (const item of assigned) {
      assert.ok(item.caller_name, '"whose is it" is the first question about any leak');
    }
  });
});

describe('the follow-up round filter', () => {
  it('lists leads by how many calls they have had, like the old FU columns', async () => {
    const leadId = makeLeadFor(USERS.callerA1, 'Second Round');
    const a1 = await login(h.app, EMAILS.callerA1);
    const next = new Date(Date.now() + 3.6e6).toISOString();
    for (let i = 0; i < 2; i += 1) {
      await h.app.inject({
        method: 'POST', url: `/leads/${leadId}/calls`, headers: auth(a1),
        payload: { disposition: 'not_answered', durationSeconds: 0, nextActionAt: next },
      });
    }

    const two = await h.app.inject({ method: 'GET', url: '/leads?attempts=2', headers: auth(a1) });
    assert.ok(two.json().leads.some((l: { id: string }) => l.id === leadId),
      'a lead with two calls is due its 2nd follow-up');

    const three = await h.app.inject({ method: 'GET', url: '/leads?attempts=3', headers: auth(a1) });
    assert.ok(!three.json().leads.some((l: { id: string }) => l.id === leadId));
  });

  it('groups the long tail as 5plus rather than a dropdown per number', async () => {
    const leadId = makeLeadFor(USERS.callerA1, 'Eighth Round');
    fixtureSql(`update crm.leads set attempt_count = 8 where id = '${leadId}';`);
    const a1 = await login(h.app, EMAILS.callerA1);
    const res = await h.app.inject({ method: 'GET', url: '/leads?attempts=5plus', headers: auth(a1) });
    assert.ok(res.json().leads.some((l: { id: string }) => l.id === leadId),
      'the eighth follow-up lives in the 5+ list');
  });
});

describe('leaderboard avatars', () => {
  const PIXEL =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

  it('lets an admin set an icon and everyone see it', async () => {
    const admin = await login(h.app, EMAILS.admin);
    const set = await h.app.inject({
      method: 'PUT', url: `/admin/users/${USERS.callerA1}/avatar`, headers: auth(admin),
      payload: { dataUrl: PIXEL },
    });
    assert.equal(set.statusCode, 200);
    assert.equal(set.json().has_avatar, true);

    // The board is visible to every role, so the icons must be too.
    const a2 = await login(h.app, EMAILS.callerA2);
    const seen = await h.app.inject({ method: 'GET', url: '/users/avatars', headers: auth(a2) });
    assert.equal(seen.statusCode, 200);
    assert.equal(seen.json()[USERS.callerA1], PIXEL);
  });

  it('clears an icon with null', async () => {
    const admin = await login(h.app, EMAILS.admin);
    const cleared = await h.app.inject({
      method: 'PUT', url: `/admin/users/${USERS.callerA1}/avatar`, headers: auth(admin),
      payload: { dataUrl: null },
    });
    assert.equal(cleared.statusCode, 200);
    assert.equal(cleared.json().has_avatar, false);
  });

  it('refuses anything that is not a small raster image', async () => {
    const admin = await login(h.app, EMAILS.admin);
    for (const bad of [
      'https://example.com/avatar.png',            // a URL is not an upload
      'data:text/html;base64,PGh0bWw+',            // wrong media type entirely
      'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=', // svg can carry script
    ]) {
      const res = await h.app.inject({
        method: 'PUT', url: `/admin/users/${USERS.callerA1}/avatar`, headers: auth(admin),
        payload: { dataUrl: bad },
      });
      assert.equal(res.statusCode, 400, `${bad.slice(0, 30)} must be rejected`);
    }
  });

  it('does not let a caller set anyone\'s icon', async () => {
    const a1 = await login(h.app, EMAILS.callerA1);
    const res = await h.app.inject({
      method: 'PUT', url: `/admin/users/${USERS.callerA1}/avatar`, headers: auth(a1),
      payload: { dataUrl: PIXEL },
    });
    assert.equal(res.statusCode, 403);
  });
});

describe('lead flow diagnostics ("why is this caller not getting leads")', () => {
  it('names the rule stopping each caller, and shows who is receiving', async () => {
    const cs = await login(h.app, EMAILS.counsellorA);
    const res = await h.app.inject({ method: 'GET', url: '/dashboards/lead-flow', headers: auth(cs) });
    assert.equal(res.statusCode, 200);
    const { callers } = res.json();

    // The before() hook put every caller on the floor, so they all read as
    // receiving - the healthy floor is the baseline the verdicts hang off.
    const a1 = callers.find((c: { user_id: string }) => c.user_id === USERS.callerA1);
    assert.ok(a1, 'every caller appears, whether or not they have leads');
    assert.equal(a1.flow_status, 'receiving');
    assert.equal(a1.has_team_today, true);
  });

  it('reads off_shift the moment a caller leaves the floor', async () => {
    fixtureSql(`update crm.attendance_sessions set ended_at = now()
                 where user_id = '${USERS.callerB2}' and ended_at is null;`);
    const cs = await login(h.app, EMAILS.counsellorA);
    const res = await h.app.inject({ method: 'GET', url: '/dashboards/lead-flow', headers: auth(cs) });
    const b2 = res.json().callers.find((c: { user_id: string }) => c.user_id === USERS.callerB2);
    assert.equal(b2.flow_status, 'off_shift',
      'the panel must name the exact rule: distribution skips callers who are not on shift');
    // Put them back for whatever runs after this.
    fixtureSql(`insert into crm.attendance_sessions (user_id, started_at)
                values ('${USERS.callerB2}', now());`);
  });

  it('is not visible to a caller', async () => {
    const a1 = await login(h.app, EMAILS.callerA1);
    const res = await h.app.inject({ method: 'GET', url: '/dashboards/lead-flow', headers: auth(a1) });
    assert.equal(res.statusCode, 403);
  });

  // The share moves on its own - the nightly ranking hands one caller per team
  // distribution.ace_share_pct of the fresh leads - and until 0061 no screen
  // said so. "Why did all the leads go to her today?" has to be answerable
  // from this panel, or it gets answered by reading a migration file.
  it('names each caller\u2019s actual share of the fresh leads, and who holds the ACE seat', async () => {
    const cs = await login(h.app, EMAILS.counsellorA);
    const before = await h.app.inject({ method: 'GET', url: '/dashboards/lead-flow', headers: auth(cs) });
    const even = before.json().callers
      .filter((c: { team_id: string | null }) => c.team_id !== null)
      .find((c: { user_id: string }) => c.user_id === USERS.callerA1);
    assert.equal(Number(even.fresh_share_pct), 50, 'two equals on the floor split their team evenly');
    assert.equal(even.tier, 'standard');

    fixtureSql(`insert into crm.performance_tiers (user_id, tier)
                values ('${USERS.callerA1}', 'ace')
                on conflict (user_id) do update set tier = 'ace', pinned_by = null,
                  pin_reason = null, pin_expires_at = null;`);

    const res = await h.app.inject({ method: 'GET', url: '/dashboards/lead-flow', headers: auth(cs) });
    const callers = res.json().callers;
    const a1 = callers.find((c: { user_id: string }) => c.user_id === USERS.callerA1);
    const a2 = callers.find((c: { user_id: string }) => c.user_id === USERS.callerA2);

    assert.equal(a1.tier, 'ace');
    assert.ok(Number(a1.fresh_share_pct) > 60, 'the ACE seat is visibly worth two thirds of the team');
    assert.ok(Number(a2.fresh_share_pct) < 40, 'and the rest is visibly what everyone else splits');
    assert.equal(Math.round(Number(a1.fresh_share_pct) + Number(a2.fresh_share_pct)), 100);
    assert.ok(Number.isInteger(Number(a1.days_present_in_window)),
      'the days the ranking measured them over travel with the row');

    fixtureSql(`delete from crm.performance_tiers where user_id = '${USERS.callerA1}';`);
  });

  it('says restricted out loud instead of reporting a caller as receiving nothing', async () => {
    fixtureSql(`insert into crm.performance_tiers (user_id, tier)
                values ('${USERS.callerB1}', 'restricted')
                on conflict (user_id) do update set tier = 'restricted', pinned_by = null,
                  pin_reason = null, pin_expires_at = null;`);
    const cs = await login(h.app, EMAILS.counsellorA);
    const res = await h.app.inject({ method: 'GET', url: '/dashboards/lead-flow', headers: auth(cs) });
    const b1 = res.json().callers.find((c: { user_id: string }) => c.user_id === USERS.callerB1);
    assert.equal(b1.flow_status, 'restricted',
      'a caller barred from fresh leads must not read "receiving leads"');
    assert.equal(Number(b1.fresh_share_pct), 0);
    fixtureSql(`delete from crm.performance_tiers where user_id = '${USERS.callerB1}';`);
  });
});

describe('follow-up radar', () => {
  it('counts an overdue follow-up against the person who owes it', async () => {
    const leadId = makeLeadFor(USERS.callerA1, 'Overdue Radar');
    fixtureSql(`update crm.leads
                   set next_action_at = now() - interval '90 minutes',
                       first_touched_at = now() - interval '1 day'
                 where id = '${leadId}';`);

    const cs = await login(h.app, EMAILS.counsellorA);
    const res = await h.app.inject({ method: 'GET', url: '/dashboards/followups', headers: auth(cs) });
    assert.equal(res.statusCode, 200);
    const row = res.json().find((r: { user_id: string }) => r.user_id === USERS.callerA1);
    assert.ok(Number(row.overdue_now) >= 1, 'the overdue promise shows against its owner');
    assert.ok(Number(row.oldest_overdue_minutes) >= 89, 'and says how late it is');
  });
});

describe('overall standings', () => {
  it('weights every metric into one number and ranks by it', async () => {
    // Give A1 unambiguous dominance today: connects and talk time.
    const leadId = makeLeadFor(USERS.callerA1, 'Standings Fixture');
    const a1 = await login(h.app, EMAILS.callerA1);
    await h.app.inject({
      method: 'POST', url: `/leads/${leadId}/calls`, headers: auth(a1),
      payload: {
        disposition: 'connected_interested', durationSeconds: 300,
        callbackAt: new Date(Date.now() + 3.6e6).toISOString(),
      },
    });

    const res = await h.app.inject({ method: 'GET', url: '/performance/overall?days=1', headers: auth(a1) });
    assert.equal(res.statusCode, 200);
    const rows = res.json();
    assert.ok(rows.length >= 1, 'someone with activity is on the board');
    for (const r of rows) {
      assert.ok(Number(r.overall_points) >= 0 && Number(r.overall_points) <= 100.5,
        'points live on a 0-100 scale');
      assert.ok(Number(r.rank) >= 1);
    }
    // Ordered best first, and the ranks agree with the order.
    const pts = rows.map((r: { overall_points: string }) => Number(r.overall_points));
    assert.deepEqual([...pts].sort((x, y) => y - x), pts, 'sorted by points, best first');
  });

  // The bug that started 0061/0062: a caller back from five days' leave was
  // ranked on totals against a colleague's full week, dropped down the board,
  // and lost the guaranteed fresh-lead share for having been away.
  //
  // Stated positively, which is also what makes it testable against a database
  // full of other tests' calls: the SAME work per day earns the SAME standing,
  // however many days you were there. B1 worked two days and B2 five, at an
  // identical pace - so B2's totals are far larger and their points are not.
  it('gives equal work per day equal standing, however many days were worked', async () => {
    // Days 0..n-1, today included, so both are measured over the same kind of
    // day. Three days each side of the fixture against six: identical pace,
    // wildly different totals.
    for (const [user, days] of [[USERS.callerB1, 3], [USERS.callerB2, 6]] as const) {
      fixtureSql(`
        with made as (
          insert into crm.leads (source_id, full_name, phone_e164, caller_id, team_id,
                                 status, next_action_at)
          select '33333333-0000-0000-0000-000000000001',
                 'Rate ' || d || '-' || i,
                 '+9197' || substr(md5('${user}' || d || i), 1, 8),
                 '${user}', crm.team_of('${user}', current_date), 'working', now()
            from generate_series(0, ${days} - 1) d, generate_series(1, 40) i
          returning id, full_name
        )
        insert into crm.call_attempts
          (lead_id, user_id, started_at, disposition, duration_seconds, is_connect)
        select m.id, '${user}',
               -- Clamped to the past: today's slice must not land in the future
               -- whatever o'clock the suite happens to run at.
               least(((crm.ist_date(now())
                       - split_part(substr(m.full_name, 6), '-', 1)::int)::timestamp
                      + interval '11 hours') at time zone 'Asia/Kolkata',
                     now() - interval '1 minute'),
               case when split_part(m.full_name, '-', 2)::int <= 20
                    then 'connected_interested'::crm.disposition
                    else 'not_answered'::crm.disposition end,
               case when split_part(m.full_name, '-', 2)::int <= 20 then 60 else 0 end,
               split_part(m.full_name, '-', 2)::int <= 20
          from made m;`);
    }

    const admin = await login(h.app, EMAILS.admin);
    const res = await h.app.inject({
      method: 'GET', url: '/performance/overall?days=7', headers: auth(admin),
    });
    assert.equal(res.statusCode, 200);
    const rows = res.json();
    const b1 = rows.find((r: { user_id: string }) => r.user_id === USERS.callerB1);
    const b2 = rows.find((r: { user_id: string }) => r.user_id === USERS.callerB2);
    assert.ok(b1 && b2, 'both callers are on the board');

    assert.ok(Number(b2.dials) > Number(b1.dials) * 1.5,
      'the fixture is the shape of the bug: on raw totals the one who was there more wins easily');
    assert.ok(Number(b2.days_present) > Number(b1.days_present),
      'and the board reports the days each number is out of');

    const spread = Math.abs(Number(b1.overall_points) - Number(b2.overall_points));
    const top = Math.max(Number(b1.overall_points), Number(b2.overall_points));
    assert.ok(spread <= top * 0.15,
      `equal work per day must earn near-equal points, not a 2.5x gap: `
      + `${b1.overall_points} (${b1.days_present}d) vs ${b2.overall_points} (${b2.days_present}d)`);

    // Ordered best first, ranks agreeing with the order, on the same payload.
    const pts = rows.map((r: { overall_points: string }) => Number(r.overall_points));
    assert.deepEqual([...pts].sort((x, y) => y - x), pts, 'still sorted by points, best first');
  });

  it('serves the browser the reminder and refresh cadence settings', async () => {
    const a1 = await login(h.app, EMAILS.callerA1);
    const res = await h.app.inject({ method: 'GET', url: '/meta/ui-settings', headers: auth(a1) });
    const cfg = res.json();
    assert.equal(Number(cfg['alerts.repeat_minutes']), 0,
      'reminders pop once - the repeat nag ships off');
    assert.equal(cfg['alerts.chime'], true, 'the single soft chime ships on');
    assert.ok(Number(cfg['ui.refresh_seconds']) >= 5, 'live screens know their cadence');
  });
});

describe('attendance till date', () => {
  it('rolls up days present, total minutes, and an attendance rate', async () => {
    const a1 = await login(h.app, EMAILS.callerA1);
    const res = await h.app.inject({ method: 'GET', url: '/me/attendance/summary', headers: auth(a1) });
    assert.equal(res.statusCode, 200);
    const s = res.json();
    // The before() hook put every caller on the floor an hour ago, so today
    // exists in everyone's record.
    assert.ok(Number(s.days_present) >= 1);
    assert.ok(Number(s.total_minutes) >= 1, 'time logged till date is real minutes');
    assert.ok(Number(s.floor_days_since_joining) >= Number(s.days_present),
      'the denominator can never be smaller than the days attended');
    assert.ok(Number(s.attendance_pct) > 0 && Number(s.attendance_pct) <= 100);
  });

  it('gives the counsellor the whole floor, but not a caller', async () => {
    const cs = await login(h.app, EMAILS.counsellorA);
    const all = await h.app.inject({ method: 'GET', url: '/attendance/summary', headers: auth(cs) });
    assert.equal(all.statusCode, 200);
    assert.ok(all.json().length >= 4, 'every active person with a record appears');

    const a1 = await login(h.app, EMAILS.callerA1);
    const own = await h.app.inject({ method: 'GET', url: '/attendance/summary', headers: auth(a1) });
    assert.equal(own.statusCode, 403, 'the floor-wide rollup is for floor managers');
  });

  it('never counts a day the floor did not work against anyone', async () => {
    // A fresh floor day exists only if someone was present on it - so the
    // denominator equals the count of distinct business dates in the sessions
    // table from the person''s first day, by construction.
    const days = fixtureSql(`select count(distinct business_date) from crm.attendance_sessions;`).trim();
    const cs = await login(h.app, EMAILS.counsellorA);
    const all = await h.app.inject({ method: 'GET', url: '/attendance/summary', headers: auth(cs) });
    for (const row of all.json()) {
      assert.ok(Number(row.floor_days_since_joining) <= Number(days));
    }
  });

  it('a forgotten End shift never eats the next day, and never blocks it', async () => {
    // Yesterday, 09:30 IST, never ended - the exact shape that inflated
    // "time logged" across absent days and made Start shift refuse forever.
    fixtureSql(`
      insert into crm.attendance_sessions (user_id, started_at)
      values ('${USERS.mentor}',
              ((crm.ist_date(now()) - 1)::timestamp + interval '4 hours')
                at time zone 'Asia/Kolkata');
    `);

    const m = await login(h.app, EMAILS.mentor);
    const res = await h.app.inject({
      method: 'POST', url: '/attendance/login', headers: auth(m),
    });
    assert.equal(res.statusCode, 201, 'Start shift works despite yesterday\'s open session');

    const stale = fixtureSql(`
      select ended_reason || ':' || round(extract(epoch from (ended_at - started_at)) / 60)::text
        from crm.attendance_sessions
       where user_id = '${USERS.mentor}' order by started_at asc limit 1;
    `).trim();
    assert.equal(stale, 'stale_shift_closed:1',
      'the stale shift is closed at its honest end, not carried into today');

    const summary = await h.app.inject({
      method: 'GET', url: '/me/attendance/summary', headers: auth(m),
    });
    // Present means worked: the stale one-minute day stays on record but is
    // not attendance - only today, being worked right now, counts.
    assert.equal(Number(summary.json().days_present), 1,
      'the forgotten one-minute day is not a present day');
    assert.ok(Number(summary.json().total_minutes) < 24 * 60,
      'and the total is hours actually worked, not elapsed calendar time');

    await h.app.inject({ method: 'POST', url: '/attendance/logout', headers: auth(m) });
  });
});

describe('escalation ladder and pools (API)', () => {
  it('escalates a lead to the counsellor after two no-connect caller attempts, and off the caller pipeline', async () => {
    const leadId = makeLeadFor(USERS.callerA1, 'API Escalate');
    const a1 = await login(h.app, EMAILS.callerA1);
    for (let i = 0; i < 2; i += 1) {
      const r = await h.app.inject({
        method: 'POST', url: `/leads/${leadId}/calls`, headers: auth(a1),
        payload: { disposition: 'not_answered', durationSeconds: 0 },
      });
      assert.equal(r.statusCode, 201);
    }
    // The caller no longer sees it in their pipeline (it belongs to the counsellor now).
    const mine = await h.app.inject({ method: 'GET', url: '/me/pipeline', headers: auth(a1) });
    assert.ok(!mine.json().leads.some((l: { lead_id: string }) => l.lead_id === leadId),
      'an escalated lead leaves the caller pipeline');

    const cs = await login(h.app, EMAILS.counsellorA);
    const theirs = await h.app.inject({ method: 'GET', url: '/me/pipeline', headers: auth(cs) });
    assert.ok(theirs.json().leads.some((l: { lead_id: string }) => l.lead_id === leadId),
      'and appears on the counsellor pipeline');
  });

  it('drops a lead into the re-tap pool when the counsellor also cannot reach it, with no overdue alert', async () => {
    const leadId = makeLeadFor(USERS.callerA1, 'API Retap');
    const a1 = await login(h.app, EMAILS.callerA1);
    for (let i = 0; i < 2; i += 1) {
      await h.app.inject({
        method: 'POST', url: `/leads/${leadId}/calls`, headers: auth(a1),
        payload: { disposition: 'not_answered', durationSeconds: 0 },
      });
    }
    const cs = await login(h.app, EMAILS.counsellorA);
    await h.app.inject({
      method: 'POST', url: `/leads/${leadId}/calls`, headers: auth(cs),
      payload: { disposition: 'not_answered', durationSeconds: 0 },
    });
    const pool = await h.app.inject({ method: 'GET', url: '/me/retap-pool', headers: auth(cs) });
    assert.ok(pool.json().leads.some((l: { lead_id: string }) => l.lead_id === leadId),
      'the unreachable lead is parked in the re-tap pool');

    const alerts = await h.app.inject({ method: 'GET', url: '/me/alerts?scope=work', headers: auth(cs) });
    assert.ok(!alerts.json().alerts.some(
      (a: { lead_id: string; kind: string }) => a.lead_id === leadId && a.kind.includes('overdue')),
      'a re-tap lead never nags as overdue, even in the full work list');
  });

  it('lets someone claim a parked lead back into live work', async () => {
    const leadId = makeLeadFor(USERS.callerA1, 'API Claim');
    fixtureSql(`update crm.leads set status='nurture', pool='retap', retap_since=now(),
                 next_action_at=null where id='${leadId}';`);
    const cs = await login(h.app, EMAILS.counsellorA);
    const r = await h.app.inject({ method: 'POST', url: `/leads/${leadId}/claim`, headers: auth(cs) });
    assert.equal(r.statusCode, 200);
    assert.equal(r.json().status, 'working');
    assert.equal(r.json().pool, null);
  });

  it('keeps the lead with its caller once the counsellor daily cap is reached', async () => {
    // The cap turns "give the counsellors the unreachable leads" into a
    // workable number (15/day shipped). Shrink it to what counsellor A has
    // already received today, so the next hand-up finds no room.
    fixtureSql(`update crm.settings s
                   set value = to_jsonb(coalesce((
                         select count(*) from crm.lead_events e
                          where e.event_type = 'escalated_to_counsellor'
                            and e.occurred_at >= (crm.ist_date(now()))::timestamp at time zone 'Asia/Kolkata'
                            and (e.payload->>'counsellor_id')::uuid = '${USERS.counsellorA}'), 0))
                 where s.key = 'escalation.counsellor_daily_cap';`);

    const leadId = makeLeadFor(USERS.callerA1, 'API Capped');
    const a1 = await login(h.app, EMAILS.callerA1);
    for (let i = 0; i < 2; i += 1) {
      await h.app.inject({
        method: 'POST', url: `/leads/${leadId}/calls`, headers: auth(a1),
        payload: { disposition: 'not_answered', durationSeconds: 0 },
      });
    }

    const stage = fixtureSql(
      `select escalation_stage || ' ' || na_streak from crm.leads where id='${leadId}';`,
    ).trim();
    assert.equal(stage, 'caller 2',
      'past the cap the lead stays with its caller, identifiable by its streak');

    const mine = await h.app.inject({ method: 'GET', url: '/me/pipeline', headers: auth(a1) });
    assert.ok(mine.json().leads.some((l: { lead_id: string }) => l.lead_id === leadId),
      'and it is still on the caller pipeline, not lost');

    // Restore the shipped cap; the next failed attempt hands the lead up.
    fixtureSql(`update crm.settings set value='15'::jsonb
                 where key='escalation.counsellor_daily_cap';`);
    await h.app.inject({
      method: 'POST', url: `/leads/${leadId}/calls`, headers: auth(a1),
      payload: { disposition: 'not_answered', durationSeconds: 0 },
    });
    const after = fixtureSql(
      `select escalation_stage from crm.leads where id='${leadId}';`,
    ).trim();
    assert.equal(after, 'counsellor', 'with room again, the next failed attempt escalates');
  });

  it('lists not-answered-twice leads through the na filter, badge-ready', async () => {
    const leadId = makeLeadFor(USERS.callerA1, 'API NA Twice');
    fixtureSql(`update crm.leads set na_streak = 2, attempt_count = 2,
                 first_touched_at = now() where id='${leadId}';`);
    const a1 = await login(h.app, EMAILS.callerA1);
    const res = await h.app.inject({ method: 'GET', url: '/leads?na=2plus', headers: auth(a1) });
    assert.equal(res.statusCode, 200);
    const mine = res.json().leads.find((l: { id: string }) => l.id === leadId);
    assert.ok(mine, 'the twice-unanswered lead is one filter away');
    assert.ok(Number(mine.na_streak) >= 2, 'and carries the streak the badge shows');
  });
});

describe('per-lead reminders (API)', () => {
  it('mutes a lead so it raises no reminder', async () => {
    const leadId = makeLeadFor(USERS.callerA1, 'API Mute');
    fixtureSql(`update crm.leads set next_action_at = now() - interval '2 hours',
                 first_touched_at = now() - interval '3 hours', attempt_count = 1
               where id='${leadId}';`);
    const a1 = await login(h.app, EMAILS.callerA1);
    const before = await h.app.inject({ method: 'GET', url: '/me/alerts?scope=work', headers: auth(a1) });
    assert.ok(before.json().alerts.some((a: { lead_id: string }) => a.lead_id === leadId),
      'an overdue lead alerts before muting');

    const put = await h.app.inject({
      method: 'PUT', url: `/leads/${leadId}/reminder`, headers: auth(a1),
      payload: { muted: true },
    });
    assert.equal(put.statusCode, 200);
    assert.equal(put.json().reminder_muted, true);

    const after = await h.app.inject({ method: 'GET', url: '/me/alerts?scope=work', headers: auth(a1) });
    assert.ok(!after.json().alerts.some((a: { lead_id: string }) => a.lead_id === leadId),
      'and is silent after muting');
  });

  it('raises a custom reminder at the chosen time', async () => {
    const leadId = makeLeadFor(USERS.callerA1, 'API Custom Reminder');
    fixtureSql(`update crm.leads set first_touched_at = now() - interval '1 hour',
                 attempt_count = 1 where id='${leadId}';`);
    const a1 = await login(h.app, EMAILS.callerA1);
    const past = new Date(Date.now() - 60_000).toISOString();
    await h.app.inject({
      method: 'PUT', url: `/leads/${leadId}/reminder`, headers: auth(a1),
      payload: { at: past, note: 'Call after lunch' },
    });
    const alerts = await h.app.inject({ method: 'GET', url: '/me/alerts', headers: auth(a1) });
    assert.ok(alerts.json().alerts.some(
      (a: { lead_id: string; kind: string }) => a.lead_id === leadId && a.kind === 'custom_reminder'),
      'the custom reminder fires once it is due');
  });
});

describe('lead location and the admin archive (API)', () => {
  it('lets the caller set the lead\'s location, and clear a wrong one', async () => {
    const leadId = makeLeadFor(USERS.callerA1, 'API Locate');
    const a1 = await login(h.app, EMAILS.callerA1);

    const set = await h.app.inject({
      method: 'PUT', url: `/leads/${leadId}/city`, headers: auth(a1),
      payload: { city: '  Kanpur ' },
    });
    assert.equal(set.statusCode, 200);
    assert.equal(set.json().city, 'Kanpur', 'stored trimmed, as typed');

    const clear = await h.app.inject({
      method: 'PUT', url: `/leads/${leadId}/city`, headers: auth(a1),
      payload: { city: null },
    });
    assert.equal(clear.json().city, null, 'a wrong guess must not stick forever');
  });

  it('archives old leads from Admin: dry run counts, the real run parks, a caller is refused', async () => {
    const oldId = makeLeadFor(USERS.callerA1, 'API Old Lead');
    fixtureSql(`update crm.leads set created_at = '2026-08-01T10:00:00+05:30'
                 where id = '${oldId}';`);

    const a1 = await login(h.app, EMAILS.callerA1);
    const denied = await h.app.inject({
      method: 'POST', url: '/admin/archive-leads', headers: auth(a1),
      payload: { before: '2026-08-15', dryRun: true },
    });
    assert.equal(denied.statusCode, 403, 'parking the lead book is an owner act');

    const admin = await login(h.app, EMAILS.admin);
    const dry = await h.app.inject({
      method: 'POST', url: '/admin/archive-leads', headers: auth(admin),
      payload: { before: '2026-08-15', dryRun: true },
    });
    assert.equal(dry.statusCode, 200);
    assert.ok(Number(dry.json().archived) >= 1, 'the dry run counts the old lead');
    assert.equal(
      fixtureSql(`select pool is null from crm.leads where id = '${oldId}';`).trim(),
      't', 'the dry run moves nothing');

    const real = await h.app.inject({
      method: 'POST', url: '/admin/archive-leads', headers: auth(admin),
      payload: { before: '2026-08-15', dryRun: false },
    });
    assert.ok(Number(real.json().archived) >= 1);
    assert.equal(
      fixtureSql(`select status || ' ' || coalesce(pool, '-')
                    from crm.leads where id = '${oldId}';`).trim(),
      'nurture previous_month', 'the old lead parks in Previous months');
  });
});

describe('performance tiers: ranked daily, pinnable by the admin (API)', () => {
  it('serves every caller\'s tier alongside the user list', async () => {
    const cs = await login(h.app, EMAILS.counsellorA);
    const res = await h.app.inject({ method: 'GET', url: '/admin/users', headers: auth(cs) });
    assert.equal(res.statusCode, 200);
    const callers = res.json().filter((u: { role: string }) => u.role === 'caller');
    assert.ok(callers.length >= 4);
    for (const c of callers) {
      assert.ok(['ace', 'standard', 'restricted'].includes(c.tier),
        `caller tier must be real, got ${c.tier}`);
    }
  });

  it('lets the admin pin a tier with a reason, and hand it back to the ranking', async () => {
    const a1 = await login(h.app, EMAILS.callerA1);
    const denied = await h.app.inject({
      method: 'PUT', url: `/admin/users/${USERS.callerB2}/tier`, headers: auth(a1),
      payload: { mode: 'pin', tier: 'ace', reason: 'myself, obviously' },
    });
    assert.equal(denied.statusCode, 403, 'a caller cannot set tiers');

    const admin = await login(h.app, EMAILS.admin);
    const pin = await h.app.inject({
      method: 'PUT', url: `/admin/users/${USERS.callerB2}/tier`, headers: auth(admin),
      payload: { mode: 'pin', tier: 'restricted', reason: 'test: quality hold' },
    });
    assert.equal(pin.statusCode, 200);
    assert.equal(pin.json().tier, 'restricted');

    const listed = await h.app.inject({ method: 'GET', url: '/admin/users', headers: auth(admin) });
    const b2 = listed.json().find((u: { id: string }) => u.id === USERS.callerB2);
    assert.equal(b2.tier, 'restricted');
    assert.equal(b2.tier_pinned, true, 'the pin shows as a pin');

    // Back to the ranking: standard immediately, not restricted-for-15-more-minutes.
    const auto = await h.app.inject({
      method: 'PUT', url: `/admin/users/${USERS.callerB2}/tier`, headers: auth(admin),
      payload: { mode: 'auto' },
    });
    assert.equal(auto.statusCode, 200);
    const after = await h.app.inject({ method: 'GET', url: '/admin/users', headers: auth(admin) });
    const b2After = after.json().find((u: { id: string }) => u.id === USERS.callerB2);
    assert.equal(b2After.tier, 'standard');
    assert.equal(b2After.tier_pinned, false);
  });

  it('a pin without a reason is refused - tier changes are audited decisions', async () => {
    const admin = await login(h.app, EMAILS.admin);
    const res = await h.app.inject({
      method: 'PUT', url: `/admin/users/${USERS.callerB2}/tier`, headers: auth(admin),
      payload: { mode: 'pin', tier: 'ace', reason: '' },
    });
    assert.equal(res.statusCode, 400);
  });
});

describe('team chat (API)', () => {
  it('lets an admin broadcast to the whole floor, and everyone reads it', async () => {
    const admin = await login(h.app, EMAILS.admin);
    const post = await h.app.inject({
      method: 'POST', url: '/messages', headers: auth(admin),
      payload: { body: 'Stand-up at 9:30 sharp.' },
    });
    assert.equal(post.statusCode, 201);

    const a1 = await login(h.app, EMAILS.callerA1);
    const feed = await h.app.inject({ method: 'GET', url: '/messages', headers: auth(a1) });
    assert.ok(feed.json().some((m: { body: string }) => m.body === 'Stand-up at 9:30 sharp.'),
      'a floor-wide message reaches a caller');
  });

  it('lets a caller reply, but only inside their own fence', async () => {
    // The floor asked to answer back, so the admin-only megaphone rule is
    // gone - a caller may post to the floor or their own team, and the fence
    // that remains is the other team's channel, held by RLS below.
    const a1 = await login(h.app, EMAILS.callerA1);
    const r = await h.app.inject({
      method: 'POST', url: '/messages', headers: auth(a1),
      payload: { body: 'Acknowledged.' },
    });
    assert.equal(r.statusCode, 201);
  });
});

describe('historical upload (API)', () => {
  it('imports previous-month records into the pool, deduping re-uploads', async () => {
    const admin = await login(h.app, EMAILS.admin);
    const csv = 'Full Name,Phone Number,City\nApril Client,9812000001,Pune\nApril Two,9812000002,Mumbai';
    const teamId = fixtureSql(`select id from crm.teams order by rotation_order limit 1;`).trim();

    const first = await h.app.inject({
      method: 'POST', url: '/admin/history/import', headers: auth(admin),
      payload: { csv, teamId, month: '2026-04' },
    });
    assert.equal(first.statusCode, 200);
    assert.equal(first.json().created, 2);

    // Re-uploading the same month is idempotent - all duplicates, nothing new.
    const again = await h.app.inject({
      method: 'POST', url: '/admin/history/import', headers: auth(admin),
      payload: { csv, teamId, month: '2026-04' },
    });
    assert.equal(again.json().created, 0);
    assert.equal(again.json().duplicate, 2);

    const months = await h.app.inject({
      method: 'GET', url: '/dashboards/previous-months', headers: auth(admin),
    });
    assert.ok(months.json().months.some((m: { month: string; leads: number }) => m.month === '2026-04' && m.leads >= 2));
  });

  it('does not let a caller import history', async () => {
    const a1 = await login(h.app, EMAILS.callerA1);
    const r = await h.app.inject({
      method: 'POST', url: '/admin/history/import', headers: auth(a1),
      payload: { csv: 'Full Name,Phone Number\nX,9812000009', teamId: USERS.callerA1, month: '2026-04' },
    });
    assert.equal(r.statusCode, 403);
  });
});

describe('live floor activity (API)', () => {
  it('reflects a logged outcome on the floor feed, filterable by disposition', async () => {
    const leadId = makeLeadFor(USERS.callerA1, 'API Activity');
    const a1 = await login(h.app, EMAILS.callerA1);
    await h.app.inject({
      method: 'POST', url: `/leads/${leadId}/calls`, headers: auth(a1),
      payload: { disposition: 'connected_interested', durationSeconds: 120,
                 callbackAt: new Date(Date.now() + 3.6e6).toISOString() },
    });
    const cs = await login(h.app, EMAILS.counsellorA);
    const feed = await h.app.inject({
      method: 'GET', url: '/dashboards/activity?disposition=connected_interested', headers: auth(cs),
    });
    assert.equal(feed.statusCode, 200);
    assert.ok(feed.json().some((r: { lead_id: string }) => r.lead_id === leadId),
      'the interested outcome shows on the floor feed at once');
  });
});

describe('a signed-in user can change their own password', () => {
  it('changes it with the current password, and the old one stops working', async () => {
    const token = await login(h.app, EMAILS.callerA2);
    const res = await h.app.inject({
      method: 'POST', url: '/auth/change-password', headers: auth(token),
      payload: { currentPassword: TEST_PASSWORD, newPassword: 'a-brand-new-secret-1' },
    });
    assert.equal(res.statusCode, 200);

    const old = await h.app.inject({
      method: 'POST', url: '/auth/login',
      payload: { email: EMAILS.callerA2, password: TEST_PASSWORD },
    });
    assert.equal(old.statusCode, 401, 'the old password must die immediately');

    const fresh = await h.app.inject({
      method: 'POST', url: '/auth/login',
      payload: { email: EMAILS.callerA2, password: 'a-brand-new-secret-1' },
    });
    assert.equal(fresh.statusCode, 200);
  });

  it('refuses without the current password, so a walk-up cannot hijack a session', async () => {
    const token = await login(h.app, EMAILS.callerB1);
    const res = await h.app.inject({
      method: 'POST', url: '/auth/change-password', headers: auth(token),
      payload: { currentPassword: 'wrong-guess-here', newPassword: 'whatever-else-12' },
    });
    assert.equal(res.statusCode, 401);
  });
});

describe('a forgotten shift ends itself', () => {
  it('logs out an hour-idle session, backdated to the last real activity', async () => {
    // A dedicated user, so no other test's shift activity can muddy the shape:
    // on the floor three hours, never dialled, never opened a lead.
    fixtureSql(`
      insert into crm.users (id, full_name, email, role)
      values ('22222222-0000-0000-0000-0000000000fa', 'Forgot To Leave', 'forgot@5circles.test', 'caller')
      on conflict do nothing;
      insert into crm.attendance_sessions (user_id, started_at)
      values ('22222222-0000-0000-0000-0000000000fa', now() - interval '3 hours');
    `);
    const closed = Number(fixtureSql(`select crm.auto_logout_idle();`).trim());
    assert.ok(closed >= 1, 'the idle session must be closed');

    const row = fixtureSql(`
      select ended_reason || ' ' || (ended_at < now() - interval '30 minutes')
        from crm.attendance_sessions
       where user_id = '22222222-0000-0000-0000-0000000000fa' and ended_reason = 'auto_idle'
       order by started_at desc limit 1;`).trim();
    assert.equal(row, 'auto_idle true',
      'the silent hours are backdated away - idle time is not hours worked');
  });

  it('leaves an active session alone', async () => {
    const leadId = makeLeadFor(USERS.callerA1, 'Keeps Working');
    fixtureSql(`
      insert into crm.call_attempts (lead_id, user_id, disposition, duration_seconds, started_at)
      values ('${leadId}', '${USERS.callerA1}', 'not_answered', 0, now() - interval '5 minutes');
    `);
    fixtureSql(`select crm.auto_logout_idle();`);
    const open = fixtureSql(`
      select count(*) from crm.attendance_sessions
       where user_id = '${USERS.callerA1}' and ended_at is null;`).trim();
    assert.equal(open, '1', 'a caller who dialled five minutes ago is not idle');
  });
});

describe('everyone can speak in team chat', () => {
  it('lets a caller reply to the floor', async () => {
    const a1 = await login(h.app, EMAILS.callerA1);
    const res = await h.app.inject({
      method: 'POST', url: '/messages', headers: auth(a1),
      payload: { body: 'Acknowledged - on it.' },
    });
    assert.equal(res.statusCode, 201);
  });

  it('stops a caller posting into the other team\'s channel', async () => {
    const a1 = await login(h.app, EMAILS.callerA1);
    const teamB = fixtureSql(`select id from crm.teams where name = 'Team B';`).trim();
    const res = await h.app.inject({
      method: 'POST', url: '/messages', headers: auth(a1),
      payload: { body: 'sneaking in', teamId: teamB },
    });
    assert.equal(res.statusCode, 403, 'RLS must fence the channels, not the UI');
  });
});

describe('advisory clients register', () => {
  it('a client appears the moment real money is recorded, flagged until MITC and KYC are done', async () => {
    const leadId = makeLeadFor(USERS.callerA1, 'Paying Client');
    fixtureSql(`
      insert into crm.deals (id, lead_id, product_id, counsellor_id, booked_amount)
      values ('77777777-0000-0000-0000-000000000001', '${leadId}',
              (select id from crm.products limit 1), '${USERS.counsellorA}', 50000);
      insert into crm.payments (deal_id, amount, mode, recorded_by)
      values ('77777777-0000-0000-0000-000000000001', 20000, 'upi', '${USERS.counsellorA}');
    `);
    const cs = await login(h.app, EMAILS.counsellorA);
    const res = await h.app.inject({ method: 'GET', url: '/advisory', headers: auth(cs) });
    assert.equal(res.statusCode, 200);
    const row = res.json().find((r: { deal_id: string }) => r.deal_id === '77777777-0000-0000-0000-000000000001');
    assert.ok(row, 'paid means listed - booked-but-unpaid does not');
    assert.equal(row.client_status, 'active');
    assert.equal(row.mitc_done_at, null, 'checkpoints start pending');
  });

  it('ticking MITC records who and when, and it cannot be unticked', async () => {
    const cs = await login(h.app, EMAILS.counsellorA);
    const res = await h.app.inject({
      method: 'PUT', url: '/advisory/77777777-0000-0000-0000-000000000001',
      headers: auth(cs), payload: { mitcDone: true },
    });
    assert.equal(res.statusCode, 200);
    assert.ok(res.json().mitc_done_at);
    assert.equal(res.json().mitc_by, USERS.counsellorA);
  });

  it('a caller cannot reach the register at all', async () => {
    const a1 = await login(h.app, EMAILS.callerA1);
    const res = await h.app.inject({ method: 'GET', url: '/advisory', headers: auth(a1) });
    assert.equal(res.statusCode, 403);
  });
});

describe('every role gets the new screens, not just admin', () => {
  // The whole point of this suite: these features were built for the floor,
  // and a caller or a mentor seeing an empty page or a 403 would mean they
  // silently only worked for whoever built them. Each row is
  // [role, endpoint, expected status]. 403 appears only where the refusal is
  // the intended behaviour, and each of those is spelled out.
  const MATRIX: Array<[keyof typeof EMAILS, string, number, string]> = [
    // The daily brief: everybody who has numbers of their own.
    ['callerA1', '/me/brief', 200, 'a caller sees their own dials and SLA'],
    ['counsellorA', '/me/brief', 200, 'a counsellor sees the money arithmetic'],
    ['mentor', '/me/brief', 200, 'a mentor gets the shell of it, with no targets'],
    ['admin', '/me/brief', 200, 'an admin gets the floor roll-up'],
    ['ops', '/me/brief', 200, 'ops likewise'],

    // Fresh leads.
    ['callerA1', '/me/fresh', 200, 'a caller sees their own never-contacted leads'],
    ['counsellorA', '/me/fresh?scope=all', 200, 'a counsellor sees the whole floor'],
    ['admin', '/me/fresh?scope=all', 200, 'an admin sees the whole floor'],
    ['ops', '/me/fresh?scope=all', 200, 'ops sees the whole floor'],
    ['founder', '/me/fresh?scope=all', 200, 'and the founder, for oversight'],

    // The quiet no-answer pool.
    ['callerA1', '/me/no-answer-pool', 200, 'a caller works their own re-tap batch'],
    ['counsellorA', '/me/no-answer-pool?scope=team', 200, 'a counsellor sees the team pool'],
    ['admin', '/me/no-answer-pool?scope=team', 200, 'an admin sees it too'],
    ['founder', '/me/no-answer-pool?scope=team', 200, 'and the founder'],

    // The alerts list behind the bell.
    ['callerA1', '/me/alerts', 200, 'the bell works for callers'],
    ['counsellorA', '/me/alerts', 200, 'and counsellors'],
    ['mentor', '/me/alerts', 200, 'and mentors'],
    ['admin', '/me/alerts', 200, 'and admins'],

    // The ticker strip above every screen.
    ['callerA1', '/dashboards/ticker', 200, 'the ticker is not admin-only'],
    ['mentor', '/dashboards/ticker', 200, 'mentors see it as well'],

    // Training: the entire floor, no exceptions.
    ['callerA1', '/training', 200, 'callers get the academy'],
    ['mentor', '/training', 200, 'mentors get the academy'],
    ['ops', '/training', 200, 'ops gets the academy'],
    ['admin', '/training/registry', 200, 'and the glossary'],
    ['callerA1', '/training/registry', 200, 'callers get the glossary too'],

    // Mentors and Advisory.
    ['mentor', '/mentors/book', 200, 'a mentor reads their own book'],
    ['counsellorA', '/mentors/book', 200, 'a counsellor reads it for the warm pipeline'],
    ['callerA1', '/mentors/book', 403, 'a caller has no business in the client book'],
    ['counsellorA', '/advisory', 200, 'a counsellor works the compliance checklist'],
    ['callerA1', '/advisory', 403, 'a caller does not'],

    // Events: everyone, because the roster is shared on purpose.
    ['callerA1', '/events', 200, 'callers see events'],
    ['mentor', '/events', 200, 'mentors see events'],
    ['counsellorA', '/events/followups/open', 200, 'and the post-event task list'],

    // Lead flow, including the per-team waiting breakdown.
    ['counsellorA', '/dashboards/lead-flow', 200, 'a counsellor can diagnose waiting leads'],
    ['admin', '/dashboards/lead-flow', 200, 'so can an admin'],
    ['callerA1', '/dashboards/lead-flow', 403, 'a caller does not manage distribution'],
  ];

  for (const [role, url, expected, why] of MATRIX) {
    it(`${role} → ${url} → ${expected} (${why})`, async () => {
      const token = await login(h.app, EMAILS[role]);
      const res = await h.app.inject({ method: 'GET', url, headers: auth(token) });
      assert.equal(res.statusCode, expected, `${role} on ${url}: ${res.body.slice(0, 160)}`);
    });
  }

  it('a mentor gets a brief with no revenue target rather than a broken page', async () => {
    const m = await login(h.app, EMAILS.mentor);
    const res = await h.app.inject({ method: 'GET', url: '/me/brief', headers: auth(m) });
    assert.equal(res.statusCode, 200);
    // v_daily_brief covers callers and counsellors; a mentor legitimately has
    // no row. The endpoint must still answer cleanly.
    assert.ok('brief' in res.json(), 'the shape is always the same');
  });
});

describe('fresh leads have their own list', () => {
  it('lists never-contacted leads with a flag, and keeps late ones on the list', async () => {
    const inTime = makeLeadFor(USERS.callerA1, 'Fresh Timely');
    const late = makeLeadFor(USERS.callerA1, 'Fresh Overdue');
    fixtureSql(`
      update crm.leads set assigned_at = now() - interval '5 minutes',
             first_touch_due_at = now() + interval '25 minutes',
             first_touched_at = null, attempt_count = 0
       where id = '${inTime}';
      update crm.leads set assigned_at = now() - interval '4 hours',
             first_touch_due_at = now() - interval '3 hours',
             first_touched_at = null, attempt_count = 0
       where id = '${late}';
    `);

    const a1 = await login(h.app, EMAILS.callerA1);
    const res = await h.app.inject({ method: 'GET', url: '/me/fresh', headers: auth(a1) });
    assert.equal(res.statusCode, 200);
    const byId = new Map(res.json().leads.map((l: { lead_id: string }) => [l.lead_id, l]));

    assert.equal((byId.get(inTime) as { flag: string }).flag, 'waiting');
    assert.equal((byId.get(late) as { flag: string }).flag, 'flagged',
      'a late fresh lead is flagged, never dropped from the list');
    assert.ok(Number((byId.get(late) as { minutes_late: number }).minutes_late) > 0);
  });

  it('the flag filter narrows without hiding anything permanently', async () => {
    const a1 = await login(h.app, EMAILS.callerA1);
    const flagged = await h.app.inject({
      method: 'GET', url: '/me/fresh?flag=flagged', headers: auth(a1),
    });
    for (const l of flagged.json().leads) {
      assert.equal(l.flag, 'flagged');
    }
    const all = await h.app.inject({ method: 'GET', url: '/me/fresh', headers: auth(a1) });
    assert.ok(all.json().count >= flagged.json().count);
  });

  it('a counsellor can see the whole floor, including leads with no caller', async () => {
    const teamA = fixtureSql(`select id from crm.teams where name = 'Team A';`).trim();
    fixtureSql(`
      insert into crm.leads (source_id, full_name, phone_e164, team_id, status,
                             first_touch_due_at, next_action_at, next_action_note)
      values ('${SOURCES.meta}', 'Fresh No Owner', '+919555950001', '${teamA}', 'new',
              now() - interval '2 hours', now() - interval '2 hours', 'First contact');
    `);
    const cs = await login(h.app, EMAILS.counsellorA);
    const res = await h.app.inject({
      method: 'GET', url: '/me/fresh?scope=all', headers: auth(cs),
    });
    const row = res.json().leads.find(
      (l: { full_name: string }) => l.full_name === 'Fresh No Owner',
    );
    assert.ok(row, 'a lead nobody owns still appears somewhere');
    assert.equal(row.user_id, null);
    assert.ok(res.json().teams.length > 0, 'with a per-team summary');
  });

  it('one real attempt removes a lead from the fresh list for good', async () => {
    const lead = makeLeadFor(USERS.callerA1, 'Fresh Then Called');
    fixtureSql(`
      update crm.leads set first_touched_at = null, attempt_count = 0,
             first_touch_due_at = now() - interval '1 hour'
       where id = '${lead}';
    `);
    const a1 = await login(h.app, EMAILS.callerA1);
    const before = await h.app.inject({ method: 'GET', url: '/me/fresh', headers: auth(a1) });
    assert.ok(before.json().leads.some((l: { lead_id: string }) => l.lead_id === lead));

    await h.app.inject({
      method: 'POST', url: `/leads/${lead}/calls`, headers: auth(a1),
      payload: {
        disposition: 'not_answered', durationSeconds: 0,
        nextActionAt: new Date(Date.now() + 3600_000).toISOString(),
        nextActionNote: 'try again',
      },
    });

    const after = await h.app.inject({ method: 'GET', url: '/me/fresh', headers: auth(a1) });
    assert.ok(
      !after.json().leads.some((l: { lead_id: string }) => l.lead_id === lead),
      'contacted means it leaves the fresh list',
    );
  });
});

describe('repeated no-answers go quiet', () => {
  it('past the threshold a lead leaves the alert stream and joins the re-tap pool', async () => {
    const noisy = makeLeadFor(USERS.callerA1, 'Three Strikes');
    const quiet = makeLeadFor(USERS.callerA1, 'Six Strikes');
    fixtureSql(`
      update crm.leads set na_streak = 3, attempt_count = 3,
             first_touched_at = now() - interval '2 days',
             last_contacted_at = now() - interval '2 days',
             next_action_at = now() - interval '1 day'
       where id = '${noisy}';
      update crm.leads set na_streak = 6, attempt_count = 6,
             first_touched_at = now() - interval '11 days',
             last_contacted_at = now() - interval '11 days',
             next_action_at = now() - interval '6 days'
       where id = '${quiet}';
    `);

    const a1 = await login(h.app, EMAILS.callerA1);
    const alerts = await h.app.inject({ method: 'GET', url: '/me/alerts?scope=work', headers: auth(a1) });
    const kindsFor = (id: string) => alerts.json().alerts
      .filter((x: { lead_id: string }) => x.lead_id === id)
      .map((x: { kind: string }) => x.kind);

    assert.ok(kindsFor(noisy).length > 0, 'three no-answers still alerts');
    assert.deepEqual(kindsFor(quiet), [], 'six no-answers raises nothing at all');

    const pool = await h.app.inject({
      method: 'GET', url: '/me/no-answer-pool', headers: auth(a1),
    });
    assert.equal(pool.statusCode, 200);
    assert.equal(pool.json().threshold, 3);
    const ids = pool.json().leads.map((l: { lead_id: string }) => l.lead_id);
    assert.ok(ids.includes(quiet), 'the quiet lead is in the pool');
    assert.ok(!ids.includes(noisy), 'the noisy one is not - it is still being worked');

    const row = pool.json().leads.find((l: { lead_id: string }) => l.lead_id === quiet);
    assert.ok(Number(row.days_since_touch) >= 11, 'and it carries how long it has been silent');
  });

  it('the lead stays open, owned and countable - only the interrupting stops', async () => {
    const state = fixtureSql(`
      select status || '|' || (caller_id is not null) || '|' || (next_action_at is not null)
        from crm.leads where full_name like 'Six Strikes%';
    `).trim();
    assert.match(state, /^(new|working|callback)\|true\|true$/, `unexpected state: ${state}`);
  });

  it('one re-tap nudge per person, and not again until the window passes', async () => {
    fixtureSql(`delete from crm.notifications where kind = 'retap_due';`);
    const first = Number(fixtureSql('select crm.send_retap_reminders();').trim());
    const second = Number(fixtureSql('select crm.send_retap_reminders();').trim());
    assert.ok(first >= 1, 'the owner of the quiet leads is nudged once');
    assert.equal(second, 0, 'and not again straight away');

    const a1 = await login(h.app, EMAILS.callerA1);
    const res = await h.app.inject({ method: 'GET', url: '/me/notifications', headers: auth(a1) });
    const nudge = res.json().notifications.find(
      (n: { kind: string }) => n.kind === 'retap_due',
    );
    assert.ok(nudge, 'it reaches the notification centre');
    assert.match(nudge.title, /re-tapped/);

    // Age it past the window and the next one is due.
    fixtureSql(`
      update crm.notifications set created_at = now() - interval '6 days'
       where kind = 'retap_due';
    `);
    const third = Number(fixtureSql('select crm.send_retap_reminders();').trim());
    assert.ok(third >= 1, 'after five days the reminder comes round again');
  });

  it('a counsellor can see the whole team pool, a caller only their own', async () => {
    const cs = await login(h.app, EMAILS.counsellorA);
    const team = await h.app.inject({
      method: 'GET', url: '/me/no-answer-pool?scope=team', headers: auth(cs),
    });
    assert.equal(team.statusCode, 200);

    const a1 = await login(h.app, EMAILS.callerA1);
    const mine = await h.app.inject({
      method: 'GET', url: '/me/no-answer-pool?scope=team', headers: auth(a1),
    });
    // Even asking for team scope, RLS keeps a caller to their own leads.
    for (const l of mine.json().leads) {
      assert.equal(l.user_id, USERS.callerA1, 'a caller sees only their own quiet leads');
    }
  });
});

describe('manual leads and the payment punch-in', () => {
  it('a counsellor adds a lead by hand and it lands on the fresh list', async () => {
    const cs = await login(h.app, EMAILS.counsellorA);
    const res = await h.app.inject({
      method: 'POST', url: '/leads/manual', headers: auth(cs),
      payload: { fullName: 'Desk Enquiry', phone: '9822001001', city: 'Pune',
                 note: 'walked past the office' },
    });
    assert.equal(res.statusCode, 201);
    const lead = res.json();
    assert.ok(lead.next_action_at, 'a manual lead is a complete lead from birth');
    assert.ok(lead.first_touch_due_at, 'with a first-touch clock running');

    const fresh = await h.app.inject({
      method: 'GET', url: '/me/fresh?scope=all', headers: auth(cs),
    });
    assert.ok(
      fresh.json().leads.some((l: { lead_id: string }) => l.lead_id === lead.id),
      'never contacted, so it appears on Fresh leads at once',
    );
  });

  it('assigning to a named caller puts it straight in their pipeline', async () => {
    const cs = await login(h.app, EMAILS.counsellorA);
    const res = await h.app.inject({
      method: 'POST', url: '/leads/manual', headers: auth(cs),
      payload: { fullName: 'Asked For A1', phone: '9822001002', assignTo: USERS.callerA1 },
    });
    assert.equal(res.statusCode, 201);
    assert.equal(res.json().caller_id, USERS.callerA1);
    assert.equal(res.json().status, 'working');
  });

  it('a duplicate number is refused naming where the lead already is', async () => {
    const cs = await login(h.app, EMAILS.counsellorA);
    const res = await h.app.inject({
      method: 'POST', url: '/leads/manual', headers: auth(cs),
      payload: { fullName: 'Desk Enquiry Again', phone: '9822001001' },
    });
    assert.equal(res.statusCode, 409);
    assert.match(res.json().message, /already in the book/);
  });

  it('a caller cannot add leads, from the UI or anywhere else', async () => {
    const a1 = await login(h.app, EMAILS.callerA1);
    const res = await h.app.inject({
      method: 'POST', url: '/leads/manual', headers: auth(a1),
      payload: { fullName: 'Self Serve', phone: '9822001003' },
    });
    assert.equal(res.statusCode, 403);
  });

  it('an admin logs an inbound call and routes it to a team lead, or to fair distribution', async () => {
    const admin = await login(h.app, EMAILS.admin);
    const followupAt = new Date(Date.now() + 24 * 3600_000).toISOString();

    const toLead = await h.app.inject({
      method: 'POST', url: '/leads/manual', headers: auth(admin),
      payload: { fullName: 'Rang Reception', phone: '9822001017',
                 kind: 'inbound', followupAt, assignTo: USERS.counsellorA },
    });
    assert.equal(toLead.statusCode, 201);
    assert.equal(toLead.json().priority, 'immediate');

    // No target picked: fair distribution, never an error - this is the
    // path the admin's own modal takes by default.
    const fair = await h.app.inject({
      method: 'POST', url: '/leads/manual', headers: auth(admin),
      payload: { fullName: 'Rang Reception Two', phone: '9822001018',
                 kind: 'inbound', followupAt },
    });
    assert.equal(fair.statusCode, 201);
  });

  it('the one exception: a caller logs the inbound call they answered, and keeps it', async () => {
    const a1 = await login(h.app, EMAILS.callerA1);
    const followupAt = new Date(Date.now() + 24 * 3600_000).toISOString();
    const res = await h.app.inject({
      method: 'POST', url: '/leads/manual', headers: auth(a1),
      payload: { fullName: 'Rang The Office', phone: '9822001007',
                 kind: 'inbound', followupAt, note: 'asked about pricing' },
    });
    assert.equal(res.statusCode, 201);
    const lead = res.json();
    assert.equal(lead.caller_id, USERS.callerA1, 'the receiver keeps what they answered');
    assert.equal(lead.priority, 'immediate', 'an inbound call is never a lead worked later');

    // The promised date rings: it is a pending callback, not just a note.
    const day = await h.app.inject({ method: 'GET', url: `/leads/${lead.id}`, headers: auth(a1) });
    assert.equal(day.statusCode, 200);
    assert.ok(
      day.json().callbacks.some((c: { status: string }) => c.status === 'pending'),
      'the follow-up the client heard is a pending callback',
    );

    // ...but they cannot route it to a colleague,
    const routed = await h.app.inject({
      method: 'POST', url: '/leads/manual', headers: auth(a1),
      payload: { fullName: 'Routed Away', phone: '9822001008',
                 kind: 'inbound', followupAt, assignTo: USERS.callerA2 },
    });
    assert.equal(routed.statusCode, 403);

    // ...and the date the client was promised is not optional.
    const undated = await h.app.inject({
      method: 'POST', url: '/leads/manual', headers: auth(a1),
      payload: { fullName: 'No Date', phone: '9822001009', kind: 'inbound' },
    });
    assert.equal(undated.statusCode, 409);
  });

  it('the inbound register lists every punched-in call, names the puncher, and scopes by RLS', async () => {
    const admin = await login(h.app, EMAILS.admin);
    const a1 = await login(h.app, EMAILS.callerA1);
    const b1 = await login(h.app, EMAILS.callerB1);

    // The whole floor, for the admin - each row carrying who punched it in.
    const all = await h.app.inject({ method: 'GET', url: '/leads/inbound', headers: auth(admin) });
    assert.equal(all.statusCode, 200);
    const calls = all.json().calls;

    const answered = calls.find((c: { full_name: string }) => c.full_name === 'Rang The Office');
    assert.ok(answered, 'the caller-logged inbound call is on the register');
    assert.equal(answered.punched_by_id, USERS.callerA1, 'the register says who punched it in');
    assert.ok(answered.punched_by, 'by name, not just an id');
    assert.equal(answered.owner_id, USERS.callerA1, 'and who owns it now');
    assert.ok(answered.next_action_at, 'the promised follow-up rides along');

    // Punched in by one person, owned by another: both facts survive.
    const routed = calls.find((c: { full_name: string }) => c.full_name === 'Rang Reception');
    assert.ok(routed, 'the admin-logged call is there too');
    assert.equal(routed.punched_by_id, USERS.admin);
    assert.equal(routed.owner_id, USERS.counsellorA, 'routed to the team lead at punch-in');

    // RLS is the scope, not the route: another caller sees neither call...
    const other = await h.app.inject({ method: 'GET', url: '/leads/inbound', headers: auth(b1) });
    assert.equal(other.statusCode, 200);
    assert.ok(
      !other.json().calls.some((c: { full_name: string }) =>
        ['Rang The Office', 'Rang Reception'].includes(c.full_name)),
      'a caller cannot read a colleague\'s inbound calls',
    );

    // ...while the caller who answered sees their own, and only their own.
    const mine = await h.app.inject({ method: 'GET', url: '/leads/inbound', headers: auth(a1) });
    assert.equal(mine.statusCode, 200);
    assert.ok(mine.json().calls.some((c: { lead_id: string }) => c.lead_id === answered.lead_id));
    assert.ok(
      mine.json().calls.every((c: { caller_id: string | null; counsellor_id: string | null }) =>
        c.caller_id === USERS.callerA1 || c.counsellor_id === USERS.callerA1),
      'a caller\'s register is exactly their own calls',
    );

    // The reminder option on a register row: set it, and the register shows it.
    const at = new Date(Date.now() + 3 * 3600_000).toISOString();
    const set = await h.app.inject({
      method: 'PUT', url: `/leads/${answered.lead_id}/reminder`, headers: auth(a1),
      payload: { at, note: 'ring before the promised slot' },
    });
    assert.equal(set.statusCode, 200);
    const after = await h.app.inject({ method: 'GET', url: '/leads/inbound', headers: auth(a1) });
    const row = after.json().calls.find((c: { lead_id: string }) => c.lead_id === answered.lead_id);
    assert.ok(row.reminder_at, 'the reminder is visible on the register row');
    assert.equal(row.reminder_note, 'ring before the promised slot');
  });

  it('the punch-in searches open deals and spreads the amount across instalments', async () => {
    const lead = makeLeadFor(USERS.callerA1, 'Punch Payer');
    fixtureSql(`
      insert into crm.deals (id, lead_id, product_id, counsellor_id, team_id, booked_amount)
      values ('77777777-0000-0000-0000-000000000011', '${lead}',
              (select id from crm.products limit 1), '${USERS.counsellorA}',
              crm.team_of('${USERS.callerA1}', current_date), 20000);
      insert into crm.instalments (deal_id, seq, due_date, amount)
      values ('77777777-0000-0000-0000-000000000011', 1, current_date - 5, 10000),
             ('77777777-0000-0000-0000-000000000011', 2, current_date + 25, 10000);
    `);
    const cs = await login(h.app, EMAILS.counsellorA);

    const found = await h.app.inject({
      method: 'GET', url: '/collections/deal-search?q=Punch', headers: auth(cs),
    });
    assert.equal(found.statusCode, 200);
    const hit = found.json().find(
      (d: { deal_id: string }) => d.deal_id === '77777777-0000-0000-0000-000000000011',
    );
    assert.ok(hit, 'searchable by name');
    assert.equal(Number(hit.outstanding), 20000);

    const paid = await h.app.inject({
      method: 'POST', url: '/collections/punch-in', headers: auth(cs),
      payload: { dealId: hit.deal_id, amount: 12500, mode: 'upi', reference: 'UTR-42' },
    });
    assert.equal(paid.statusCode, 201);
    assert.equal(paid.json().applied, 2, 'split across the first and second instalment');
    assert.equal(Number(paid.json().deal.outstanding), 7500);

    const first = fixtureSql(`
      select status from crm.instalments
       where deal_id = '77777777-0000-0000-0000-000000000011' and seq = 1;
    `).trim();
    assert.equal(first, 'paid', 'the oldest instalment fills first');
  });

  it('a payment dated today is never "in the future", whatever the hour', async () => {
    // The form defaults "Paid on" to today. The old date arithmetic pinned
    // the date to a fixed hour of the day, which read as a future timestamp
    // for most of the working day and refused the punch-in outright.
    const cs = await login(h.app, EMAILS.counsellorA);
    const istToday = new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
    const res = await h.app.inject({
      method: 'POST', url: '/collections/punch-in', headers: auth(cs),
      payload: {
        dealId: '77777777-0000-0000-0000-000000000011',
        amount: 500, mode: 'upi', paidOn: istToday,
      },
    });
    assert.equal(res.statusCode, 201, res.body);

    const tomorrow = new Date(Date.now() + 30 * 3600_000).toISOString().slice(0, 10);
    const future = await h.app.inject({
      method: 'POST', url: '/collections/punch-in', headers: auth(cs),
      payload: {
        dealId: '77777777-0000-0000-0000-000000000011',
        amount: 500, mode: 'upi', paidOn: tomorrow,
      },
    });
    assert.equal(future.statusCode, 400, 'a genuinely future date is still refused');
    assert.match(future.json().message, /future/);
  });

  it('an overpayment is refused before any row is written', async () => {
    const cs = await login(h.app, EMAILS.counsellorA);
    const res = await h.app.inject({
      method: 'POST', url: '/collections/punch-in', headers: auth(cs),
      payload: { dealId: '77777777-0000-0000-0000-000000000011', amount: 99999, mode: 'cash' },
    });
    assert.equal(res.statusCode, 409);
    assert.match(res.json().message, /outstanding/);
  });

  it('a caller cannot punch in money', async () => {
    const a1 = await login(h.app, EMAILS.callerA1);
    const res = await h.app.inject({
      method: 'POST', url: '/collections/punch-in', headers: auth(a1),
      payload: { dealId: '77777777-0000-0000-0000-000000000011', amount: 100, mode: 'cash' },
    });
    assert.equal(res.statusCode, 403);
  });
});

describe('alerts say whose lead each one is', () => {
  it('a counsellor sees the owner on every team alert, not just a lead name', async () => {
    const leadId = makeLeadFor(USERS.callerA1, 'Owner Shown');
    fixtureSql(`
      update crm.leads set next_action_at = now() - interval '2 hours',
             first_touched_at = now() - interval '1 day', attempt_count = 1
       where id = '${leadId}';
    `);
    const cs = await login(h.app, EMAILS.counsellorA);
    const res = await h.app.inject({ method: 'GET', url: '/me/alerts?scope=work', headers: auth(cs) });
    assert.equal(res.statusCode, 200);

    const row = res.json().alerts.find((a: { lead_id: string }) => a.lead_id === leadId);
    assert.ok(row, 'the team lead appears in the counsellor list');
    assert.equal(row.owner_id, USERS.callerA1);
    assert.equal(row.owner_name, 'Caller A1',
      'a manager must be able to tell whose lead it is without opening it');
  });

  it('a first-contact breach is described in plain words, not as a policy name', async () => {
    const leadId = makeLeadFor(USERS.callerA1, 'Never Called Yet');
    fixtureSql(`
      update crm.leads set first_touched_at = null, attempt_count = 0,
             first_touch_due_at = now() - interval '3 hours'
       where id = '${leadId}';
    `);
    const a1 = await login(h.app, EMAILS.callerA1);
    const res = await h.app.inject({ method: 'GET', url: '/me/alerts?scope=work', headers: auth(a1) });
    const row = res.json().alerts.find(
      (a: { lead_id: string; kind: string }) => a.lead_id === leadId && a.kind === 'sla_breach',
    );
    assert.ok(row, 'the breach is raised');
    assert.match(row.title, /first contact overdue/i,
      'the row itself says what happened in words a caller can act on');
  });
});

describe('alerts you can actually clear', () => {
  it('snoozing moves the promise on the working clock and records it on the lead', async () => {
    const leadId = makeLeadFor(USERS.callerA1, 'Snoozable');
    fixtureSql(`
      update crm.leads set next_action_at = now() - interval '3 hours',
                           next_action_note = 'overdue on purpose'
       where id = '${leadId}';
    `);
    const a1 = await login(h.app, EMAILS.callerA1);
    const res = await h.app.inject({
      method: 'POST', url: '/me/alerts/act', headers: auth(a1),
      payload: { leadId, action: 'snooze', minutes: 120, note: 'client asked for later' },
    });
    assert.equal(res.statusCode, 200);
    assert.ok(new Date(res.json().next_action_at) > new Date(), 'the promise moved forward');

    const events = fixtureSql(`
      select count(*) from crm.lead_events
       where lead_id = '${leadId}' and event_type = 'reminder_set';
    `).trim();
    assert.equal(events, '1', 'moving a promise is written into the lead history');
  });

  it('a lead alert cannot simply be marked read - that would hide a real breach', async () => {
    const leadId = makeLeadFor(USERS.callerA1, 'Not Dismissable');
    const a1 = await login(h.app, EMAILS.callerA1);
    const res = await h.app.inject({
      method: 'POST', url: '/me/alerts/act', headers: auth(a1),
      payload: { leadId, action: 'read' },
    });
    assert.equal(res.statusCode, 400);
  });

  it('a notification, which has no promise behind it, is simply read', async () => {
    fixtureSql(`
      insert into crm.notifications (user_id, kind, title, body)
      values ('${USERS.callerA1}', 'new_lead', 'Test notice', 'body');
    `);
    const id = fixtureSql(`
      select id from crm.notifications
       where user_id = '${USERS.callerA1}' and title = 'Test notice' limit 1;
    `).trim().split('\n')[0]!.trim();

    const a1 = await login(h.app, EMAILS.callerA1);
    const res = await h.app.inject({
      method: 'POST', url: '/me/alerts/act', headers: auth(a1),
      payload: { notificationId: id, action: 'read' },
    });
    assert.equal(res.statusCode, 200);
    const unread = fixtureSql(`
      select count(*) from crm.notifications where id = '${id}' and read_at is null;
    `).trim();
    assert.equal(unread, '0');
  });
});

describe('lead flow explains itself', () => {
  it('waiting leads are reported per team with the blocking reason', async () => {
    const teamB = fixtureSql(`select id from crm.teams where name = 'Team B';`).trim();
    fixtureSql(`
      update crm.attendance_sessions s set ended_at = now()
       where s.ended_at is null
         and s.user_id in (select user_id from crm.team_memberships
                            where team_id = '${teamB}' and period @> current_date);
      insert into crm.leads (source_id, full_name, phone_e164, team_id, status,
                             next_action_at, next_action_note)
      select '${SOURCES.meta}', 'Held B ' || i, '+9195557000' || i, '${teamB}', 'new',
             now() + interval '1 hour', 'First contact'
        from generate_series(1, 3) i;
    `);
    const cs = await login(h.app, EMAILS.counsellorA);
    const res = await h.app.inject({
      method: 'GET', url: '/dashboards/lead-flow', headers: auth(cs),
    });
    assert.equal(res.statusCode, 200);
    const row = res.json().waiting.find((w: { team_name: string }) => w.team_name === 'Team B');
    assert.ok(row, 'the blocked team appears in its own right');
    assert.equal(row.reason, 'nobody_on_shift');
    assert.equal(Number(row.on_floor), 0);
    assert.ok(Number(row.callers) > 0, 'the team has callers - they are just not here');
  });

  it('only an admin can force the sweep', async () => {
    const cs = await login(h.app, EMAILS.counsellorA);
    const denied = await h.app.inject({
      method: 'POST', url: '/dashboards/lead-flow/assign-now', headers: auth(cs), payload: {},
    });
    assert.equal(denied.statusCode, 403);

    const admin = await login(h.app, EMAILS.admin);
    const ok = await h.app.inject({
      method: 'POST', url: '/dashboards/lead-flow/assign-now', headers: auth(admin), payload: {},
    });
    assert.equal(ok.statusCode, 200);
    assert.ok(Number.isInteger(Number(ok.json().assigned)));
  });
});

describe('lead intake health', () => {
  it('reports every source, its state and the last run, to whoever runs the floor', async () => {
    const cs = await login(h.app, EMAILS.counsellorA);
    const res = await h.app.inject({ method: 'GET', url: '/dashboards/intake', headers: auth(cs) });
    assert.equal(res.statusCode, 200);
    const body = res.json();

    assert.ok(Array.isArray(body.sources) && body.sources.length >= 1);
    assert.ok(body.sources.every((s: { state: string }) => typeof s.state === 'string'),
      'every source carries a state the screen can colour');
    assert.equal(typeof body.leads_today, 'number');
    assert.equal(typeof body.jobs_never_ran, 'boolean',
      'the floor can tell whether the background engine has ever run');

    // The CSV imports earlier in this suite went through a real source, so at
    // least one has genuinely synced and must not be reported as broken.
    const synced = body.sources.filter((s: { last_synced_at: string | null }) => s.last_synced_at);
    assert.ok(synced.length >= 1, 'the sources imported in this suite show a sync time');

    // A source with no sheet is hand entry or a pasted CSV - the importer
    // never reads it. Calling that "not importing" raised an hourly outage
    // the floor could not clear, which is how a real one learns to hide.
    const sheetless = body.sources.filter((s: { sheet_configured: boolean }) => !s.sheet_configured);
    assert.ok(sheetless.length >= 1, 'the seed has a hand-entry source');
    assert.ok(
      sheetless.every((s: { state: string }) => s.state === 'manual' || s.state === 'off'),
      'a sheet-less source reads as manual, never as a fault',
    );
  });

  it('refuses a sync from someone who does not run the floor, and says so plainly when the importer is absent', async () => {
    const a1 = await login(h.app, EMAILS.callerA1);
    const denied = await h.app.inject({
      method: 'POST', url: '/dashboards/intake/sync-now', headers: auth(a1), payload: {},
    });
    assert.equal(denied.statusCode, 403);

    // The test server has no Google credentials, so the importer is not
    // attached - the admin must be told that, not shown a false success.
    const admin = await login(h.app, EMAILS.admin);
    const res = await h.app.inject({
      method: 'POST', url: '/dashboards/intake/sync-now', headers: auth(admin), payload: {},
    });
    assert.equal(res.statusCode, 400);
    assert.match(res.json().message, /not configured on this server/);
  });

  it('tells the floor how many leads each team received this month', async () => {
    const cs = await login(h.app, EMAILS.counsellorA);
    const res = await h.app.inject({ method: 'GET', url: '/dashboards/leads-month', headers: auth(cs) });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.ok(Array.isArray(body.teams) && body.teams.length >= 2, 'one row per team');
    assert.equal(typeof body.total, 'number');
    assert.equal(
      body.total,
      body.teams.reduce((n: number, t: { leads_month: number }) => n + Number(t.leads_month), 0),
      'the total is the sum of the team rows',
    );

    // The month counter is floor management, not a caller screen.
    const a1 = await login(h.app, EMAILS.callerA1);
    const denied = await h.app.inject({ method: 'GET', url: '/dashboards/leads-month', headers: auth(a1) });
    assert.equal(denied.statusCode, 403);
  });

  it('offers the four new advisory products for sale', async () => {
    const cs = await login(h.app, EMAILS.counsellorA);
    const res = await h.app.inject({ method: 'GET', url: '/advisory/products', headers: auth(cs) });
    const names = res.json().map((p: { name: string }) => p.name);
    for (const wanted of ['Swing Advisory', 'Trader Advisory', 'Pro Advisory', 'Grow+']) {
      assert.ok(names.includes(wanted), `${wanted} is sellable`);
    }
  });
});

describe('clients added by hand', () => {
  it('a counsellor can enter an offline client, and they appear in both books', async () => {
    const cs = await login(h.app, EMAILS.counsellorA);
    const products = await h.app.inject({
      method: 'GET', url: '/advisory/products', headers: auth(cs),
    });
    const productId = products.json()[0].id;

    const res = await h.app.inject({
      method: 'POST', url: '/advisory/manual', headers: auth(cs),
      payload: {
        fullName: 'Desk Payer', phone: '9855577001', productId,
        amount: 30000, mode: 'cash', note: 'paid at the desk',
      },
    });
    assert.equal(res.statusCode, 201);
    const dealId = res.json().deal_id;

    const register = await h.app.inject({ method: 'GET', url: '/advisory', headers: auth(cs) });
    const row = register.json().find((r: { deal_id: string }) => r.deal_id === dealId);
    assert.ok(row, 'in the advisory register');
    assert.equal(row.is_manual, true);
    assert.equal(Number(row.checkpoints_done), 0, 'all three checkpoints start open');

    const book = await h.app.inject({ method: 'GET', url: '/mentors/book', headers: auth(cs) });
    assert.ok(
      book.json().clients.some((c: { deal_id: string }) => c.deal_id === dealId),
      'and in the mentor book, because they have genuinely paid',
    );
  });

  it('the group checkpoint ticks one-way and records who did it', async () => {
    const cs = await login(h.app, EMAILS.counsellorA);
    const register = await h.app.inject({ method: 'GET', url: '/advisory', headers: auth(cs) });
    const target = register.json().find((r: { full_name: string }) => r.full_name === 'Desk Payer');

    const res = await h.app.inject({
      method: 'PUT', url: `/advisory/${target.deal_id}`, headers: auth(cs),
      payload: { groupAdded: true },
    });
    assert.equal(res.statusCode, 200);
    assert.ok(res.json().group_added_at);
    assert.equal(res.json().group_added_by, USERS.counsellorA);

    const after = await h.app.inject({ method: 'GET', url: '/advisory', headers: auth(cs) });
    const row = after.json().find((r: { full_name: string }) => r.full_name === 'Desk Payer');
    assert.equal(Number(row.checkpoints_done), 1);
  });

  it('a caller cannot invent a paying client', async () => {
    const a1 = await login(h.app, EMAILS.callerA1);
    const res = await h.app.inject({
      method: 'POST', url: '/advisory/manual', headers: auth(a1),
      payload: {
        fullName: 'Nope', phone: '9855577002',
        productId: '44444444-0000-0000-0000-000000000001', amount: 1000,
      },
    });
    assert.equal(res.statusCode, 403);
  });

  it('an admin entering a sale credits the named counsellor, their team and the source', async () => {
    const admin = await login(h.app, EMAILS.admin);

    const opts = await h.app.inject({
      method: 'GET', url: '/advisory/entry-options', headers: auth(admin),
    });
    assert.equal(opts.statusCode, 200);
    const { counsellors, sources } = opts.json();
    assert.ok(
      counsellors.some(
        (c: { full_name: string; team_name: string }) =>
          c.full_name === 'Counsellor B' && c.team_name === 'Team B',
      ),
      'counsellors come with their team, because the deal follows it',
    );
    const manualSource = sources.find((s: { name: string }) => s.name === 'Manual entry');
    assert.ok(manualSource, 'the Manual entry source is offered');

    const products = await h.app.inject({
      method: 'GET', url: '/advisory/products', headers: auth(admin),
    });
    const res = await h.app.inject({
      method: 'POST', url: '/advisory/manual', headers: auth(admin),
      payload: {
        fullName: 'Credited Sale', phone: '9855577003',
        productId: products.json()[0].id, amount: 20000, mode: 'upi',
        counsellorId: USERS.counsellorB, sourceId: manualSource.id,
      },
    });
    assert.equal(res.statusCode, 201);

    const register = await h.app.inject({ method: 'GET', url: '/advisory', headers: auth(admin) });
    const row = register.json().find(
      (r: { deal_id: string }) => r.deal_id === res.json().deal_id,
    );
    assert.equal(row.counsellor_name, 'Counsellor B', 'credited to the named closer, not the typist');
    assert.equal(row.team_name, 'Team B', 'and to the closer\'s team');
    assert.equal(row.source, 'Manual entry', 'the register answers "where from"');
  });

  it('"converted by" refuses anyone who is not a counsellor', async () => {
    const cs = await login(h.app, EMAILS.counsellorA);
    const res = await h.app.inject({
      method: 'POST', url: '/advisory/manual', headers: auth(cs),
      payload: {
        fullName: 'Bad Credit', phone: '9855577004',
        productId: '44444444-0000-0000-0000-000000000001', amount: 1000,
        counsellorId: USERS.callerA1,
      },
    });
    assert.equal(res.statusCode, 409);
    assert.match(res.json().message ?? res.body, /active counsellor/);
  });

  it('a caller cannot read the entry options either', async () => {
    const a1 = await login(h.app, EMAILS.callerA1);
    const res = await h.app.inject({
      method: 'GET', url: '/advisory/entry-options', headers: auth(a1),
    });
    assert.equal(res.statusCode, 403);
  });

  it('the same person can buy a second product; the same product twice is refused', async () => {
    const cs = await login(h.app, EMAILS.counsellorA);
    const products = await h.app.inject({
      method: 'GET', url: '/advisory/products', headers: auth(cs),
    });
    const [p1, p2] = products.json();

    const again = await h.app.inject({
      method: 'POST', url: '/advisory/manual', headers: auth(cs),
      payload: { fullName: 'Desk Payer', phone: '9855577001', productId: p1.id, amount: 5000 },
    });
    assert.equal(again.statusCode, 409, 'same product twice is a double-entry');
    assert.match(again.json().message, /already has an open/);

    const upgrade = await h.app.inject({
      method: 'POST', url: '/advisory/manual', headers: auth(cs),
      payload: { fullName: 'Desk Payer', phone: '9855577001', productId: p2.id, amount: 12000 },
    });
    assert.equal(upgrade.statusCode, 201, 'a different product is a purchase');

    const register = await h.app.inject({ method: 'GET', url: '/advisory', headers: auth(cs) });
    const mine = register.json().filter((r: { full_name: string }) => r.full_name === 'Desk Payer');
    assert.equal(mine.length, 2, 'one row per product bought');
    assert.equal(new Set(mine.map((r: { lead_id: string }) => r.lead_id)).size, 1,
      'both deals belong to the same person, not a duplicate lead');
  });

  it('a client record can be corrected, and the correction is written to history', async () => {
    const cs = await login(h.app, EMAILS.counsellorA);
    const register = await h.app.inject({ method: 'GET', url: '/advisory', headers: auth(cs) });
    const target = register.json().find(
      (r: { full_name: string; booked_amount: string }) =>
        r.full_name === 'Desk Payer' && Number(r.booked_amount) === 30000,
    );
    assert.ok(target, 'the original Desk Payer deal is present');

    const res = await h.app.inject({
      method: 'PUT', url: `/advisory/${target.deal_id}/details`, headers: auth(cs),
      payload: { fullName: 'Desk Payer Fixed', amount: 32000, paidAmount: 32000 },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().client.full_name, 'Desk Payer Fixed');
    assert.equal(Number(res.json().client.booked_amount), 32000);
    assert.equal(Number(res.json().client.paid_amount), 32000, 'the single payment follows the correction');
    assert.equal(Number(res.json().client.outstanding), 0);

    const event = fixtureSql(
      `select payload -> 'changes' -> 'total' ->> 'to' from crm.lead_events
        where event_type = 'client_edited' order by id desc limit 1;`,
    ).trim();
    assert.equal(event, '32000.00', 'old and new values land in the lead history');

    // Raising the total alone must never claim more money was received.
    const raised = await h.app.inject({
      method: 'PUT', url: `/advisory/${target.deal_id}/details`, headers: auth(cs),
      payload: { amount: 40000 },
    });
    assert.equal(Number(raised.json().client.paid_amount), 32000, 'received is untouched');
    assert.equal(Number(raised.json().client.outstanding), 8000, 'the difference becomes owed');
    const chased = fixtureSql(
      `select coalesce(sum(amount), 0) from crm.instalments
        where deal_id = '${target.deal_id}' and status in ('due', 'part_paid', 'overdue');`,
    ).trim();
    assert.equal(chased, '8000.00', 'and it is a real instalment, so Outstanding payments chases it');

    await h.app.inject({
      method: 'PUT', url: `/advisory/${target.deal_id}/details`, headers: auth(cs),
      payload: { amount: 32000 },
    });

    // The paid date, mode and reference are payment facts, correctable too.
    const res2 = await h.app.inject({
      method: 'PUT', url: `/advisory/${target.deal_id}/details`, headers: auth(cs),
      payload: { paidOn: '2026-08-01', mode: 'neft', reference: 'UTR-999' },
    });
    assert.equal(res2.statusCode, 200);
    const c = res2.json().client;
    assert.equal(String(c.first_paid_on).slice(0, 10), '2026-08-01');
    assert.equal(c.first_payment_mode, 'neft');
    assert.equal(c.first_payment_reference, 'UTR-999');

    const future = await h.app.inject({
      method: 'PUT', url: `/advisory/${target.deal_id}/details`, headers: auth(cs),
      payload: { paidOn: '2031-01-01' },
    });
    assert.equal(future.statusCode, 400, 'a payment cannot be re-dated into the future');
    assert.match(future.json().message, /future/);

    // TODAY is not the future. The old date arithmetic pinned "today" to a
    // fixed hour and refused it for most of the working day.
    const istToday = new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
    const today = await h.app.inject({
      method: 'PUT', url: `/advisory/${target.deal_id}/details`, headers: auth(cs),
      payload: { paidOn: istToday },
    });
    assert.equal(today.statusCode, 200, 'correcting the date to today must work at any hour');
  });

  it('money recorded through the CRM itself cannot be edited', async () => {
    const cs = await login(h.app, EMAILS.counsellorA);
    const real = fixtureSql(
      `select id from crm.deals where not is_manual and status = 'booked'
        and team_id = '11111111-0000-0000-0000-000000000001' limit 1;`,
    ).trim();
    assert.ok(real, 'a CRM-recorded deal exists in the fixture');

    const res = await h.app.inject({
      method: 'PUT', url: `/advisory/${real}/details`, headers: auth(cs),
      payload: { amount: 999 },
    });
    assert.equal(res.statusCode, 409);
    assert.match(res.json().message, /audit record/);
  });

  it('a counsellor cannot edit the other team\'s client — it reads as not found', async () => {
    const csB = await login(h.app, EMAILS.counsellorB);
    const register = await h.app.inject({ method: 'GET', url: '/advisory', headers: auth(csB) });
    assert.ok(
      !register.json().some((r: { full_name: string }) => r.full_name === 'Desk Payer Fixed'),
      'team B does not even see the team A client',
    );

    const dealId = fixtureSql(
      `select d.id from crm.deals d join crm.leads l on l.id = d.lead_id
        where l.full_name = 'Desk Payer Fixed' limit 1;`,
    ).trim();
    const res = await h.app.inject({
      method: 'PUT', url: `/advisory/${dealId}/details`, headers: auth(csB),
      payload: { fullName: 'Hijacked' },
    });
    assert.equal(res.statusCode, 404, 'the edit fence matches the reading fence');
  });

  it('a part-paid client owes real money that Outstanding payments chases', async () => {
    const cs = await login(h.app, EMAILS.counsellorA);
    const products = await h.app.inject({
      method: 'GET', url: '/advisory/products', headers: auth(cs),
    });
    const res = await h.app.inject({
      method: 'POST', url: '/advisory/manual', headers: auth(cs),
      payload: {
        fullName: 'Half Payer', phone: '9855577010', productId: products.json()[0].id,
        amount: 30000, paidAmount: 3000, mode: 'upi',
      },
    });
    assert.equal(res.statusCode, 201);

    const register = await h.app.inject({ method: 'GET', url: '/advisory', headers: auth(cs) });
    const row = register.json().find((r: { deal_id: string }) => r.deal_id === res.json().deal_id);
    assert.equal(Number(row.booked_amount), 30000, 'total sold');
    assert.equal(Number(row.paid_amount), 3000, 'money actually received');
    assert.equal(Number(row.outstanding), 27000, 'and the gap is visible without arithmetic');
    assert.ok(row.balance_due_on, 'with a date it falls due');

    // The whole point: it reaches the people who chase money.
    const due = await h.app.inject({ method: 'GET', url: '/collections/due', headers: auth(cs) });
    const chase = due.json().find(
      (d: { deal_id: string }) => d.deal_id === res.json().deal_id,
    );
    assert.ok(chase, 'the balance appears in the dues queue');
    assert.equal(Number(chase.amount) - Number(chase.paid_amount), 27000);

    // And collecting it through the normal punch-in settles the client.
    const paid = await h.app.inject({
      method: 'POST', url: '/collections/punch-in', headers: auth(cs),
      payload: { dealId: res.json().deal_id, amount: 27000, mode: 'neft' },
    });
    assert.equal(paid.statusCode, 201);
    const after = await h.app.inject({ method: 'GET', url: '/advisory', headers: auth(cs) });
    const settled = after.json().find((r: { deal_id: string }) => r.deal_id === res.json().deal_id);
    assert.equal(Number(settled.outstanding), 0, 'nothing left to collect');
  });

  it('a down payment larger than the total is refused', async () => {
    const cs = await login(h.app, EMAILS.counsellorA);
    const res = await h.app.inject({
      method: 'POST', url: '/advisory/manual', headers: auth(cs),
      payload: {
        fullName: 'Typo Payer', phone: '9855577011',
        productId: '44444444-0000-0000-0000-000000000001',
        amount: 5000, paidAmount: 9000,
      },
    });
    assert.equal(res.statusCode, 409);
    assert.match(res.json().message, /cannot be more than the total/);
  });

  it('the add form knows who is already in the book, across the team fence', async () => {
    // Desk Payer Fixed sits with team A holding two open deals.
    const csB = await login(h.app, EMAILS.counsellorB);
    const res = await h.app.inject({
      url: '/advisory/lookup?phone=9855577001', headers: auth(csB),
    });
    assert.equal(res.statusCode, 200);
    const found = res.json().found;
    assert.ok(found, 'the other team\'s client is still the truth');
    assert.equal(found.full_name, 'Desk Payer Fixed');
    assert.ok(found.open_deals.length >= 2, 'both products are listed');
    assert.ok(
      found.open_deals.every((d: { mine: boolean }) => d.mine === false),
      'but team B cannot record money on them',
    );

    const csA = await login(h.app, EMAILS.counsellorA);
    const mine = await h.app.inject({
      url: '/advisory/lookup?phone=9855577001', headers: auth(csA),
    });
    assert.ok(
      mine.json().found.open_deals.every((d: { mine: boolean }) => d.mine === true),
      'the owning team gets the one-click punch-in',
    );

    const nobody = await h.app.inject({
      url: '/advisory/lookup?phone=9899000000', headers: auth(csA),
    });
    assert.equal(nobody.json().found, null, 'an unknown number is simply not found');

    const a1 = await login(h.app, EMAILS.callerA1);
    const denied = await h.app.inject({
      url: '/advisory/lookup?phone=9855577001', headers: auth(a1),
    });
    assert.equal(denied.statusCode, 403, 'callers cannot fish the client book by phone');
  });

  it('an unusable phone number is refused before anything is created', async () => {
    const cs = await login(h.app, EMAILS.counsellorA);
    // Long enough to pass the schema, junk enough to fail normalisation - so
    // this exercises the database's own refusal, not the request validator.
    const res = await h.app.inject({
      method: 'POST', url: '/advisory/manual', headers: auth(cs),
      payload: {
        fullName: 'Bad Number', phone: '0000000',
        productId: '44444444-0000-0000-0000-000000000001', amount: 1000,
      },
    });
    assert.equal(res.statusCode, 409);
    assert.match(res.json().message ?? res.body, /dialable/);

    const created = fixtureSql(
      `select count(*) from crm.leads where full_name = 'Bad Number';`,
    ).trim();
    assert.equal(created, '0', 'nothing is created when the number is rejected');
  });
});

describe('training academy', () => {
  it('lists every module, marks my track, and counts what I still owe', async () => {
    const a1 = await login(h.app, EMAILS.callerA1);
    const res = await h.app.inject({ method: 'GET', url: '/training', headers: auth(a1) });
    assert.equal(res.statusCode, 200);
    const { modules, outstanding } = res.json();

    assert.ok(modules.length >= 10, 'all ten modules are present');
    assert.ok(
      modules.some((m: { slug: string }) => m.slug === 'the-rulebook'),
      'the rulebook is one of them',
    );
    // A caller's track is the shared modules plus the caller one - never the
    // mentor or admin ones, though they can still read those.
    const callerTrack = modules.filter((m: { isMyTrack: boolean }) => m.isMyTrack);
    assert.ok(callerTrack.some((m: { slug: string }) => m.slug === 'the-callers-job'));
    assert.ok(!callerTrack.some((m: { slug: string }) => m.slug === 'the-admins-job'));
    assert.equal(outstanding, callerTrack.length, 'nothing acknowledged yet');
  });

  it('substitutes the live configuration, so training cannot quote a stale rule', async () => {
    fixtureSql(`update crm.settings set value = '7'::jsonb
                 where key = 'sla.immediate_first_touch_minutes';`);
    const a1 = await login(h.app, EMAILS.callerA1);
    const res = await h.app.inject({
      method: 'GET', url: '/training/how-leads-are-distributed', headers: auth(a1),
    });
    assert.equal(res.statusCode, 200);
    const { body } = res.json();
    assert.ok(!body.includes('{{setting:'), 'no placeholder survives to the page');
    assert.match(body, /7\s+working minutes/, 'it quotes the value that is actually configured');

    // Back to the configured 30-minute window, and the page follows along.
    fixtureSql(`update crm.settings set value = '30'::jsonb
                 where key = 'sla.immediate_first_touch_minutes';`);
    const after = await h.app.inject({
      method: 'GET', url: '/training/how-leads-are-distributed', headers: auth(a1),
    });
    assert.match(after.json().body, /30\s+working minutes/, 'change the setting, the page follows');
  });

  it('acknowledgement is signed against the exact text read', async () => {
    const a1 = await login(h.app, EMAILS.callerA1);
    const mod = await h.app.inject({
      method: 'GET', url: '/training/the-rulebook', headers: auth(a1),
    });
    const version = mod.json().version;
    assert.ok(version, 'a module carries a content version');

    const ack = await h.app.inject({
      method: 'POST', url: '/training/the-rulebook/ack',
      headers: auth(a1), payload: { quizScore: 75 },
    });
    assert.equal(ack.statusCode, 200);
    assert.equal(ack.json().version, version, 'the ack records the version read');
    assert.equal(ack.json().quiz_score, 75);

    const list = await h.app.inject({ method: 'GET', url: '/training', headers: auth(a1) });
    const row = list.json().modules.find((m: { slug: string }) => m.slug === 'the-rulebook');
    assert.ok(row.ackedAt);
    assert.equal(row.stale, false, 'freshly read is not stale');
  });

  it('editing a module makes existing acknowledgements stale', async () => {
    // Simulate an edit by storing an ack against a version that is not the
    // current file hash - exactly what happens when the wording changes.
    fixtureSql(`
      update crm.training_acks set version = 'an-older-wording'
       where user_id = '${USERS.callerA1}' and module_slug = 'the-rulebook';
    `);
    const a1 = await login(h.app, EMAILS.callerA1);
    const list = await h.app.inject({ method: 'GET', url: '/training', headers: auth(a1) });
    const row = list.json().modules.find((m: { slug: string }) => m.slug === 'the-rulebook');
    assert.equal(row.stale, true, 'the floor is asked to read it again');
    assert.ok(row.ackedAt, 'but the earlier signature is not erased');
  });

  it('nobody can sign in somebody else’s name', async () => {
    const a1 = await login(h.app, EMAILS.callerA1);
    await h.app.inject({
      method: 'POST', url: '/training/the-rulebook/ack', headers: auth(a1), payload: {},
    });
    const rows = fixtureSql(`
      select count(*) from crm.training_acks
       where module_slug = 'the-rulebook' and user_id <> '${USERS.callerA1}';
    `).trim();
    assert.equal(rows, '0', 'the ack landed against the signed-in user only');
  });

  it('search finds a rule wherever it is written', async () => {
    const a1 = await login(h.app, EMAILS.callerA1);
    const res = await h.app.inject({
      method: 'GET', url: '/training/search?q=callback', headers: auth(a1),
    });
    assert.equal(res.statusCode, 200);
    assert.ok(res.json().results.length > 0, 'callbacks are covered somewhere');
    assert.ok(res.json().results[0].hits.length > 0, 'with a quotable excerpt');
  });

  it('the glossary is one file, and it is what the tooltips read', async () => {
    const a1 = await login(h.app, EMAILS.callerA1);
    const res = await h.app.inject({
      method: 'GET', url: '/training/registry', headers: auth(a1),
    });
    const { entries } = res.json();
    assert.ok(entries.length > 30, 'every tab, button, filter and badge');
    for (const e of entries) {
      assert.ok(e.key && e.label && e.does && e.when, `registry entry ${e.key} is complete`);
    }
    assert.ok(entries.some((e: { key: string }) => e.key === 'tab.day'));
  });

  it('a counsellor sees the compliance matrix; a caller does not', async () => {
    const cs = await login(h.app, EMAILS.counsellorA);
    const res = await h.app.inject({
      method: 'GET', url: '/training/compliance', headers: auth(cs),
    });
    assert.equal(res.statusCode, 200);
    const { people, modules } = res.json();
    assert.ok(modules.length >= 10);
    const a1row = people.find((p: { userId: string }) => p.userId === USERS.callerA1);
    assert.ok(a1row, 'the caller appears in the matrix');
    assert.ok(a1row.required > 0, 'with a required count for their role');

    const a1 = await login(h.app, EMAILS.callerA1);
    const denied = await h.app.inject({
      method: 'GET', url: '/training/compliance', headers: auth(a1),
    });
    assert.equal(denied.statusCode, 403);
  });

  it('a caller can mark their own tour done without being able to edit their user row', async () => {
    const a1 = await login(h.app, EMAILS.callerA1);
    const res = await h.app.inject({
      method: 'POST', url: '/training/tour/complete', headers: auth(a1), payload: {},
    });
    assert.equal(res.statusCode, 200);
    assert.ok(res.json().tour_completed_at);

    const role = fixtureSql(`select role from crm.users where id = '${USERS.callerA1}';`).trim();
    assert.equal(role, 'caller', 'and their role is untouched');
  });

  it('an unknown module is a 404, not a blank page', async () => {
    const a1 = await login(h.app, EMAILS.callerA1);
    const res = await h.app.inject({
      method: 'GET', url: '/training/no-such-module', headers: auth(a1),
    });
    assert.equal(res.statusCode, 404);
  });
});

describe('daily accountability brief', () => {
  it('a caller sees dials and SLA, never a revenue target', async () => {
    const a1 = await login(h.app, EMAILS.callerA1);
    const res = await h.app.inject({ method: 'GET', url: '/me/brief', headers: auth(a1) });
    assert.equal(res.statusCode, 200);
    const { brief, teams } = res.json();
    assert.equal(brief.role, 'caller');
    assert.equal(brief.monthly_target, null, 'a caller carries no revenue target');
    assert.ok(Number(brief.dial_target) > 0, 'but they do carry a dial target');
    assert.deepEqual(teams, [], 'a caller gets no team roll-up');
  });

  it('a counsellor gets the gap, the working days left and the required run-rate', async () => {
    const cs = await login(h.app, EMAILS.counsellorA);
    const res = await h.app.inject({ method: 'GET', url: '/me/brief', headers: auth(cs) });
    const { brief, teams } = res.json();
    assert.ok(Number(brief.monthly_target) > 0, 'a share of the office number by default');
    assert.ok(Number(brief.working_days_left) >= 1);
    assert.ok(Number(brief.required_per_day) >= 0);
    assert.ok(teams.length > 0, 'managers get the team roll-up');
  });

  it('the engine delivers each slot once and holds the rest', async () => {
    fixtureSql(`
      delete from crm.reminder_log;
      delete from crm.notifications where kind like 'daily_brief%';
      update crm.settings
         set value = to_jsonb(extract(hour from now() at time zone 'Asia/Kolkata')::int * 60
                            + extract(minute from now() at time zone 'Asia/Kolkata')::int)
       where key = 'reminder.morning_minutes';
      update crm.settings set value = '0'::jsonb
       where key in ('reminder.midday_minutes', 'reminder.evening_minutes');
      update crm.settings set value = '30'::jsonb where key = 'reminder.catchup_minutes';
    `);
    const first = Number(fixtureSql('select crm.send_due_reminders();').trim());
    const second = Number(fixtureSql('select crm.send_due_reminders();').trim());
    assert.ok(first > 0, 'the morning brief went out');
    assert.equal(second, 0, 'a second run is a no-op - the log makes it idempotent');

    const a1 = await login(h.app, EMAILS.callerA1);
    const res = await h.app.inject({ method: 'GET', url: '/me/notifications', headers: auth(a1) });
    const brief = res.json().notifications.find(
      (n: { kind: string }) => n.kind === 'daily_brief_morning',
    );
    assert.ok(brief, 'it lands in the notification centre');
    assert.match(brief.body, /\d+ leads in hand/, 'the body is numbers, not encouragement');
  });
});

describe('events', () => {
  let eventId = '';
  let rosterId = '';

  it('an admin creates an event; a caller cannot', async () => {
    const admin = await login(h.app, EMAILS.admin);
    const res = await h.app.inject({
      method: 'POST', url: '/events', headers: auth(admin),
      payload: {
        name: 'September Options Seminar', kind: 'in_office', status: 'published',
        startsAt: '2026-09-05T10:00:00+05:30', venue: 'Head office',
        capacity: 60, audienceTags: ['options', 'beginners'],
      },
    });
    assert.equal(res.statusCode, 201);
    eventId = res.json().id;

    const a1 = await login(h.app, EMAILS.callerA1);
    const denied = await h.app.inject({
      method: 'POST', url: '/events', headers: auth(a1),
      payload: { name: 'Mine', startsAt: '2026-09-05T10:00:00+05:30' },
    });
    assert.equal(denied.statusCode, 403);
  });

  it('the preview count is the number the import actually adds', async () => {
    fixtureSql(`
      insert into crm.leads (source_id, full_name, phone_e164, caller_id, team_id,
                             status, campaign_name, next_action_at)
      select '${SOURCES.meta}', 'Event Guest ' || i, '+9195554000' || i,
             '${USERS.callerA1}', crm.team_of('${USERS.callerA1}', current_date),
             'working', 'Sep-Seminar', now() + interval '2 hours'
        from generate_series(1, 4) i;
    `);
    const admin = await login(h.app, EMAILS.admin);
    const filter = { campaign: 'Sep-Seminar', statuses: ['working'] };

    const preview = await h.app.inject({
      method: 'POST', url: `/events/${eventId}/import/preview`,
      headers: auth(admin), payload: filter,
    });
    assert.equal(preview.statusCode, 200);
    assert.equal(preview.json().matched, 4);

    const imported = await h.app.inject({
      method: 'POST', url: `/events/${eventId}/import`, headers: auth(admin), payload: filter,
    });
    assert.equal(imported.json().added, 4, 'what the preview promised is what arrived');
    assert.equal(imported.json().event.invited, 4);

    const again = await h.app.inject({
      method: 'POST', url: `/events/${eventId}/import`, headers: auth(admin), payload: filter,
    });
    assert.equal(again.json().added, 0, 'a repeat import tops up, it does not duplicate');
  });

  it('the imported leads are untouched in the pipeline', async () => {
    const stillMine = fixtureSql(`
      select count(*) from crm.leads
       where campaign_name = 'Sep-Seminar'
         and caller_id = '${USERS.callerA1}' and status = 'working';
    `).trim();
    assert.equal(stillMine, '4', 'importing copies; it never moves or restages a lead');
  });

  it('both teams see the whole roster even though the lead book is fenced', async () => {
    const b1 = await login(h.app, EMAILS.callerB1);
    const res = await h.app.inject({ method: 'GET', url: `/events/${eventId}`, headers: auth(b1) });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().roster.length, 4, 'an invitation is not a lead');
    rosterId = res.json().roster[0].id;

    const leads = await h.app.inject({
      method: 'GET', url: `/leads?q=${encodeURIComponent('Event Guest')}`, headers: auth(b1),
    });
    assert.equal(
      leads.json().leads.filter((l: { full_name: string }) =>
        l.full_name?.startsWith('Event Guest')).length,
      0,
      'the other team still cannot reach the leads themselves',
    );
  });

  it('a name search returns matches, not the whole book', async () => {
    // Regression: regexp_replace strips a text query to '', and the phone
    // branch then read "like '%'" - every lead the user could see came back.
    const a1 = await login(h.app, EMAILS.callerA1);
    const res = await h.app.inject({
      method: 'GET', url: `/leads?q=${encodeURIComponent('Event Guest')}`, headers: auth(a1),
    });
    const names = res.json().leads.map((l: { full_name: string }) => l.full_name ?? '');
    assert.ok(names.length > 0, 'the owner does find their own guests');
    assert.ok(
      names.every((n: string) => n.startsWith('Event Guest')),
      `a name search must not fall through to everything: got ${names.slice(0, 5).join(', ')}`,
    );

    // Phone search matches the END of the number - people type the last few
    // digits off a missed call, not the +91 prefix.
    const byPhone = await h.app.inject({
      method: 'GET', url: '/leads?q=540001', headers: auth(a1),
    });
    assert.ok(byPhone.json().leads.length > 0, 'searching digits still finds phone numbers');
  });

  it('a caller can work the roster, and attendance drives the counters', async () => {
    const b1 = await login(h.app, EMAILS.callerB1);
    const marked = await h.app.inject({
      method: 'PUT', url: `/events/${eventId}/roster/${rosterId}`,
      headers: auth(b1), payload: { status: 'attended', notes: 'came with a friend' },
    });
    assert.equal(marked.statusCode, 200);
    assert.ok(marked.json().attended_at, 'attendance stamps itself');

    const res = await h.app.inject({ method: 'GET', url: `/events/${eventId}`, headers: auth(b1) });
    assert.equal(res.json().event.attended, 1);
    // numeric stays an exact string on the wire, by design - see CLAUDE.md.
    assert.equal(Number(res.json().event.attendance_pct), 25);

    const open = await h.app.inject({
      method: 'GET', url: '/events/followups/open', headers: auth(b1),
    });
    assert.ok(
      open.json().some((f: { roster_id: string }) => f.roster_id === rosterId),
      'the attendee lands on the post-event task list',
    );
  });

  it('a walk-up with no lead record can still be added, but not with a junk number', async () => {
    const cs = await login(h.app, EMAILS.counsellorA);
    const ok = await h.app.inject({
      method: 'POST', url: `/events/${eventId}/roster`, headers: auth(cs),
      payload: { fullName: 'Walk-up Guest', phone: '9811999888', city: 'Pune' },
    });
    assert.equal(ok.statusCode, 201);
    assert.equal(ok.json().lead_id, null, 'no lead behind them, and that is fine');

    const junk = await h.app.inject({
      method: 'POST', url: `/events/${eventId}/roster`, headers: auth(cs),
      payload: { fullName: 'Bad Number', phone: '12345' },
    });
    assert.equal(junk.statusCode, 400);
  });
});

describe('mentors module', () => {
  const PAID_DEAL = '77777777-0000-0000-0000-000000000002';
  const UNPAID_DEAL = '77777777-0000-0000-0000-000000000003';

  before(() => {
    const leadA = makeLeadFor(USERS.callerA1, 'Warm Paying Client');
    const leadB = makeLeadFor(USERS.callerA1, 'Cold Booked Client');
    fixtureSql(`
      insert into crm.deals (id, lead_id, product_id, counsellor_id, team_id, booked_amount)
      values ('${PAID_DEAL}', '${leadA}', (select id from crm.products limit 1),
              '${USERS.counsellorA}', crm.team_of('${USERS.callerA1}', current_date), 40000),
             ('${UNPAID_DEAL}', '${leadB}', (select id from crm.products limit 1),
              '${USERS.counsellorA}', crm.team_of('${USERS.callerA1}', current_date), 40000);
      insert into crm.payments (deal_id, amount, mode, recorded_by)
      values ('${PAID_DEAL}', 40000, 'upi', '${USERS.counsellorA}');
    `);
  });

  it('a mentor reads the book: the paid client is in, the unpaid deal is not', async () => {
    const m = await login(h.app, EMAILS.mentor);
    const res = await h.app.inject({ method: 'GET', url: '/mentors/book', headers: auth(m) });
    assert.equal(res.statusCode, 200);
    const { clients, mentors } = res.json();
    assert.ok(clients.some((c: { deal_id: string }) => c.deal_id === PAID_DEAL),
      'money recorded means listed');
    assert.ok(!clients.some((c: { deal_id: string }) => c.deal_id === UNPAID_DEAL),
      'booked without payment is not a client');
    assert.ok(mentors.some((u: { id: string }) => u.id === USERS.mentor),
      'the mentors directory lists the mentor');
    const row = clients.find((c: { deal_id: string }) => c.deal_id === PAID_DEAL);
    assert.equal(row.health, 'amber', 'paid today, never touched: amber until worked');
  });

  it('a caller cannot open the book at all', async () => {
    const a1 = await login(h.app, EMAILS.callerA1);
    const res = await h.app.inject({ method: 'GET', url: '/mentors/book', headers: auth(a1) });
    assert.equal(res.statusCode, 403);
  });

  it('three taps log a touchpoint and the health chip moves', async () => {
    const m = await login(h.app, EMAILS.mentor);
    const logged = await h.app.inject({
      method: 'POST', url: `/mentors/${PAID_DEAL}/touchpoints`, headers: auth(m),
      payload: { channel: 'call', outcome: 'reached_positive', upsell: 'high', upsellNote: 'annual plan' },
    });
    assert.equal(logged.statusCode, 201);
    assert.equal(logged.json().mentor_id, USERS.mentor, 'the log is signed by the logger');

    const res = await h.app.inject({ method: 'GET', url: '/mentors/book', headers: auth(m) });
    const row = res.json().clients.find((c: { deal_id: string }) => c.deal_id === PAID_DEAL);
    assert.equal(row.health, 'green', 'touched today and positive: green');
    assert.equal(row.upsell_potential, 'high');

    const tl = await h.app.inject({
      method: 'GET', url: `/mentors/${PAID_DEAL}/timeline`, headers: auth(m),
    });
    assert.equal(tl.statusCode, 200);
    assert.equal(tl.json().touchpoints.length, 1);
    assert.equal(tl.json().touchpoints[0].mentor_name, 'Mentor One');
  });

  it('a concern raised turns the client red immediately', async () => {
    const m = await login(h.app, EMAILS.mentor);
    await h.app.inject({
      method: 'POST', url: `/mentors/${PAID_DEAL}/touchpoints`, headers: auth(m),
      payload: { channel: 'whatsapp', outcome: 'reached_concern' },
    });
    const res = await h.app.inject({ method: 'GET', url: '/mentors/book', headers: auth(m) });
    const row = res.json().clients.find((c: { deal_id: string }) => c.deal_id === PAID_DEAL);
    assert.equal(row.health, 'red');
  });

  it('touchpoints cannot be logged on an unpaid deal or dated in the future', async () => {
    const m = await login(h.app, EMAILS.mentor);
    const unpaid = await h.app.inject({
      method: 'POST', url: `/mentors/${UNPAID_DEAL}/touchpoints`, headers: auth(m),
      payload: { channel: 'call', outcome: 'reached_neutral' },
    });
    assert.equal(unpaid.statusCode, 404, 'no money, no client, no log');

    const future = await h.app.inject({
      method: 'POST', url: `/mentors/${PAID_DEAL}/touchpoints`, headers: auth(m),
      payload: { channel: 'call', outcome: 'reached_neutral', touchedOn: '2030-01-01' },
    });
    assert.equal(future.statusCode, 400);
  });

  it('the warm pipeline is team-fenced: counsellor A sees the upsell, counsellor B does not', async () => {
    const ca = await login(h.app, EMAILS.counsellorA);
    const resA = await h.app.inject({ method: 'GET', url: '/mentors/book?upsell=high', headers: auth(ca) });
    assert.equal(resA.statusCode, 200);
    assert.ok(resA.json().clients.some((c: { deal_id: string }) => c.deal_id === PAID_DEAL),
      'the team counsellor sees the flagged client');

    const cb = await login(h.app, EMAILS.counsellorB);
    const resB = await h.app.inject({ method: 'GET', url: '/mentors/book', headers: auth(cb) });
    assert.ok(!resB.json().clients.some((c: { deal_id: string }) => c.deal_id === PAID_DEAL),
      'RLS keeps the other team out - row filtering, not menu hiding');
  });

  it('assignment is an admin act, refused for non-mentor targets', async () => {
    const m = await login(h.app, EMAILS.mentor);
    const notAdmin = await h.app.inject({
      method: 'PUT', url: `/mentors/${PAID_DEAL}/assign`, headers: auth(m),
      payload: { mentorId: USERS.mentor },
    });
    assert.equal(notAdmin.statusCode, 403);

    const admin = await login(h.app, EMAILS.admin);
    const toCaller = await h.app.inject({
      method: 'PUT', url: `/mentors/${PAID_DEAL}/assign`, headers: auth(admin),
      payload: { mentorId: USERS.callerA1 },
    });
    assert.equal(toCaller.statusCode, 400, 'a caller is not a mentor');

    const ok = await h.app.inject({
      method: 'PUT', url: `/mentors/${PAID_DEAL}/assign`, headers: auth(admin),
      payload: { mentorId: USERS.mentor },
    });
    assert.equal(ok.statusCode, 200);
    assert.equal(ok.json().mentor_id, USERS.mentor);
  });
});

describe('tata tele: the dialler and the sensor on one verification pipeline', () => {
  const TT_SECRET = 'test-tata-secret';

  /** Smartflo stamps are wall-clock in the account timezone (IST). */
  const istStamp = (d = new Date()) => {
    const date = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(d);
    const time = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }).format(d);
    return `${date} ${time}`;
  };

  /** One call-hangup webhook event, in Smartflo's variable names. */
  const hangupEvent = (over: Record<string, unknown>) => ({
    call_id: `${Date.now()}.1`,
    direction: 'outbound',
    call_status: 'answered',
    answered_agent_number: '919000000001', // caller A1's Dialing number, per seed
    start_stamp: istStamp(),
    ...over,
  });

  let leadId = '';
  let leadNumber = ''; // national digits, as Smartflo sends them

  before(() => {
    process.env.TATA_TELE_WEBHOOK_SECRET = TT_SECRET;
    process.env.SERVICE_USER_ID = USERS.ops;
    delete process.env.TATA_TELE_API_TOKEN;
    delete process.env.TATA_TELE_LOGIN_EMAIL;
    delete process.env.TATA_TELE_LOGIN_PASSWORD;
    fixtureSql(`update crm.settings set value = 'true'::jsonb where key = 'tata_tele.enabled';`);
    // These tests click as one caller seconds apart; the double-click guard
    // has its own test in the power-dialling block.
    fixtureSql(`update crm.settings set value = '0'::jsonb where key = 'tata_tele.click_cooldown_seconds';`);

    leadId = makeLeadFor(USERS.callerA1, 'Smartflo Client');
    leadNumber = fixtureSql(`select phone_e164 from crm.leads where id = '${leadId}'`)
      .trim().replace('+91', '');
  });

  it('the webhook admits nobody without the shared secret', async () => {
    const noSecret = await h.app.inject({
      method: 'POST', url: '/integrations/tata-tele/webhook', payload: {},
    });
    assert.equal(noSecret.statusCode, 401);

    const wrong = await h.app.inject({
      method: 'POST', url: '/integrations/tata-tele/webhook?secret=guess', payload: {},
    });
    assert.equal(wrong.statusCode, 401);

    // Unconfigured reads the same as wrong: nothing gets in until the secret
    // is deliberately set on the server.
    delete process.env.TATA_TELE_WEBHOOK_SECRET;
    const unconfigured = await h.app.inject({
      method: 'POST', url: `/integrations/tata-tele/webhook?secret=${TT_SECRET}`, payload: {},
    });
    assert.equal(unconfigured.statusCode, 401);
    process.env.TATA_TELE_WEBHOOK_SECRET = TT_SECRET;
  });

  it('a delivery ingests, matches the lead, and repeats as an update, never a duplicate', async () => {
    const event = hangupEvent({
      uuid: 'wh-1',
      call_to_number: `91${leadNumber}`,
      billsec: '75',
      recording_url: 'https://cloudphone.tatateleservices.com/file/recording?id=wh1',
    });

    // Smartflo sends one JSON object per event; a batching relay may send an
    // array. Both are the same door.
    const first = await h.app.inject({
      method: 'POST',
      url: '/integrations/tata-tele/webhook',
      headers: { 'x-tata-tele-secret': TT_SECRET },
      payload: event,
    });
    assert.equal(first.statusCode, 200, first.body);
    assert.partialDeepStrictEqual(first.json(), { received: 1, seen: 1, inserted: 1, matched: 1 });

    const again = await h.app.inject({
      method: 'POST',
      url: `/integrations/tata-tele/webhook?secret=${TT_SECRET}`,
      payload: [event],
    });
    assert.equal(again.statusCode, 200);
    assert.partialDeepStrictEqual(again.json(), { inserted: 0, updated: 1 });
  });

  it('the caller is offered the Smartflo call and one click verifies the dial - recording withheld from them', async () => {
    const caller = await login(h.app, EMAILS.callerA1);

    const sug = await h.app.inject({
      method: 'GET', url: `/leads/${leadId}/device-log-suggestion`, headers: auth(caller),
    });
    assert.equal(sug.statusCode, 200);
    const suggestion = sug.json().suggestion;
    assert.ok(suggestion, 'the Smartflo row is offered exactly like a companion-app row');
    assert.equal(suggestion.duration_seconds, 75);
    assert.equal(suggestion.source, 'tata_tele');
    assert.equal(suggestion.recording_url, null, 'a caller never sees their own recordings');

    const logged = await h.app.inject({
      method: 'POST', url: `/leads/${leadId}/calls`, headers: auth(caller),
      payload: { disposition: 'connected_interested', durationSeconds: 75, deviceLogId: suggestion.id },
    });
    assert.ok(logged.statusCode < 300, logged.body);

    const detail = await h.app.inject({
      method: 'GET', url: `/leads/${leadId}`, headers: auth(caller),
    });
    const attempt = detail.json().attempts[0];
    assert.equal(attempt.is_verified, true, 'the Smartflo row is what flips is_verified');
    assert.equal(attempt.recording_url, null);
  });

  it('the counsellor gets the recording on the same attempt, for coaching', async () => {
    const counsellor = await login(h.app, EMAILS.counsellorA);
    const detail = await h.app.inject({
      method: 'GET', url: `/leads/${leadId}`, headers: auth(counsellor),
    });
    assert.equal(detail.statusCode, 200);
    const attempt = detail.json().attempts[0];
    assert.equal(attempt.is_verified, true);
    assert.match(attempt.recording_url ?? '', /recording/, 'matched rows carry the recording for the counsellor');
  });

  it('click-to-call names each missing piece plainly instead of failing vaguely', async () => {
    const caller = await login(h.app, EMAILS.callerA1);
    const c2cLead = makeLeadFor(USERS.callerA1, 'Refusal Client');

    // No credentials on the server.
    const unconfigured = await h.app.inject({
      method: 'POST', url: `/leads/${c2cLead}/call`, headers: auth(caller),
    });
    assert.equal(unconfigured.statusCode, 400);
    assert.match(unconfigured.json().message, /TATA_TELE_LOGIN_EMAIL/);

    // Credentials present, integration switched off.
    h.app.tataTele = {
      baseUrl: '',
      clickToCall: async () => ({ refId: 'never', message: 'unused' }),
    };
    fixtureSql(`update crm.settings set value = 'false'::jsonb where key = 'tata_tele.enabled';`);
    const disabled = await h.app.inject({
      method: 'POST', url: `/leads/${c2cLead}/call`, headers: auth(caller),
    });
    assert.equal(disabled.statusCode, 409);
    assert.match(disabled.json().message, /tata_tele\.enabled/);
    fixtureSql(`update crm.settings set value = 'true'::jsonb where key = 'tata_tele.enabled';`);

    // A user with no Dialing number: Smartflo has no phone to ring first.
    const admin = await login(h.app, EMAILS.admin);
    const noNumber = await h.app.inject({
      method: 'POST', url: `/leads/${c2cLead}/call`, headers: auth(admin),
    });
    assert.equal(noNumber.statusCode, 400);
    assert.match(noNumber.json().message, /Dialing number/);

    // A lead the user cannot see reads as 404 - RLS is the access control.
    const otherTeam = await login(h.app, EMAILS.callerB1);
    const invisible = await h.app.inject({
      method: 'POST', url: `/leads/${c2cLead}/call`, headers: auth(otherTeam),
    });
    assert.equal(invisible.statusCode, 404);

    delete h.app.tataTele;
  });

  it('a click places the bridge, records itself, and the CDR ties back by ref_id', async () => {
    const caller = await login(h.app, EMAILS.callerA1);
    const clickLead = makeLeadFor(USERS.callerA1, 'Clicked Client');
    const clickNumber = fixtureSql(`select phone_e164 from crm.leads where id = '${clickLead}'`)
      .trim().replace('+91', '');

    let dialled: { agentNumber: string; destinationNumber: string; callerId?: string } | null = null;
    h.app.tataTele = {
      baseUrl: '',
      clickToCall: async (p) => {
        dialled = p;
        return { refId: 'C2C-777', message: 'Call originated successfully.' };
      },
    };

    const placed = await h.app.inject({
      method: 'POST', url: `/leads/${clickLead}/call`, headers: auth(caller),
    });
    assert.equal(placed.statusCode, 200, placed.body);
    assert.equal(placed.json().refId, 'C2C-777');
    assert.match(placed.json().message, /ringing your phone/i);
    assert.deepEqual(dialled, {
      agentNumber: '919000000001',
      destinationNumber: `91${clickNumber}`,
    }, 'numbers come from the database, never the browser');

    const click = fixtureSql(
      `select status || '|' || provider_ref_id from crm.telephony_calls
        where lead_id = '${clickLead}'`,
    ).trim();
    assert.equal(click, 'requested|C2C-777');
    assert.equal(
      fixtureSql(`select count(*) from crm.lead_events
                   where lead_id = '${clickLead}' and event_type = 'click_to_call'`).trim(),
      '1',
      'the click is on the lead timeline',
    );

    // Smartflo's webhook echoes ref_id: the CDR finds the click, the click
    // finds the lead, and the log-call form can now offer the verified row.
    const hangup = await h.app.inject({
      method: 'POST',
      url: `/integrations/tata-tele/webhook?secret=${TT_SECRET}`,
      payload: hangupEvent({
        uuid: 'wh-c2c', ref_id: 'C2C-777',
        call_to_number: `91${clickNumber}`, billsec: '48',
      }),
    });
    assert.equal(hangup.statusCode, 200);
    assert.partialDeepStrictEqual(hangup.json(), { inserted: 1, matched: 1, linked: 1 });

    const linked = fixtureSql(
      `select count(*) from crm.telephony_calls
        where lead_id = '${clickLead}' and device_log_id is not null`,
    ).trim();
    assert.equal(linked, '1', 'the CDR is tied back to the click that placed it');
  });

  it('an upstream failure is a 502 that says whose fault it is - and the failed click is still a row', async () => {
    const caller = await login(h.app, EMAILS.callerA1);
    const failLead = makeLeadFor(USERS.callerA1, 'Unlucky Client');

    h.app.tataTele = {
      baseUrl: '',
      clickToCall: async () => {
        throw new TataTeleApiError(401, 'Token has expired');
      },
    };

    const res = await h.app.inject({
      method: 'POST', url: `/leads/${failLead}/call`, headers: auth(caller),
    });
    assert.equal(res.statusCode, 502);
    assert.match(res.json().message, /90 days/, 'an expired login is named as exactly that');

    const failed = fixtureSql(
      `select status || '|' || failure_reason from crm.telephony_calls
        where lead_id = '${failLead}'`,
    ).trim();
    assert.equal(failed, 'failed|Token has expired', 'a click that never became a call is data');

    delete h.app.tataTele;
  });

  it('/me says whether the Call button should exist at all', async () => {
    const caller = await login(h.app, EMAILS.callerA1);

    const without = await h.app.inject({ method: 'GET', url: '/me', headers: auth(caller) });
    assert.equal(without.json().cloud_calling, false, 'no credentials, no button');

    h.app.tataTele = {
      baseUrl: '',
      clickToCall: async () => ({ refId: null, message: '' }),
    };
    const withClient = await h.app.inject({ method: 'GET', url: '/me', headers: auth(caller) });
    assert.equal(withClient.json().cloud_calling, true);

    fixtureSql(`update crm.settings set value = 'false'::jsonb where key = 'tata_tele.enabled';`);
    const switchedOff = await h.app.inject({ method: 'GET', url: '/me', headers: auth(caller) });
    assert.equal(switchedOff.json().cloud_calling, false, 'the setting is the master switch');
    fixtureSql(`update crm.settings set value = 'true'::jsonb where key = 'tata_tele.enabled';`);

    delete h.app.tataTele;
  });

  it('a stranger agent is quarantined and the health panel names the hold', async () => {
    const posted = await h.app.inject({
      method: 'POST',
      url: `/integrations/tata-tele/webhook?secret=${TT_SECRET}`,
      payload: hangupEvent({
        uuid: 'wh-stranger',
        answered_agent_number: '919333300000',
        call_to_number: `91${leadNumber}`,
        billsec: '30',
      }),
    });
    assert.equal(posted.statusCode, 200);
    assert.partialDeepStrictEqual(posted.json(), { quarantined: 1 });

    const admin = await login(h.app, EMAILS.admin);
    const health = await h.app.inject({
      method: 'GET', url: '/integrations/tata-tele/health', headers: auth(admin),
    });
    assert.equal(health.statusCode, 200);
    const body = health.json();
    assert.equal(body.enabled, true);
    assert.ok(body.quarantine_open >= 1);
    assert.ok(body.quarantine.some((r: { external_id: string }) => r.external_id === 'wh-stranger'));
    assert.equal(body.credentials_configured, false);
    assert.equal(body.webhook_secret_configured, true);
    assert.equal(typeof body.state, 'string');
  });

  it('health is floor-management reading: counsellors see it, quarantine payload stays admin/ops', async () => {
    const caller = await login(h.app, EMAILS.callerA1);
    const denied = await h.app.inject({
      method: 'GET', url: '/integrations/tata-tele/health', headers: auth(caller),
    });
    assert.equal(denied.statusCode, 403);

    const counsellor = await login(h.app, EMAILS.counsellorA);
    const ok = await h.app.inject({
      method: 'GET', url: '/integrations/tata-tele/health', headers: auth(counsellor),
    });
    assert.equal(ok.statusCode, 200);
    // RLS trims the quarantine to nothing for a counsellor - the payloads are
    // raw call data. No WHERE clause in the route decides this.
    assert.deepEqual(ok.json().quarantine, []);
  });

  it('sync-now says plainly when the server has no credentials', async () => {
    const admin = await login(h.app, EMAILS.admin);
    const res = await h.app.inject({
      method: 'POST', url: '/integrations/tata-tele/sync', headers: auth(admin), payload: {},
    });
    assert.equal(res.statusCode, 400);
    assert.match(res.json().message, /TATA_TELE_LOGIN_EMAIL/);
  });

  it('the pull worker logs in, syncs the roster and the CDRs through the same one door', async () => {
    const wkLead = makeLeadFor(USERS.callerA1, 'Pulled Client');
    const wkNumber = fixtureSql(`select phone_e164 from crm.leads where id = '${wkLead}'`)
      .trim().replace('+91', '');

    let authHeader = '';
    let mode: 'ok' | 'expired' = 'ok';
    const fake = http.createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      const url = new URL(req.url ?? '/', 'http://x');
      if (req.method === 'POST' && url.pathname === '/v1/auth/login') {
        if (mode === 'expired') {
          res.statusCode = 401;
          res.end(JSON.stringify({ success: false, message: 'These credentials do not match our records.' }));
          return;
        }
        res.end(JSON.stringify({ success: true, access_token: 'sf-jwt', expires_in: 3600 }));
        return;
      }
      authHeader = String(req.headers.authorization ?? '');
      if (req.method === 'GET' && url.pathname === '/v1/users') {
        res.end(JSON.stringify({
          has_more: false,
          data: [
            { name: 'Caller A1', extension: '05001', user_status: 1,
              agent: { id: '0501', name: 'Caller A1', status: 0, follow_me_number: '+919000000001' } },
            { name: 'Ghost Agent',
              agent: { id: '0502', name: 'Ghost Agent', follow_me_number: '+919666600000' } },
          ],
        }));
        return;
      }
      if (req.method === 'GET' && url.pathname === '/v1/call/records') {
        const page = Number(url.searchParams.get('page') ?? '1');
        const rows = page === 1
          ? [{
              id: '9001', call_id: '1715235734.9001', uuid: 'pull-1',
              direction: 'outbound', status: 'answered',
              agent_number: '919000000001', agent_name: 'caller a1',
              client_number: `91${wkNumber}`, did_number: '+918069651170',
              date: istStamp().slice(0, 10), time: istStamp().slice(11),
              call_duration: 55, answered_seconds: 40,
            }]
          : [];
        res.end(JSON.stringify({ count: rows.length, limit: 100, page, results: rows }));
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ message: 'no such endpoint' }));
    });
    await new Promise<void>((resolve) => fake.listen(0, '127.0.0.1', resolve));
    const port = (fake.address() as { port: number }).port;
    fixtureSql(`update crm.settings
                   set value = to_jsonb('http://127.0.0.1:${port}/v1/'::text)
                 where key = 'tata_tele.base_url';`);

    try {
      const client = new TataTeleClient({
        auth: { kind: 'login', email: 'crm@5circles.test', password: 'pw' },
        baseUrl: 'http://unused.invalid/',
        minIntervalMs: 1,
      });
      const worker = new TataTeleWorker(h.db, USERS.ops, client);
      const summary = await worker.syncOnce();
      assert.ok(summary, 'enabled, so it runs');
      assert.equal(authHeader, 'Bearer sf-jwt', 'the worker logged in and used the JWT');
      assert.partialDeepStrictEqual(summary.agents, { seen: 2 });
      assert.ok(summary.agents.unmapped >= 1, 'the ghost agent is counted unmapped');
      assert.partialDeepStrictEqual(summary.cdrs, { seen: 1, inserted: 1, matched: 1, quarantined: 0 });

      const ghost = fixtureSql(
        `select user_id is null from crm.tata_tele_agents where agent_msisdn = '+919666600000'`,
      ).trim();
      assert.equal(ghost, 't', 'the roster names the stranger for the health panel');

      // The 90-day password rotation must surface as exactly what it is.
      mode = 'expired';
      const expiredClient = new TataTeleClient({
        auth: { kind: 'login', email: 'crm@5circles.test', password: 'rotated-away' },
        baseUrl: 'http://unused.invalid/',
        minIntervalMs: 1,
      });
      const expiredWorker = new TataTeleWorker(h.db, USERS.ops, expiredClient);
      await assert.rejects(
        () => expiredWorker.syncOnce(),
        (err: unknown) => err instanceof TataTeleApiError && err.authFailed,
      );

      // Flipping the setting off is a deliberate quiet, not a failure.
      fixtureSql(`update crm.settings set value = 'false'::jsonb where key = 'tata_tele.enabled';`);
      assert.equal(await worker.syncOnce(), null);
      fixtureSql(`update crm.settings set value = 'true'::jsonb where key = 'tata_tele.enabled';`);
    } finally {
      await new Promise<void>((resolve) => fake.close(() => resolve()));
    }
  });

  it('an admin can fix the one mapping fact: the Dialing number', async () => {
    const admin = await login(h.app, EMAILS.admin);

    const set = await h.app.inject({
      method: 'PUT', url: `/admin/users/${USERS.mentor}/dialing-msisdn`, headers: auth(admin),
      payload: { dialingMsisdn: '98111 22233' },
    });
    assert.equal(set.statusCode, 200);
    assert.equal(set.json().dialing_msisdn, '+919811122233', 'normalised on the way in');

    const dupe = await h.app.inject({
      method: 'PUT', url: `/admin/users/${USERS.founder}/dialing-msisdn`, headers: auth(admin),
      payload: { dialingMsisdn: '9811122233' },
    });
    assert.equal(dupe.statusCode, 409);
    assert.match(dupe.json().message, /already assigned/);

    const junk = await h.app.inject({
      method: 'PUT', url: `/admin/users/${USERS.mentor}/dialing-msisdn`, headers: auth(admin),
      payload: { dialingMsisdn: '12' },
    });
    assert.equal(junk.statusCode, 400);

    const cleared = await h.app.inject({
      method: 'PUT', url: `/admin/users/${USERS.mentor}/dialing-msisdn`, headers: auth(admin),
      payload: { dialingMsisdn: null },
    });
    assert.equal(cleared.statusCode, 200);
    assert.equal(cleared.json().dialing_msisdn, null);

    const counsellor = await login(h.app, EMAILS.counsellorA);
    const denied = await h.app.inject({
      method: 'PUT', url: `/admin/users/${USERS.mentor}/dialing-msisdn`, headers: auth(counsellor),
      payload: { dialingMsisdn: '9811100000' },
    });
    assert.equal(denied.statusCode, 403);
  });
});

/* ===========================================================================
 * Power dialling (0075): the CRM works a caller's due list back to back.
 * A dedicated caller, so earlier tests' leads cannot reorder the queue.
 * =========================================================================== */

describe('power dialling: the due list, back to back', () => {
  const DIALLER = '22222222-0000-0000-0000-0000000000e1';
  const DIALLER_EMAIL = 'dialler@5circles.test';
  const TEAM_A = '11111111-0000-0000-0000-000000000001';
  let token = '';
  let immediateId = '';
  let freshId = '';
  let laterId = '';

  const leadFor = (name: string, phone: string, status: string, priority: string): string =>
    fixtureSql(`
      insert into crm.leads (source_id, full_name, phone_e164, caller_id, team_id, status, priority)
      values ('${SOURCES.meta}', '${name}', '${phone}', '${DIALLER}', '${TEAM_A}', '${status}', '${priority}')
      returning id;
    `).trim().split('\n')[0]!.trim();

  const setting = (key: string, value: string) =>
    fixtureSql(`update crm.settings set value = '${value}'::jsonb where key = '${key}';`);

  before(async () => {
    fixtureSql(`
      insert into crm.users (id, full_name, email, role, employee_code, dialing_msisdn)
      values ('${DIALLER}', 'Power Dialler', '${DIALLER_EMAIL}', 'caller', 'CLR-PWR', '+919812399901')
      on conflict do nothing;
    `);
    const hash = await hashPassword(TEST_PASSWORD);
    await h.db.withoutUser((q) => q.query('select crm.set_password($1, $2, false)', [DIALLER, hash]));
    token = await login(h.app, DIALLER_EMAIL);

    // Open the window around the clock: the suite runs at any hour.
    setting('power_dial.start_hour', '0');
    setting('power_dial.end_hour', '24');
    fixtureSql(`update crm.settings set value = 'true'::jsonb where key = 'tata_tele.enabled';`);

    immediateId = leadFor('Dial Immediate', '+919812399911', 'new', 'immediate');
    freshId = leadFor('Dial Fresh', '+919812399912', 'new', 'normal');
    // Contacted hours ago, next step agreed for later: never auto-dialled early.
    laterId = leadFor('Dial Later', '+919812399913', 'working', 'normal');
    fixtureSql(`
      insert into crm.call_attempts (lead_id, user_id, started_at, duration_seconds, disposition)
      values ('${laterId}', '${DIALLER}', now() - interval '3 hours', 40, 'wrong_person');
      update crm.leads set next_action_at = now() + interval '90 minutes' where id = '${laterId}';
    `);
  });

  after(() => {
    setting('power_dial.start_hour', '9');
    setting('power_dial.end_hour', '21');
    setting('tata_tele.click_cooldown_seconds', '10');
    delete h.app.tataTele;
  });

  const next = (exclude: string[] = []) =>
    h.app.inject({
      method: 'GET',
      url: `/me/dial-next${exclude.length ? `?exclude=${exclude.join(',')}` : ''}`,
      headers: auth(token),
    });

  it('hands out the due work most urgent first, honours skips, and never dials early', async () => {
    const first = await next();
    assert.equal(first.statusCode, 200, first.body);
    const a = first.json();
    assert.equal(a.open, true);
    assert.equal(a.countdown_seconds, 5);
    assert.equal(a.lead.lead_id, immediateId, 'the immediate lead rings first');
    assert.equal(a.lead.dial_reason, 'immediate');
    assert.equal(a.remaining, 2, 'the later lead is not due');

    const second = (await next([immediateId])).json();
    assert.equal(second.lead.lead_id, freshId, 'a skipped lead is passed over');
    assert.equal(second.remaining, 1);

    const done = (await next([immediateId, freshId])).json();
    assert.equal(done.lead, null);
    assert.equal(done.remaining, 0);
    // "Next" is the lead agreed for later - never a skipped fresh lead, which
    // is due already. Null only when the later one falls past midnight IST.
    const laterDue = fixtureSql(
      `select extract(epoch from next_action_at)::bigint from crm.leads where id = '${laterId}'`,
    ).trim();
    assert.ok(
      done.next_due_at === null
        || Math.round(new Date(done.next_due_at).getTime() / 1000) === Number(laterDue),
      `the quiet queue names the work agreed for later, got ${done.next_due_at}`,
    );
  });

  it('keeps to its hours: outside the window it hands out nothing', async () => {
    setting('power_dial.start_hour', '0');
    setting('power_dial.end_hour', '0');
    try {
      const closed = (await next()).json();
      assert.equal(closed.open, false);
      assert.equal(closed.lead, null);
      assert.equal(closed.remaining, 2, 'the due work is still counted, just not dialled');
      assert.deepEqual(closed.window, { start_hour: 0, end_hour: 0 });
    } finally {
      setting('power_dial.end_hour', '24');
    }
  });

  it('a queue is its owner\'s: a colleague is never handed these leads', async () => {
    const a1 = await login(h.app, EMAILS.callerA1);
    const res = await h.app.inject({ method: 'GET', url: '/me/dial-next', headers: auth(a1) });
    assert.equal(res.statusCode, 200);
    assert.ok(![immediateId, freshId, laterId].includes(res.json().lead?.lead_id));
  });

  it('refuses a malformed skip list instead of guessing', async () => {
    const res = await h.app.inject({
      method: 'GET', url: '/me/dial-next?exclude=not-a-uuid', headers: auth(token),
    });
    assert.equal(res.statusCode, 400);
  });

  it('a click returns its id and the server\'s time, and a double-click is refused', async () => {
    setting('tata_tele.click_cooldown_seconds', '60');
    const dialled: string[] = [];
    h.app.tataTele = {
      baseUrl: '',
      clickToCall: async (p) => {
        dialled.push(p.destinationNumber);
        return { refId: `PD-${dialled.length}`, message: 'queued' };
      },
    };

    const placed = await h.app.inject({
      method: 'POST', url: `/leads/${immediateId}/call`, headers: auth(token),
    });
    assert.equal(placed.statusCode, 200, placed.body);
    const body = placed.json();
    assert.match(body.callId, /^[0-9a-f-]{36}$/);
    assert.ok(Math.abs(Date.now() - new Date(body.requestedAt).getTime()) < 60_000,
      'requestedAt is the server moment the call was placed');

    const again = await h.app.inject({
      method: 'POST', url: `/leads/${freshId}/call`, headers: auth(token),
    });
    assert.equal(again.statusCode, 409);
    assert.match(again.json().message, /still ringing your phone/);
    assert.deepEqual(dialled, ['919812399911'], 'the second bridge never reached Smartflo');
  });

  it('a logged outcome moves the dialler on to the next lead', async () => {
    const logged = await h.app.inject({
      method: 'POST', url: `/leads/${immediateId}/calls`, headers: auth(token),
      payload: { disposition: 'not_answered', durationSeconds: 0 },
    });
    assert.ok(logged.statusCode < 300, logged.body);

    const after = (await next()).json();
    assert.equal(after.lead.lead_id, freshId, 'the dialled lead has left the queue');
    assert.equal(after.remaining, 1);
  });

  it('offers only a call record placed after the click, never an older one', async () => {
    const phone = '+919812399912';
    fixtureSql(`
      insert into crm.device_call_logs
        (user_id, device_row_key, counterparty_msisdn, direction, started_at, duration_seconds, source)
      values ('${DIALLER}', 'tata:pd-old', '${phone}', 'outgoing', now() - interval '2 hours', 50, 'tata_tele');
    `);
    const since = new Date(Date.now() - 60_000).toISOString();
    const url = (s?: string) =>
      `/leads/${freshId}/device-log-suggestion${s ? `?since=${encodeURIComponent(s)}` : ''}`;

    const anyAge = (await h.app.inject({ method: 'GET', url: url(), headers: auth(token) })).json();
    assert.equal(anyAge.suggestion?.duration_seconds, 50, 'without since, the old call is offered');

    const fromClick = (await h.app.inject({ method: 'GET', url: url(since), headers: auth(token) })).json();
    assert.equal(fromClick.suggestion, null, 'with since, the older call is not this call');

    fixtureSql(`
      insert into crm.device_call_logs
        (user_id, device_row_key, counterparty_msisdn, direction, started_at, duration_seconds, source)
      values ('${DIALLER}', 'tata:pd-new', '${phone}', 'outgoing', now(), 75, 'tata_tele');
    `);
    const arrived = (await h.app.inject({ method: 'GET', url: url(since), headers: auth(token) })).json();
    assert.equal(arrived.suggestion?.duration_seconds, 75, 'the call placed after the click is offered');
  });
});

/* ===========================================================================
 * Office visits: the walk-in from booking to counselling response, and the
 * conversion ratio built on it (0071).
 * =========================================================================== */

describe('office visits', () => {
  const ADV_ANNUAL = '44444444-0000-0000-0000-000000000002';
  const nextWeek = () => new Date(Date.now() + 7 * 86_400_000).toISOString();

  it('lets a caller book a visit and a counsellor take the arrival', async () => {
    const leadId = makeLeadFor(USERS.callerA1, 'Booked Visitor');
    const a1 = await login(h.app, EMAILS.callerA1);

    const booked = await h.app.inject({
      method: 'POST', url: `/leads/${leadId}/walkin-visit`, headers: auth(a1),
      payload: { counsellorId: USERS.counsellorA, expectedAt: nextWeek(), note: 'wants the annual' },
    });
    assert.equal(booked.statusCode, 201);
    assert.equal(booked.json().status, 'expected');
    // Credit for the walk-in belongs to the caller who sent them in.
    assert.equal(booked.json().caller_id, USERS.callerA1);
    assert.equal(booked.json().counsellor_id, USERS.counsellorA);

    // The arrival completes that booking rather than opening a second visit:
    // one person in the office is one visit, which is what makes the ratio
    // a ratio rather than a guess.
    const ca = await login(h.app, EMAILS.counsellorA);
    const arrived = await h.app.inject({
      method: 'POST', url: `/leads/${leadId}/walkin-arrival`, headers: auth(ca), payload: {},
    });
    assert.equal(arrived.statusCode, 201);
    assert.equal(arrived.json().visit_id, booked.json().visit_id, 'same visit, not a second one');
    assert.equal(arrived.json().status, 'arrived');
    assert.ok(arrived.json().arrived_at);

    const all = await h.app.inject({
      method: 'GET', url: `/leads/${leadId}/walkin-visits`, headers: auth(ca),
    });
    assert.equal(all.json().length, 1);
  });

  it('refuses a booked visit with no day — "sometime" is how a visit becomes nothing', async () => {
    const leadId = makeLeadFor(USERS.callerA1, 'Vague Visitor');
    const a1 = await login(h.app, EMAILS.callerA1);
    const res = await h.app.inject({
      method: 'POST', url: `/leads/${leadId}/walkin-visit`, headers: auth(a1),
      payload: { counsellorId: USERS.counsellorA },
    });
    assert.equal(res.statusCode, 400);
  });

  it('records the counselling response, and keeps the lead alive with a next action', async () => {
    const leadId = makeLeadFor(USERS.callerA1, 'Thinking Visitor');
    const ca = await login(h.app, EMAILS.counsellorA);
    const arrived = await h.app.inject({
      method: 'POST', url: `/leads/${leadId}/walkin-arrival`, headers: auth(ca), payload: {},
    });
    const visitId = arrived.json().visit_id;

    const res = await h.app.inject({
      method: 'POST', url: `/walkins/${visitId}/response`, headers: auth(ca),
      payload: { outcome: 'thinking', productId: ADV_ANNUAL, notes: 'discussing with spouse' },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().outcome, 'thinking');
    assert.equal(res.json().status, 'counselled');
    assert.equal(res.json().is_converted, false);

    const lead = await h.app.inject({ method: 'GET', url: `/leads/${leadId}`, headers: auth(ca) });
    assert.ok(lead.json().lead.next_action_at, 'a counselled lead still carries a next action');
  });

  it('will not let a caller write the counselling response', async () => {
    const leadId = makeLeadFor(USERS.callerA1, 'Not Yours To Say');
    const ca = await login(h.app, EMAILS.counsellorA);
    const arrived = await h.app.inject({
      method: 'POST', url: `/leads/${leadId}/walkin-arrival`, headers: auth(ca), payload: {},
    });
    const a1 = await login(h.app, EMAILS.callerA1);
    const res = await h.app.inject({
      method: 'POST', url: `/walkins/${arrived.json().visit_id}/response`, headers: auth(a1),
      payload: { outcome: 'thinking' },
    });
    assert.equal(res.statusCode, 403);
  });

  it('refuses "converted" by hand — the deal is the conversion', async () => {
    const leadId = makeLeadFor(USERS.callerA1, 'Hand Typed');
    const ca = await login(h.app, EMAILS.counsellorA);
    const arrived = await h.app.inject({
      method: 'POST', url: `/leads/${leadId}/walkin-arrival`, headers: auth(ca), payload: {},
    });
    const res = await h.app.inject({
      method: 'POST', url: `/walkins/${arrived.json().visit_id}/response`, headers: auth(ca),
      payload: { outcome: 'converted' },
    });
    assert.equal(res.statusCode, 400, 'not an accepted outcome on this route at all');
  });

  it('marks the visit converted when the deal is booked, carrying the product across', async () => {
    const leadId = makeLeadFor(USERS.callerA2, 'Converted Visitor');
    const ca = await login(h.app, EMAILS.counsellorA);
    const arrived = await h.app.inject({
      method: 'POST', url: `/leads/${leadId}/walkin-arrival`, headers: auth(ca), payload: {},
    });
    const visitId = arrived.json().visit_id;

    const deal = await h.app.inject({
      method: 'POST', url: `/leads/${leadId}/deals`, headers: auth(ca),
      payload: {
        productId: ADV_ANNUAL,
        bookedAmount: 75000,
        instalments: [{ dueDate: '2026-10-05', amount: 75000 }],
      },
    });
    assert.equal(deal.statusCode, 201);

    const visits = await h.app.inject({
      method: 'GET', url: `/leads/${leadId}/walkin-visits`, headers: auth(ca),
    });
    const visit = visits.json().find((v: { visit_id: string }) => v.visit_id === visitId);
    assert.equal(visit.outcome, 'converted', 'the deal marks the visit, nobody types it');
    assert.equal(visit.is_converted, true);
    assert.equal(visit.product_id, ADV_ANNUAL);
    assert.equal(visit.deal_id, deal.json().deal.id);
  });

  it('answers all four conversion questions from the same rows', async () => {
    const admin = await login(h.app, EMAILS.admin);
    const res = await h.app.inject({
      method: 'GET', url: '/dashboards/walkins?from=2000-01-01&to=2100-01-01', headers: auth(admin),
    });
    assert.equal(res.statusCode, 200);
    const d = res.json();

    // How many walk-ins converted.
    assert.ok(Number(d.funnel.arrived) > 0, 'visits were recorded');
    assert.ok(Number(d.funnel.converted) > 0, 'at least one converted');

    // Who converted the most.
    const cns = d.counsellors.find((c: { user_id: string }) => c.user_id === USERS.counsellorA);
    assert.ok(cns, 'the counsellor who took the visits is on the board');
    assert.ok(Number(cns.converted) > 0);

    // Which product converted the most.
    assert.ok(d.products.some((p: { product_id: string; converted: number }) =>
      p.product_id === ADV_ANNUAL && Number(p.converted) > 0));

    // Who called the most walk-ins in — credited to the caller, never the
    // counsellor who greeted them.
    const caller = d.callers.find((c: { user_id: string }) => c.user_id === USERS.callerA2);
    assert.ok(caller, 'the caller who sent them in gets the walk-in');
    assert.ok(Number(caller.walkins) > 0);
  });

  it('shows the desk, and flags a visit nobody has answered for', async () => {
    const leadId = makeLeadFor(USERS.callerB1, 'Left Waiting');
    const cb = await login(h.app, EMAILS.counsellorB);
    const arrived = await h.app.inject({
      method: 'POST', url: `/leads/${leadId}/walkin-arrival`, headers: auth(cb), payload: {},
    });
    fixtureSql(`update crm.walkin_visits set arrived_at = now() - interval '4 hours'
                 where id = '${arrived.json().visit_id}';`);

    const desk = await h.app.inject({ method: 'GET', url: '/walkins/desk', headers: auth(cb) });
    assert.equal(desk.statusCode, 200);
    const row = desk.json().visits.find(
      (v: { visit_id: string }) => v.visit_id === arrived.json().visit_id);
    assert.ok(row, 'the visit is on the desk');
    assert.equal(row.response_overdue, true, 'somebody has been sitting there with no response');
    assert.ok(desk.json().counsellors.length > 0, 'the desk offers who can take a walk-in');
  });

  it('does not show one team’s visits to the other team’s counsellor', async () => {
    const leadId = makeLeadFor(USERS.callerA1, 'Team A Only');
    const ca = await login(h.app, EMAILS.counsellorA);
    const arrived = await h.app.inject({
      method: 'POST', url: `/leads/${leadId}/walkin-arrival`, headers: auth(ca), payload: {},
    });
    const cb = await login(h.app, EMAILS.counsellorB);
    const desk = await h.app.inject({ method: 'GET', url: '/walkins/desk', headers: auth(cb) });
    assert.ok(
      !desk.json().visits.some((v: { visit_id: string }) => v.visit_id === arrived.json().visit_id),
      'RLS keeps the other team’s walk-ins off this desk',
    );
  });

  it('keeps the lead page walk-in button and the visit record in step', async () => {
    // Both are the same act since 0071. Two walk-in numbers that disagree is
    // worse than one nobody built.
    const leadId = makeLeadFor(USERS.callerA1, 'One Number Only');
    const a1 = await login(h.app, EMAILS.callerA1);
    const marked = await h.app.inject({
      method: 'POST', url: `/leads/${leadId}/walkin`, headers: auth(a1), payload: { walkedIn: true },
    });
    assert.equal(marked.statusCode, 200);
    assert.ok(marked.json().walked_in_at);

    const visits = await h.app.inject({
      method: 'GET', url: `/leads/${leadId}/walkin-visits`, headers: auth(a1),
    });
    assert.equal(visits.json().length, 1, 'the tick created the visit record too');
    assert.equal(visits.json()[0].status, 'arrived');
  });
});

/* ===========================================================================
 * Separate leaderboards, and individual targets.
 * =========================================================================== */

describe('leaderboards, one per job', () => {
  it('ranks callers among callers and counsellors among counsellors', async () => {
    const admin = await login(h.app, EMAILS.admin);
    const [callers, counsellors, mixed] = await Promise.all([
      h.app.inject({ method: 'GET', url: '/performance/overall?days=30&role=caller', headers: auth(admin) }),
      h.app.inject({ method: 'GET', url: '/performance/overall?days=30&role=counsellor', headers: auth(admin) }),
      h.app.inject({ method: 'GET', url: '/performance/overall?days=30', headers: auth(admin) }),
    ]);
    assert.equal(callers.statusCode, 200);
    assert.ok(callers.json().every((r: { role: string }) => r.role === 'caller'));
    assert.ok(counsellors.json().every((r: { role: string }) => r.role === 'counsellor'));
    // The default board still carries both, so nothing that asked for the old
    // shape breaks.
    assert.ok(mixed.json().length >= callers.json().length);

    // Each board is ranked from 1 within itself: that is the whole point of
    // splitting them.
    if (callers.json().length > 0) assert.equal(Number(callers.json()[0].rank), 1);
    if (counsellors.json().length > 0) assert.equal(Number(counsellors.json()[0].rank), 1);
  });

  it('rejects a role nobody is', async () => {
    const admin = await login(h.app, EMAILS.admin);
    const res = await h.app.inject({
      method: 'GET', url: '/performance/overall?days=7&role=mentor', headers: auth(admin),
    });
    assert.equal(res.statusCode, 400);
  });
});

describe('individual targets', () => {
  const thisMonth = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' })
    .format(new Date()).slice(0, 7);

  it('gives everyone a target without one having to be set', async () => {
    const admin = await login(h.app, EMAILS.admin);
    const res = await h.app.inject({ method: 'GET', url: '/targets', headers: auth(admin) });
    assert.equal(res.statusCode, 200);
    const people = res.json().people;
    const caller = people.find((p: { user_id: string }) => p.user_id === USERS.callerA1);
    const counsellor = people.find((p: { user_id: string }) => p.user_id === USERS.counsellorB);
    assert.ok(Number(caller.walkin_target) > 0, 'a caller carries the floor walk-in standard');
    assert.equal(caller.revenue_target, null, 'a caller carries no revenue target');
    assert.ok(Number(counsellor.revenue_target) > 0, 'a counsellor carries a share of breakeven');
  });

  it('lets a counsellor set one, and clear it back to the default', async () => {
    const ca = await login(h.app, EMAILS.counsellorA);
    const set = await h.app.inject({
      method: 'PUT', url: `/targets/${USERS.callerA1}`, headers: auth(ca),
      payload: { month: thisMonth, walkinTarget: 25 },
    });
    assert.equal(set.statusCode, 200);
    assert.equal(Number(set.json().walkin_target), 25);
    assert.equal(set.json().is_custom, true);

    const cleared = await h.app.inject({
      method: 'PUT', url: `/targets/${USERS.callerA1}`, headers: auth(ca),
      payload: { month: thisMonth, walkinTarget: null },
    });
    // Cleared falls back to the role default, never to zero: an empty box must
    // not read as "no target".
    assert.ok(Number(cleared.json().walkin_target) > 0);
  });

  it('counts a caller’s walk-ins towards their own target', async () => {
    const leadId = makeLeadFor(USERS.callerB2, 'Target Filler');
    const cb = await login(h.app, EMAILS.counsellorB);
    await h.app.inject({
      method: 'POST', url: `/leads/${leadId}/walkin-arrival`, headers: auth(cb), payload: {},
    });
    const admin = await login(h.app, EMAILS.admin);
    const res = await h.app.inject({ method: 'GET', url: '/targets', headers: auth(admin) });
    const caller = res.json().people.find((p: { user_id: string }) => p.user_id === USERS.callerB2);
    assert.ok(Number(caller.walkins) > 0, 'the caller who sent them in gets the walk-in');
  });

  it('does not let a caller set anybody’s target, including their own', async () => {
    const a1 = await login(h.app, EMAILS.callerA1);
    const res = await h.app.inject({
      method: 'PUT', url: `/targets/${USERS.callerA1}`, headers: auth(a1),
      payload: { month: thisMonth, walkinTarget: 1 },
    });
    assert.equal(res.statusCode, 403);
  });

  it('refuses a target set backwards into a closed month', async () => {
    const admin = await login(h.app, EMAILS.admin);
    const res = await h.app.inject({
      method: 'PUT', url: `/targets/${USERS.counsellorA}`, headers: auth(admin),
      payload: { month: '2024-01', revenueTarget: 1000 },
    });
    assert.equal(res.statusCode, 409);
  });

  it('gives a person their own number for self-reflection', async () => {
    const a1 = await login(h.app, EMAILS.callerA1);
    const res = await h.app.inject({ method: 'GET', url: '/me/target', headers: auth(a1) });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().user_id, USERS.callerA1);
  });
});
