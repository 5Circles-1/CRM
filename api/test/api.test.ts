import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  auth,
  EMAILS,
  fixtureSql,
  login,
  makeLeadFor,
  rebuildTestDatabase,
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

  it('refuses to guess when two tabs match equally well', () => {
    // Reading the wrong tab silently is worse than saying so: the leads would
    // arrive from a feed nobody chose, and nothing would look broken.
    assert.equal(resolveWorksheet('leads', ['Leads', 'LEADS']), null);
  });

  it('returns null when nothing resembles the configured name', () => {
    assert.equal(resolveWorksheet('Sheet 1', TABS), null);
  });
});
