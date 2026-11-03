import { api, get, post } from '../api.js';
import { esc, fmtDT, h, openModal, toast } from '../util.js';

/**
 * Admin: the accounts, the sources (Meta / ChatGPT sheets), CSV import, and
 * the quarantine - rows the importer refused, kept with the reason so a
 * mistyped number is never silently lost.
 */
export async function render(outlet, me) {
  const [users, sourcesData] = await Promise.all([get('/admin/users'), get('/admin/sources')]);
  const { sources, quarantined, syncConfigured } = sourcesData;

  outlet.innerHTML = '';
  const root = h(`
    <div>
      <div class="panel">
        <div class="frow" style="justify-content:space-between">
          <div class="section-h" style="margin-top:0">Team</div>
          <button class="btn primary" data-add-user style="flex:0 0 auto">+ Add person</button>
        </div>
        <table class="table">
          <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th></th></tr></thead>
          <tbody>
            ${users
              .map(
                (u) => `
              <tr data-user="${u.id}" class="${u.is_active ? '' : 'row-muted'}">
                <td><b>${esc(u.full_name)}</b></td>
                <td class="mono">${esc(u.email)}</td>
                <td>
                  <select data-role ${u.id === me.id ? 'disabled title="Ask another admin to change your role"' : ''}>
                    ${['caller', 'followup', 'admin']
                      .map((r) => `<option value="${r}" ${u.role === r ? 'selected' : ''}>${r === 'followup' ? 'Follow-up' : r[0].toUpperCase() + r.slice(1)}</option>`)
                      .join('')}
                  </select>
                </td>
                <td>${u.is_active ? '<span class="badge b-ok">Active</span>' : '<span class="badge b-mute">Deactivated</span>'}</td>
                <td class="right">
                  <button class="btn small" data-reset>Reset password</button>
                  ${u.id === me.id
                    ? ''
                    : `<button class="btn small" data-toggle>${u.is_active ? 'Deactivate' : 'Reactivate'}</button>`}
                </td>
              </tr>`,
              )
              .join('')}
          </tbody>
        </table>
        <div class="hint">
          Fresh leads rotate between active <b>callers</b>; qualified leads pass to the
          <b>follow-up</b> person. Deactivating someone stops both at once and signs them out.
        </div>
      </div>

      <div class="panel">
        <div class="section-h" style="margin-top:0">Lead sources</div>
        ${syncConfigured ? '' : `<div class="hint" style="margin-bottom:8px">
          Automatic sheet sync is off on this server (set SERVICE_USER_ID and a Google service
          account). "Sync now" below still works once a sheet is configured and shared with the
          service account.</div>`}
        <table class="table">
          <thead><tr><th>Source</th><th>Google Sheet</th><th>Tab</th><th>Last synced</th><th>Last run</th><th></th></tr></thead>
          <tbody>
            ${sources
              .map(
                (s) => `
              <tr data-source="${s.id}">
                <td><b>${esc(s.name)}</b>${s.is_active ? '' : ' <span class="badge b-mute">off</span>'}</td>
                <td class="mono">${esc(shortId(s.spreadsheet_id))}</td>
                <td>${esc(s.worksheet_name ?? '—')}</td>
                <td>${s.last_synced_at ? esc(fmtDT(s.last_synced_at)) : '—'}</td>
                <td>${lastRun(s)}</td>
                <td class="right">
                  <button class="btn small" data-edit-source>Edit</button>
                  ${s.spreadsheet_id ? '<button class="btn small" data-sync>Sync now</button>' : ''}
                </td>
              </tr>`,
              )
              .join('')}
          </tbody>
        </table>
        <div class="hint">
          Point each source at the Google Sheet its leads land in (Meta's connected sheet, the
          ChatGPT export). The importer reads the whole sheet every few minutes and can never
          create the same lead twice; a repeat phone number becomes a repeat enquiry on the
          existing lead.
        </div>
      </div>

      <div class="panel">
        <div class="section-h" style="margin-top:0">Import leads from CSV</div>
        <div class="frow">
          <select name="import-source" style="flex:0 0 auto">
            ${sources.filter((s) => s.is_active).map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('')}
          </select>
          <button class="btn" data-import style="flex:0 0 auto">Import</button>
        </div>
        <label class="f">
          <span class="hint">First row is headers — name, phone, email, city, campaign (extra columns are kept on the lead)</span>
          <textarea name="csv" rows="5" placeholder="Full Name,Phone Number,Email,City&#10;Asha Rao,98765 43210,asha@x.in,Pune"></textarea>
        </label>
        <div data-import-result></div>
      </div>

      <div class="panel">
        <div class="section-h" style="margin-top:0">Quarantine
          <span class="badge ${quarantined.length ? 'b-warn' : 'b-ok'}">${quarantined.length}</span>
        </div>
        ${quarantined.length === 0
          ? '<div class="empty">Nothing quarantined — every imported row became a lead.</div>'
          : `<div class="hint" style="margin-bottom:8px">Rows the importer refused, kept with the reason.
               Fix the number and add the lead by hand from the Leads screen.</div>
             <table class="table">
               <thead><tr><th>When</th><th>Source</th><th>Row</th><th>Why</th></tr></thead>
               <tbody>
                 ${quarantined
                   .map(
                     (r) => `
                   <tr>
                     <td class="mono">${esc(fmtDT(r.created_at))}</td>
                     <td>${esc(r.source_name)}</td>
                     <td class="mono">${esc(payloadPreview(r.payload))}</td>
                     <td>${esc(r.reject_reason ?? '')}</td>
                   </tr>`,
                   )
                   .join('')}
               </tbody>
             </table>`}
      </div>
    </div>`);
  outlet.appendChild(root);

  const reload = () => render(outlet, me);

  // ---- users ----
  root.querySelector('[data-add-user]').addEventListener('click', () => addUserModal(reload));

  root.querySelectorAll('tr[data-user]').forEach((tr) => {
    const id = tr.dataset.user;
    tr.querySelector('[data-role]')?.addEventListener('change', async (e) => {
      try {
        await api(`/admin/users/${id}`, { method: 'PUT', body: { role: e.target.value } });
        toast('Role changed.');
        reload();
      } catch (err) {
        toast(err.message, 'err');
        reload();
      }
    });
    tr.querySelector('[data-toggle]')?.addEventListener('click', async (e) => {
      const activate = e.target.textContent === 'Reactivate';
      try {
        await api(`/admin/users/${id}`, { method: 'PUT', body: { isActive: activate } });
        toast(activate ? 'Reactivated.' : 'Deactivated — their session is revoked and they receive no new leads.');
        reload();
      } catch (err) {
        toast(err.message, 'err');
      }
    });
    tr.querySelector('[data-reset]')?.addEventListener('click', () => resetPasswordModal(id, tr));
  });

  // ---- sources ----
  root.querySelectorAll('tr[data-source]').forEach((tr) => {
    const id = tr.dataset.source;
    const source = sources.find((s) => s.id === id);
    tr.querySelector('[data-edit-source]')?.addEventListener('click', () => editSourceModal(source, reload));
    tr.querySelector('[data-sync]')?.addEventListener('click', async (e) => {
      e.target.disabled = true;
      e.target.textContent = 'Syncing…';
      try {
        const s = await post(`/admin/sources/${id}/sync`);
        toast(`Synced: ${s.created} new, ${s.duplicate} already known, ${s.quarantined} quarantined.`);
        reload();
      } catch (err) {
        toast(err.message, 'err');
        e.target.disabled = false;
        e.target.textContent = 'Sync now';
      }
    });
  });

  // ---- import ----
  root.querySelector('[data-import]').addEventListener('click', async (e) => {
    const csv = root.querySelector('[name=csv]').value.trim();
    const sourceId = root.querySelector('[name=import-source]').value;
    if (!csv) { toast('Paste the CSV first.', 'err'); return; }
    e.target.disabled = true;
    try {
      const s = await post('/admin/import', { sourceId, csv });
      root.querySelector('[data-import-result]').innerHTML = `
        <div class="hint">Imported: <b>${s.created}</b> new lead${s.created === 1 ? '' : 's'},
        ${s.duplicate} already known, ${s.quarantined} quarantined${
          s.errors.length ? `, ${s.errors.length} failed: ${esc(s.errors[0])}` : ''
        }.</div>`;
      if (s.created > 0) toast(`${s.created} lead${s.created === 1 ? '' : 's'} imported and assigned.`);
    } catch (err) {
      toast(err.message, 'err');
    } finally {
      e.target.disabled = false;
    }
  });
}

