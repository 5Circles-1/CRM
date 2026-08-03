import { get, post } from '../api.js';
import { agoLabel, badge, esc, fmtDT, h, minsLabel, toast } from '../util.js';

/**
 * The counsellor's home: who is on the floor, what is leaking, what needs
 * transferring (requirement 8), and their own negotiations.
 */
export async function render(outlet, me) {
  const [floor, immediate, leakage, candidates, targets, qualified, negotiation] = await Promise.all([
    get('/dashboards/floor'),
    get('/queues/immediate'),
    get('/dashboards/leakage'),
    get('/transfers/candidates').catch(() => []),
    get('/transfers/targets').catch(() => []),
    get('/leads?status=qualified&limit=100'),
    get('/leads?status=negotiation&limit=100'),
  ]);

  outlet.innerHTML = '';

  // --- leakage summary chips: if all zero, say so loudly (it's the goal) ---
  const leakTotal = leakage.summary.reduce((a, s) => a + Number(s.count), 0);
  outlet.appendChild(h(`
    <div class="chips">
      <span class="chip ${leakTotal > 0 ? 'hot' : ''}">Pipeline leaks <b>${leakTotal}</b></span>
      ${leakage.summary.map((s) => `<span class="chip">${esc(labelLeak(s.leak_type))} <b>${Number(s.count)}</b></span>`).join('')}
      ${leakTotal === 0 ? '<span class="chip" style="color:var(--ok)">Pipeline clean ✓</span>' : ''}
    </div>`));

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

  // --- floor live ---
  outlet.appendChild(h(`
    <div class="panel">
      <h2>Floor live</h2>
      <table class="table" data-testid="floor-live"><thead><tr>
        <th>Person</th><th>Status</th><th class="num">Logged</th><th class="num">Dials</th>
        <th class="num">Connects</th><th class="num">Urgent in queue</th><th>Last call</th>
      </tr></thead><tbody>
      ${floor.map((r) => `
        <tr>
          <td>${esc(r.full_name)} <span class="hint">${esc(r.role)}</span></td>
          <td>${r.currently_logged_in ? '<span class="badge b-ok">on floor</span>' : '<span class="badge b-mute">off</span>'}
              ${r.is_late ? '<span class="badge b-warn">late</span>' : ''}</td>
          <td class="num">${esc(minsLabel(r.logged_minutes_today))}</td>
          <td class="num">${Number(r.dials_today)}${r.dial_target ? ` / ${Number(r.dial_target)}` : ''}</td>
          <td class="num">${Number(r.connects_today)}</td>
          <td class="num">${Number(r.urgent_in_queue) > 0 ? `<span class="badge b-bad">${Number(r.urgent_in_queue)}</span>` : '0'}</td>
          <td>${esc(fmtDT(r.last_call_at))}</td>
        </tr>`).join('')}
      </tbody></table>
    </div>`));

  // --- leakage detail ---
  if (leakage.items.length > 0) {
    outlet.appendChild(h(`
      <div class="panel">
        <h2>Leakage detail <small>work this list to zero</small></h2>
        <table class="table"><thead><tr>
          <th>Type</th><th>Lead</th><th class="num">Late by</th><th>Severity</th><th></th>
        </tr></thead><tbody>
        ${leakage.items.slice(0, 30).map((l) => `
          <tr>
            <td>${esc(labelLeak(l.leak_type))}</td>
            <td>${esc(l.full_name ?? 'Unnamed')} <span class="hint mono">${esc(l.phone_e164)}</span></td>
            <td class="num">${esc(agoLabel(l.minutes_late))}</td>
            <td>${l.severity === 'high' ? '<span class="badge b-bad">high</span>' : '<span class="badge b-warn">medium</span>'}</td>
            <td class="right"><a href="#/lead/${esc(l.lead_id)}">open</a></td>
          </tr>`).join('')}
        </tbody></table>
      </div>`));
  }

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
