import { get } from '../api.js';
import { esc, fmtINR, h } from '../util.js';
import { barChart, donutChart, statTile } from '../charts.js';

/**
 * The Overview tab: the whole book between two dates, on one screen.
 *
 * This answers the owner's four questions in one glance - how many leads the
 * CRM holds, who is carrying how many, what the phones said back in bulk
 * (not answered / call later / will visit / ...), and what it turned into.
 * The window is any custom date range; the presets are just shortcuts. RLS
 * scopes every number, so a counsellor reads their team and admin the floor.
 */

const STATUS_LABEL = {
  new: 'Fresh — not yet dialled',
  working: 'Being worked',
  callback: 'Callback booked',
  qualified: 'With counsellor',
  negotiation: 'In negotiation',
  won: 'Won',
  lost: 'Lost',
  invalid: 'Invalid number',
  nurture: 'Nurture (parked)',
  handed_off: 'Handed off',
};

/** IST calendar date as YYYY-MM-DD - business dates, never the browser's UTC day. */
const istToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());

const shiftDays = (ymd, days) => {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

function presets() {
  const today = istToday();
  const monthStart = `${today.slice(0, 7)}-01`;
  const prevMonthEnd = shiftDays(monthStart, -1);
  const prevMonthStart = `${prevMonthEnd.slice(0, 7)}-01`;
  return [
    { label: 'Today', from: today, to: today },
    { label: 'Last 7 days', from: shiftDays(today, -6), to: today },
    { label: 'This month', from: monthStart, to: today },
    { label: 'Last month', from: prevMonthStart, to: prevMonthEnd },
    { label: 'Last 30 days', from: shiftDays(today, -29), to: today },
    { label: 'All time', from: '2000-01-01', to: today },
  ];
}

// The chosen window survives leaving and returning to the tab - a manager
// mid-comparison should not lose their range to a navigation.
let state = { from: null, to: null };

let dispoLabels = null;
async function loadDispoLabels() {
  if (dispoLabels) return dispoLabels;
  try {
    const list = await get('/meta/dispositions');
    dispoLabels = new Map(list.map((d) => [d.value, d.label]));
  } catch {
    dispoLabels = new Map();
  }
  return dispoLabels;
}

const dispoLabel = (v) => dispoLabels?.get(v) ?? String(v ?? '').replace(/_/g, ' ');

export async function render(outlet, me) {
  if (!state.from || !state.to) {
    const thisMonth = presets()[2];
    state = { from: thisMonth.from, to: thisMonth.to };
  }
  await loadDispoLabels();

  outlet.innerHTML = '';
  const controls = h(`
    <div class="panel" data-testid="overview-range">
      <div class="row spread wrap">
        <h2 class="mt0">Everything between two dates <small>totals, per person, and the bulk response</small></h2>
        <div class="row wrap" style="gap:8px;align-items:center">
          <input type="date" id="ov-from" value="${esc(state.from)}"
            style="border:1px solid var(--line);border-radius:8px;padding:7px 10px">
          <span class="hint">to</span>
          <input type="date" id="ov-to" value="${esc(state.to)}"
            style="border:1px solid var(--line);border-radius:8px;padding:7px 10px">
        </div>
      </div>
      <div class="row wrap" id="ov-presets" style="gap:6px;margin-top:10px">
        ${presets().map((p) => `<button class="chip${p.from === state.from && p.to === state.to ? ' on' : ''}"
          data-from="${p.from}" data-to="${p.to}">${esc(p.label)}</button>`).join('')}
      </div>
    </div>`);
  outlet.appendChild(controls);

  const body = h('<div id="ov-body"></div>');
  outlet.appendChild(body);

  const fromEl = controls.querySelector('#ov-from');
  const toEl = controls.querySelector('#ov-to');

  const apply = async () => {
    if (!fromEl.value || !toEl.value) return;
    if (fromEl.value > toEl.value) {
      body.innerHTML = '<div class="panel"><div class="empty">The "from" date is after the "to" date — swap them round.</div></div>';
      return;
    }
    state = { from: fromEl.value, to: toEl.value };
    controls.querySelectorAll('#ov-presets .chip').forEach((c) =>
      c.classList.toggle('on', c.dataset.from === state.from && c.dataset.to === state.to));
    body.innerHTML = '<div class="spin"></div>';
    try {
      const data = await get(`/dashboards/overview?from=${state.from}&to=${state.to}`);
      drawBody(body, data, me);
    } catch (err) {
      body.innerHTML = '';
      body.appendChild(h(`<div class="panel"><div class="empty">${esc(err.message)}</div></div>`));
    }
  };

  fromEl.addEventListener('change', apply);
  toEl.addEventListener('change', apply);
  controls.querySelector('#ov-presets').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    fromEl.value = chip.dataset.from;
    toEl.value = chip.dataset.to;
    apply();
  });

  await apply();
}

