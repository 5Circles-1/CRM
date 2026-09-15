import { get, put } from '../api.js';
import { esc, fmtINR, h, openModal, toast } from '../util.js';
import { statTile } from '../charts.js';

/**
 * Individual targets: revenue for a counsellor, walk-ins for a caller.
 *
 * Two different numbers on purpose. A counsellor is judged on money that
 * arrived — the same figure the breakeven thermometer and the daily brief
 * already mean by "collected", not a second booked-revenue number beside it.
 * A caller is judged on how many people they put in the office, because the
 * deal is not theirs to close; crm.walkin_visits credits the walk-in to
 * whoever sent them in, which is what makes it a fair individual target
 * rather than a shared one.
 *
 * Nobody has to be given a target for this page to be honest. A person with
 * no row set carries their role's default — an equal share of the office
 * breakeven for a counsellor, the floor's walk-in standard for a caller — and
 * setting one is an adjustment, not a prerequisite.
 */

const istMonth = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date()).slice(0, 7);

const shiftMonth = (ym, n) => {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return d.toISOString().slice(0, 7);
};

/** A percentage with nothing to divide by is a dash, never 0%. */
const pct = (v) => (v === null || v === undefined ? '—' : `${Number(v)}%`);

const bar = (value, tone) => `
  <div class="bar-mini"><div style="width:${Math.min(100, Math.max(0, Number(value) || 0))}%${
    tone ? `;background:var(--${tone})` : ''}"></div></div>`;

let month = null;

export async function render(outlet, me) {
  if (!month) month = istMonth();
  const canSet = me.role === 'counsellor' || me.role === 'admin';

  const draw = async () => {
    outlet.innerHTML = '<div class="spin"></div>';
    const data = await get(`/targets?month=${month}`);
    outlet.innerHTML = '';

    const people = data.people ?? [];
    const callers = people.filter((p) => p.role === 'caller');
    const counsellors = people.filter((p) => p.role === 'counsellor');
    const mine = people.find((p) => p.user_id === me.id);
    const isCurrent = month === istMonth();

    // --- month picker ---
    const head = h(`
      <div class="panel">
        <div class="row spread wrap">
          <h2 class="mt0">Targets <small>${esc(data.month_label ?? month)}</small></h2>
          <div class="row" style="gap:6px">
            <button class="chip" data-month="${shiftMonth(month, -1)}">← ${esc(shiftMonth(month, -1))}</button>
            <button class="chip on">${esc(month)}</button>
            <button class="chip" data-month="${shiftMonth(month, 1)}">${esc(shiftMonth(month, 1))} →</button>
          </div>
        </div>
        <div class="hint">
          A <b>counsellor's target is revenue collected</b> — money that actually arrived, the
          same figure the breakeven thermometer uses. A <b>caller's target is walk-ins</b> —
          people they put in the office, credited to whoever sent them in and never to
          whoever greeted them. Anyone without a target of their own carries their role's
          default (${Number(data.default_walkins ?? 0)} walk-ins; an equal share of the
          ${fmtINR(data.office_breakeven)} office breakeven), so nothing here is ever blank.
          ${canSet ? '' : '<br>Only a counsellor or an admin can change a target.'}
        </div>
      </div>`);
    head.querySelectorAll('[data-month]').forEach((b) =>
      b.addEventListener('click', () => { month = b.dataset.month; draw(); }));
    outlet.appendChild(head);

    // --- my own number, first and biggest: requirement 7 is self-reflection ---
    if (mine) {
      const isCounsellor = mine.role === 'counsellor';
      const tiles = h('<div class="grid cols-4" style="margin-bottom:16px" data-testid="my-target"></div>');
      if (isCounsellor) {
        tiles.appendChild(statTile('My revenue target', fmtINR(mine.revenue_target),
          mine.is_custom ? 'set for me' : 'my share of the office number'));
        tiles.appendChild(statTile('Collected', fmtINR(mine.revenue_collected),
          `${pct(mine.revenue_pct)} of target`,
          Number(mine.revenue_pct ?? 0) >= 100 ? 'good' : ''));
        tiles.appendChild(statTile('Still to collect',
          fmtINR(Math.max(0, Number(mine.revenue_target ?? 0) - Number(mine.revenue_collected ?? 0))),
          Number(mine.working_days_left) > 0
            ? `${fmtINR(mine.revenue_per_day_needed)} a day for ${Number(mine.working_days_left)} working days`
            : 'the month is closed'));
        tiles.appendChild(statTile('Booked this month', fmtINR(mine.revenue_booked),
          'what was signed — collection follows'));
      } else {
        tiles.appendChild(statTile('My walk-in target', Number(mine.walkin_target ?? 0),
          mine.is_custom ? 'set for me' : 'the floor standard'));
        tiles.appendChild(statTile('Walk-ins so far', Number(mine.walkins ?? 0),
          `${pct(mine.walkin_pct)} of target`,
          Number(mine.walkin_pct ?? 0) >= 100 ? 'good' : ''));
        tiles.appendChild(statTile('Still to send in',
          Math.max(0, Number(mine.walkin_target ?? 0) - Number(mine.walkins ?? 0)),
          Number(mine.working_days_left) > 0
            ? `${Number(mine.walkins_per_day_needed ?? 0)} a day for ${Number(mine.working_days_left)} working days`
            : 'the month is closed'));
        tiles.appendChild(statTile('Of mine, converted', Number(mine.walkins_converted ?? 0),
          'closed by a counsellor after I sent them in'));
      }
      outlet.appendChild(tiles);
    }

    // --- the two boards ---
    outlet.appendChild(board({
      title: '🤝 Counsellors — revenue',
      sub: 'money collected this month against the target each carries',
      testid: 'targets-counsellors',
      rows: counsellors,
      canSet,
      isCurrent,
      columns: [
        ['Target', (p) => fmtINR(p.revenue_target)],
        ['Collected', (p) => fmtINR(p.revenue_collected)],
        ['Booked', (p) => fmtINR(p.revenue_booked)],
      ],
      progress: (p) => ({ value: p.revenue_pct, label: pct(p.revenue_pct) }),
      pace: (p) => (Number(p.working_days_left) > 0 && p.revenue_per_day_needed !== null
        ? `${fmtINR(p.revenue_per_day_needed)}/day to finish` : '—'),
      onEdit: (p) => targetModal(p, month, draw),
    }));

    outlet.appendChild(board({
      title: '📞 Callers — walk-ins',
      sub: 'people put in the office this month against the target each carries',
      testid: 'targets-callers',
      rows: callers,
      canSet,
      isCurrent,
      columns: [
        ['Target', (p) => Number(p.walkin_target ?? 0)],
        ['Walk-ins', (p) => Number(p.walkins ?? 0)],
        ['Converted', (p) => Number(p.walkins_converted ?? 0)],
      ],
      progress: (p) => ({ value: p.walkin_pct, label: pct(p.walkin_pct) }),
      pace: (p) => (Number(p.working_days_left) > 0 && p.walkins_per_day_needed !== null
        ? `${Number(p.walkins_per_day_needed)}/day to finish` : '—'),
      onEdit: (p) => targetModal(p, month, draw),
    }));
  };

  await draw();
}

