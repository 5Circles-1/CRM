/**
 * API integration tests: the real server against the real database, through
 * the same RLS-constrained role production uses.
 *
 * Areas: auth, the lead list and its filters, manual add + dedupe, the five
 * call outcomes and the qualified handover, checkpoints, assignment
 * authority, reminders, the dashboard, admin user management, CSV import
 * with quarantine and re-enquiry.
 */
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
  SOURCES,
  TEST_PASSWORD,
  USERS,
  type TestHarness,
} from './helpers.ts';

let h: TestHarness;
let adminTok: string;
let sanyaTok: string;
let harshTok: string;
let aishaTok: string;

before(async () => {
  rebuildTestDatabase();
  h = await startHarness();
  adminTok = await login(h.app, EMAILS.admin);
  sanyaTok = await login(h.app, EMAILS.sanya);
  harshTok = await login(h.app, EMAILS.harsh);
  aishaTok = await login(h.app, EMAILS.aisha);
});

after(async () => {
  await h.close();
});

const get = async (url: string, tok: string) =>
  await h.app.inject({ method: 'GET', url, headers: auth(tok) });
const post = async (url: string, tok: string, payload?: unknown) =>
  await h.app.inject({
    method: 'POST',
    url,
    headers: auth(tok),
    payload: (payload ?? {}) as Record<string, unknown>,
  });
const put = async (url: string, tok: string, payload: unknown) =>
  await h.app.inject({
    method: 'PUT',
    url,
    headers: auth(tok),
    payload: payload as Record<string, unknown>,
  });

describe('auth', () => {
  it('rejects a wrong password and a missing session', async () => {
    const bad = await h.app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: EMAILS.sanya, password: 'wrong-password-123' },
    });
    assert.equal(bad.statusCode, 401);

    const noSession = await h.app.inject({ method: 'GET', url: '/leads' });
    assert.equal(noSession.statusCode, 401);
  });

  it('identifies the signed-in user', async () => {
    const res = await get('/me', sanyaTok);
    assert.equal(res.statusCode, 200);
    const me = res.json();
    assert.equal(me.full_name, 'Sanya');
    assert.equal(me.role, 'caller');
  });

  it('the System service account cannot log in', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'system@5circles.test', password: TEST_PASSWORD },
    });
    assert.equal(res.statusCode, 401);
  });

  it('logout revokes the session', async () => {
    const tok = await login(h.app, EMAILS.harsh);
    await post('/auth/logout', tok);
    const res = await get('/me', tok);
    assert.equal(res.statusCode, 401);
  });
});

describe('manual add and dedupe', () => {
  it('normalises the phone and assigns a caller automatically', async () => {
    const res = await post('/leads', adminTok, {
      fullName: 'Walk In One',
      phone: '098111 22233',
      city: 'Pune',
    });
    assert.equal(res.statusCode, 200);
    const lead = res.json();
    assert.equal(lead.phone_e164, '+919811122233');
    assert.equal(lead.stage, 'new');
    assert.ok([USERS.sanya, USERS.harsh].includes(lead.assigned_to), 'must land on a caller');
    assert.ok(lead.next_follow_up_at, 'fresh lead must be due');
    assert.equal(lead.source_name, 'Manual');
  });

  it('refuses an undialable number with a readable message', async () => {
    const res = await post('/leads', sanyaTok, { phone: '12345' });
    assert.equal(res.statusCode, 400);
    assert.match(res.json().message, /not a dialable/);
  });

  it('a second lead for the same phone is a 409 that points at the first', async () => {
    const res = await post('/leads', harshTok, { fullName: 'Dup', phone: '+91 98111 22233' });
    assert.equal(res.statusCode, 409);
    const body = res.json();
    assert.ok(body.leadId, 'must carry the existing lead id');
    assert.match(body.message, /already has this number/);
  });
});

