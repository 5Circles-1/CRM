import { get, post, put } from '../api.js';
import { avatarHtml, esc, fmtDT, fmtINR, h, openModal, toast } from '../util.js';

/** Ops/admin surface: settings, users, ingestion, quarantine, security alerts. */
const TABS = [
  ['settings', 'Settings'],
  ['users', 'Users'],
  ['ingest', 'Ingestion'],
  ['products', 'Products'],
  ['data', 'Data'],
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

  const draw = { settings, users, ingest, products, data, quarantine, alerts };
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
  const panel = h(`
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
    </div>`);
  body.appendChild(panel);

  // On the panel, not on `body`: the tab container outlives every redraw, so a
  // listener there stacked once per visit - the third trip to this tab saved
  // every setting three times and showed three toasts for one click.
  panel.addEventListener('click', async (e) => {
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

/* ---------------- data: keep the floor on current leads ---------------- */

/**
 * The archive button. Two steps on purpose: first a dry-run that says exactly
 * how many leads would move, then the real thing - an owner-level act should
 * never fire off one accidental click. Nothing is deleted: parked leads live
 * in Previous months, searchable, one click from being worked again.
 */
async function data(body) {
  body.innerHTML = '';
  const panel = h(`
    <div class="panel">
      <h2>Keep the floor on current data <small>nothing is deleted — old leads park in Previous months</small></h2>
      <p class="hint mt0" style="max-width:680px">
        Every lead created before the date below — and not worked since it — leaves every
        pipeline, alert and fresh list and parks in <b>Previous months</b>. Paying clients and
        anyone with a deal are never touched. A parked lead stays searchable in Find lead and
        comes back with one click (Pick up &amp; work) if the person ever calls again.
      </p>
      <div class="frow" style="max-width:460px;align-items:flex-end">
        <label class="f" style="margin:0">Keep leads from
          <input type="date" name="cutoff" value="2026-08-15">
        </label>
        <button class="btn primary" id="arch-check" data-testid="archive-check">Check what would move</button>
      </div>
      <div id="arch-result" style="margin-top:12px"></div>
    </div>`);
  body.appendChild(panel);

  const result = panel.querySelector('#arch-result');
  panel.querySelector('#arch-check').addEventListener('click', async () => {
    const before = panel.querySelector('[name=cutoff]').value;
    if (!before) { toast('Pick a date first.', 'err'); return; }
    try {
      const r = await post('/admin/archive-leads', { before, dryRun: true });
      result.innerHTML = '';
      if (r.archived === 0) {
        result.appendChild(h(`<div class="empty">Nothing older than ${esc(before)} is still live — the floor is already clean.</div>`));
        return;
      }
      const go = h(`
        <div class="banner warn">
          <b>${r.archived} lead${r.archived === 1 ? '' : 's'}</b> created before ${esc(before)}
          would move to Previous months.
          <button class="btn danger" id="arch-go" data-testid="archive-go" style="margin-left:10px">Archive them now</button>
        </div>`);
      result.appendChild(go);
      go.querySelector('#arch-go').addEventListener('click', async (e) => {
        e.target.disabled = true;
        try {
          const done = await post('/admin/archive-leads', { before, dryRun: false });
          result.innerHTML = '';
          result.appendChild(h(`
            <div class="banner" style="background:var(--ok-bg);color:var(--ok);border-color:var(--ok-bg)">
              ${done.archived} lead${done.archived === 1 ? '' : 's'} parked in Previous months.
              The pipelines now carry only current data.
            </div>`));
          toast('Archived.');
        } catch (err) {
          toast(err.message, 'err');
          e.target.disabled = false;
        }
      });
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
        <th>Name</th><th>Email</th><th>Role</th><th>Team</th>
        <th title="ACE holds the guaranteed share of fresh leads. Ranked daily from the leaderboard; a pin overrides it.">Tier</th>
        <th>SIM</th><th>Status</th><th></th>
      </tr></thead><tbody>
      ${list.map((u) => `
        <tr>
          <td>${avatarHtml(u.full_name, u.avatar_url, 26)} ${esc(u.full_name)}
              <span class="hint">${esc(u.employee_code ?? '')}</span></td>
          <td>${esc(u.email)}</td>
          <td>${esc(u.role)}</td>
          <td>${esc(u.team_name ?? '—')}
              ${u.is_active && u.role === 'caller' && !u.team_name
                ? '<span class="badge b-bad" title="Distribution walks the teams, so a caller in no team never receives a lead">no team — gets no leads</span>' : ''}</td>
          <td>${u.role !== 'caller' ? '<span class="hint">—</span>'
            : u.tier === 'ace'
              ? `<span class="badge b-warn" title="Gets the guaranteed share of fresh leads${u.tier_pinned ? ' (pinned)' : ' (ranked daily)'}">⭐ ACE</span>`
            : u.tier === 'restricted'
              ? '<span class="badge b-bad" title="Receives no fresh leads">restricted</span>'
              : '<span class="badge b-mute">standard</span>'}
            ${u.tier_pinned ? '<span class="hint" title="An admin pinned this; the daily ranking will not change it until the pin expires">📌</span>' : ''}</td>
          <td class="mono">${esc(u.dialing_msisdn ?? '—')}</td>
          <td>${u.is_active ? '<span class="badge b-ok">active</span>' : '<span class="badge b-mute">deactivated</span>'}</td>
          <td class="right">${me.role !== 'admin' ? '' : u.is_active
            ? `${u.role === 'caller' ? `<button class="btn small u-tier" data-id="${esc(u.id)}">Tier</button>` : ''}
               <button class="btn small u-avatar" data-id="${esc(u.id)}">${u.avatar_url ? 'Change icon' : 'Set icon'}</button>
               <button class="btn small u-pwd" data-id="${esc(u.id)}">Reset password</button>
               <button class="btn small danger u-deact" data-id="${esc(u.id)}">Deactivate</button>`
            : `<button class="btn small u-react" data-id="${esc(u.id)}">Reactivate</button>`}</td>
        </tr>`).join('')}
      </tbody></table>
      <div class="hint" style="margin-top:8px">
        ⭐ ACE is picked automatically every day: the team's best caller on the leaderboard over the
        last week holds the guaranteed share of fresh leads (Admin → Settings → distribution.ace_share_pct).
        Pin a tier only to override the ranking — pins need a reason and can expire.
      </div>
    </div>`);
  body.appendChild(panel);

  panel.querySelector('#new-user')?.addEventListener('click', () => newUserModal(teams, () => users(body, me)));

  panel.addEventListener('click', async (e) => {
    const id = e.target.dataset?.id;
    if (!id) return;

    if (e.target.classList.contains('u-avatar')) {
      avatarModal(list.find((u) => u.id === id), () => users(body, me));
      return;
    }

    if (e.target.classList.contains('u-deact')) {
      if (!confirm('Deactivate this user? Their sessions end immediately.')) return;
      try {
        await post(`/admin/users/${id}/deactivate`);
        toast('Deactivated — live sessions revoked.');
        users(body, me);
      } catch (err) {
        toast(err.message, 'err');
      }
      return;
    }

    // Nothing is ever hard deleted here, so a deactivated account keeps its
    // email. Without a way back, the only option was a second account on a new
    // address - which strands the first one's leads, calls and scores.
    if (e.target.classList.contains('u-react')) {
      try {
        await post(`/admin/users/${id}/reactivate`);
        toast('Reactivated — set a new password before they log in.');
        users(body, me);
      } catch (err) {
        toast(err.message, 'err');
      }
      return;
    }

    if (e.target.classList.contains('u-pwd')) passwordModal(id, () => users(body, me));
    if (e.target.classList.contains('u-tier')) tierModal(list.find((u) => u.id === id), () => users(body, me));
  });
}

/**
 * The tier override. The daily ranking owns ACE by default; this is the human
 * hand on the dial - pin somebody up or down with a reason (audited), or hand
 * the seat back to the ranking.
 */
function tierModal(user, onDone) {
  if (!user) return;
  const bodyEl = h(`
    <div>
      <p class="hint mt0">Now: <b>${esc(user.tier ?? 'standard')}</b>${user.tier_pinned
        ? ` — pinned${user.tier_pin_reason ? `: “${esc(user.tier_pin_reason)}”` : ''}`
        : ' — set by the daily ranking'}</p>
      <label class="f">What should decide their tier?
        <select name="mode">
          <option value="auto">The daily ranking (recommended)</option>
          <option value="ace">Pin ⭐ ACE — guaranteed share of fresh leads</option>
          <option value="standard">Pin STANDARD</option>
          <option value="restricted">Pin RESTRICTED — no fresh leads</option>
        </select>
      </label>
      <div id="pin-fields" style="display:none">
        <label class="f">Reason <span class="hint">required — this is audited under your name</span>
          <input name="reason" maxlength="300" placeholder="e.g. best converter this month">
        </label>
        <label class="f">Pin until <span class="hint">optional — after this it returns to the ranking</span>
          <input name="expires" type="date">
        </label>
      </div>
    </div>`);
  const footer = h('<div><button class="btn primary" data-testid="tier-save">Save tier</button></div>');
  const { close } = openModal(`Tier for ${user.full_name}`, bodyEl, footer);

  const modeSel = bodyEl.querySelector('[name=mode]');
  const pinFields = bodyEl.querySelector('#pin-fields');
  modeSel.addEventListener('change', () => {
    pinFields.style.display = modeSel.value === 'auto' ? 'none' : '';
  });

  footer.querySelector('button').addEventListener('click', async () => {
    const mode = modeSel.value;
    try {
      if (mode === 'auto') {
        await put(`/admin/users/${user.id}/tier`, { mode: 'auto' });
        toast('Back with the daily ranking.');
      } else {
        const reason = bodyEl.querySelector('[name=reason]').value.trim();
        if (reason.length < 3) { toast('A pin needs a reason — it is audited.', 'err'); return; }
        const expires = bodyEl.querySelector('[name=expires]').value;
        await put(`/admin/users/${user.id}/tier`, {
          mode: 'pin', tier: mode, reason,
          expiresAt: expires ? new Date(`${expires}T23:59:59`).toISOString() : null,
        });
        toast(`Pinned ${mode.toUpperCase()}.`);
      }
      close();
      onDone();
    } catch (err) {
      toast(err.message, 'err');
    }
  });
}

/**
 * Upload a leaderboard icon.
 *
 * The browser does the downsizing: whatever lands here - a 12MB phone photo
 * included - leaves as a 128px square PNG data URL a few KB long. Sending the
 * original and resizing on the server would mean running an image pipeline for
 * what is, in the end, a 26px circle next to a name.
 */
function avatarModal(user, onDone) {
  if (!user) return;
  const bodyEl = h(`
    <div>
      <div class="row" style="align-items:center;gap:14px">
        <span id="avatar-preview">${avatarHtml(user.full_name, user.avatar_url, 64)}</span>
        <div>
          <label class="f" style="margin:0">Choose an image
            <input name="file" type="file" accept="image/png,image/jpeg,image/webp">
          </label>
          <div class="hint">Square images look best. It is resized to 128px before upload.</div>
        </div>
      </div>
    </div>`);
  const footer = h(`
    <div>
      ${user.avatar_url ? '<button class="btn danger" id="avatar-clear">Remove icon</button>' : ''}
      <button class="btn primary" id="avatar-save" disabled>Save icon</button>
    </div>`);
  const { close } = openModal(`Icon for ${user.full_name}`, bodyEl, footer);

  let dataUrl = null;
  bodyEl.querySelector('[name=file]').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const img = await createImageBitmap(file);
      const size = 128;
      const canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext('2d');
      // Cover-crop to a square from the centre, so nobody arrives stretched.
      const side = Math.min(img.width, img.height);
      ctx.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, size, size);
      dataUrl = canvas.toDataURL('image/png');
      bodyEl.querySelector('#avatar-preview').innerHTML = avatarHtml(user.full_name, dataUrl, 64);
      footer.querySelector('#avatar-save').disabled = false;
    } catch {
      toast('Could not read that image — try a PNG or JPG.', 'err');
    }
  });

  footer.querySelector('#avatar-save').addEventListener('click', async () => {
    if (!dataUrl) return;
    try {
      await put(`/admin/users/${user.id}/avatar`, { dataUrl });
      toast('Icon saved — it shows on the leaderboard immediately.');
      close();
      onDone();
    } catch (err) {
      toast(err.message, 'err');
    }
  });

  footer.querySelector('#avatar-clear')?.addEventListener('click', async () => {
    try {
      await put(`/admin/users/${user.id}/avatar`, { dataUrl: null });
      toast('Icon removed.');
      close();
      onDone();
    } catch (err) {
      toast(err.message, 'err');
    }
  });
}

/** Set a temporary password. They are forced to change it at next login. */
function passwordModal(userId, onDone) {
  const bodyEl = h(`
    <div>
      <label class="f">Temporary password
        <span class="hint">at least 10 characters — they must change it at first login</span>
        <input name="temp" minlength="10" required>
      </label>
    </div>`);
  const footer = h('<div><button class="btn primary">Set password</button></div>');
  const { close } = openModal('Reset password', bodyEl, footer);

  footer.querySelector('button').addEventListener('click', async () => {
    const temp = bodyEl.querySelector('[name=temp]').value;
    if (temp.length < 10) {
      toast('The temporary password needs at least 10 characters.', 'err');
      return;
    }
    try {
      await post(`/admin/users/${userId}/reset-password`, { temporaryPassword: temp });
      toast('Password set — they must change it at next login.');
      close();
      onDone();
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
            <option value="mentor">mentor</option>
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

async function ingest(body, me) {
  const [sources, runs, teams] = await Promise.all([
    get('/admin/sources'),
    get('/ingest/runs'),
    get('/admin/teams'),
  ]);
  body.innerHTML = '';
  const teamName = (id) => teams.find((t) => t.id === id)?.name ?? null;

  if (sources.length === 0) {
    body.appendChild(h(`
      <div class="banner" style="background:var(--warn-bg);color:var(--warn);border-color:#eed9b8">
        No lead sources yet — create one below before importing anything.
      </div>`));
  }

  // Two active sources on the same sheet and tab are not a second feed - they
  // are the same feed read twice. The lead itself is deduped on phone, so the
  // second read lands in the re-enquiry branch: priority jumps to 'immediate'
  // and reenquiry_count climbs, for leads nobody enquired about twice. When
  // every lead is immediate, none of them are, and the callers lose the queue.
  const feedKey = (s) =>
    s.spreadsheet_id
      ? JSON.stringify([s.spreadsheet_id, (s.worksheet_name ?? '').trim().toLowerCase()])
      : null;
  const activeFeeds = new Map();
  sources.filter((s) => s.is_active && feedKey(s)).forEach((s) => {
    activeFeeds.set(feedKey(s), (activeFeeds.get(feedKey(s)) ?? 0) + 1);
  });
  const isDoubleRead = (s) => s.is_active && feedKey(s) && activeFeeds.get(feedKey(s)) > 1;
  const doubleReadCount = sources.filter(isDoubleRead).length;

  const srcPanel = h(`
    <div class="panel">
      <div class="row spread">
        <h2 class="mt0">Lead sources <small>${sources.length}</small></h2>
        <button class="btn primary" id="new-source">New source</button>
      </div>
      ${doubleReadCount === 0 ? '' : `
      <div class="banner" style="background:var(--warn-bg);color:var(--warn);border-color:#eed9b8">
        <b>${doubleReadCount} active sources read the same sheet and tab.</b>
        Every lead they share would be counted as a repeat enquiry and forced to
        <b>immediate</b> priority, which empties the immediate queue of meaning.
        Keep one and deactivate the rest — nothing is deleted, and past runs stay.
      </div>`}
      ${sources.length === 0 ? '' : `
      <table class="table"><thead><tr>
        <th>Name</th><th>Sheet</th><th>Goes to</th><th>Priority</th><th>Last synced</th><th>Active</th><th></th>
      </tr></thead><tbody>
      ${sources.map((s) => `
        <tr${isDoubleRead(s) ? ' style="background:var(--warn-bg)"' : ''}>
          <td><b>${esc(s.name)}</b></td>
          <td>${s.spreadsheet_id ? `${esc(s.spreadsheet_id.slice(0, 18))}… / ${esc(s.worksheet_name ?? '')}` : '<span class="hint">manual CSV only</span>'}</td>
          <td>${s.pinned_team_id
            ? esc(teamName(s.pinned_team_id) ?? 'unknown team')
            : '<span class="hint">both teams, alternating</span>'}</td>
          <td>${esc(s.default_priority)}</td>
          <td>${esc(fmtDT(s.last_synced_at))}</td>
          <td>${s.is_active ? '<span class="badge b-ok">yes</span>' : '<span class="badge b-mute">no</span>'}</td>
          <td class="num">
            <button class="btn small" data-edit="${esc(s.id)}">Edit</button>
            <button class="btn small" data-toggle="${esc(s.id)}">${s.is_active ? 'Deactivate' : 'Reactivate'}</button>
          </td>
        </tr>`).join('')}
      </tbody></table>`}
    </div>`);
  body.appendChild(srcPanel);
  const redraw = () => ingest(body, me);
  srcPanel.querySelector('#new-source').addEventListener('click', () => sourceModal(null, teams, redraw));

  srcPanel.querySelectorAll('[data-edit]').forEach((btn) => {
    btn.addEventListener('click', () =>
      sourceModal(sources.find((s) => s.id === btn.dataset.edit), teams, redraw));
  });

  srcPanel.querySelectorAll('[data-toggle]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const source = sources.find((s) => s.id === btn.dataset.toggle);
      btn.disabled = true;
      try {
        await put(`/admin/sources/${source.id}`, { isActive: !source.is_active });
        toast(source.is_active ? 'Source deactivated.' : 'Source reactivated.');
        await redraw();
      } catch (err) {
        btn.disabled = false;
        toast(err.message, 'err');
      }
    });
  });

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

  // Redraw the whole tab after every attempt, success or failure. "Recent
  // runs" is rendered once when the tab opens, so without this it keeps
  // showing the PREVIOUS attempt - which reads as though nothing happened,
  // or worse, as though an old error is the new one.
  const runImport = async (button, url, payload) => {
    const label = button.textContent;
    button.disabled = true;
    button.textContent = 'Working…';
    try {
      const summary = await post(url, payload);
      const rowErrors = summary.errors?.length ?? 0;
      toast(
        rowErrors
          ? `Imported, but ${rowErrors} row${rowErrors === 1 ? '' : 's'} failed — see Recent runs.`
          : `Done: ${summary.created} created, ${summary.duplicate} duplicate, ${summary.quarantined} quarantined.`,
        rowErrors ? 'err' : 'ok',
      );
    } catch (err) {
      toast(err.message, 'err');
    } finally {
      button.disabled = false;
      button.textContent = label;
      await ingest(body, me);
    }
  };

  panel.querySelector('#run-sheet').addEventListener('click', (e) =>
    runImport(e.target, `/ingest/sources/${panel.querySelector('[name=source]').value}/run`));

  panel.querySelector('#run-csv').addEventListener('click', (e) => {
    const csv = panel.querySelector('[name=csv]').value;
    if (!csv.trim()) { toast('Paste some CSV first.', 'err'); return; }
    runImport(e.target, `/ingest/sources/${panel.querySelector('[name=source]').value}/csv`, { csv });
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
          <td>${r.error_text ? `<span class="badge b-bad" style="white-space:normal;text-align:left;display:inline-block;max-width:46ch">${esc(r.error_text)}</span>` : '—'}</td>
        </tr>`).join('')}
      </tbody></table>`}
    </div>`));
}

/**
 * Create a source, or edit one that exists.
 *
 * Create-only was the wrong shape: a mistyped worksheet tab could not be
 * corrected, so the only way forward was to make another source. That is how a
 * single Meta sheet ends up wired in five times.
 */
function sourceModal(source, teams, onDone) {
  const editing = Boolean(source);
  const mapText = source?.column_map && Object.keys(source.column_map).length
    ? JSON.stringify(source.column_map, null, 2)
    : '';

  const bodyEl = h(`
    <div>
      <label class="f">Name <input name="name" required placeholder="Meta Lead Ads — Main Sheet" value="${esc(source?.name ?? '')}"></label>
      <div class="frow">
        <label class="f">Google Sheet
          <span class="hint">paste the whole sheet URL, or just its ID — blank means CSV-only</span>
          <input name="sheet" placeholder="https://docs.google.com/spreadsheets/d/…" value="${esc(source?.spreadsheet_id ?? '')}"></label>
        <label class="f">Worksheet tab
          <span class="hint">the tab name exactly as it appears at the bottom of the sheet</span>
          <input name="tab" placeholder="Form Responses 1" value="${esc(source?.worksheet_name ?? '')}"></label>
      </div>
      <div class="frow">
        <label class="f">Send these leads to
          <span class="hint">pin this sheet to one team, or let it alternate between both</span>
          <select name="team">
            <option value="">— both teams, alternating —</option>
            ${teams.map((t) => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join('')}
          </select>
        </label>
        <label class="f">Default priority
          <select name="priority">
            <option value="normal">normal</option>
            <option value="immediate">immediate (5-minute first-touch SLA)</option>
          </select>
        </label>
      </div>
      <label class="f">Column map <span class="hint">(optional JSON: field → sheet header; common headers are auto-detected)</span>
        <textarea name="map" rows="3" placeholder='{"full_name":"Full Name","phone":"Phone Number"}'>${esc(mapText)}</textarea>
      </label>
    </div>`);
  bodyEl.querySelector('[name=priority]').value = source?.default_priority ?? 'normal';
  bodyEl.querySelector('[name=team]').value = source?.pinned_team_id ?? '';

  const footer = h(`<div><button class="btn primary">${editing ? 'Save changes' : 'Create source'}</button></div>`);
  const { close } = openModal(editing ? `Edit ${source.name}` : 'New lead source', bodyEl, footer);

  footer.querySelector('button').addEventListener('click', async () => {
    const mapRaw = bodyEl.querySelector('[name=map]').value.trim();
    let columnMap;
    if (mapRaw) {
      try { columnMap = JSON.parse(mapRaw); } catch { toast('The column map is not valid JSON.', 'err'); return; }
    }
    const sheet = bodyEl.querySelector('[name=sheet]').value.trim();
    const tab = bodyEl.querySelector('[name=tab]').value.trim();
    if (sheet && !tab) { toast('A sheet source also needs the worksheet tab name.', 'err'); return; }
    const payload = {
      name: bodyEl.querySelector('[name=name]').value.trim(),
      spreadsheetId: sheet || undefined,
      worksheetName: tab || undefined,
      defaultPriority: bodyEl.querySelector('[name=priority]').value,
      // null, not undefined: the update coalesces undefined to "leave alone",
      // so unpinning a source has to be said explicitly.
      pinnedTeamId: bodyEl.querySelector('[name=team]').value || null,
      columnMap,
    };
    try {
      if (editing) await put(`/admin/sources/${source.id}`, payload);
      else await post('/admin/sources', payload);
      toast(editing ? 'Source updated.' : 'Source created.');
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
