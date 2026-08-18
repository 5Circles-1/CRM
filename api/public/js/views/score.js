import { get } from '../api.js';
import { esc, fmtDate, h, starsHtml } from '../util.js';

/**
 * Requirement 7. Own trend first, rank second - the score exists for
 * self-reflection, so the breakdown matters more than the number.
 */
const LABELS = {
  dial_volume: 'Dials', connect_rate: 'Connect rate', talk_time: 'Talk time',
  callback_discipline: 'Callbacks kept', first_touch_sla: 'Speed to lead',
  qualification: 'Qualified handoffs', data_integrity: 'Log accuracy',
  conversion: 'Conversion', collected_revenue: 'Collected revenue',
  collection_health: 'Collection health', pipeline_hygiene: 'Pipeline hygiene',
  team_leakage: 'Team leakage',
};

export async function render(outlet) {
  const { latest, history } = await get('/me/score?days=30');
  outlet.innerHTML = '';

  if (!latest) {
    outlet.appendChild(h(`<div class="panel"><div class="empty">
      No score yet — snapshots run every 15 minutes once you have activity today.</div></div>`));
    return;
  }

  const delta = latest.change_vs_last_week;
  const deltaText =
    delta === null || delta === undefined ? ''
    : Number(delta) >= 0 ? `<span class="badge b-ok">▲ ${Number(delta).toFixed(0)} vs last week</span>`
    : `<span class="badge b-bad">▼ ${Math.abs(Number(delta)).toFixed(0)} vs last week</span>`;

  outlet.appendChild(h(`
    <div class="grid cols-3">
      <div class="stat"><div class="k">Today</div>
        <div class="v" style="font-size:34px" data-testid="score-total">${Number(latest.total).toFixed(0)}</div>
        <div class="s">${starsHtml(latest.total, 'Your rating today — one star per 20 points')} ${deltaText}</div></div>
      <div class="stat"><div class="k">Your 7-day average</div>
        <div class="v">${latest.own_7day_avg ?? '—'}</div>
        <div class="s">out of 100</div></div>
      <div class="stat"><div class="k">Team average today</div>
        <div class="v">${latest.team_avg_that_day ?? '—'}</div>
        <div class="s">you are #${latest.rank_in_team} in the team</div></div>
    </div>`));

  const comps = Object.entries(latest.components ?? {});
  outlet.appendChild(h(`
    <div class="panel">
      <h2>Where the points came from <small>components that had nothing to measure are excluded, not gifted</small></h2>
      <table class="table"><thead><tr>
        <th>Component</th><th class="num">Done</th><th class="num">Target</th><th class="num">Points</th><th></th>
      </tr></thead><tbody>
      ${comps.map(([key, c]) => {
        const applicable = c.applicable !== false;
        const pct = applicable && Number(c.weight) > 0 ? Math.round((Number(c.points) / Number(c.weight)) * 100) : 0;
        return `<tr>
          <td>${esc(LABELS[key] ?? key)}</td>
          <td class="num">${esc(String(c.raw ?? '—'))}</td>
          <td class="num">${esc(String(c.target ?? '—'))}</td>
          <td class="num">${applicable ? `${Number(c.points).toFixed(1)} / ${Number(c.weight).toFixed(0)}` : '—'}</td>
          <td style="width:180px">${applicable
            ? `<div class="bar-mini"><div style="width:${pct}%"></div></div>`
            : '<span class="badge b-mute">did not apply today</span>'}</td>
        </tr>`;
      }).join('')}
      </tbody></table>
    </div>`));

  outlet.appendChild(h(`
    <div class="panel">
      <h2>Last 30 days</h2>
      ${history.length === 0 ? '<div class="empty">No history yet.</div>' : `
      <table class="table"><tbody>
        ${history.map((d) => `
          <tr>
            <td style="width:120px">${esc(fmtDate(d.score_date))}</td>
            <td><div class="bar-mini"><div style="width:${Math.min(100, Number(d.total))}%"></div></div></td>
            <td class="num" style="width:60px">${Number(d.total).toFixed(0)}</td>
          </tr>`).join('')}
      </tbody></table>`}
    </div>`));
}
