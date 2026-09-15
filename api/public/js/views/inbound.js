import { get } from '../api.js';
import { badge, esc, fmtDT, h } from '../util.js';
import { addLeadModal } from '../addlead.js';
import { reminderModal } from './lead.js';

/**
 * The inbound-call register (0069).
 *
 * The Floor has counted inbound calls since 0057, but a count is not a list:
 * "which clients rang us, who punched each call in, and is the promise we
 * made them still standing?" had no screen. This is that screen.
 *
 * Who punched a call in and who owns it now are shown side by side, because
 * they are not always the same person - an admin can punch a call in and
 * route it, and a lead can be transferred later. The follow-up column is the
 * date the client heard on the phone (also a pending callback, the kind that
 * rings - 0055), and every row offers the existing per-lead reminder for an
 * extra personal nudge on top.
 *
 * No scope switch: RLS decides whose register this is. A caller sees the
 * inbound calls they own, a counsellor their team's, admin/ops/viewer the
 * whole floor - the same rule as every other list.
 */

const OPEN = new Set(['new', 'working', 'callback', 'qualified', 'negotiation']);

const istMonth = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata', month: 'numeric', year: 'numeric',
});

const followupCell = (c) => {
  if (!c.next_action_at) return '<span class="hint">—</span>';
  const when = fmtDT(c.next_action_at);
  if (!OPEN.has(c.status)) return `<span class="hint">${esc(when)}</span>`;
  const overdue = new Date(c.next_action_at).getTime() < Date.now();
  return `${overdue ? `<span class="badge b-bad">overdue</span> ` : ''}${esc(when)}
    ${c.next_action_note ? `<div class="hint">${esc(c.next_action_note)}</div>` : ''}`;
};

const reminderLabel = (c) => {
  if (c.reminder_muted) return '🔕 muted';
  if (c.reminder_at) return `⏰ ${fmtDT(c.reminder_at)}`;
  return '⏰ Remind me';
};

export async function render(outlet, me) {
  const canRemind = me.role !== 'viewer';
  const canLog = ['caller', 'counsellor', 'admin', 'ops'].includes(me.role);

  const draw = async () => {
    outlet.innerHTML = '<div class="spin"></div>';
    const data = await get('/leads/inbound');
    const calls = data.calls ?? [];
    outlet.innerHTML = '';

    const nowMonth = istMonth.format(new Date());
    const thisMonth = calls.filter((c) => istMonth.format(new Date(c.punched_at)) === nowMonth).length;
    const overdue = calls.filter((c) =>
      OPEN.has(c.status) && c.next_action_at && new Date(c.next_action_at).getTime() < Date.now()).length;

    outlet.appendChild(h(`
      <div>
      <div class="grid cols-3" style="margin-bottom:16px">
        <div class="stat"><div class="k">Inbound calls this month</div><div class="v">${thisMonth}</div>
          <div class="s">clients who rang the office</div></div>
        <div class="stat"><div class="k">On the register</div><div class="v">${calls.length}</div>
          <div class="s">${data.count >= 200 ? 'latest 200 shown' : 'everything you can see'}</div></div>
        <div class="stat ${overdue ? 'tone-bad' : 'tone-good'}"><div class="k">Follow-up promise broken</div>
          <div class="v">${overdue}</div>
          <div class="s">${overdue ? 'the client was told a date that has passed' : 'every promise is still ahead'}</div></div>
      </div>

      <div class="panel">
        <div class="row spread wrap">
          <div>
            <h2 class="mt0">Inbound calls <small>${calls.length}</small></h2>
            <div class="hint">
              Every client who rang the office — who punched the call in, who
              owns it now, and the follow-up date the client was promised.
              That date already rings as a callback; the ⏰ button adds your
              own extra reminder on top.
            </div>
          </div>
          ${canLog ? `<button class="btn primary small" id="add-inbound" data-testid="inbound-log">
            📞 Log inbound call</button>` : ''}
        </div>
        ${calls.length === 0 ? `<div class="empty">
          No inbound calls yet. When a client rings the office, log it with
          the 📞 button — it lands here with the promise it carries.
        </div>` : `
        <div style="overflow-x:auto">
        <table class="table" data-testid="inbound-table"><thead><tr>
          <th>Client</th><th>Punched in by</th><th>Owner now</th>
          <th>Status</th><th>Follow-up promised</th>
          ${canRemind ? '<th>Reminder</th>' : ''}<th></th>
        </tr></thead><tbody>
        ${calls.map((c) => `
          <tr class="click" data-lead="${esc(c.lead_id)}">
            <td><b>${esc(c.full_name ?? 'Unnamed')}</b>
              ${c.green_reason === 'will_visit'
                ? ' <span class="badge b-ok" title="Promised to visit and has not yet come">🚶 will visit</span>'
                : c.green_reason === 'interested'
                ? ' <span class="badge b-ok" title="Showed real interest on a call">🟢</span>' : ''}
              <span class="hint mono">${esc(c.phone_e164)}</span>
              ${c.city ? `<div class="hint">${esc(c.city)}</div>` : ''}</td>
            <td>${esc(c.punched_by ?? '—')}
              <div class="hint">${esc(fmtDT(c.punched_at))}</div></td>
            <td>${c.owner_name
              ? `${esc(c.owner_name)}${c.team_name ? `<div class="hint">${esc(c.team_name)}</div>` : ''}`
              : '<span class="badge b-warn">no owner</span>'}</td>
            <td>${badge(c.status)}</td>
            <td>${followupCell(c)}</td>
            ${canRemind ? `<td><button class="btn small" data-remind="${esc(c.lead_id)}"
              title="A personal nudge on top of the promised callback">${reminderLabel(c)}</button></td>` : ''}
            <td class="num"><button class="btn small" data-open="${esc(c.lead_id)}">Open</button></td>
          </tr>`).join('')}
        </tbody></table></div>`}
      </div>
      </div>`));

    outlet.querySelector('#add-inbound')?.addEventListener('click', () =>
      addLeadModal(me, () => draw(), 'inbound'));

    outlet.querySelectorAll('[data-remind]').forEach((btn) =>
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const c = calls.find((x) => x.lead_id === btn.dataset.remind);
        if (!c) return;
        reminderModal({
          id: c.lead_id,
          reminder_muted: c.reminder_muted,
          reminder_at: c.reminder_at,
          reminder_note: c.reminder_note,
        }, () => draw());
      }));

    outlet.querySelectorAll('[data-lead], [data-open]').forEach((el) =>
      el.addEventListener('click', (ev) => {
        ev.stopPropagation();
        location.hash = `#/lead/${el.dataset.lead ?? el.dataset.open}`;
      }));
  };

  await draw();
}
