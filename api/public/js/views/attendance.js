import { get } from '../api.js';
import { esc, fmtDate, fmtDT, h, minsLabel } from '../util.js';

/** Requirement 6: the 9-hour login, visible per person per day. */
export async function render(outlet, me) {
  const mine = await get('/me/attendance?days=30');
  outlet.innerHTML = '';

  if (['counsellor', 'admin', 'ops', 'viewer'].includes(me.role)) {
    const team = await get('/attendance/today');
    outlet.appendChild(h(`
      <div class="panel">
        <h2>Floor today <small>expected 9h (09:30–18:30 IST)</small></h2>
        ${team.length === 0 ? '<div class="empty">Nobody has logged in yet today.</div>' : `
        <table class="table" data-testid="attendance-today"><thead><tr>
          <th>Person</th><th>First login</th><th class="num">Logged</th><th class="num">Shortfall</th><th>Status</th>
        </tr></thead><tbody>
        ${team.map((r) => `
          <tr>
            <td>${esc(r.full_name)} <span class="hint">${esc(r.role)}</span></td>
            <td>${esc(fmtDT(r.first_login_at))}${r.is_late ? ' <span class="badge b-warn">late</span>' : ''}</td>
            <td class="num">${esc(minsLabel(r.logged_minutes))}</td>
            <td class="num">${Number(r.shortfall_minutes) > 0 ? esc(minsLabel(r.shortfall_minutes)) : '—'}</td>
            <td>${r.currently_logged_in
              ? '<span class="badge b-ok">on floor</span>'
              : r.met_hours ? '<span class="badge b-ok">met 9h</span>' : '<span class="badge b-mute">off floor</span>'}</td>
          </tr>`).join('')}
        </tbody></table>`}
      </div>`));
  }

  outlet.appendChild(h(`
    <div class="panel">
      <h2>My last 30 days</h2>
      ${mine.length === 0 ? '<div class="empty">No attendance recorded yet — use “Start shift” in the top bar.</div>' : `
      <table class="table"><thead><tr>
        <th>Date</th><th>First login</th><th class="num">Sessions</th><th class="num">Logged</th><th>9h met</th>
      </tr></thead><tbody>
      ${mine.map((r) => `
        <tr>
          <td>${esc(fmtDate(r.business_date))}</td>
          <td>${esc(fmtDT(r.first_login_at))}${r.is_late ? ' <span class="badge b-warn">late</span>' : ''}</td>
          <td class="num">${Number(r.session_count)}</td>
          <td class="num">${esc(minsLabel(r.logged_minutes))} / ${esc(minsLabel(r.expected_minutes))}</td>
          <td>${r.met_hours ? '<span class="badge b-ok">yes</span>'
              : r.currently_logged_in ? '<span class="badge b-info">in progress</span>'
              : `<span class="badge b-bad">short ${esc(minsLabel(r.shortfall_minutes))}</span>`}</td>
        </tr>`).join('')}
      </tbody></table>`}
    </div>`));
}
