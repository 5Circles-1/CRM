import { get, post } from '../api.js';
import { agoLabel, avatarHtml, badge, esc, fmtDT, fmtINR, fmtTalk, h, minsLabel, toast } from '../util.js';

/**
 * The leaderboard parameters, and what wins each one.
 *
 * Winners are computed, never picked: whoever tops each metric holds that
 * trophy, ties share it, and a metric nobody has scored on yet has no winner
 * rather than crowning a row of zeros. Callers and counsellors compete on the
 * same board - the old Excel credited both the Executive and the Counsellor on
 * every visit and every payment, so a board that split them would break the
 * shared credit the floor is used to.
 */
const TROPHIES = [
  { key: 'dials',       label: 'Most calls',        icon: '📞' },
  { key: 'connects',    label: 'Most connects',     icon: '🎯' },
  { key: 'interested',  label: 'Most interested',   icon: '✨' },
  { key: 'walked_in',   label: 'Most walk-ins',     icon: '🚶' },
  { key: 'deals',       label: 'Most conversions',  icon: '🏆' },
  { key: 'revenue',     label: 'Most revenue',      icon: '💰', fmt: (v) => fmtINR(v) },
  { key: 'talk_seconds', label: 'Most talk time',   icon: '⏱️', fmt: (v) => fmtTalk(v) },
];

/**
 * The counsellor's home: who is on the floor, what is leaking, what needs
 * transferring (requirement 8), and their own negotiations.
 */
