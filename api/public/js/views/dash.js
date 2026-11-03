import { get } from '../api.js';
import { barChart, lineChart, statTile } from '../charts.js';
import { esc, h, istToday } from '../util.js';

/**
 * The dashboard: what needs attention now, what happened in the chosen range,
 * the funnel for leads received in that range, and who did what.
 */

const RANGES = [
  ['today', 'Today'],
  ['7d', 'Last 7 days'],
  ['30d', 'Last 30 days'],
  ['custom', 'Dates…'],
];

let state = { range: '7d', from: '', to: '' };

const shiftDate = (ymd, days) => {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

export async function render(outlet) {
  outlet.innerHTML = '';
  const root = h(`
    <div>
      <div class="panel filterbar">
        <div class="frow">
          <span class="chips" data-ranges>
            ${RANGES.map(([k, label]) => `<button class="chip${state.range === k ? ' on' : ''}" data-range="${k}">${label}</button>`).join('')}
          </span>
          <span data-custom ${state.range === 'custom' ? '' : 'hidden'}>
            <input type="date" name="from" value="${esc(state.from)}">
            <span class="hint">to</span>
            <input type="date" name="to" value="${esc(state.to)}">
          </span>
        </div>
      </div>
      <div data-body><div class="spin"></div></div>
    </div>`);
  outlet.appendChild(root);

  root.querySelectorAll('[data-range]').forEach((chip) =>
    chip.addEventListener('click', () => {
      state.range = chip.dataset.range;
      root.querySelectorAll('[data-range]').forEach((c) => c.classList.toggle('on', c === chip));
      root.querySelector('[data-custom]').hidden = state.range !== 'custom';
      if (state.range !== 'custom') draw(root);
    }),
  );
  root.querySelector('[name=from]').addEventListener('change', (e) => { state.from = e.target.value; draw(root); });
  root.querySelector('[name=to]').addEventListener('change', (e) => { state.to = e.target.value; draw(root); });

  await draw(root);
}

async function draw(root) {
  const today = istToday();
  let from = '';
  let to = '';
  if (state.range === 'today') { from = today; to = today; }
  else if (state.range === '7d') { from = shiftDate(today, -6); to = today; }
  else if (state.range === '30d') { from = shiftDate(today, -29); to = today; }
  else { from = state.from; to = state.to; }

  const params = new URLSearchParams();
  if (from) params.set('from', from);
  if (to) params.set('to', to);

  const body = root.querySelector('[data-body]');
  let d;
  try {
    d = await get(`/dashboard?${params}`);
  } catch (err) {
    body.innerHTML = `<div class="panel empty">${esc(err.message)}</div>`;
    return;
  }

  body.innerHTML = '';

  // ---- needs attention now (range-independent) ----
  const now = h(`
    <div class="panel">
      <div class="section-h" style="margin-top:0">Right now</div>
      <div class="grid stat-grid" data-tiles></div>
    </div>`);
  const tiles = now.querySelector('[data-tiles]');
  tiles.appendChild(linkTile(statTile('Overdue follow-ups', d.now.overdue_now, 'promised and late', d.now.overdue_now > 0 ? 'red' : 'green'), '#/leads', { due: 'overdue', stage: 'open' }));
  tiles.appendChild(linkTile(statTile('Due today', d.now.due_today, 'on the reminder list'), '#/reminders'));
  tiles.appendChild(linkTile(statTile('Never called', d.now.untouched_now, 'new, waiting for call one', d.now.untouched_now > 0 ? 'amber' : 'green'), '#/leads', { stage: 'new' }));
  tiles.appendChild(linkTile(statTile('Unassigned', d.now.unassigned_now, 'belonging to nobody', d.now.unassigned_now > 0 ? 'red' : 'green'), '#/leads', { assigned: 'none', stage: 'open' }));
  tiles.appendChild(linkTile(statTile('Open pipeline', d.now.open_now, 'live leads in play'), '#/leads', { stage: 'open' }));
  body.appendChild(now);

  // ---- the range ----
  const t = d.totals;
  const rangePanel = h(`
    <div class="panel">
      <div class="section-h" style="margin-top:0">${esc(fmtRange(d.from, d.to))}</div>
      <div class="grid stat-grid">
        ${tile('Leads in', t.leads_in)}
        ${tile('Calls made', t.calls)}
        ${tile('Qualified', t.qualified)}
        ${tile('Invites sent', t.invites_sent)}
        ${tile('Confirmed', t.confirmed)}
        ${tile('Converted', t.converted, t.leads_in > 0 ? `${pct(t.converted, t.leads_in)} of leads in` : '')}
      </div>
    </div>`);
  body.appendChild(rangePanel);

  // ---- day by day ----
  if (d.byDay.length > 1) {
    const chartPanel = h('<div class="panel"><div class="section-h" style="margin-top:0">Day by day</div></div>');
    chartPanel.appendChild(
      lineChart(
        d.byDay.map((r) => ({ ...r, day: String(r.day).slice(5, 10) })),
        {
          x: 'day',
          series: [
            { key: 'leads_in', label: 'Leads in' },
            { key: 'calls', label: 'Calls' },
            { key: 'qualified', label: 'Qualified' },
            { key: 'converted', label: 'Converted' },
          ],
          height: 220,
        },
      ),
    );
    body.appendChild(chartPanel);
  }

  // ---- funnel for the cohort received in range ----
  const f = d.funnel;
  const funnelPanel = h(`
    <div class="panel">
      <div class="section-h" style="margin-top:0">Funnel — the ${Number(f.received)} lead${f.received === 1 ? '' : 's'} received in this range</div>
    </div>`);
  funnelPanel.appendChild(
    barChart(
      [
        { label: 'Received', value: f.received },
        { label: 'Contacted', value: f.contacted, sub: pct(f.contacted, f.received) },
        { label: 'Qualified', value: f.qualified, sub: pct(f.qualified, f.received) },
        { label: 'Invite sent', value: f.invite_sent, sub: pct(f.invite_sent, f.received) },
        { label: 'Confirmed', value: f.confirmed, sub: pct(f.confirmed, f.received) },
        { label: 'Converted', value: f.converted, sub: pct(f.converted, f.received) },
      ],
      {},
    ),
  );
  body.appendChild(funnelPanel);

  // ---- per person ----
  const people = h(`
    <div class="panel">
      <div class="section-h" style="margin-top:0">Who did what</div>
      <table class="table">
        <thead><tr>
          <th>Person</th><th>Calls</th><th>Qualified</th><th>Call-backs</th>
          <th>Not answered</th><th>Not qualified</th><th>Conversions</th>
          <th>Open now</th><th>Overdue now</th>
        </tr></thead>
        <tbody>
          ${d.byPerson
            .map(
              (p) => `
            <tr>
              <td><b>${esc(p.full_name)}</b> <span class="hint">${esc(p.role === 'followup' ? 'follow-up' : p.role)}</span></td>
              <td>${p.calls}</td><td>${p.qualified_calls}</td><td>${p.call_backs}</td>
              <td>${p.not_answered}</td><td>${p.not_qualified_calls}</td><td>${p.conversions}</td>
              <td>${p.open_now}</td>
              <td class="${Number(p.overdue_now) > 0 ? 't-red' : 't-green'}">${p.overdue_now}</td>
            </tr>`,
            )
            .join('')}
        </tbody>
      </table>
      <div class="hint">Calls and conversions are for the chosen dates; "open" and "overdue" are right now.</div>
    </div>`);
  body.appendChild(people);

  // ---- sources ----
  const sources = h(`
    <div class="panel">
      <div class="section-h" style="margin-top:0">Where leads came from</div>
      <table class="table">
        <thead><tr><th>Source</th><th>Leads</th><th>Contacted</th><th>Qualified</th><th>Converted</th></tr></thead>
        <tbody>
          ${d.bySource
            .map(
              (s) => `
            <tr>
              <td><b>${esc(s.source)}</b></td>
              <td>${s.leads}</td><td>${s.contacted}</td><td>${s.qualified}</td>
              <td>${s.converted}${s.leads > 0 ? ` <span class="hint">${pct(s.converted, s.leads)}</span>` : ''}</td>
            </tr>`,
            )
            .join('')}
        </tbody>
      </table>
    </div>`);
  body.appendChild(sources);
}

function tile(label, value, sub = '') {
  return `<div class="stat"><div class="k">${esc(label)}</div><div class="v">${esc(String(value))}</div>${
    sub ? `<div class="s">${esc(sub)}</div>` : ''
  }</div>`;
}

/** Wrap a stat tile so clicking it opens the pre-filtered list behind it. */
function linkTile(tileEl, hash, filters = null) {
  tileEl.style.cursor = 'pointer';
  tileEl.addEventListener('click', () => {
    if (filters) {
      try {
        sessionStorage.setItem(
          'crm-lead-filters',
          JSON.stringify({ q: '', range: 'all', from: '', to: '', assigned: '', stage: '', source: '', due: '', ...filters }),
        );
      } catch { /* fine */ }
    }
    location.hash = hash;
  });
  return tileEl;
}

const pct = (a, b) => (Number(b) > 0 ? `${Math.round((Number(a) / Number(b)) * 100)}%` : '—');

function fmtRange(from, to) {
  const f = String(from).slice(0, 10);
  const t = String(to).slice(0, 10);
  return f === t ? f : `${f} → ${t}`;
}