function board({ title, sub, testid, rows, canSet, isCurrent, columns, progress, pace, onEdit }) {
  const panel = h(`
    <div class="panel" data-testid="${esc(testid)}">
      <h2 class="mt0">${title} <small>${esc(sub)}</small></h2>
    </div>`);

  if (rows.length === 0) {
    panel.appendChild(h('<div class="empty">Nobody in this role.</div>'));
    return panel;
  }

  panel.appendChild(h(`
    <div style="overflow-x:auto">
    <table class="table"><thead><tr>
      <th>Person</th><th>Team</th>
      ${columns.map(([label]) => `<th class="num">${esc(label)}</th>`).join('')}
      <th class="num" style="width:160px">Progress</th>
      <th class="num">Pace needed</th>
      <th></th>
    </tr></thead><tbody>
    ${rows.map((p) => {
      const pr = progress(p);
      const tone = Number(pr.value ?? 0) >= 100 ? 'ok' : Number(pr.value ?? 0) >= 60 ? '' : 'warn';
      return `
        <tr>
          <td><b>${esc(p.full_name)}</b>
            ${p.is_custom
              ? `<span class="badge b-info" title="Set by ${esc(p.set_by_name ?? 'someone')}">set</span>`
              : '<span class="badge b-mute" title="Carrying the role default">default</span>'}</td>
          <td class="hint">${esc(p.team_name ?? '—')}</td>
          ${columns.map(([, fn]) => `<td class="num">${esc(String(fn(p)))}</td>`).join('')}
          <td class="num">${bar(pr.value, tone)}<span class="hint">${esc(pr.label)}</span></td>
          <td class="num hint">${esc(pace(p))}</td>
          <td class="num">${canSet && isCurrent
            ? `<button class="btn small" data-edit="${esc(p.user_id)}">Set target</button>`
            : ''}</td>
        </tr>`;
    }).join('')}
    </tbody></table></div>
    ${!isCurrent ? '<div class="hint" style="margin-top:8px">A closed month is history — targets can only be set for the month being worked.</div>' : ''}`));

  panel.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-edit]');
    if (!btn) return;
    const person = rows.find((r) => r.user_id === btn.dataset.edit);
    if (person) onEdit(person);
  });

  return panel;
}

function targetModal(person, month, onDone) {
  const isCounsellor = person.role === 'counsellor';
  const body = h(`
    <div>
      <p class="hint mt0">
        ${esc(person.full_name)} · ${esc(person.role)} · ${esc(month)}.
        Leave a field empty to clear it — they fall back to the role default rather than
        to zero, so an empty box never means "no target".
      </p>
      <label class="f">Revenue to collect this month (₹)
        <input type="number" name="revenue" min="0" step="1000" data-testid="target-revenue"
          value="${person.is_custom && isCounsellor ? Number(person.revenue_target ?? '') : ''}"
          placeholder="${isCounsellor ? `default ${Number(person.revenue_target ?? 0)}` : 'callers carry no revenue target'}">
      </label>
      <label class="f">Walk-ins to put in the office this month
        <input type="number" name="walkins" min="0" step="1" data-testid="target-walkins"
          value="${person.is_custom ? Number(person.walkin_target ?? '') : ''}"
          placeholder="default ${Number(person.walkin_target ?? 0)}">
      </label>
      <div class="hint">
        ${isCounsellor
          ? 'Revenue means <b>collected</b>, not booked — the same number the thermometer and the daily brief use, so nobody is chasing two different figures.'
          : 'A caller’s walk-in is credited to them for sending the client in, whoever ends up closing the deal.'}
      </div>
    </div>`);

  const footer = h('<div><button class="btn primary" data-testid="target-save">Save target</button></div>');
  const { close } = openModal(`Target for ${person.full_name}`, body, footer);

  footer.querySelector('button').addEventListener('click', async () => {
    const revenue = body.querySelector('[name=revenue]').value.trim();
    const walkins = body.querySelector('[name=walkins]').value.trim();
    try {
      await put(`/targets/${person.user_id}`, {
        month,
        revenueTarget: revenue === '' ? null : Number(revenue),
        walkinTarget: walkins === '' ? null : Number(walkins),
      });
      toast('Target saved.');
      close();
      onDone();
    } catch (err) {
      toast(err.message, 'err');
    }
  });
}
