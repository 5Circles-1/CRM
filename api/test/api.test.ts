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

let h: TestHarness;

before(async () => {
  rebuildTestDatabase();
  h = await startHarness();
  // Put every caller on the floor so distribution has somewhere to send leads.
  fixtureSql(`
    insert into crm.attendance_sessions (user_id, started_at)
    select id, now() - interval '1 hour' from crm.users where role = 'caller';
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

  it('keeps the quarantined row available for ops to fix', async () => {
    const ops = await login(h.app, EMAILS.ops);
    const res = await h.app.inject({ url: '/admin/quarantine', headers: auth(ops) });
    assert.equal(res.statusCode, 200);
    const rows = res.json();
    assert.ok(rows.length >= 1);
    assert.match(rows[0].reject_reason, /not dialable/);
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

describe('an untouched lead moves to another caller', () => {
  it('moves it after the deadline, and off the first caller entirely', async () => {
    // Requirement 9 in practice: a lead sitting on someone who has not started
    // it is a pipeline leak, and the counsellor is not watching a stopwatch.
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
    await h.app.inject({
      method: 'PUT', url: '/admin/settings/sla.untouched_reassign_minutes',
      headers: auth(admin), payload: { value: 10 },
    });
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
    const res = await h.app.inject({ method: 'GET', url: '/me/alerts', headers: auth(a1) });
    assert.equal(res.statusCode, 200);

    const ids = res.json().alerts.map((a: { lead_id: string }) => a.lead_id);
    assert.ok(ids.includes(leadId), 'my own breached lead must raise an alert');
    assert.ok(!ids.includes(otherLead), 'another caller\'s alert must not leak');
    assert.ok(res.json().critical >= 1);
  });

  it('marks how late each one is, so the list can be ordered by urgency', async () => {
    const a1 = await login(h.app, EMAILS.callerA1);
    const res = await h.app.inject({ method: 'GET', url: '/me/alerts', headers: auth(a1) });
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

  it('records a promised visit as a date somebody has to check', async () => {
    const leadId = makeLeadFor(USERS.callerA1, 'Coming In');
    const a1 = await login(h.app, EMAILS.callerA1);
    await h.app.inject({
      method: 'POST', url: `/leads/${leadId}/calls`, headers: auth(a1),
      payload: { disposition: 'will_visit', durationSeconds: 120, nextActionAt: next() },
    });
    const row = fixtureSql(
      `select (walkin_expected_at is not null)::text from crm.leads where id = '${leadId}';`,
    ).trim();
    assert.equal(row, 'true');
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
    const res = await h.app.inject({ method: 'GET', url: '/me/alerts', headers: auth(a1) });
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
    const res = await h.app.inject({ method: 'GET', url: '/me/alerts', headers: auth(a1) });
    const kinds = res.json().alerts
      .filter((a: { lead_id: string }) => a.lead_id === leadId)
      .map((a: { kind: string }) => a.kind);
    assert.ok(kinds.includes('new_lead'), `expected new_lead, got ${kinds.join(',')}`);
  });

  it('only customer appointments interrupt, but nothing is silenced from the bell', async () => {
    // This rule changed deliberately. Eight kinds used to interrupt, which on
    // a busy floor is a popup every few minutes and trains people to dismiss
    // without reading - so a real callback gets clicked away. Now only the two
    // appointment kinds pop. Everything else still reaches the bell and the
    // Alerts tab in full, which is the distinction that matters: being nagged
    // about a lead and losing a lead are different failures.
    const a1 = await login(h.app, EMAILS.callerA1);
    const cfg = await h.app.inject({ method: 'GET', url: '/meta/ui-settings', headers: auth(a1) });
    const popups = cfg.json()['alerts.popup_kinds'];

    assert.deepEqual([...popups].sort(), ['callback_due', 'callback_soon']);
    for (const k of ['follow_up_due', 'action_overdue', 'new_lead', 'retap_due']) {
      assert.ok(!popups.includes(k), `${k} must not interrupt`);
    }

    // ...and the quiet kinds are still delivered, just without a popup.
    const alerts = await h.app.inject({ method: 'GET', url: '/me/alerts', headers: auth(a1) });
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

  it('serves the browser the reminder and refresh cadence settings', async () => {
    const a1 = await login(h.app, EMAILS.callerA1);
    const res = await h.app.inject({ method: 'GET', url: '/meta/ui-settings', headers: auth(a1) });
    const cfg = res.json();
    assert.ok(Number(cfg['alerts.repeat_minutes']) > 0, 'critical reminders repeat by default');
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

    const alerts = await h.app.inject({ method: 'GET', url: '/me/alerts', headers: auth(cs) });
    assert.ok(!alerts.json().alerts.some(
      (a: { lead_id: string; kind: string }) => a.lead_id === leadId && a.kind.includes('overdue')),
      'a re-tap lead never nags as overdue');
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
});

describe('per-lead reminders (API)', () => {
  it('mutes a lead so it raises no reminder', async () => {
    const leadId = makeLeadFor(USERS.callerA1, 'API Mute');
    fixtureSql(`update crm.leads set next_action_at = now() - interval '2 hours',
                 first_touched_at = now() - interval '3 hours', attempt_count = 1
               where id='${leadId}';`);
    const a1 = await login(h.app, EMAILS.callerA1);
    const before = await h.app.inject({ method: 'GET', url: '/me/alerts', headers: auth(a1) });
    assert.ok(before.json().alerts.some((a: { lead_id: string }) => a.lead_id === leadId),
      'an overdue lead alerts before muting');

    const put = await h.app.inject({
      method: 'PUT', url: `/leads/${leadId}/reminder`, headers: auth(a1),
      payload: { muted: true },
    });
    assert.equal(put.statusCode, 200);
    assert.equal(put.json().reminder_muted, true);

    const after = await h.app.inject({ method: 'GET', url: '/me/alerts', headers: auth(a1) });
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
    const alerts = await h.app.inject({ method: 'GET', url: '/me/alerts', headers: auth(a1) });
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
    const res = await h.app.inject({ method: 'GET', url: '/me/alerts', headers: auth(cs) });
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
    const res = await h.app.inject({ method: 'GET', url: '/me/alerts', headers: auth(a1) });
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
      payload: { fullName: 'Desk Payer Fixed', amount: 32000 },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().client.full_name, 'Desk Payer Fixed');
    assert.equal(Number(res.json().client.booked_amount), 32000);
    assert.equal(Number(res.json().client.paid_amount), 32000, 'the single payment follows the correction');

    const event = fixtureSql(
      `select payload -> 'changes' -> 'amount' ->> 'to' from crm.lead_events
        where event_type = 'client_edited' order by id desc limit 1;`,
    ).trim();
    assert.equal(event, '32000.00', 'old and new values land in the lead history');
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
                 where key = 'sla.untouched_reassign_minutes';`);
    const a1 = await login(h.app, EMAILS.callerA1);
    const res = await h.app.inject({
      method: 'GET', url: '/training/how-leads-are-distributed', headers: auth(a1),
    });
    assert.equal(res.statusCode, 200);
    const { body } = res.json();
    assert.ok(!body.includes('{{setting:'), 'no placeholder survives to the page');
    assert.match(body, /7\s+working minutes/, 'it quotes the value that is actually configured');

    fixtureSql(`update crm.settings set value = '10'::jsonb
                 where key = 'sla.untouched_reassign_minutes';`);
    const after = await h.app.inject({
      method: 'GET', url: '/training/how-leads-are-distributed', headers: auth(a1),
    });
    assert.match(after.json().body, /10\s+working minutes/, 'change the setting, the page follows');
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
