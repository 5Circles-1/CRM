import { get } from '../api.js';
import { esc, fmtINR, fmtTalk, h } from '../util.js';
import { barChart, donutChart, lineChart, statTile } from '../charts.js';

/**
 * Performance, as charts rather than a wall of numbers.
 *
 * The same screen for everyone: a caller sees themselves, a counsellor sees
 * their team, an admin sees the floor. None of that is decided here - RLS on
 * crm.v_person_performance draws the line, so this view cannot leak one
 * person's numbers to another.
 *
 * Every chart has the table underneath it. That is not belt-and-braces: three
 * of the categorical colours sit below 3:1 against white, so the numbers have
 * to be legible without relying on telling the colours apart.
 */

const COLUMNS = [
  { key: 'dials', label: 'Dials' },
  { key: 'connects', label: 'Connects' },
  { key: 'interested', label: 'Interested' },
  { key: 'not_interested', label: 'Not interested' },
  { key: 'not_answered', label: 'No answer' },
  { key: 'callbacks_booked', label: 'Callbacks' },
  { key: 'visits_promised', label: 'Visits promised' },
  { key: 'walked_in', label: 'Walked in' },
  { key: 'whatsapp_sent', label: 'WhatsApp' },
  { key: 'deals', label: 'Deals' },
];

const RANKABLE = [
  { key: 'connects', label: 'Connects' },
  { key: 'dials', label: 'Dials' },
  { key: 'interested', label: 'Interested' },
  { key: 'walked_in', label: 'Walk-ins' },
  { key: 'deals', label: 'Deals' },
  { key: 'revenue', label: 'Revenue' },
  { key: 'talk_seconds', label: 'Talk time' },
];

/** A rate of null means nothing to divide by — say so, never print 0%. */
const pct = (v) => (v === null || v === undefined ? '—' : `${Number(v)}%`);
const dayLabel = (d) =>
  new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' });

