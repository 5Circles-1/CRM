import { get } from '../api.js';
import { avatarHtml, esc, fmtDT, h, outcomeLabel, stageBadge } from '../util.js';

/**
 * What is due. Three buckets - overdue, today, next 7 days - built from the
 * one date every open lead carries. There is no separate reminder object to
 * tidy: logging the call moves the date and the row moves itself.
 *
 * Callers and the follow-up person see their own list (plus anything
 * unassigned); the admin sees the whole floor's, each row naming its owner.
 */
export async function render(outlet, me) {
  const { overdue, today, upcoming } = await get('/reminders');

  outlet.innerHTML = '';
  const root = h(`
    <div>
      ${bucket('Overdue', overdue, 'These were promised and the time has passed — call them first.', 'b-bad')}
      ${bucket('Due today', today, 'Booked for later today.', 'b-warn')}
      ${bucket('Coming up (7 days)', upcoming, 'Future callbacks and follow-ups, in order.', 'b-info')}
    </div>`);
  outlet.appendChild(root);

  root.querySelectorAll('tr[data-id]').forEach((tr) => {
    tr.addEventListener('click', (e) => {
      if (e.target.closest('a')) return;
      location.hash = `#/lead/${tr.dataset.id}`;
    });
  });
}

function bucket(title, rows, hint, tone) {
  return `
    <div class="panel">
      <div class="section-h" style="margin-top:0">
        ${esc(title)} <span class="badge ${tone}">${rows.length}</span>
      </div>
      ${rows.length === 0
        ? `<div class="empty">Nothing here${title === 'Overdue' ? ' — well done' : ''}.</div>`
        : `<div class="hint" style="margin-bottom:8px">${esc(hint)}</div>
           <table class="table">
             <thead><tr><th>When</th><th>Name</th><th>Phone</th><th>With</th><th>Status</th><th>Last response</th><th>Note</th></tr></thead>
             <tbody>${rows.map(row).join('')}</tbody>
           </table>`}
    </div>`;
}

function row(l) {
  return `
    <tr data-id="${l.id}">
      <td class="mono">${esc(fmtDT(l.next_follow_up_at))}</td>
      <td><b>${esc(l.full_name ?? '—')}</b></td>
      <td class="mono"><a href="tel:${esc(l.phone_e164)}">${esc(l.phone_e164)}</a></td>
      <td>${l.assigned_name ? `${avatarHtml(l.assigned_name, 22)} ${esc(l.assigned_name)}` : '<span class="badge b-bad">Unassigned</span>'}</td>
      <td>${stageBadge(l.stage)}</td>
      <td>${esc(outcomeLabel(l))}</td>
      <td class="hint">${esc(l.follow_up_note ?? '')}</td>
    </tr>`;
}
