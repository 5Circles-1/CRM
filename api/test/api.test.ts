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
    fixtureSql(`update crm.leads set assigned_at = now() - interval '11 minutes',
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
      fixtureSql(`update crm.leads set assigned_at = now() - interval '11 minutes',
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

  it('offers every kind as a popup, so none can be silenced by accident', async () => {
    const a1 = await login(h.app, EMAILS.callerA1);
    const cfg = await h.app.inject({ method: 'GET', url: '/meta/ui-settings', headers: auth(a1) });
    const kinds = cfg.json()['alerts.popup_kinds'];
    for (const k of ['callback_due', 'follow_up_due', 'action_overdue', 'new_lead']) {
      assert.ok(kinds.includes(k), `${k} must be able to pop up`);
    }
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
