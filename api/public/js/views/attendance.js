import { get } from '../api.js';
import { avatarHtml, esc, fmtDate, fmtDT, h, minsLabel } from '../util.js';
import { statTile } from '../charts.js';

/**
 * Requirement 6, grown up: today's floor, everyone's record till date, and
 * the person's own history.
 *
 * The attendance percentage is judged against "floor days" - dates on which
 * anyone at all worked - so a Sunday or an office holiday is never held
 * against anybody, but a day the whole floor worked and one person missed is.
 */
export async function render(outlet, me) {
  const isLead = ['counsellor', 'admin', 'ops', 'viewer'].includes(me.role);
  const [mine, summary, team, floorSummary, avatars] = await Promise.all([
    get('/me/attendance?days=30'),
    get('/me/attendance/summary').catch(() => null),
    isLead ? get('/attendance/today') : Promise.resolve(null),
    isLead ? get('/attendance/summary').catch(() => []) : Promise.resolve(null),
    get('/users/avatars').catch(() => ({})),
  ]);
  outlet.innerHTML = '';

  // --- my record till date: the headline numbers first ---
  if (summary && summary.days_present) {
    const tiles = h('<div class="grid cols-4" style="margin-bottom:18px"></div>');
    tiles.appendChild(statTile('Days on the floor', Number(summary.days_present),
      `of ${Number(summary.floor_days_since_joining)} floor days since ${fmtDate(summary.first_day)}`));
    tiles.appendChild(statTile('Attendance', summary.attendance_pct !== null ? `${Number(summary.attendance_pct)}%` : '—',
      'days present vs days the floor worked',
      Number(summary.attendance_pct) >= 90 ? 'good' : Number(summary.attendance_pct) < 75 ? 'bad' : ''));
    tiles.appendChild(statTile('Time logged till date', minsLabel(summary.total_minutes),
      `average ${minsLabel(summary.avg_minutes_per_day)} per day`));
    tiles.appendChild(statTile('Full 9h days', Number(summary.full_days),
      `${Number(summary.late_days)} late arrival${Number(summary.late_days) === 1 ? '' : 's'}`));
    outlet.appendChild(tiles);
  }

  if (isLead && team) {
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

  // --- everyone's attendance till date, for the people who manage the floor ---
  if (isLead && Array.isArray(floorSummary) && floorSummary.length > 0) {
    outlet.appendChild(h(`
      <div class="panel" data-testid="attendance-overall">
        <h2>Overall attendance — till date
          <small>presence is judged against days the floor actually worked</small></h2>
        <div style="overflow-x:auto">
        <table class="table"><thead><tr>
          <th>Person</th><th>Since</th><th class="num">Days present</th>
          <th class="num">Attendance</th><th class="num">Time logged</th>
          <th class="num">Avg / day</th><th class="num">Full 9h days</th>
          <th class="num">Late days</th>
        </tr></thead><tbody>
        ${floorSummary.map((r) => {
          const pct = r.attendance_pct === null ? null : Number(r.attendance_pct);
          return `
          <tr>
            <td>${avatarHtml(r.full_name, avatars[r.user_id], 22)} ${esc(r.full_name)}
                <span class="hint">${esc(r.role)}</span>
                ${r.currently_logged_in ? '<span class="badge b-ok">on floor</span>' : ''}</td>
            <td>${esc(fmtDate(r.first_day))}</td>
            <td class="num">${Number(r.days_present)} / ${Number(r.floor_days_since_joining)}</td>
            <td class="num">${pct === null ? '—'
              : pct >= 90 ? `<span class="badge b-ok">${pct}%</span>`
              : pct < 75 ? `<span class="badge b-bad">${pct}%</span>`
              : `<span class="badge b-warn">${pct}%</span>`}</td>
            <td class="num">${esc(minsLabel(r.total_minutes))}</td>
            <td class="num">${esc(minsLabel(r.avg_minutes_per_day))}</td>
            <td class="num">${Number(r.full_days)}</td>
            <td class="num">${Number(r.late_days) > 0
              ? `<span class="badge b-warn">${Number(r.late_days)}</span>` : '0'}</td>
          </tr>`;
        }).join('')}
        </tbody></table></div>
        <div class="hint" style="margin-top:8px">
          “Days present” counts against floor days since that person's first recorded day,
          so Sundays and holidays are never held against anyone.
        </div>
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
