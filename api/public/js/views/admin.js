import { get, post, put } from '../api.js';
import { esc, fmtDT, fmtINR, h, openModal, toast } from '../util.js';

/** Ops/admin surface: settings, users, ingestion, quarantine, security alerts. */
const TABS = [
  ['settings', 'Settings'],
  ['users', 'Users'],
  ['ingest', 'Ingestion'],
  ['products', 'Products'],
  ['quarantine', 'Quarantine'],
  ['alerts', 'Security alerts'],
];

export async function render(outlet, me) {
  outlet.innerHTML = '';
  const tabs = h(`<div class="tabs">${TABS.map(([k, l], i) =>
    `<button class="btn ${i === 0 ? 'active' : ''}" data-tab="${k}">${esc(l)}</button>`).join('')}</div>`);
  const body = h('<div></div>');
  outlet.appendChild(tabs);
  outlet.appendChild(body);

  const draw = { settings, users, ingest, products, quarantine, alerts };
  tabs.addEventListener('click', (e) => {
    const tab = e.target?.dataset?.tab;
    if (!tab) return;
    tabs.querySelectorAll('.btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
    body.innerHTML = '<div class="spin"></div>';
    draw[tab](body, me);
  });

  await settings(body, me);
}

/* ---------------- settings ---------------- */

async function settings(body, me) {
  const rows = await get('/admin/settings');
  body.innerHTML = '';
  body.appendChild(h(`
    <div class="panel">
      <h2>Every tunable number in the system <small>changes are audited with the actor</small></h2>
      <table class="table"><thead><tr><th>Setting</th><th>Value</th><th></th></tr></thead><tbody>
      ${rows.map((s) => `
        <tr data-key="${esc(s.key)}">
          <td><b>${esc(s.key)}</b><div class="hint">${esc(s.description)}</div></td>
          <td style="width:160px"><input class="sv" value="${esc(JSON.stringify(s.value).replace(/^"|"$/g, ''))}"
              style="width:100%;border:1px solid var(--line);border-radius:7px;padding:7px" ${me.role !== 'admin' ? 'disabled' : ''}></td>
          <td class="right" style="width:90px">${me.role === 'admin' ? '<button class="btn small sv-save">Save</button>' : ''}</td>
        </tr>`).join('')}
      </tbody></table>
    </div>`));

  body.addEventListener('click', async (e) => {
    if (!e.target.classList?.contains('sv-save')) return;
    const tr = e.target.closest('tr');
    const key = tr.dataset.key;
    const raw = tr.querySelector('.sv').value.trim();
    // Numbers and booleans go through typed; everything else as a string.
    const value = raw === 'true' ? true : raw === 'false' ? false : raw !== '' && !Number.isNaN(Number(raw)) ? Number(raw) : raw;
    try {
      await put(`/admin/settings/${encodeURIComponent(key)}`, { value });
      toast(`${key} updated.`);
    } catch (err) {
      toast(err.message, 'err');
    }
  });
}

/* ---------------- users ---------------- */

async function users(body, me) {
  const [list, teams] = await Promise.all([get('/admin/users'), get('/admin/teams')]);
  body.innerHTML = '';
  const panel = h(`
    <div class="panel">
      <div class="row spread">
        <h2 class="mt0">Users <small>${list.length}</small></h2>
        ${me.role === 'admin' ? '<button class="btn primary" id="new-user">New user</button>' : ''}
      </div>
      <table class="table"><thead><tr>
        <th>Name</th><th>Email</th><th>Role</th><th>Team</th><th>SIM</th><th>Status</th><th></th>
      </tr></thead><tbody>
      ${list.map((u) => `
        <tr>
          <td>${esc(u.full_name)} <span class="hint">${esc(u.employee_code ?? '')}</span></td>
          <td>${esc(u.email)}</td>
          <td>${esc(u.role)}</td>
          <td>${esc(u.team_name ?? '—')}</td>
          <td class="mono">${esc(u.dialing_msisdn ?? '—')}</td>
          <td>${u.is_active ? '<span class="badge b-ok">active</span>' : '<span class="badge b-mute">deactivated</span>'}</td>
          <td class="right">${me.role === 'admin' && u.is_active
            ? `<button class="btn small danger u-deact" data-id="${esc(u.id)}">Deactivate</button>` : ''}</td>
        </tr>`).join('')}
      </tbody></table>
    </div>`);
  body.appendChild(panel);

  panel.querySelector('#new-user')?.addEventListener('click', () => newUserModal(teams, () => users(body, me)));

  panel.addEventListener('click', async (e) => {
    if (!e.target.classList?.contains('u-deact')) return;
    if (!confirm('Deactivate this user? Their sessions end immediately.')) return;
    try {
      await post(`/admin/users/${e.target.dataset.id}/deactivate`);
      toast('Deactivated — live sessions revoked.');
      users(body, me);
    } catch (err) {
      toast(err.message, 'err');
    }
  });
}

function newUserModal(teams, onDone) {
  const bodyEl = h(`
    <div>
      <label class="f">Full name <input name="name" required></label>
      <label class="f">Email <input name="email" type="email" required></label>
      <div class="frow">
        <label class="f">Role
          <select name="role">
            <option value="caller">caller</option><option value="counsellor">counsellor</option>
            <option value="ops">ops</option><option value="viewer">viewer</option><option value="admin">admin</option>
          </select>
        </label>
        <label class="f">Team
          <select name="team"><option value="">— none —</option>
            ${teams.map((t) => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join('')}
          </select>
        </label>
      </div>
      <div class="frow">
        <label class="f">Dialing SIM <input name="msisdn" placeholder="+91…"></label>
        <label class="f">Employee code <input name="code"></label>
      </div>
      <label class="f">Temporary password
        <span class="hint">at least 10 characters — they must change it at first login</span>
        <input name="temp" minlength="10" required>
      </label>
    </div>`);
  const footer = h('<div><button class="btn primary">Create user</button></div>');
  const { close } = openModal('New user', bodyEl, footer);

  footer.querySelector('button').addEventListener('click', async () => {
    // Check here too: the modal has no <form>, so the browser never enforces
    // minlength on its own, and a round trip to be told "too short" is a
    // worse experience than being told before sending.
    const temp = bodyEl.querySelector('[name=temp]').value;
    if (temp.length < 10) {
      toast('The temporary password needs at least 10 characters.', 'err');
      return;
    }
    try {
      await post('/admin/users', {
        fullName: bodyEl.querySelector('[name=name]').value.trim(),
        email: bodyEl.querySelector('[name=email]').value.trim(),
        role: bodyEl.querySelector('[name=role]').value,
        teamId: bodyEl.querySelector('[name=team]').value || undefined,
        dialingMsisdn: bodyEl.querySelector('[name=msisdn]').value.trim() || undefined,
        employeeCode: bodyEl.querySelector('[name=code]').value.trim() || undefined,
        temporaryPassword: temp,
      });
      toast('User created.');
      close();
      onDone();
    } catch (err) {
      toast(err.message, 'err');
    }
  });
}

/* ---------------- ingestion ---------------- */

async function ingest(body) {
  const [sources, runs] = await Promise.all([get('/admin/sources'), get('/ingest/runs')]);
  body.innerHTML = '';

  if (sources.length === 0) {
    body.appendChild(h(`
      <div class="banner" style="background:var(--warn-bg);color:var(--warn);border-color:#eed9b8">
        No lead sources yet — create one below before importing anything.
      </div>`));
  }

  const srcPanel = h(`
    <div class="panel">
      <div class="row spread">
        <h2 class="mt0">Lead sources <small>${sources.length}</small></h2>
        <button class="btn primary" id="new-source">New source</button>
      </div>
      ${sources.length === 0 ? '' : `
      <table class="table"><thead><tr>
        <th>Name</th><th>Sheet</th><th>Priority</th><th>Last synced</th><th>Active</th>
      </tr></thead><tbody>
      ${sources.map((s) => `
        <tr>
          <td><b>${esc(s.name)}</b></td>
          <td>${s.spreadsheet_id ? `${esc(s.spreadsheet_id.slice(0, 18))}… / ${esc(s.worksheet_name ?? '')}` : '<span class="hint">manual CSV only</span>'}</td>
          <td>${esc(s.default_priority)}</td>
          <td>${esc(fmtDT(s.last_synced_at))}</td>
          <td>${s.is_active ? '<span class="badge b-ok">yes</span>' : '<span class="badge b-mute">no</span>'}</td>
        </tr>`).join('')}
      </tbody></table>`}
    </div>`);
  body.appendChild(srcPanel);
  srcPanel.querySelector('#new-source').addEventListener('click', () => newSourceModal(() => ingest(body)));

  if (sources.length === 0) return;

  const panel = h(`
    <div class="panel">
      <h2>Run an import</h2>
      <div class="frow">
        <label class="f">Source
          <select name="source">${sources.map((s) =>
            `<option value="${esc(s.id)}">${esc(s.name)}${s.spreadsheet_id ? ' (sheet linked)' : ''}</option>`).join('')}
          </select>
        </label>
      </div>
      <div class="row">
        <button class="btn primary" id="run-sheet">Sync from Google Sheet</button>
        <span class="hint">or paste CSV below — same pipeline, same dedupe and quarantine</span>
      </div>
      <label class="f" style="margin-top:12px">CSV (first row = headers)
        <textarea name="csv" rows="5" placeholder="Full Name,Phone Number,Email,City&#10;Asha Rao,9876543210,asha@example.com,Pune"></textarea>
      </label>
      <button class="btn" id="run-csv">Import CSV</button>
      <div id="ingest-result" style="margin-top:12px"></div>
    </div>`);
  body.appendChild(panel);

  const resultBox = panel.querySelector('#ingest-result');
  const showSummary = (s) => {
    resultBox.innerHTML = '';
    resultBox.appendChild(h(`
      <div class="banner" style="background:var(--info-bg);color:var(--info);border-color:#c7d7f8">
        Seen ${Number(s.seen)} · created ${Number(s.created)} · duplicates ${Number(s.duplicate)}
        · quarantined ${Number(s.quarantined)} · assigned ${Number(s.assigned)}
        ${s.errors?.length ? ` · <b>${s.errors.length} row errors</b>` : ''}
      </div>`));
  };

  panel.querySelector('#run-sheet').addEventListener('click', async (e) => {
    e.target.disabled = true;
    try { showSummary(await post(`/ingest/sources/${panel.querySelector('[name=source]').value}/run`)); }
    catch (err) { toast(err.message, 'err'); }
    e.target.disabled = false;
  });
  panel.querySelector('#run-csv').addEventListener('click', async (e) => {
    const csv = panel.querySelector('[name=csv]').value;
    if (!csv.trim()) { toast('Paste some CSV first.', 'err'); return; }
    e.target.disabled = true;
    try { showSummary(await post(`/ingest/sources/${panel.querySelector('[name=source]').value}/csv`, { csv })); }
    catch (err) { toast(err.message, 'err'); }
    e.target.disabled = false;
  });

  body.appendChild(h(`
    <div class="panel">
      <h2>Recent runs</h2>
      ${runs.length === 0 ? '<div class="empty">No runs yet.</div>' : `
      <table class="table"><thead><tr>
        <th>Source</th><th>Started</th><th class="num">Seen</th><th class="num">Created</th>
        <th class="num">Dupes</th><th class="num">Quarantined</th><th>Error</th>
      </tr></thead><tbody>
      ${runs.map((r) => `
        <tr>
          <td>${esc(r.source_name)}</td><td>${esc(fmtDT(r.started_at))}</td>
          <td class="num">${Number(r.rows_seen)}</td><td class="num">${Number(r.rows_created)}</td>
          <td class="num">${Number(r.rows_duplicate)}</td><td class="num">${Number(r.rows_quarantined)}</td>
          <td>${r.error_text ? `<span class="badge b-bad">${esc(r.error_text.slice(0, 60))}</span>` : '—'}</td>
        </tr>`).join('')}
      </tbody></table>`}
    </div>`));
}

function newSourceModal(onDone) {
  const bodyEl = h(`
    <div>
      <label class="f">Name <input name="name" required placeholder="Meta Lead Ads — Main Sheet"></label>
      <div class="frow">
        <label class="f">Google Sheet ID <span class="hint">(from the sheet URL; blank = CSV-only source)</span>
          <input name="sheet" placeholder="1AbC…"></label>
        <label class="f">Worksheet tab <input name="tab" placeholder="Leads"></label>
      </div>
      <label class="f">Default priority
        <select name="priority">
          <option value="normal">normal</option>
          <option value="immediate">immediate (5-minute first-touch SLA)</option>
        </select>
      </label>
      <label class="f">Column map <span class="hint">(optional JSON: field → sheet header; common headers are auto-detected)</span>
        <textarea name="map" rows="3" placeholder='{"full_name":"Full Name","phone":"Phone Number"}'></textarea>
      </label>
    </div>`);
  const footer = h('<div><button class="btn primary">Create source</button></div>');
  const { close } = openModal('New lead source', bodyEl, footer);

  footer.querySelector('button').addEventListener('click', async () => {
    const mapRaw = bodyEl.querySelector('[name=map]').value.trim();
    let columnMap;
    if (mapRaw) {
      try { columnMap = JSON.parse(mapRaw); } catch { toast('The column map is not valid JSON.', 'err'); return; }
    }
    const sheet = bodyEl.querySelector('[name=sheet]').value.trim();
    const tab = bodyEl.querySelector('[name=tab]').value.trim();
    if (sheet && !tab) { toast('A sheet source also needs the worksheet tab name.', 'err'); return; }
    try {
      await post('/admin/sources', {
        name: bodyEl.querySelector('[name=name]').value.trim(),
        spreadsheetId: sheet || undefined,
        worksheetName: tab || undefined,
        defaultPriority: bodyEl.querySelector('[name=priority]').value,
        columnMap,
      });
      toast('Source created.');
      close();
      onDone();
    } catch (err) {
      toast(err.message, 'err');
    }
  });
}

/* ---------------- products ---------------- */

async function products(body, me) {
  const list = await get('/products');
  body.innerHTML = '';
  const panel = h(`
    <div class="panel">
      <div class="row spread">
        <h2 class="mt0">Products <small>what counsellors can book deals against</small></h2>
        ${me.role === 'admin' ? '<button class="btn primary" id="new-product">New product</button>' : ''}
      </div>
      ${list.length === 0 ? '<div class="empty">No products yet — counsellors cannot book a deal until one exists.</div>' : `
      <table class="table"><thead><tr>
        <th>Name</th><th>Code</th><th class="num">List price</th><th>SEBI-regulated</th><th></th>
      </tr></thead><tbody>
      ${list.map((p) => `
        <tr>
          <td>${esc(p.name)}</td><td class="mono">${esc(p.code)}</td>
          <td class="num">${fmtINR(p.list_price_inr)}</td>
          <td>${p.is_sebi_regulated ? '<span class="badge b-info">yes</span>' : '<span class="badge b-mute">no — needs the non-SEBI disclaimer</span>'}</td>
          <td class="right">${me.role === 'admin'
            ? `<button class="btn small danger p-deact" data-id="${esc(p.id)}">Retire</button>` : ''}</td>
        </tr>`).join('')}
      </tbody></table>`}
    </div>`);
  body.appendChild(panel);

  panel.querySelector('#new-product')?.addEventListener('click', () => {
    const bodyEl = h(`
      <div>
        <label class="f">Name <input name="name" required placeholder="Advisory — Annual"></label>
        <div class="frow">
          <label class="f">Code <input name="code" required placeholder="ADV-A"></label>
          <label class="f">List price (₹) <input name="price" type="number" min="1" step="0.01" required></label>
        </div>
        <label class="f">SEBI-regulated product?
          <select name="sebi"><option value="true">Yes — advisory</option><option value="false">No — course / other activity</option></select>
        </label>
      </div>`);
    const footer = h('<div><button class="btn primary">Create product</button></div>');
    const { close } = openModal('New product', bodyEl, footer);
    footer.querySelector('button').addEventListener('click', async () => {
      try {
        await post('/admin/products', {
          name: bodyEl.querySelector('[name=name]').value.trim(),
          code: bodyEl.querySelector('[name=code]').value.trim(),
          listPriceInr: Number(bodyEl.querySelector('[name=price]').value),
          isSebiRegulated: bodyEl.querySelector('[name=sebi]').value === 'true',
        });
        toast('Product created.');
        close();
        products(body, me);
      } catch (err) {
        toast(err.message, 'err');
      }
    });
  });

  panel.addEventListener('click', async (e) => {
    if (!e.target.classList?.contains('p-deact')) return;
    if (!confirm('Retire this product? Existing deals keep it; new deals cannot use it.')) return;
    try {
      await post(`/admin/products/${e.target.dataset.id}/deactivate`);
      toast('Product retired.');
      products(body, me);
    } catch (err) {
      toast(err.message, 'err');
    }
  });
}

/* ---------------- quarantine ---------------- */

async function quarantine(body) {
  const rows = await get('/admin/quarantine');
  body.innerHTML = '';
  const panel = h(`
    <div class="panel">
      <h2>Quarantined rows <small>nothing is dropped — fix and replay</small></h2>
      ${rows.length === 0 ? '<div class="empty">Quarantine is empty.</div>' : `
      <table class="table"><tbody>
      ${rows.map((r) => `
        <tr data-id="${esc(r.id)}">
          <td style="width:40%">
            <b>${esc(r.source_name)}</b> · ${esc(r.source_row_key)}
            <div class="hint">${esc(r.reject_reason)}</div>
            <div class="hint">${esc(fmtDT(r.created_at))}</div>
          </td>
          <td>
            <textarea class="q-payload" rows="4"
              style="width:100%;font-size:12.5px;border:1px solid var(--line);border-radius:7px;padding:8px">${esc(JSON.stringify(r.payload, null, 1))}</textarea>
          </td>
          <td class="right" style="width:90px"><button class="btn small primary q-replay">Replay</button></td>
        </tr>`).join('')}
      </tbody></table>`}
    </div>`);
  body.appendChild(panel);

  panel.addEventListener('click', async (e) => {
    if (!e.target.classList?.contains('q-replay')) return;
    const tr = e.target.closest('tr');
    let values;
    try {
      values = JSON.parse(tr.querySelector('.q-payload').value);
    } catch {
      toast('Fix the JSON first.', 'err');
      return;
    }
    try {
      const summary = await post(`/ingest/quarantine/${tr.dataset.id}/replay`, { values });
      if (Number(summary.created) > 0) { toast('Row fixed — lead created and assigned.'); tr.remove(); }
      else if (Number(summary.duplicate) > 0) { toast('Row matched an existing lead.'); tr.remove(); }
      else toast('Still quarantined — the phone number is still not dialable.', 'err');
    } catch (err) {
      toast(err.message, 'err');
    }
  });
}

/* ---------------- security alerts ---------------- */

async function alerts(body, me) {
  if (me.role !== 'admin') {
    body.innerHTML = '';
    body.appendChild(h('<div class="panel"><div class="empty">Security alerts are admin-only.</div></div>'));
    return;
  }
  const rows = await get('/dashboards/security-alerts');
  body.innerHTML = '';
  const panel = h(`
    <div class="panel">
      <h2>Open security alerts <small>bulk reads and off-hours access</small></h2>
      ${rows.length === 0 ? '<div class="empty">Nothing open. Quiet is good.</div>' : `
      <table class="table"><thead><tr>
        <th>When</th><th>Type</th><th>User</th><th>Severity</th><th>Detail</th><th></th>
      </tr></thead><tbody>
      ${rows.map((a) => `
        <tr>
          <td>${esc(fmtDT(a.raised_at))}</td>
          <td>${esc(String(a.alert_type).replace(/_/g, ' '))}</td>
          <td>${esc(a.full_name ?? '—')}</td>
          <td>${a.severity === 'high' ? '<span class="badge b-bad">high</span>' : '<span class="badge b-warn">medium</span>'}</td>
          <td><span class="hint">${esc(JSON.stringify(a.detail))}</span></td>
          <td class="right"><button class="btn small a-ack" data-id="${esc(a.id)}">Acknowledge</button></td>
        </tr>`).join('')}
      </tbody></table>`}
    </div>`);
  body.appendChild(panel);

  panel.addEventListener('click', async (e) => {
    if (!e.target.classList?.contains('a-ack')) return;
    try {
      await post(`/dashboards/security-alerts/${e.target.dataset.id}/acknowledge`);
      toast('Acknowledged.');
      alerts(body, me);
    } catch (err) {
      toast(err.message, 'err');
    }
  });
}