function drawBody(body, data, me) {
  const { totals: t, dispositions, statuses, members } = data;
  const n = (v) => Number(v ?? 0);
  const byDispo = new Map(dispositions.map((d) => [d.disposition, n(d.count)]));
  const sumDispo = (...keys) => keys.reduce((a, k) => a + (byDispo.get(k) ?? 0), 0);

  const rangeLabel = data.from === data.to ? data.from : `${data.from} → ${data.to}`;

  body.innerHTML = '';

  // --- the headline numbers ---
  const tiles = h(`<div class="panel"><h2 class="mt0">Totals <small>${esc(rangeLabel)}</small></h2>
    <div class="grid cols-4" data-testid="overview-tiles"></div></div>`);
  const grid = tiles.querySelector('.grid');
  grid.appendChild(statTile('Leads in the CRM', n(t.leads_all_time), `${n(t.open_now)} open right now · all time`));
  grid.appendChild(statTile('Leads received', n(t.leads_in_range), 'new in this window'));
  grid.appendChild(statTile('Dials', n(t.dials), `${n(t.connects)} connects · ${n(t.talk_minutes)}m talk`));
  grid.appendChild(statTile('Not answered', sumDispo('not_answered'), `+ ${sumDispo('busy', 'switched_off', 'incoming_unavailable')} busy / off / unavailable`));
  grid.appendChild(statTile('Call later', sumDispo('callback_requested', 'will_call_back_self'), `${n(t.callbacks_set)} callbacks booked`));
  grid.appendChild(statTile('Office visits', n(t.walkins), `walked in · ${sumDispo('will_visit')} promised on calls`));
  grid.appendChild(statTile('Won / lost', `${n(t.won)} / ${n(t.lost)}`, 'leads closed in this window'));
  grid.appendChild(statTile('Collected', fmtINR(t.collected_amount), `${fmtINR(t.booked_amount)} booked · ${n(t.deals_booked)} deals`));
  body.appendChild(tiles);

  // --- the bulk response, and where the window's leads stand now ---
  const chartRow = h('<div class="chart-grid" style="margin-bottom:18px"></div>');

  const bulk = h(`<div class="panel"><h2 class="mt0">Bulk response
    <small>every call outcome in the window</small></h2></div>`);
  const slices = dispositions.map((d) => ({ label: dispoLabel(d.disposition), value: n(d.count) }));
  const top = slices.slice(0, 5);
  const rest = slices.slice(5).reduce((a, s) => a + s.value, 0);
  if (rest > 0) top.push({ label: 'Everything else', value: rest });
  bulk.appendChild(donutChart(top, { centreValue: n(t.dials), centreLabel: 'dials' }));
  if (dispositions.length) {
    bulk.appendChild(h(`
      <table class="table" data-testid="overview-dispositions" style="margin-top:12px"><thead><tr>
        <th>Outcome</th><th class="num">Calls</th><th class="num">Share</th><th class="num">Real connects</th>
      </tr></thead><tbody>
      ${dispositions.map((d) => `
        <tr>
          <td>${esc(dispoLabel(d.disposition))}</td>
          <td class="num">${n(d.count)}</td>
          <td class="num">${n(t.dials) ? Math.round((n(d.count) / n(t.dials)) * 100) : 0}%</td>
          <td class="num">${n(d.connects) || '—'}</td>
        </tr>`).join('')}
      </tbody></table>`));
  }
  chartRow.appendChild(bulk);

  const statusPanel = h(`<div class="panel"><h2 class="mt0">Where those leads stand
    <small>leads received in the window, by status today</small></h2></div>`);
  statusPanel.appendChild(barChart(statuses.map((s) => ({
    label: STATUS_LABEL[s.status] ?? s.status, value: n(s.count),
  }))));
  chartRow.appendChild(statusPanel);
  body.appendChild(chartRow);

  // --- one row per person ---
  const people = h(`<div class="panel"><h2 class="mt0">Every team member
    <small>leads carried and what their calls said back · ${esc(rangeLabel)}</small></h2></div>`);
  if (members.length === 0) {
    people.appendChild(h('<div class="empty">Nobody to show.</div>'));
  } else {
    people.appendChild(h(`
      <div style="overflow-x:auto">
      <table class="table" data-testid="overview-members"><thead><tr>
        <th>Person</th><th>Team</th><th class="num">Leads</th><th class="num">Open now</th>
        <th class="num">Dials</th><th class="num">Connects</th><th class="num">No answer</th>
        <th class="num">Call later</th><th class="num">Will visit</th><th class="num">Walk-ins</th>
        <th class="num">Won</th><th class="num">Collected</th>
      </tr></thead><tbody>
      ${members.map((m) => `
        <tr${m.user_id === me.id ? ' style="font-weight:600"' : ''}>
          <td>${esc(m.full_name)} <span class="hint">${esc(m.role)}${m.is_active ? '' : ' · inactive'}</span></td>
          <td>${esc(m.team_name ?? '—')}</td>
          <td class="num">${n(m.leads_assigned)}</td>
          <td class="num">${n(m.open_now)}</td>
          <td class="num">${n(m.dials)}</td>
          <td class="num">${n(m.connects)}</td>
          <td class="num">${n(m.not_answered) + n(m.busy_unreachable)}</td>
          <td class="num">${n(m.call_later)}</td>
          <td class="num">${n(m.visit_promised)}</td>
          <td class="num">${n(m.walkins)}</td>
          <td class="num">${n(m.won)}</td>
          <td class="num">${n(m.collected_amount) > 0 ? fmtINR(m.collected_amount) : '—'}</td>
        </tr>`).join('')}
      </tbody></table></div>
      <div class="hint" style="margin-top:8px">
        "Leads" counts the window's leads against everyone who carried them — a qualified lead
        appears with its caller and its counsellor, the same way deal credit is shared.
        "No answer" includes busy, switched off and incoming-unavailable.
      </div>`));
  }
  body.appendChild(people);
}
