import { get, post } from '../api.js';
import { addLeadModal } from '../addlead.js';
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
/**
 * Why a group of leads is sitting unassigned, in words that name the fix.
 *
 * The old banner said "waiting for an eligible caller" while two callers were
 * visibly working — true, but useless, because the waiting leads belonged to a
 * different team. Each reason below points at something someone can go and do.
 */
const WAIT_WHY = (w) => ({
  nobody_on_shift:
    `nobody on this team has started a shift (${w.callers} caller${w.callers === 1 ? '' : 's'} on the team), `
    + 'and the team lead is off the floor too — leads flow to the team lead automatically when the '
    + 'callers are absent. They hand out the moment anyone on the team presses Start shift.',
  all_on_floor_restricted:
    `everyone on the floor from this team is RESTRICTED, so no fresh leads may go to them. `
    + 'Un-restrict someone in Admin, or get a STANDARD caller on the floor.',
  team_has_no_callers:
    'this team has no active callers at all. Add someone to it in Admin → Users.',
  no_team:
    'these leads belong to no team, so distribution cannot see them. '
    + 'Pin the lead source to a team in Admin → Ingestion.',
  engine_should_be_assigning:
    `${w.eligible_now} eligible caller${w.eligible_now === 1 ? ' is' : 's are'} on the floor, `
    + 'so these should be moving within a minute. If the number is not falling, press Hand out now.',
}[w.reason] ?? 'held at team level.');

