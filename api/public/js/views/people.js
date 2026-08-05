import { get } from '../api.js';
import { esc, fmtINR, fmtTalk, h } from '../util.js';

/**
 * Per-person performance: what each caller and counsellor actually did.
 *
 * One table, sortable, and identical for everyone - a caller sees themselves,
 * a counsellor sees their team, an admin sees the floor, and none of that is
 * decided here. RLS on crm.v_person_performance draws the line, so this view
 * cannot accidentally show one person another's numbers.
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

const SORTABLE = new Set(['dials', 'connects', 'interested', 'walked_in', 'deals', 'revenue', 'talk_seconds']);

/** A rate of null means there was nothing to divide by - say so, do not print 0%. */
const pct = (v) => (v === null || v === undefined ? '<span class="hint">—</span>' : `${Number(v)}%`);

export async function render(outlet, me) {
  let days = 7;
  let sort = 'connects';

  const draw = async () => {
    const rows = await get(`/performance?days=${days}&sort=${sort}`);
    outlet.innerHTML = '';

    outlet.appendChild(h(`
      <div class="panel">
        <div class="row spread">
          <h2 class="mt0">Performance <small>${
            me.role === 'admin' || me.role === 'ops' ? 'everyone on the floor'
              : me.role === 'counsellor' ? 'your team' : 'you'}</small></h2>
          <div class="row">
            ${[1, 7, 30].map((d) => `
              <button class="btn small ${d === days ? 'active' : ''}" data-days="${d}">${
                d === 1 ? 'Today' : `${d} days`}</button>`).join('')}
          </div>
        </div>
        ${rows.length === 0 ? '<div class="empty">No calls or deals in this window yet.</div>' : `
        <table class="table"><thead><tr>
          <th>Person</th><th>Role</th>
          ${COLUMNS.map((c) => `<th class="num ${SORTABLE.has(c.key) ? 'sortable' : ''}"
                ${SORTABLE.has(c.key) ? `data-sort="${c.key}"` : ''}
                ${sort === c.key ? 'aria-sort="descending"' : ''}>${esc(c.label)}${
                  sort === c.key ? ' ▾' : ''}</th>`).join('')}
          <th class="num sortable" data-sort="talk_seconds">Talk time${sort === 'talk_seconds' ? ' ▾' : ''}</th>
          <th class="num">Connect %</th><th class="num">Interest %</th><th class="num">Conversion %</th>
          <th class="num sortable" data-sort="revenue">Revenue${sort === 'revenue' ? ' ▾' : ''}</th>
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
        </tbody></table>
        <div class="hint" style="margin-top:8px">
          A dash in a percentage column means there was nothing to divide by — nobody is
          ranked on a percentage of zero calls. “Visits promised” is what the client said;
          “walked in” is what actually happened.
        </div>`}
      </div>`));

    outlet.querySelectorAll('[data-days]').forEach((b) =>
      b.addEventListener('click', () => { days = Number(b.dataset.days); draw(); }));
    outlet.querySelectorAll('[data-sort]').forEach((th) =>
      th.addEventListener('click', () => { sort = th.dataset.sort; draw(); }));
  };

  await draw();
}