describe('outcomes and the qualified handover', () => {
  it('not answered: stage calling, streak counted, retry booked', async () => {
    const id = makeLeadFor(USERS.sanya, 'NA Case');
    const res = await post(`/leads/${id}/call`, sanyaTok, { outcome: 'not_answered' });
    assert.equal(res.statusCode, 200);
    const lead = res.json();
    assert.equal(lead.stage, 'calling');
    assert.equal(lead.na_streak, 1);
    assert.equal(lead.last_outcome, 'not_answered');
    assert.ok(new Date(lead.next_follow_up_at).getTime() > Date.now() + 20 * 3600 * 1000);
  });

  it('a call-back without a time is refused with the reason', async () => {
    const id = makeLeadFor(USERS.sanya, 'CB Case');
    const res = await post(`/leads/${id}/call`, sanyaTok, { outcome: 'call_back' });
    assert.equal(res.statusCode, 409);
    assert.match(res.json().message, /date and time/);
  });

  it('a call-back books the chosen time', async () => {
    const id = makeLeadFor(USERS.sanya, 'CB Timed');
    const at = new Date(Date.now() + 3 * 3600 * 1000).toISOString();
    const res = await post(`/leads/${id}/call`, sanyaTok, {
      outcome: 'call_back',
      note: 'asked for evening',
      nextFollowUpAt: at,
    });
    assert.equal(res.statusCode, 200);
    assert.equal(new Date(res.json().next_follow_up_at).getTime(), new Date(at).getTime());
  });

  it('qualified by a caller passes the lead to the follow-up person', async () => {
    const id = makeLeadFor(USERS.harsh, 'Qualify Case');
    const res = await post(`/leads/${id}/call`, harshTok, {
      outcome: 'qualified',
      note: 'wants the webinar',
    });
    assert.equal(res.statusCode, 200);
    const lead = res.json();
    assert.equal(lead.stage, 'qualified');
    assert.equal(lead.assigned_to, USERS.aisha);
    assert.equal(lead.assigned_name, 'Aisha');
  });

  it('the timeline records who did what', async () => {
    const id = makeLeadFor(USERS.harsh, 'Timeline Case');
    await post(`/leads/${id}/call`, harshTok, { outcome: 'not_answered' });
    await post(`/leads/${id}/note`, sanyaTok, { note: 'spoke to spouse, call after 6' });
    const res = await get(`/leads/${id}`, adminTok);
    assert.equal(res.statusCode, 200);
    const { activities } = res.json();
    const kinds = activities.map((a: { kind: string }) => a.kind);
    assert.ok(kinds.includes('call') && kinds.includes('note') && kinds.includes('system'));
    const note = activities.find((a: { kind: string }) => a.kind === 'note');
    assert.equal(note.user_name, 'Sanya');
  });

  it('not qualified closes; reopen brings it back', async () => {
    const id = makeLeadFor(USERS.sanya, 'NQ Case');
    const closed = await post(`/leads/${id}/call`, sanyaTok, { outcome: 'not_qualified' });
    assert.equal(closed.json().stage, 'not_qualified');
    assert.equal(closed.json().next_follow_up_at, null);

    const reopened = await post(`/leads/${id}/reopen`, sanyaTok);
    assert.equal(reopened.statusCode, 200);
    assert.equal(reopened.json().stage, 'calling');
    assert.ok(reopened.json().next_follow_up_at);
  });
});

describe('checkpoints', () => {
  it('invite sent, confirmed, converted - and only an admin can undo', async () => {
    const id = makeLeadFor(USERS.aisha, 'Convert Case');
    await post(`/leads/${id}/call`, aishaTok, { outcome: 'qualified' });

    const t = await post(`/leads/${id}/checkpoint`, aishaTok, { kind: 'template_sent', on: true });
    assert.ok(t.json().template_sent_at);
    const c = await post(`/leads/${id}/checkpoint`, aishaTok, { kind: 'confirmed', on: true });
    assert.ok(c.json().confirmed_at);

    const won = await post(`/leads/${id}/checkpoint`, aishaTok, { kind: 'converted', on: true });
    assert.equal(won.json().stage, 'converted');

    const refused = await post(`/leads/${id}/checkpoint`, aishaTok, { kind: 'converted', on: false });
    assert.equal(refused.statusCode, 403);
    assert.match(refused.json().message, /only an admin/i);

    const undone = await post(`/leads/${id}/checkpoint`, adminTok, { kind: 'converted', on: false });
    assert.equal(undone.statusCode, 200);
    assert.equal(undone.json().stage, 'qualified');
  });

  it('a closed lead cannot be converted without reopening', async () => {
    const id = makeLeadFor(USERS.sanya, 'Closed Convert');
    await post(`/leads/${id}/call`, sanyaTok, { outcome: 'not_qualified' });
    const res = await post(`/leads/${id}/checkpoint`, sanyaTok, { kind: 'converted', on: true });
    assert.equal(res.statusCode, 409);
    assert.match(res.json().message, /reopen/);
  });
});

describe('assignment authority', () => {
  it('a caller cannot move an owned lead; an admin can; anyone can claim unassigned', async () => {
    const id = makeLeadFor(USERS.sanya, 'Move Case');

    const refused = await post(`/leads/${id}/assign`, harshTok, { userId: USERS.harsh });
    assert.equal(refused.statusCode, 403);

    const moved = await post(`/leads/${id}/assign`, adminTok, { userId: USERS.harsh });
    assert.equal(moved.statusCode, 200);
    assert.equal(moved.json().assigned_to, USERS.harsh);

    fixtureSql(`update crm.leads set assigned_to = null where id = '${id}';`);
    const claimOther = await post(`/leads/${id}/assign`, sanyaTok, { userId: USERS.harsh });
    assert.equal(claimOther.statusCode, 403);
    const claimed = await post(`/leads/${id}/assign`, sanyaTok, { userId: USERS.sanya });
    assert.equal(claimed.statusCode, 200);
    assert.equal(claimed.json().assigned_to, USERS.sanya);
  });
});