export async function render(outlet, me) {
  const [floor, immediate, leakage, candidates, targets, qualified, negotiation, today,
         overallToday, avatars, leadFlow, followups, intake, month] = await Promise.all([
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
    get('/dashboards/intake').catch(() => null),
    get('/dashboards/leads-month').catch(() => null),
  ]);

  outlet.innerHTML = '';

  // The inbound-call door, on the screen the counsellors and the admin land
  // on. It lived only on Fresh leads and Find lead, which is two clicks away
  // from where anyone answering a phone actually is.
  const inboundRow = h(`
    <div class="row spread wrap" style="margin-bottom:10px">
      <div class="hint">
        A client rang the office? Log it here — an inbound call is the warmest
        lead on the floor, and its follow-up date rings when it is due.
      </div>
      <button class="btn primary" data-testid="floor-inbound">📞 Inbound call</button>
    </div>`);
  inboundRow.querySelector('button').addEventListener('click', () =>
    addLeadModal(me, (lead) => {
      if (lead?.id) location.hash = `#/lead/${lead.id}`;
    }, 'inbound'));
  outlet.appendChild(inboundRow);

  // --- is the lead pipe alive? straight to the top, before anything else ---
  //
  // Leads stopped arriving from the sheet for two days and every screen
  // looked merely quiet. Nothing is more urgent than "the leads are not
  // coming in", so nothing sits above it.
  if (intake) renderIntake(outlet, intake, me);
  if (month) renderMonth(outlet, month);

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

  // --- live activity: every outcome logged today, filterable by disposition ---
  //
  // The answer to "leads are going missing": whatever a caller records shows
  // here at once. Nothing is hidden - the filter narrows, it never drops.
  const activityPanel = h('<div class="panel" data-testid="floor-activity"></div>');
  outlet.appendChild(activityPanel);
  let dispFilter = '';
  const DISPO_LABEL = (d) => String(d ?? '').replace(/_/g, ' ');
  const drawActivity = async () => {
    const rows = await get(`/dashboards/activity${dispFilter ? `?disposition=${dispFilter}` : ''}`).catch(() => []);
    // Build the filter chips from the outcomes actually seen today.
    const seen = [...new Set((Array.isArray(rows) ? rows : []).map((r) => r.disposition))];
    const allDispos = dispFilter && !seen.includes(dispFilter) ? [dispFilter, ...seen] : seen;
    // innerHTML, not h(): this panel has several sibling nodes (header, chips,
    // table) and h() keeps only the first element - which is exactly how the
    // chips and table went missing the first time.
    activityPanel.innerHTML = `
      <div class="row spread">
        <h2 class="mt0">Live activity <small>every call logged today — updates on its own</small></h2>
      </div>
      <div class="chips" data-testid="activity-chips">
        <button class="chip ${dispFilter === '' ? 'on' : ''}" data-disp="">All outcomes</button>
        ${allDispos.map((d) => `<button class="chip ${dispFilter === d ? 'on' : ''}" data-disp="${esc(d)}">${esc(DISPO_LABEL(d))}</button>`).join('')}
      </div>
      ${(!Array.isArray(rows) || rows.length === 0)
        ? '<div class="empty">No calls logged yet today.</div>'
        : `<div style="overflow-x:auto"><table class="table"><thead><tr>
             <th>Time</th><th>Who</th><th>Lead</th><th>Outcome</th><th class="num">Talk</th>
           </tr></thead><tbody>
           ${rows.slice(0, 100).map((r) => `
             <tr>
               <td>${esc(fmtDT(r.started_at))}</td>
               <td>${esc(r.by_name)} <span class="hint">${esc(r.by_role)}</span></td>
               <td><a href="#/lead/${esc(r.lead_id)}">${esc(r.lead_name ?? 'Lead')}</a>
                   <span class="hint mono">${esc(r.phone_e164)}</span></td>
               <td>${badge(r.disposition)}${r.is_connect ? ' <span class="badge b-ok">connect</span>' : ''}</td>
               <td class="num">${esc(fmtTalk(r.duration_seconds))}</td>
             </tr>`).join('')}
           </tbody></table></div>`}`;
    activityPanel.querySelectorAll('[data-disp]').forEach((b) =>
      b.addEventListener('click', () => { dispFilter = b.dataset.disp; drawActivity(); }));
  };
  await drawActivity();

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
      restricted: '<span class="badge b-bad">restricted — no fresh leads</span>',
      inactive: '<span class="badge b-mute">deactivated</span>',
    };
    const FLOW_WHY = {
      off_shift: 'Leads only go to callers who pressed “Start shift”. They will start receiving the moment they are on the floor.',
      no_team: 'Distribution walks the teams, so a caller in no team is invisible to it. Add them to a team in Admin → Users.',
      restricted: 'Their tier is RESTRICTED, so no fresh lead may go to them — transfers and re-tap work still can. Change it in Admin → Users → Tier.',
      inactive: 'Deactivated accounts are excluded everywhere.',
    };
    // Why each caller is getting the number of leads they are getting.
    //
    // The share moves on its own: the daily ranking picks each team's best
    // caller and hands them distribution.ace_share_pct of the fresh leads.
    // That is deliberate — and it was completely invisible, so "why did all
    // the leads go to her today?" was a question no screen could answer.
    // The Share column is the answer, straight from the engine's own rule.
    const shareCell = (c) => {
      const pct = Number(c.fresh_share_pct ?? 0);
      if (!c.is_active) return '<span class="hint">—</span>';
      if (pct === 0) return '<span class="badge b-warn">0%</span>';
      return `${pct}%${c.tier === 'ace'
        ? ' <span class="badge b-warn" title="Today\u2019s best caller on the leaderboard holds the guaranteed share of fresh leads. Ranked automatically each night; an admin can pin it.">⭐ ACE</span>'
        : ''}`;
    };
    const stuck = leadFlow.callers.filter((c) => c.flow_status !== 'receiving' && c.is_active);
    outlet.appendChild(h(`
      <div class="panel" data-testid="lead-flow">
        <h2>Lead flow <small>who the distribution engine can reach right now</small></h2>
        ${Number(leadFlow.unassigned) > 0 ? `
          <div class="banner warn">
            <div><b>${Number(leadFlow.unassigned)} lead${Number(leadFlow.unassigned) === 1 ? '' : 's'} waiting with no caller.</b></div>
            <div style="font-weight:500;margin-top:6px">
              ${(leadFlow.waiting ?? []).map((w) => `
                <div style="margin-top:4px">
                  <b>${esc(w.team_name)}:</b> ${Number(w.waiting)} waiting —
                  ${esc(WAIT_WHY(w))}
                </div>`).join('') || 'Held at team level; they hand out automatically.'}
            </div>
            ${Number(leadFlow.covered) > 0 ? `
            <div class="hint" style="margin-top:6px">
              Not counted above: ${Number(leadFlow.covered)} lead${Number(leadFlow.covered) === 1 ? ' is' : 's are'}
              with the team leads, covering for absent callers — owned and being worked, not waiting.
            </div>` : ''}
            ${me.role === 'admin' || me.role === 'ops'
              ? '<button class="btn small" id="assign-now" style="margin-top:8px">Hand out now</button>' : ''}
          </div>` : Number(leadFlow.covered) > 0 ? `
          <div class="hint" style="margin-bottom:10px">
            ${Number(leadFlow.covered)} lead${Number(leadFlow.covered) === 1 ? ' is' : 's are'} with the team leads,
            covering for absent callers — owned and being worked, not waiting.
          </div>` : ''}
        <table class="table"><thead><tr>
          <th>Caller</th><th>Team</th><th>Status</th>
          <th class="num" title="Share of this team's fresh leads the engine is targeting for them right now">Share of fresh</th>
          <th class="num">Today</th>
          <th class="num">Open book</th><th class="num">Passed over today</th><th>Last lead received</th>
        </tr></thead><tbody>
        ${leadFlow.callers.map((c) => `
          <tr>
            <td>${avatarHtml(c.full_name, avatars[c.user_id], 22)} ${esc(c.full_name)}</td>
            <td>${esc(c.team_name ?? '—')}</td>
            <td>${FLOW[c.flow_status] ?? esc(c.flow_status)}</td>
            <td class="num">${shareCell(c)}</td>
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
        ${leadFlow.callers.some((c) => c.tier === 'ace' && c.is_active) ? `
          <div class="hint" style="margin-top:8px">
            ⭐ <b>ACE</b> is picked automatically each night: each team's best caller
            <b>per day they actually worked</b> over the last week holds the guaranteed
            share of that team's fresh leads. Days off are not counted against anyone,
            and a caller the ranking could not measure keeps the tier they earned —
            coming back from leave never costs somebody their share.
            Pin or unpin it in Admin → Users → Tier.
          </div>` : ''}
      </div>`));

    outlet.querySelector('#assign-now')?.addEventListener('click', async (ev) => {
      const btn = ev.currentTarget;
      btn.disabled = true;
      try {
        const r = await post('/dashboards/lead-flow/assign-now', {});
        toast(Number(r.assigned) > 0
          ? `${r.assigned} lead${Number(r.assigned) === 1 ? '' : 's'} handed out.`
          : 'Nothing could be handed out — the reason above still applies.');
        render(outlet, me);
      } catch (err) { toast(err.message, 'err'); btn.disabled = false; }
    });
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

/**
 * Lead intake: is the pipe actually delivering?
 *
 * The floor lost two days of Meta leads because "no fresh leads" and "the
 * importer has stopped" look identical from every other screen. This panel
 * only shows itself when something is wrong or worth knowing, so on a healthy
 * day it is one quiet line — and on a broken one it is the first thing on the
 * page, naming the fix.
 */
const INTAKE_WHY = {
  not_shared: ['The sheet is not shared with the CRM', 'Google is refusing to open the spreadsheet, so every run reads zero rows — nothing is lost, the leads are still sitting in the sheet. Open the sheet → Share → add the CRM\'s service account address below as a Viewer. The next import pulls the whole backlog.'],
  not_connected: ['No sheet connected', 'This source has no Google Sheet configured. Add the spreadsheet in Admin → Lead sources, or import a CSV there.'],
  manual: ['Hand entry only', 'Leads reach this source by being typed in or pasted as a CSV — the importer never reads it, so it is not waiting on anything.'],
  never_run: ['Never imported', 'The sheet is configured but has never synced. The importer needs SERVICE_USER_ID and Google credentials in the API environment.'],
  failing: ['Import failing', 'The last run returned an error — the message is below. A renamed tab or revoked sheet access are the usual causes.'],
  stale: ['Import has stalled', 'The last successful sync is older than it should be. The importer may have stopped, or the server may have been restarted without credentials.'],
  all_rejected: ['Every row rejected', 'Rows are arriving but all of them are being quarantined — usually the phone column was renamed in the sheet. Fix the mapping in Admin → Lead sources; nothing is lost, quarantined rows can be replayed.'],
  off: ['Switched off', 'This source is inactive, so it is not imported.'],
};

/**
 * The month counter: how many leads each team has received this month, in
 * one line. The owner's question — "how many did we get, in total, this
 * month" — should never need a report built to answer it.
 */
function renderMonth(outlet, month) {
  const teams = month.teams ?? [];
  outlet.appendChild(h(`
    <div class="panel" style="margin-bottom:16px" data-testid="month-leads">
      <div class="row spread wrap">
        <h2 class="mt0">Leads received in ${esc(month.month)}
          <small>${Number(month.total)} total${Number(month.inbound_total) > 0
            ? ` · ${Number(month.inbound_total)} inbound 📞` : ''}</small></h2>
      </div>
      <div class="row wrap" style="gap:18px">
        ${teams.map((t) => `
          <div>
            <div class="hint">${esc(t.team_name)}</div>
            <div style="font-size:1.6em;font-weight:700">${Number(t.leads_month)}</div>
            <div class="hint">${Number(t.leads_today)} today${Number(t.inbound_month) > 0
              ? ` · ${Number(t.inbound_month)} inbound` : ''}${Number(t.won_month) > 0
              ? ` · ${Number(t.won_month)} won` : ''}</div>
          </div>`).join('')}
      </div>
    </div>`));
}

function renderIntake(outlet, intake, me) {
  const sources = intake.sources ?? [];
  // 'manual' and 'off' are not faults: a hand-entry source has no sheet by
  // design, and shouting about it every hour is what taught the floor to
  // ignore the bell.
  const bad = sources.filter((s) => !['healthy', 'off', 'manual'].includes(s.state));
  const quiet = Number(intake.minutes_since_lead ?? 0) > 120;
  const enginesDead = intake.jobs_never_ran === true;
  const canAct = me.role === 'admin' || me.role === 'ops';

  // Nothing wrong and leads flowing: one line, no noise.
  if (!bad.length && !quiet && !enginesDead) {
    outlet.appendChild(h(`
      <div class="hint" style="margin-bottom:12px">
        Lead intake healthy — ${Number(intake.leads_today ?? 0)} lead${Number(intake.leads_today) === 1 ? '' : 's'} in today,
        newest ${Number(intake.minutes_since_lead ?? 0)}m ago.
      </div>`));
    return;
  }

  const panel = h(`
    <div class="panel" data-testid="intake-health"
         style="margin-bottom:16px;border:2px solid var(--bad)">
      <div class="row spread wrap">
        <h2 class="mt0" style="color:var(--bad)">⚠ Leads are not arriving</h2>
        ${canAct ? '<button class="btn primary" id="sync-now" data-testid="sync-now">Import the sheet now</button>' : ''}
      </div>
      <div class="hint" style="margin-bottom:10px">
        ${Number(intake.leads_today ?? 0)} lead${Number(intake.leads_today) === 1 ? '' : 's'} created today${
          intake.minutes_since_lead != null
            ? ` · newest was ${Number(intake.minutes_since_lead)} minutes ago`
            : ' · no leads on record at all'}.
      </div>
      ${enginesDead ? `
        <div class="alert-row" style="border-left:3px solid var(--bad)">
          <b>The background engine has never run on this server.</b>
          <div class="hint">Sheet import, lead distribution, reminders and scoring are all driven by it.
          It needs <code>SERVICE_USER_ID</code> set in the API environment — until then leads must be
          imported by hand from Admin → Lead sources.</div>
        </div>` : ''}
      ${bad.map((s) => {
        const [title, why] = INTAKE_WHY[s.state] ?? [s.state, ''];
        return `
        <div class="alert-row" style="border-left:3px solid var(--bad)">
          <b>${esc(s.source_name)} — ${esc(title)}</b>
          <div class="hint">${esc(why)}</div>
          <div class="hint">
            ${s.last_synced_at
              ? `last sync ${esc(fmtDT(s.last_synced_at))} (${Number(s.minutes_since_sync)}m ago)`
              : 'never synced'}
            ${s.rows_seen != null ? ` · last run saw ${Number(s.rows_seen)} row${Number(s.rows_seen) === 1 ? '' : 's'},
              created ${Number(s.rows_created)}, matched ${Number(s.rows_duplicate)} existing,
              quarantined ${Number(s.rows_quarantined)}` : ''}
          </div>
          ${s.state === 'not_shared' && intake.service_account_email ? `
            <div style="margin-top:6px">
              <b>Share the sheet with:</b>
              <code class="mono" data-testid="sa-email">${esc(intake.service_account_email)}</code>
              <button class="btn small" data-copy="${esc(intake.service_account_email)}">Copy</button>
            </div>` : ''}
          ${s.error_text ? `<div class="hint mono" style="color:var(--bad)">${esc(s.error_text)}</div>` : ''}
        </div>`;
      }).join('')}
      ${!bad.length && quiet ? `
        <div class="alert-row" style="border-left:3px solid var(--warn)">
          <b>Every source looks configured, but nothing new has come in.</b>
          <div class="hint">Either the sheet genuinely has no new rows, or every row matched somebody
          already in the book (a re-enquiry attaches to the existing lead rather than creating a second one).
          The counts on each source below tell you which.</div>
        </div>` : ''}
      <details style="margin-top:8px">
        <summary class="hint">All sources</summary>
        <table class="table"><thead><tr>
          <th>Source</th><th>State</th><th>Last sync</th>
          <th class="num">Seen</th><th class="num">Created</th>
          <th class="num">Matched</th><th class="num">Rejected</th>
        </tr></thead><tbody>
        ${sources.map((s) => `
          <tr>
            <td>${esc(s.source_name)}</td>
            <td>${s.state === 'healthy'
              ? '<span class="badge b-ok">healthy</span>'
              : ['off', 'manual'].includes(s.state)
                ? `<span class="badge b-mute">${esc(s.state === 'manual' ? 'hand entry' : 'off')}</span>`
                : `<span class="badge b-bad">${esc(String(s.state).replace(/_/g, ' '))}</span>`}</td>
            <td>${s.last_synced_at ? esc(fmtDT(s.last_synced_at)) : '<span class="hint">never</span>'}</td>
            <td class="num">${s.rows_seen ?? '—'}</td>
            <td class="num">${s.rows_created ?? '—'}</td>
            <td class="num">${s.rows_duplicate ?? '—'}</td>
            <td class="num">${s.rows_quarantined ?? '—'}</td>
          </tr>`).join('')}
        </tbody></table>
      </details>
    </div>`);
  outlet.appendChild(panel);

  panel.querySelectorAll('[data-copy]').forEach((b) =>
    b.addEventListener('click', () => {
      navigator.clipboard?.writeText(b.dataset.copy);
      toast('Address copied — paste it into the sheet’s Share box as a Viewer.');
    }));

  panel.querySelector('#sync-now')?.addEventListener('click', async (e) => {
    e.target.disabled = true;
    e.target.textContent = 'Importing…';
    try {
      const r = await post('/dashboards/intake/sync-now', {});
      const made = (r.summaries ?? []).reduce((a, s) => a + Number(s.created ?? 0), 0);
      toast(made > 0
        ? `${made} new lead${made === 1 ? '' : 's'} imported.`
        : 'The sheet was read, but there was nothing new in it.');
      render(outlet, me);
    } catch (err) {
      toast(err.message, 'err');
      e.target.disabled = false;
      e.target.textContent = 'Import the sheet now';
    }
  });
}
