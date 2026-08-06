import { get } from '../api.js';
import { esc, fmtDT, fmtINR, h, minsLabel } from '../util.js';
import { barChart, donutChart, lineChart } from '../charts.js';

/** Requirement 2: caller and counsellor performance, plus the breakeven thermometer. */
export async function render(outlet) {
  const [thermo, funnel, counsellors, money] = await Promise.all([
    get('/dashboards/thermometer'),
    get('/dashboards/funnel?days=30'),
    get('/dashboards/counsellors'),
    get('/dashboards/collections-series?days=30'),
  ]);
  const dayLabel = (d) =>
    new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' });

  outlet.innerHTML = '';

  // --- thermometer ---
  const pace = Math.max(0, Math.min(130, Number(thermo.pct_of_pace) || 0));
  const statusLabel = {
    green: 'On pace', amber: 'Slipping', red: 'Behind — act now',
    founder_intervention: 'Founder intervention',
  }[thermo.status] ?? thermo.status;
  const statusClass = { green: 'b-ok', amber: 'b-warn' }[thermo.status] ?? 'b-bad';

  outlet.appendChild(h(`
    <div class="panel thermo t-${esc(thermo.status)}" data-testid="thermometer">
      <div class="row spread">
        <h2 class="mt0">Collection vs breakeven <small>this month</small></h2>
        <span class="badge ${statusClass}">${esc(statusLabel)}</span>
      </div>
      <div class="grid cols-4">
        <div class="stat"><div class="k">Collected MTD</div><div class="v">${fmtINR(thermo.collected_mtd)}</div>
          <div class="s">should be ${fmtINR(thermo.expected_by_today)} by today</div></div>
        <div class="stat"><div class="k">Monthly breakeven</div><div class="v">${fmtINR(thermo.monthly_breakeven)}</div>
          <div class="s">gap ${fmtINR(thermo.gap_to_breakeven)}</div></div>
        <div class="stat"><div class="k">Required booking</div><div class="v">${fmtINR(thermo.required_booking)}</div>
          <div class="s">grossed up for collection slippage</div></div>
        <div class="stat"><div class="k">Daily collection floor</div><div class="v" data-testid="daily-floor">${fmtINR(thermo.daily_collection_floor)}</div>
          <div class="s">any day below this loses money</div></div>
      </div>
      <div class="bar"><div class="fill" style="width:${Math.min(100, pace)}%"></div></div>
      <div class="hint">${pace.toFixed(0)}% of where collections should be by today · booked MTD ${fmtINR(thermo.booked_mtd)}</div>
    </div>`));

  // --- money in, and the funnel it came from ---
  const chartRow = h('<div class="chart-grid" style="margin-bottom:18px"></div>');

  const moneyPanel = h(`<div class="panel"><h2 class="mt0">Collections
    <small>daily against the running month total — both in rupees, one scale</small></h2></div>`);
  moneyPanel.appendChild(lineChart(money, {
    x: 'day',
    formatX: dayLabel,
    format: (v) => fmtINR(v),
    series: [
      { key: 'collected', label: 'Collected that day' },
      { key: 'cumulative', label: 'Running total' },
    ],
  }));
  chartRow.appendChild(moneyPanel);

  // The funnel is ordered stages, so it is bars, not a pie: a pie would imply
  // the stages are parts of a whole when each one contains the next.
  const funnelPanel = h(`<div class="panel"><h2 class="mt0">Funnel <small>last 30 days</small></h2></div>`);
  funnelPanel.appendChild(barChart([
    { label: 'Leads', value: Number(funnel.leads) },
    { label: 'Contacted', value: Number(funnel.contacted) },
    { label: 'Connected', value: Number(funnel.connected) },
    { label: 'Qualified', value: Number(funnel.qualified) },
    { label: 'Won', value: Number(funnel.won) },
  ]));
  funnelPanel.appendChild(h(`<div class="hint" style="margin-top:10px">
    ${funnel.conversion_pct ?? 0}% conversion · average ${funnel.avg_attempts ?? 0} attempts per lead</div>`));
  chartRow.appendChild(funnelPanel);
  outlet.appendChild(chartRow);

  // --- callers, with a date picker ---
  const callersPanel = h(`
    <div class="panel">
      <div class="row spread">
        <h2 class="mt0">Callers</h2>
        <input type="date" id="caller-date" style="border:1px solid var(--line);border-radius:8px;padding:7px 10px">
      </div>
      <div id="caller-table"></div>
    </div>`);
  outlet.appendChild(callersPanel);

  const dateInput = callersPanel.querySelector('#caller-date');
  const drawCallers = async () => {
    const qs = dateInput.value ? `?date=${dateInput.value}` : '';
    const callers = await get(`/dashboards/callers${qs}`);
    const target = callersPanel.querySelector('#caller-table');
    if (callers.length === 0) { target.innerHTML = '<div class="empty">No caller activity for that day.</div>'; return; }
    target.innerHTML = '';
    target.appendChild(h(`
      <table class="table" data-testid="callers-table"><thead><tr>
        <th>Caller</th><th class="num">Score</th><th class="num">Dials</th><th class="num">Connects</th>
        <th class="num">Talk</th><th class="num">Unverified</th><th class="num">Leads in SLA</th>
        <th class="num">CB kept / missed</th><th class="num">Hours</th>
      </tr></thead><tbody>
      ${callers.map((c) => `
        <tr>
          <td>${esc(c.full_name)}</td>
          <td class="num">${c.score !== null && c.score !== undefined ? Number(c.score).toFixed(0) : '—'}</td>
          <td class="num">${Number(c.dials)} / ${Number(c.dial_target)}</td>
          <td class="num">${Number(c.connects)} <span class="hint">(${c.connect_rate ? (Number(c.connect_rate) * 100).toFixed(0) + '%' : '—'})</span></td>
          <td class="num">${Number(c.talk_minutes)}m</td>
          <td class="num">${Number(c.unverified_dials) > 0 ? `<span class="badge b-warn">${Number(c.unverified_dials)}</span>` : '0'}</td>
          <td class="num">${Number(c.touched_in_sla)} / ${Number(c.leads_assigned)}</td>
          <td class="num">${Number(c.callbacks_kept)} / ${Number(c.callbacks_missed)}</td>
          <td class="num">${c.logged_minutes !== null && c.logged_minutes !== undefined ? esc(minsLabel(c.logged_minutes)) : '—'}${c.is_late ? ' <span class="badge b-warn">late</span>' : ''}</td>
        </tr>`).join('')}
      </tbody></table>`));
  };
  dateInput.addEventListener('change', drawCallers);
  await drawCallers();

  // --- counsellors MTD ---
  outlet.appendChild(h(`
    <div class="panel">
      <h2>Counsellors <small>month to date</small></h2>
      ${counsellors.length === 0 ? '<div class="empty">No counsellors configured.</div>' : `
      <table class="table" data-testid="counsellors-table"><thead><tr>
        <th>Counsellor</th><th class="num">Leads</th><th class="num">Won</th><th class="num">Conversion</th>
        <th class="num">Booked</th><th class="num">Collected</th><th class="num">vs target</th><th class="num">Overdue</th>
      </tr></thead><tbody>
      ${counsellors.map((c) => {
        const pct = c.collection_target ? Math.round((Number(c.collected_amount) / Number(c.collection_target)) * 100) : 0;
        return `<tr>
          <td>${esc(c.full_name)}</td>
          <td class="num">${Number(c.leads_received)}</td>
          <td class="num">${Number(c.deals_won)}</td>
          <td class="num">${c.conversion_rate ? (Number(c.conversion_rate) * 100).toFixed(0) + '%' : '—'}</td>
          <td class="num">${fmtINR(c.booked_amount)}</td>
          <td class="num">${fmtINR(c.collected_amount)}</td>
          <td class="num" style="width:140px">
            <div class="bar-mini"><div style="width:${Math.min(100, pct)}%"></div></div>
            <span class="hint">${pct}% of ${fmtINR(c.collection_target)}</span></td>
          <td class="num">${Number(c.overdue_amount) > 0 ? `<span class="badge b-bad">${fmtINR(c.overdue_amount)}</span>` : '—'}</td>
        </tr>`;
      }).join('')}
      </tbody></table>`}
    </div>`));
}