export async function render(outlet, me) {
  let days = 7;
  let sort = 'connects';
  const isLead = me.role === 'admin' || me.role === 'ops' || me.role === 'counsellor';

  const draw = async () => {
    outlet.innerHTML = '<div class="spin"></div>';
    const [rows, daily, mine] = await Promise.all([
      get(`/performance?days=${days}&sort=${sort}`),
      get(`/performance/daily?days=${days}`),
      get(`/outcomes?days=${days}&userId=${me.id}`),
    ]);
    outlet.innerHTML = '';

    const team = rows.reduce((a, r) => {
      for (const k of ['dials', 'connects', 'interested', 'not_interested', 'walked_in', 'deals', 'talk_seconds']) {
        a[k] = (a[k] ?? 0) + Number(r[k] ?? 0);
      }
      a.revenue = (a.revenue ?? 0) + Number(r.revenue ?? 0);
      return a;
    }, {});

    // --- window picker, one row above everything ---
    outlet.appendChild(h(`
      <div class="row spread" style="margin-bottom:14px">
        <div class="chips" style="margin:0">
          ${[1, 7, 30].map((d) => `
            <button class="chip ${d === days ? 'on' : ''}" data-days="${d}">${
              d === 1 ? 'Today' : `Last ${d} days`}</button>`).join('')}
        </div>
        <span class="hint">${isLead
          ? (me.role === 'counsellor' ? 'Your team' : 'Everyone on the floor')
          : 'Your own numbers'}</span>
      </div>`));

    // --- headline numbers: the story is often one number, not a chart ---
    const tiles = h('<div class="grid cols-4" style="margin-bottom:16px"></div>');
    const shown = isLead ? team : mine;
    tiles.appendChild(statTile('Dials', Number(shown.dials ?? 0)));
    tiles.appendChild(statTile('Connects', Number(shown.connects ?? 0),
      shown.dials ? `${Math.round((shown.connects / shown.dials) * 100)}% of dials` : 'no dials yet'));
    tiles.appendChild(statTile('Talk time', fmtTalk(shown.talk_seconds ?? 0), 'total on the phone'));
    tiles.appendChild(statTile('Walk-ins', Number(shown.walked_in ?? 0), 'actually came in',
      Number(shown.walked_in ?? 0) > 0 ? 'good' : ''));
    outlet.appendChild(tiles);

    // --- trend + outcome mix, side by side ---
    const grid = h('<div class="chart-grid"></div>');

    const trend = h(`<div class="panel"><h2 class="mt0">Calls over time
      <small>dials against connects, one scale</small></h2></div>`);
    trend.appendChild(lineChart(daily, {
      x: 'day',
      formatX: dayLabel,
      series: [
        { key: 'dials', label: 'Dials' },
        { key: 'connects', label: 'Connects' },
      ],
    }));
    grid.appendChild(trend);

    const mix = h(`<div class="panel"><h2 class="mt0">What happened on the calls
      <small>${isLead ? 'across everyone you can see' : 'your outcomes'}</small></h2></div>`);
    const src = isLead ? await get(`/outcomes?days=${days}`) : mine;
    mix.appendChild(donutChart([
      { label: 'Interested', value: src.interested },
      { label: 'Callback booked', value: src.callbacks_booked },
      { label: 'Will visit', value: src.visits_promised },
      { label: 'Not interested', value: src.not_interested },
      { label: 'No answer', value: src.not_answered },
      { label: 'Job enquiry', value: src.job_enquiries },
    ], { centreValue: Number(src.dials ?? 0), centreLabel: 'dials' }));
    grid.appendChild(mix);
    outlet.appendChild(grid);

    // --- the leaderboard, only where there is more than one person ---
    if (isLead && rows.length > 1) {
      const metric = RANKABLE.find((m) => m.key === sort) ?? RANKABLE[0];
      const board = h(`
        <div class="panel">
          <div class="row spread">
            <h2 class="mt0">Who is doing what <small>ranked by ${esc(metric.label.toLowerCase())}</small></h2>
            <div class="chips" style="margin:0">
              ${RANKABLE.map((m) => `
                <button class="chip small ${m.key === sort ? 'on' : ''}" data-sort="${esc(m.key)}">${esc(m.label)}</button>`).join('')}
            </div>
          </div>
        </div>`);
      board.appendChild(barChart(
        rows.map((r) => ({
          label: r.full_name,
          sub: r.role === 'counsellor' ? '· counsellor' : '',
          value: Number(r[sort] ?? 0),
        })),
        {
          highlight: me.full_name,
          format: (v) => (sort === 'revenue' ? fmtINR(v) : sort === 'talk_seconds' ? fmtTalk(v) : String(v)),
        },
      ));
      outlet.appendChild(board);
    }

    // --- the numbers, in full ---
    outlet.appendChild(h(`
      <div class="panel">
        <h2 class="mt0">Every number <small>the charts above, exactly</small></h2>
        ${rows.length === 0 ? '<div class="empty">No calls or deals in this window yet.</div>' : `
        <div style="overflow-x:auto">
        <table class="table"><thead><tr>
          <th>Person</th><th>Role</th>
          ${COLUMNS.map((c) => `<th class="num">${esc(c.label)}</th>`).join('')}
          <th class="num">Talk time</th><th class="num">Connect %</th>
          <th class="num">Interest %</th><th class="num">Conversion %</th><th class="num">Revenue</th>
        </tr></thead><tbody>
        ${rows.map((r) => `
          <tr>
            <td><b>${esc(r.full_name)}</b></td>
            <td>${esc(r.role)}</td>
            ${COLUMNS.map((c) => `<td class="num">${Number(r[c.key] ?? 0)}</td>`).join('')}
            <td class="num">${esc(fmtTalk(r.talk_seconds))}</td>
            <td class="num">${pct(r.connect_rate)}</td>
            <td class="num">${pct(r.interest_rate)}</td>
            <td class="num">${pct(r.conversion_rate)}</td>
            <td class="num">${fmtINR(r.revenue)}</td>
          </tr>`).join('')}
        </tbody></table></div>
        <div class="hint" style="margin-top:8px">
          A dash in a percentage column means there was nothing to divide by — nobody is
          ranked on a percentage of zero calls. “Visits promised” is what the client said;
          “walked in” is what actually happened.
        </div>`}
      </div>`));

    outlet.querySelectorAll('[data-days]').forEach((b) =>
      b.addEventListener('click', () => { days = Number(b.dataset.days); draw(); }));
    outlet.querySelectorAll('[data-sort]').forEach((b) =>
      b.addEventListener('click', () => { sort = b.dataset.sort; draw(); }));
  };

  await draw();
}