function shortId(id) {
  if (!id) return '—';
  return id.length > 18 ? `${id.slice(0, 8)}…${id.slice(-6)}` : id;
}

function lastRun(s) {
  if (!s.last_run_at) return '—';
  if (s.last_run_error) return `<span class="badge b-bad" title="${esc(s.last_run_error)}">failed</span>`;
  return `<span class="badge b-ok">ok</span> <span class="hint">+${s.last_run_created ?? 0}</span>`;
}

function payloadPreview(payload) {
  try {
    const values = typeof payload === 'string' ? JSON.parse(payload) : payload;
    return Object.values(values ?? {}).filter(Boolean).slice(0, 3).join(' · ').slice(0, 60);
  } catch {
    return '';
  }
}

function addUserModal(reload) {
  const bodyEl = h(`
    <div>
      <label class="f">Full name <input name="name"></label>
      <label class="f">Email <input name="email" type="email"></label>
      <label class="f">Role
        <select name="role">
          <option value="caller">Caller — first call on fresh leads</option>
          <option value="followup">Follow-up — works qualified leads</option>
          <option value="admin">Admin — everything</option>
        </select>
      </label>
      <label class="f">Temporary password <span class="hint">(at least 10 characters — they change it at first sign-in)</span>
        <input name="password" type="text" autocomplete="off"></label>
    </div>`);
  const footer = h('<div><button class="btn primary">Create account</button></div>');
  const { close } = openModal('Add a person', bodyEl, footer);

  footer.querySelector('button').addEventListener('click', async () => {
    const v = (n) => bodyEl.querySelector(`[name=${n}]`).value.trim();
    try {
      await post('/admin/users', {
        fullName: v('name'),
        email: v('email'),
        role: bodyEl.querySelector('[name=role]').value,
        password: v('password'),
      });
      close();
      toast('Account created.');
      reload();
    } catch (err) {
      toast(err.message, 'err');
    }
  });
}