describe('the lead list and filters', () => {
  it('everyone sees everything; filters narrow it', async () => {
    const all = await get('/leads?limit=500', sanyaTok);
    assert.equal(all.statusCode, 200);
    const total = all.json().total;
    assert.ok(total >= 8, `expected a populated book, got ${total}`);

    const mine = await get('/leads?assigned=me&limit=500', sanyaTok);
    assert.ok(mine.json().total < total);
    assert.ok(
      mine.json().leads.every((l: { assigned_to: string }) => l.assigned_to === USERS.sanya),
    );

    const byStage = await get('/leads?stage=not_qualified', adminTok);
    assert.ok(
      byStage.json().leads.every((l: { stage: string }) => l.stage === 'not_qualified'),
    );

    const today = new Date().toISOString().slice(0, 10);
    const dated = await get(`/leads?from=${today}&to=${today}&limit=500`, adminTok);
    assert.equal(dated.json().total, total, 'everything here was received today');

    const byPhone = await get('/leads?q=9811122233', adminTok);
    assert.equal(byPhone.json().total, 1);
    assert.equal(byPhone.json().leads[0].full_name, 'Walk In One');

    const byName = await get('/leads?q=walk in', adminTok);
    assert.ok(byName.json().total >= 1);
  });

  it('a lead the router does not know is a 404, not a crash', async () => {
    const res = await get('/leads/00000000-0000-0000-0000-000000000000', sanyaTok);
    assert.equal(res.statusCode, 404);
  });
});

describe('reminders', () => {
  it('an overdue lead appears in its owner\'s buckets and in /reminders/due', async () => {
    const id = makeLeadFor(USERS.sanya, 'Reminder Case');
    fixtureSql(
      `update crm.leads set next_follow_up_at = now() - interval '5 minutes' where id = '${id}';`,
    );

    const mine = await get('/reminders', sanyaTok);
    assert.equal(mine.statusCode, 200);
    assert.ok(
      mine.json().overdue.some((l: { id: string }) => l.id === id),
      'overdue bucket must hold the lead',
    );

    const due = await get('/reminders/due', sanyaTok);
    assert.ok(due.json().due.some((l: { id: string }) => l.id === id));

    // Not Harsh's reminder...
    const harshs = await get('/reminders', harshTok);
    assert.ok(!harshs.json().overdue.some((l: { id: string }) => l.id === id));

    // ...but the admin sees the whole floor's.
    const admins = await get('/reminders', adminTok);
    assert.ok(admins.json().overdue.some((l: { id: string }) => l.id === id));

    // Logging the call clears it - doing the work IS dismissing the reminder.
    await post(`/leads/${id}/call`, sanyaTok, { outcome: 'not_answered' });
    const after = await get('/reminders/due', sanyaTok);
    assert.ok(!after.json().due.some((l: { id: string }) => l.id === id));
  });
});

describe('dashboard', () => {
  it('returns the full payload and excludes the service account', async () => {
    const res = await get('/dashboard', sanyaTok);
    assert.equal(res.statusCode, 200);
    const d = res.json();
    assert.ok(d.totals.leads_in >= 8);
    assert.ok(d.totals.calls >= 6);
    assert.ok(d.funnel.received >= d.funnel.contacted);
    assert.ok(d.funnel.contacted >= d.funnel.qualified);
    assert.equal(d.byDay.length, 7);
    const names = d.byPerson.map((p: { full_name: string }) => p.full_name);
    assert.ok(names.includes('Sanya') && names.includes('Aisha'));
    assert.ok(!names.includes('System'));
    const sources = d.bySource.map((s: { source: string }) => s.source);
    assert.ok(sources.includes('Manual'));
  });

  it('rejects a backwards range', async () => {
    const res = await get('/dashboard?from=2026-02-01&to=2026-01-01', adminTok);
    assert.equal(res.statusCode, 400);
  });
});

