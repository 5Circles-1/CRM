import { get, post } from '../api.js';
import {
  avatarHtml, esc, fmtDT, h, istToday, openModal, outcomeLabel, stageBadge, toast,
} from '../util.js';

/**
 * The spreadsheet. Every lead, one row each, filters along the top -
 * everything visible to everyone, the way a shared Google Sheet is.
 *
 * Filters survive navigating into a lead and back (sessionStorage), so
 * "yesterday's Meta leads with Harsh" stays put while you work through them.
 */

const FILTER_KEY = 'crm-lead-filters';

function loadFilters() {
  try {
    return JSON.parse(sessionStorage.getItem(FILTER_KEY)) ?? {};
  } catch {
    return {};
  }
}

function saveFilters(f) {
  try {
    sessionStorage.setItem(FILTER_KEY, JSON.stringify(f));
  } catch { /* private mode: filters just reset */ }
}

const shiftDate = (ymd, days) => {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

export async function render(outlet, me) {
  const f = {
    q: '', range: 'all', from: '', to: '', assigned: '', stage: '', source: '', due: '',
    ...loadFilters(),
  };

  const { users, sources } = await get('/leads/meta/options');

  outlet.innerHTML = '';
  const root = h(`
    <div>
      <div class="panel filterbar">
        <div class="frow">
          <input type="search" name="q" placeholder="Search name / phone / city…" value="${esc(f.q)}" style="min-width:220px">
          <span class="chips" data-ranges>
            ${[['today', 'Today'], ['yesterday', 'Yesterday'], ['7d', 'Last 7 days'], ['all', 'All time'], ['custom', 'Dates…']]
              .map(([k, label]) => `<button class="chip${f.range === k ? ' on' : ''}" data-range="${k}">${label}</button>`)
              .join('')}
          </span>
          <span data-custom hidden>
            <input type="date" name="from" value="${esc(f.from)}">
            <span class="hint">to</span>
            <input type="date" name="to" value="${esc(f.to)}">
          </span>
        </div>
        <div class="frow">
          <select name="assigned">
            <option value="">Everyone</option>
            <option value="me">Mine</option>
            <option value="none">Unassigned</option>
            ${users.map((u) => `<option value="${u.id}">${esc(u.full_name)}</option>`).join('')}
          </select>
          <select name="stage">
            <option value="">Any status</option>
            <option value="open">Open (needs work)</option>
            <option value="new">New — never called</option>
            <option value="calling">Calling</option>
            <option value="qualified">Qualified</option>
            <option value="converted">Converted</option>
            <option value="not_qualified">Not qualified</option>
          </select>
          <select name="source">
            <option value="">Any source</option>
            ${sources.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('')}
          </select>
          <select name="due">
            <option value="">Any follow-up</option>
            <option value="overdue">Overdue now</option>
            <option value="today">Due today</option>
          </select>
          <button class="btn small" data-clear>Clear</button>
          <span style="flex:1"></span>
          <button class="btn primary" data-add>+ Add lead</button>
        </div>
      </div>
      <div class="panel" data-table><div class="spin"></div></div>
    </div>`);
  outlet.appendChild(root);

  const el = (sel) => root.querySelector(sel);
  el('[name=assigned]').value = f.assigned;
  el('[name=stage]').value = f.stage;
  el('[name=source]').value = f.source;
  el('[name=due]').value = f.due;

  const applyRangeUI = () => {
    root.querySelectorAll('[data-range]').forEach((c) =>
      c.classList.toggle('on', c.dataset.range === f.range),
    );
    el('[data-custom]').hidden = f.range !== 'custom';
  };
  applyRangeUI();

  const rangeDates = () => {
    const today = istToday();
    if (f.range === 'today') return { from: today, to: today };
    if (f.range === 'yesterday') return { from: shiftDate(today, -1), to: shiftDate(today, -1) };
    if (f.range === '7d') return { from: shiftDate(today, -6), to: today };
    if (f.range === 'custom') return { from: f.from, to: f.to };
    return { from: '', to: '' };
  };

  let drawSeq = 0;
  async function draw() {
    saveFilters(f);
    const seq = ++drawSeq;
    const { from, to } = rangeDates();
    const params = new URLSearchParams();
    if (f.q) params.set('q', f.q);
    if (f.stage) params.set('stage', f.stage);
    if (f.assigned) params.set('assigned', f.assigned);
    if (f.source) params.set('source', f.source);
    if (f.due) params.set('due', f.due);
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    params.set('limit', '200');

    let data;
    try {
      data = await get(`/leads?${params}`);
    } catch (err) {
      el('[data-table]').innerHTML = `<div class="empty">${esc(err.message)}</div>`;
      return;
    }
    if (seq !== drawSeq) return; // a newer filter is already loading

    const { total, leads } = data;
    const host = el('[data-table]');
    if (leads.length === 0) {
      host.innerHTML = '<div class="empty">No leads match these filters.</div>';
      return;
    }

    host.innerHTML = `
      <div class="hint" style="margin-bottom:8px">${total} lead${total === 1 ? '' : 's'}${
        total > leads.length ? ` — showing the latest ${leads.length}; narrow the filters for the rest` : ''
      }</div>
      <table class="table lead-table">
        <thead><tr>
          <th>Received</th><th>Name</th><th>Phone</th><th>City</th><th>Source</th>
          <th>Assigned</th><th>Status</th><th>Last response</th><th>Next follow-up</th><th title="Invite sent / Confirmed / Converted">✉ ✓ ★</th>
        </tr></thead>
        <tbody>
          ${leads.map((l) => leadRow(l)).join('')}
        </tbody>
      </table>`;

    host.querySelectorAll('tr[data-id]').forEach((tr) => {
      tr.addEventListener('click', (e) => {
        if (e.target.closest('a')) return; // let tel:/copy links behave
        location.hash = `#/lead/${tr.dataset.id}`;
      });
    });
  }

  // ---- wiring ----
  let qTimer = null;
  el('[name=q]').addEventListener('input', (e) => {
    f.q = e.target.value.trim();
    clearTimeout(qTimer);
    qTimer = setTimeout(draw, 250);
  });
  root.querySelectorAll('[data-range]').forEach((chip) =>
    chip.addEventListener('click', () => {
      f.range = chip.dataset.range;
      applyRangeUI();
      if (f.range !== 'custom') draw();
    }),
  );
  el('[name=from]').addEventListener('change', (e) => { f.from = e.target.value; draw(); });
  el('[name=to]').addEventListener('change', (e) => { f.to = e.target.value; draw(); });
  for (const name of ['assigned', 'stage', 'source', 'due']) {
    el(`[name=${name}]`).addEventListener('change', (e) => { f[name] = e.target.value; draw(); });
  }
  el('[data-clear]').addEventListener('click', () => {
    Object.assign(f, { q: '', range: 'all', from: '', to: '', assigned: '', stage: '', source: '', due: '' });
    el('[name=q]').value = '';
    el('[name=assigned]').value = '';
    el('[name=stage]').value = '';
    el('[name=source]').value = '';
    el('[name=due]').value = '';
    applyRangeUI();
    draw();
  });
  el('[data-add]').addEventListener('click', () => addLeadModal(users, sources, me));

  await draw();
}

function leadRow(l) {
  const overdue = l.due_bucket === 'overdue';
  const checks = [
    l.template_sent_at ? '✉' : '·',
    l.confirmed_at ? '✓' : '·',
    l.converted_at ? '★' : '·',
  ].join(' ');
  return `
    <tr data-id="${l.id}" class="${overdue ? 'row-overdue' : ''}">
      <td class="mono">${esc(fmtDT(l.created_at))}${Number(l.enquiry_count) > 1 ? ` <span class="badge b-warn" title="Enquired ${l.enquiry_count} times">×${l.enquiry_count}</span>` : ''}</td>
      <td><b>${esc(l.full_name ?? '—')}</b></td>
      <td class="mono"><a href="tel:${esc(l.phone_e164)}" title="Call">${esc(l.phone_e164)}</a></td>
      <td>${esc(l.city ?? '')}</td>
      <td>${esc(l.source_name)}</td>
      <td>${l.assigned_name ? `${avatarHtml(l.assigned_name, 22)} ${esc(l.assigned_name)}` : '<span class="badge b-bad">Unassigned</span>'}</td>
      <td>${stageBadge(l.stage)}</td>
      <td>${esc(outcomeLabel(l))}</td>
      <td class="${overdue ? 't-red' : ''}">${l.next_follow_up_at ? esc(fmtDT(l.next_follow_up_at)) : '—'}</td>
      <td class="mono" title="Invite sent / Confirmed / Converted">${checks}</td>
    </tr>`;
}

function addLeadModal(users, sources, me) {
  const manual = sources.find((s) => s.name === 'Manual');
  const bodyEl = h(`
    <div>
      <label class="f">Name <input name="name" autocomplete="off"></label>
      <label class="f">Phone <span class="hint">(required)</span> <input name="phone" autocomplete="off" inputmode="tel"></label>
      <label class="f">Email <input name="email" type="email" autocomplete="off"></label>
      <label class="f">City <input name="city" autocomplete="off"></label>
      <label class="f">Give to
        <select name="assigned">
          <option value="">Automatic (round-robin)</option>
          ${users.map((u) => `<option value="${u.id}" ${u.id === me.id ? 'selected' : ''}>${esc(u.full_name)}</option>`).join('')}
        </select>
      </label>
      <label class="f">Source
        <select name="source">
          ${sources.map((s) => `<option value="${s.id}" ${manual && s.id === manual.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}
        </select>
      </label>
      <label class="f">Note <textarea name="note" rows="2" placeholder="Anything worth knowing before the first call"></textarea></label>
    </div>`);
  const footer = h('<div><button class="btn primary">Add lead</button></div>');
  const { close } = openModal('Add a lead', bodyEl, footer);
  bodyEl.querySelector('[name=phone]').focus();

  footer.querySelector('button').addEventListener('click', async () => {
    const v = (n) => bodyEl.querySelector(`[name=${n}]`).value.trim();
    if (!v('phone')) { toast('A lead needs a phone number.', 'err'); return; }
    try {
      const lead = await post('/leads', {
        fullName: v('name') || undefined,
        phone: v('phone'),
        email: v('email') || undefined,
        city: v('city') || undefined,
        note: v('note') || undefined,
        assignedTo: v('assigned') || undefined,
        sourceId: v('source') || undefined,
      });
      close();
      toast(`Lead added${lead.assigned_name ? ` — with ${lead.assigned_name}` : ''}.`);
      location.hash = `#/lead/${lead.id}`;
    } catch (err) {
      if (err.status === 409 && err.body?.leadId) {
        close();
        toast(err.message, 'err');
        location.hash = `#/lead/${err.body.leadId}`;
        return;
      }
      toast(err.message, 'err');
    }
  });
}