function resetPasswordModal(id, tr) {
  const name = tr.querySelector('b').textContent;
  const bodyEl = h(`
    <div>
      <p class="hint">Set a temporary password for <b>${esc(name)}</b>. They must change it at next sign-in.</p>
      <label class="f">Temporary password <input name="password" type="text" autocomplete="off"></label>
    </div>`);
  const footer = h('<div><button class="btn primary">Reset password</button></div>');
  const { close } = openModal('Reset password', bodyEl, footer);

  footer.querySelector('button').addEventListener('click', async () => {
    try {
      await post(`/admin/users/${id}/password`, {
        password: bodyEl.querySelector('[name=password]').value,
      });
      close();
      toast('Password reset.');
    } catch (err) {
      toast(err.message, 'err');
    }
  });
}

function editSourceModal(source, reload) {
  const bodyEl = h(`
    <div>
      <label class="f">Name <input name="name" value="${esc(source.name)}"></label>
      <label class="f">Google Sheet link or id
        <span class="hint">paste the browser URL — share the sheet with the service account's email</span>
        <input name="sheet" value="${esc(source.spreadsheet_id ?? '')}"></label>
      <label class="f">Worksheet tab <input name="tab" value="${esc(source.worksheet_name ?? '')}" placeholder="Leads"></label>
      <label class="f">Active
        <select name="active">
          <option value="true" ${source.is_active ? 'selected' : ''}>Yes</option>
          <option value="false" ${source.is_active ? '' : 'selected'}>No — stop importing from it</option>
        </select>
      </label>
    </div>`);
  const footer = h('<div><button class="btn primary">Save</button></div>');
  const { close } = openModal(`Edit source — ${source.name}`, bodyEl, footer);

  footer.querySelector('button').addEventListener('click', async () => {
    const v = (n) => bodyEl.querySelector(`[name=${n}]`).value.trim();
    try {
      await api(`/admin/sources/${source.id}`, {
        method: 'PUT',
        body: {
          name: v('name'),
          spreadsheetId: v('sheet') || null,
          worksheetName: v('tab') || null,
          isActive: bodyEl.querySelector('[name=active]').value === 'true',
        },
      });
      close();
      toast('Source saved.');
      reload();
    } catch (err) {
      toast(err.message, 'err');
    }
  });
}