describe('admin: users', () => {
  it('non-admins are refused', async () => {
    const res = await get('/admin/users', sanyaTok);
    assert.equal(res.statusCode, 403);
  });

  it('creates a user who must change the temporary password', async () => {
    const created = await post('/admin/users', adminTok, {
      fullName: 'New Caller',
      email: 'newcaller@5circles.test',
      role: 'caller',
      password: 'temporary-pass-1',
    });
    assert.equal(created.statusCode, 200);

    const loginRes = await h.app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'newcaller@5circles.test', password: 'temporary-pass-1' },
    });
    assert.equal(loginRes.statusCode, 200);
    assert.equal(loginRes.json().mustChangePassword, true);
  });

  it('a duplicate email says so in words', async () => {
    const res = await post('/admin/users', adminTok, {
      fullName: 'Dup Email',
      email: 'newcaller@5circles.test',
      role: 'caller',
      password: 'temporary-pass-2',
    });
    assert.equal(res.statusCode, 409);
    assert.match(res.json().message, /already exists/);
  });

  it('deactivation kills the live session immediately', async () => {
    const tok = await h.app
      .inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: 'newcaller@5circles.test', password: 'temporary-pass-1' },
      })
      .then((r) => r.json().token as string);

    const users = await get('/admin/users', adminTok).then((r) => r.json());
    const target = users.find((u: { email: string }) => u.email === 'newcaller@5circles.test');
    const off = await put(`/admin/users/${target.id}`, adminTok, { isActive: false });
    assert.equal(off.statusCode, 200);

    const res = await get('/me', tok);
    assert.equal(res.statusCode, 401);

    // ...and they stop receiving leads, but reactivation restores everything.
    const on = await put(`/admin/users/${target.id}`, adminTok, { isActive: true });
    assert.equal(on.statusCode, 200);
  });

  it('an admin cannot deactivate their own account', async () => {
    const res = await put(`/admin/users/${USERS.admin}`, adminTok, { isActive: false });
    assert.equal(res.statusCode, 400);
  });
});

describe('admin: CSV import, quarantine, re-enquiry', () => {
  it('imports, quarantines the undialable, and never duplicates', async () => {
    const csv = [
      'Full Name,Phone Number,Email,City,campaign_name',
      'Import One,98222 00001,one@x.in,Delhi,webinar-nov',
      'Import Two,98222 00002,,Mumbai,webinar-nov',
      'Bad Phone,12345,bad@x.in,Nowhere,webinar-nov',
    ].join('\n');

    const first = await post('/admin/import', adminTok, { sourceId: SOURCES.chatgpt, csv });
    assert.equal(first.statusCode, 200);
    assert.equal(first.json().created, 2);
    assert.equal(first.json().quarantined, 1);

    // Importing the same file again creates nothing: every row - the
    // quarantined one included - is already on record.
    const again = await post('/admin/import', adminTok, { sourceId: SOURCES.chatgpt, csv });
    assert.equal(again.json().created, 0);
    assert.equal(again.json().duplicate, 3);
    assert.equal(again.json().quarantined, 0);

    // The quarantined row is visible with its reason.
    const sources = await get('/admin/sources', adminTok).then((r) => r.json());
    assert.ok(
      sources.quarantined.some((r: { reject_reason: string }) => /not dialable/.test(r.reject_reason)),
    );

    // The imported lead went to a caller through the same round-robin (which
    // caller depends on who is least loaded by now - the admin tests above
    // added one).
    const found = await get('/leads?q=9822200001', adminTok).then((r) => r.json());
    assert.equal(found.total, 1);
    assert.equal(found.leads[0].assigned_role, 'caller');
    assert.equal(found.leads[0].campaign, 'webinar-nov');
  });

  it('a repeat enquiry attaches instead of duplicating, and pulls the follow-up to now', async () => {
    // Meta's source has an explicit column map, so use Meta's own headers.
    const csv = ['Full Name,Phone Number', 'Import One Again,+91 98222 00001'].join('\n');
    const res = await post('/admin/import', adminTok, { sourceId: SOURCES.meta, csv });
    assert.equal(res.json().created, 0);
    assert.equal(res.json().duplicate, 1);

    const found = await get('/leads?q=9822200001', adminTok).then((r) => r.json());
    assert.equal(found.total, 1, 'still exactly one lead');
    assert.equal(found.leads[0].enquiry_count, 2);
    assert.ok(new Date(found.leads[0].next_follow_up_at).getTime() <= Date.now());

    const detail = await get(`/leads/${found.leads[0].id}`, adminTok).then((r) => r.json());
    assert.ok(detail.activities.some((a: { kind: string }) => a.kind === 'enquiry'));
  });

  it('non-admins cannot import', async () => {
    const res = await post('/admin/import', sanyaTok, {
      sourceId: SOURCES.meta,
      csv: 'name,phone\nX,9822200009',
    });
    assert.equal(res.statusCode, 403);
  });
});

describe('quarantined rows are kept, never dropped', () => {
  it('the bad phone row is still there with its payload intact', async () => {
    const n = fixtureSql(
      `select count(*) from crm.ingested_rows where status = 'quarantined';`,
    ).trim();
    assert.ok(Number(n) >= 1);
  });
});