export async function render(outlet, me) {
  const [floor, immediate, leakage, candidates, targets, qualified, negotiation, today,
         overallToday, avatars, leadFlow, followups] = await Promise.all([
    get('/dashboards/floor'),
    get('/queues/immediate'),
    get('/dashboards/leakage'),
    get('/transfers/candidates').catch(() => []),
    get('/transfers/targets').catch(() => []),
    get('/leads?status=qualified&limit=100'),
    get('/leads?status=negotiation&limit=100'),
    get('/performance?days=1').catch(() => []),
    get('/performance/overall?days=1').catch(() => []),
    get('/users/avatars').catch(() => ({})),
    get('/dashboards/lead-flow').catch(() => null),
    get('/dashboards/followups').catch(() => []),
  ]);

  outlet.innerHTML = '';

  // --- the leaderboard: overall standings first, then who is winning what ---
  let boardDays = 1;
  const board = h('<div class="panel"></div>');
  outlet.appendChild(board);

  const drawBoard = async () => {
    const [rows, overall] = boardDays === 1
      ? [today, overallToday]
      : await Promise.all([
          get(`/performance?days=${boardDays}`),
          get(`/performance/overall?days=${boardDays}`).catch(() => []),
        ]);
    board.innerHTML = '';
    board.appendChild(h(`
      <div class="row spread">
        <h2 class="mt0">Leaderboard <small>updates live as calls are logged</small></h2>
        <div class="chips" style="margin:0">
          ${[[1, 'Today'], [7, 'This week'], [30, 'This month']].map(([d, l]) => `
            <button class="chip ${d === boardDays ? 'on' : ''}" data-board-days="${d}">${l}</button>`).join('')}
        </div>
      </div>`));

    // Overall standings: every metric, one weighted number. The podium is the
    // motivation; the list under it is the fairness - everyone can see where
    // the points came from, and the weights are Admin settings, not magic.
    if (overall.length > 0) {
      const podium = overall.slice(0, 3);
      const medals = ['🥇', '🥈', '🥉'];
      board.appendChild(h(`
        <div class="podium" data-testid="overall-podium">
          ${podium.map((p, i) => `
            <div class="podium-slot p${i + 1}">
              <div class="podium-medal">${medals[i]}</div>
              ${avatarHtml(p.full_name, avatars[p.user_id], i === 0 ? 64 : 48)}
              <div class="podium-name">${esc(p.full_name)}</div>
              <div class="podium-points">${Number(p.overall_points).toFixed(0)} pts</div>
            </div>`).join('')}
        </div>`));
      if (overall.length > 3) {
        const maxPts = Number(overall[0].overall_points) || 1;
        board.appendChild(h(`
          <div class="standings">
            ${overall.slice(3).map((p) => `
              <div class="standing-row">
                <span class="standing-rank">#${Number(p.rank)}</span>
                ${avatarHtml(p.full_name, avatars[p.user_id], 26)}
                <span class="standing-name">${esc(p.full_name)}</span>
                <span class="standing-track"><span style="width:${Math.max(2, (Number(p.overall_points) / maxPts) * 100)}%"></span></span>
                <span class="standing-points">${Number(p.overall_points).toFixed(0)}</span>
              </div>`).join('')}
          </div>`));
      }
      board.appendChild(h(`<div class="hint" style="margin:2px 0 10px">
        Overall points weigh conversions and revenue first, then connects, dials, interest,
        walk-ins and talk time — the weights are settings under Admin → Settings (leaderboard.*).</div>`));
    }

    const cards = h('<div class="trophy-grid"></div>');
    for (const t of TROPHIES) {
      const top = Math.max(0, ...rows.map((r) => Number(r[t.key] ?? 0)));
      // A row of zeros has no winner. Crowning one would reward whoever
      // happens to sort first, which is worse than an empty card.
      const winners = top > 0 ? rows.filter((r) => Number(r[t.key] ?? 0) === top) : [];
      cards.appendChild(h(`
        <div class="trophy${winners.length ? '' : ' idle'}">
          <div class="trophy-head">${t.icon} ${esc(t.label)}</div>
          ${winners.length === 0
            ? '<div class="trophy-none">no scores yet</div>'
            : `<div class="trophy-name">
                 ${winners.map((w) => avatarHtml(w.full_name, avatars[w.user_id], 22)).join('')}
                 ${winners.map((w) => esc(w.full_name)).join(' & ')}</div>
               <div class="trophy-value">${esc((t.fmt ?? String)(top))}</div>`}
        </div>`));
    }
    board.appendChild(cards);
    board.querySelectorAll('[data-board-days]').forEach((b) =>
      b.addEventListener('click', () => { boardDays = Number(b.dataset.boardDays); drawBoard(); }));
  };
  await drawBoard();

  // --- leakage summary chips ---
  //
  // These are buttons, not labels. They looked clickable and were not, so
  // pressing "Missed callback" did nothing and the detail list below carried
  // on showing every leak type mixed together.
  const leakTotal = leakage.summary.reduce((a, s) => a + Number(s.count), 0);
  let leakFilter = null;

  const chips = h(`
    <div class="chips" data-testid="leak-chips">
      <button class="chip ${leakTotal > 0 ? 'hot' : ''} ${leakFilter === null ? 'on' : ''}"
              data-leak="">Pipeline leaks <b>${leakTotal}</b></button>
      ${leakage.summary.map((s) => `
        <button class="chip" data-leak="${esc(s.leak_type)}">
          ${esc(labelLeak(s.leak_type))} <b>${Number(s.count)}</b></button>`).join('')}
      ${leakTotal === 0 ? '<span class="chip" style="color:var(--ok)">Pipeline clean ✓</span>' : ''}
    </div>`);
  outlet.appendChild(chips);

  // --- follow-up radar: whose promises are slipping, before they are lost ---
  //
  // The leakage list shows the leads; this shows the people. Sorted worst
  // first, so the counsellor's next conversation is always the top row.
  const radarRows = Array.isArray(followups) ? followups : [];
  const anyDue = radarRows.some((r) =>
    Number(r.overdue_now) > 0 || Number(r.callbacks_due) > 0 || Number(r.due_next_hour) > 0);
  outlet.appendChild(h(`
    <div class="panel" data-testid="followup-radar">
      <h2>Follow-up radar <small>nobody's promise slips quietly — updates live</small></h2>
      ${radarRows.length === 0 ? '<div class="empty">Nobody has follow-ups on the books yet.</div>' : `
      <table class="table"><thead><tr>
        <th>Person</th><th class="num">Overdue now</th><th class="num">Callbacks due</th>
        <th class="num">Due next hour</th><th class="num">Later today</th>
        <th class="num">Missed (7d)</th><th>Next callback</th>
      </tr></thead><tbody>
      ${radarRows.map((r) => `
        <tr${Number(r.overdue_now) > 0 || Number(r.callbacks_due) > 0 ? ' class="radar-hot"' : ''}>
          <td>${avatarHtml(r.full_name, avatars[r.user_id], 22)} ${esc(r.full_name)}
              ${r.on_shift ? '' : ' <span class="badge b-mute">off floor</span>'}</td>
          <td class="num">${Number(r.overdue_now) > 0
            ? `<span class="badge b-bad">${Number(r.overdue_now)} · ${esc(agoLabel(r.oldest_overdue_minutes))} late</span>` : '0'}</td>
          <td class="num">${Number(r.callbacks_due) > 0
            ? `<span class="badge b-bad">${Number(r.callbacks_due)}</span>` : '0'}</td>
          <td class="num">${Number(r.due_next_hour) > 0
            ? `<span class="badge b-warn">${Number(r.due_next_hour)}</span>` : '0'}</td>
          <td class="num">${Number(r.due_later_today)}</td>
          <td class="num">${Number(r.callbacks_missed_7d) > 0
            ? `<span class="badge b-warn">${Number(r.callbacks_missed_7d)}</span>` : '0'}</td>
          <td>${esc(fmtDT(r.next_callback_at))}</td>
        </tr>`).join('')}
      </tbody></table>
      ${anyDue ? '' : '<div class="hint" style="margin-top:8px">All clear — every follow-up on the floor is in the future. ✓</div>'}`}
    </div>`));

  // --- lead flow: why each caller is (or is not) receiving leads ---
  //
  // This panel exists because "X is not getting any leads" was unanswerable
  // from any screen, even though the engine records every decision. The
  // verdict column names the exact rule: off the floor (never pressed Start
  // shift), in no team (the engine cannot pick them), or deactivated.
  if (leadFlow && Array.isArray(leadFlow.callers)) {
    const FLOW = {
      receiving: '<span class="badge b-ok">receiving leads</span>',
      off_shift: '<span class="badge b-warn">off floor — skipped</span>',
      no_team: '<span class="badge b-bad">no team — never picked</span>',
      inactive: '<span class="badge b-mute">deactivated</span>',
    };
    const FLOW_WHY = {
      off_shift: 'Leads only go to callers who pressed “Start shift”. They will start receiving the moment they are on the floor.',
      no_team: 'Distribution walks the teams, so a caller in no team is invisible to it. Add them to a team in Admin → Users.',
      inactive: 'Deactivated accounts are excluded everywhere.',
    };
    const stuck = leadFlow.callers.filter((c) => c.flow_status !== 'receiving' && c.is_active);
    outlet.appendChild(h(`
      <div class="panel" data-testid="lead-flow">
        <h2>Lead flow <small>who the distribution engine can reach right now</small></h2>
        ${Number(leadFlow.unassigned) > 0 ? `
          <div class="banner" style="background:var(--warn-bg);color:var(--warn);border-color:#eed9b8">
            <b>${Number(leadFlow.unassigned)} lead${Number(leadFlow.unassigned) === 1 ? '' : 's'} waiting with no caller.</b>
            They are held at team level and hand out automatically as soon as an eligible caller is on the floor.
          </div>` : ''}
        <table class="table"><thead><tr>
          <th>Caller</th><th>Team</th><th>Status</th><th class="num">Today</th>
          <th class="num">Open book</th><th class="num">Passed over today</th><th>Last lead received</th>
        </tr></thead><tbody>
        ${leadFlow.callers.map((c) => `
          <tr>
            <td>${avatarHtml(c.full_name, avatars[c.user_id], 22)} ${esc(c.full_name)}</td>
            <td>${esc(c.team_name ?? '—')}</td>
            <td>${FLOW[c.flow_status] ?? esc(c.flow_status)}</td>
            <td class="num">${Number(c.leads_today)}</td>
            <td class="num">${Number(c.open_leads)}</td>
            <td class="num">${Number(c.passed_over_today) > 0
              ? `<span class="badge b-warn">${Number(c.passed_over_today)}</span>` : '0'}</td>
            <td>${esc(fmtDT(c.last_lead_at))}</td>
          </tr>`).join('')}
        </tbody></table>
        ${stuck.length === 0 ? '' : `
          <div class="hint" style="margin-top:8px">
            ${stuck.map((c) => `<div><b>${esc(c.full_name)}</b>: ${esc(FLOW_WHY[c.flow_status] ?? '')}</div>`).join('')}
          </div>`}
      </div>`));
  }

  // --- immediate queue ---
  if (immediate.leads.length > 0) {
    outlet.appendChild(h(`
      <div class="panel">
        <h2>Immediate — awaiting first contact <small>${immediate.leads.length}</small></h2>
        <table class="table"><thead><tr>
          <th>Lead</th><th>Caller</th><th class="num">Age</th><th>SLA</th><th></th>
        </tr></thead><tbody>
        ${immediate.leads.map((l) => `
          <tr class="click" data-lead="${esc(l.lead_id)}">
            <td>${esc(l.full_name ?? 'Unnamed')} <span class="hint mono">${esc(l.phone_e164)}</span></td>
            <td>${esc(l.caller_name ?? '—')}${l.caller_on_floor === false ? ' <span class="badge b-warn">off floor</span>' : ''}</td>
            <td class="num">${esc(agoLabel(l.age_minutes))}</td>
            <td>${l.sla_breached ? '<span class="badge b-bad">breached</span>' : '<span class="badge b-ok">in window</span>'}</td>
            <td class="right"><a href="#/lead/${esc(l.lead_id)}">open</a></td>
          </tr>`).join('')}
        </tbody></table>
      </div>`));
  }

  // --- transfer queue (requirement 8) ---
  const transferPanel = h(`
    <div class="panel">
      <h2>Not answered — reassign? <small>leads with ${'≥'}4 unanswered attempts</small></h2>
      ${candidates.length === 0 ? '<div class="empty" data-testid="transfer-empty">Nothing waiting for a transfer decision.</div>' : `
      <table class="table" data-testid="transfer-queue"><thead><tr>
        <th>Lead</th><th>Current caller</th><th class="num">NA streak</th><th class="num">Attempts</th>
        <th>Give to</th><th></th>
      </tr></thead><tbody>
      ${candidates.map((c) => `
        <tr data-row="${esc(c.lead_id)}">
          <td><a href="#/lead/${esc(c.lead_id)}">${esc(c.full_name ?? 'Unnamed')}</a>
              <span class="hint mono">${esc(c.phone_e164)}</span></td>
          <td>${esc(c.caller_name ?? '—')}</td>
          <td class="num">${Number(c.na_streak)}</td>
          <td class="num">${Number(c.attempt_count)}</td>
          <td>
            <select class="t-target" style="padding:6px;border:1px solid var(--line);border-radius:7px">
              ${targets.filter((t) => t.id !== c.caller_id)
                .map((t) => `<option value="${esc(t.id)}">${esc(t.full_name)} (${Number(t.leads_today)} today)</option>`).join('')}
            </select>
          </td>
          <td class="right"><button class="btn small primary t-go" data-lead="${esc(c.lead_id)}" data-testid="transfer-go">Transfer</button></td>
        </tr>`).join('')}
      </tbody></table>`}
    </div>`);
  outlet.appendChild(transferPanel);

  transferPanel.addEventListener('click', async (e) => {
    if (!e.target.classList?.contains('t-go')) return;
    const leadId = e.target.dataset.lead;
    const row = transferPanel.querySelector(`tr[data-row="${leadId}"]`);
    const to = row.querySelector('.t-target').value;
    if (!to) { toast('No caller available to receive it.', 'err'); return; }
    e.target.disabled = true;
    try {
      await post(`/leads/${leadId}/transfer`, { toCallerId: to, reason: 'not_answered_streak' });
      toast('Transferred.');
      row.remove();
    } catch (err) {
      toast(err.message, 'err');
      e.target.disabled = false;
    }
  });

  // --- my negotiations ---
  const mine = [...qualified.leads, ...negotiation.leads].filter((l) => l.counsellor_id === me.id);
  outlet.appendChild(h(`
    <div class="panel">
      <h2>My deals in progress <small>${mine.length}</small></h2>
      ${mine.length === 0 ? '<div class="empty">No qualified leads waiting on you.</div>' : `
      <table class="table"><thead><tr>
        <th>Lead</th><th>Status</th><th>Next action</th><th class="num">Attempts</th><th></th>
      </tr></thead><tbody>
      ${mine.map((l) => `
        <tr>
          <td>${esc(l.full_name ?? 'Unnamed')} <span class="hint mono">${esc(l.phone_e164)}</span></td>
          <td>${badge(l.status)}</td>
          <td>${esc(fmtDT(l.next_action_at))}</td>
          <td class="num">${Number(l.attempt_count)}</td>
          <td class="right"><a href="#/lead/${esc(l.id)}">open</a></td>
        </tr>`).join('')}
      </tbody></table>`}
    </div>`));

  // --- today's scoreboard, in the shape of the old Excel EOD tab ---
  //
  // Same columns the floor filled in by hand every evening - total calls,
  // answered, unanswered, interested, not interested, expected walk-in, walk-in
  // done, conversions - except nobody types them any more.
  const byUser = Object.fromEntries((Array.isArray(today) ? today : []).map((r) => [r.user_id, r]));
  outlet.appendChild(h(`
    <div class="panel">
      <h2>Today's scoreboard <small>the EOD sheet, filling itself in</small></h2>
      <div style="overflow-x:auto">
      <table class="table" data-testid="floor-live"><thead><tr>
        <th>Person</th><th>Status</th><th class="num">Hours</th>
        <th class="num">Calls</th><th class="num">Connects</th><th class="num">No answer</th>
        <th class="num">Interested</th><th class="num">Not interested</th>
        <th class="num">Visits promised</th><th class="num">Walked in</th>
        <th class="num">Deals</th><th class="num">Urgent waiting</th>
      </tr></thead><tbody>
      ${floor.map((r) => {
        const perf = byUser[r.user_id] ?? {};
        return `
        <tr>
          <td>${esc(r.full_name)} <span class="hint">${esc(r.role)}</span></td>
          <td>${r.currently_logged_in ? '<span class="badge b-ok">on floor</span>' : '<span class="badge b-mute">off</span>'}
              ${r.is_late ? '<span class="badge b-warn">late</span>' : ''}</td>
          <td class="num">${esc(minsLabel(r.logged_minutes_today))}</td>
          <td class="num">${Number(perf.dials ?? 0)}${r.dial_target ? ` / ${Number(r.dial_target)}` : ''}</td>
          <td class="num">${Number(perf.connects ?? 0)}</td>
          <td class="num">${Number(perf.not_answered ?? 0)}</td>
          <td class="num">${Number(perf.interested ?? 0)}</td>
          <td class="num">${Number(perf.not_interested ?? 0)}</td>
          <td class="num">${Number(perf.visits_promised ?? 0)}</td>
          <td class="num">${Number(perf.walked_in ?? 0)}</td>
          <td class="num">${Number(perf.deals ?? 0)}</td>
          <td class="num">${Number(r.urgent_in_queue) > 0 ? `<span class="badge b-bad">${Number(r.urgent_in_queue)}</span>` : '0'}</td>
        </tr>`;
      }).join('')}
      </tbody></table></div>
      <div class="hint" style="margin-top:8px">
        “Connects” needs 30+ seconds of real talk. “Visits promised” is what the client
        said; “walked in” is what happened. Deals count the person who closed them.
      </div>
    </div>`));

  // --- leakage detail, grouped by type ---
  //
  // Grouped even with no filter applied. One flat list of five different
  // problems is not a work list: "immediate untouched" and "missed callback"
  // need different actions, and mixing them makes both easier to skip.
  const detail = h('<div id="leak-detail"></div>');
  outlet.appendChild(detail);

  const drawLeaks = () => {
    detail.innerHTML = '';
    const items = leakFilter
      ? leakage.items.filter((l) => l.leak_type === leakFilter)
      : leakage.items;

    if (items.length === 0) {
      detail.appendChild(h(`<div class="panel"><div class="empty">${
        leakFilter ? 'Nothing leaking of this type.' : 'Nothing leaking — the pipeline is clean.'
      }</div></div>`));
      return;
    }

    const types = leakFilter ? [leakFilter] : [...new Set(items.map((l) => l.leak_type))];
    for (const type of types) {
      const group = items.filter((l) => l.leak_type === type);
      detail.appendChild(h(`
        <div class="panel">
          <h2>${esc(labelLeak(type))} <small>${group.length} · work this to zero</small></h2>
          <table class="table"><thead><tr>
            <th>Lead</th><th>Caller</th><th class="num">Late by</th><th>Severity</th><th></th>
          </tr></thead><tbody>
          ${group.slice(0, 50).map((l) => `
            <tr>
              <td>${esc(l.full_name ?? 'Unnamed')} <span class="hint mono">${esc(l.phone_e164)}</span></td>
              <td>${esc(l.caller_name ?? '—')}</td>
              <td class="num">${esc(agoLabel(l.minutes_late))}</td>
              <td>${l.severity === 'high' ? '<span class="badge b-bad">high</span>' : '<span class="badge b-warn">medium</span>'}</td>
              <td class="right"><a href="#/lead/${esc(l.lead_id)}">open</a></td>
            </tr>`).join('')}
          </tbody></table>
          ${group.length > 50 ? `<div class="hint">Showing the 50 latest of ${group.length}.</div>` : ''}
        </div>`));
    }
  };

  chips.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-leak]');
    if (!btn) return;
    const key = btn.dataset.leak || null;
    leakFilter = leakFilter === key ? null : key;
    chips.querySelectorAll('button.chip').forEach((b) =>
      b.classList.toggle('on', (b.dataset.leak || null) === leakFilter));
    drawLeaks();
  });

  drawLeaks();

  outlet.addEventListener('click', (e) => {
    const row = e.target.closest?.('tr.click[data-lead]');
    if (row) location.hash = `#/lead/${row.dataset.lead}`;
  });
}

function labelLeak(t) {
  return {
    untouched_immediate: 'Immediate untouched',
    untouched_24h: 'Untouched 24h+',
    overdue_next_action: 'Overdue action',
    missed_callback: 'Missed callback',
    unassigned: 'Unassigned',
  }[t] ?? t;
}
