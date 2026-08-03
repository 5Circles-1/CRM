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
