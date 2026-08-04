import { get } from '../api.js';
import { agoLabel, esc, fmtDT, h } from '../util.js';

/**
 * Requirement 4 and 5: the caller's pipeline for today, ordered so it can be
 * worked top to bottom without a single prioritisation decision.
 */
const BUCKETS = [
  ['immediate', 'Call now', 'Immediate leads inside their first-touch window'],
  ['overdue', 'Overdue', 'Past their scheduled time'],
  ['callback', 'Callbacks', 'The client asked for these times'],
  ['fresh', 'Fresh leads', 'Never dialled yet'],
  ['scheduled', 'Scheduled later today', ''],
];

export async function render(outlet) {
  const [summary, data] = await Promise.all([get('/me/day/summary'), get('/me/day')]);
  outlet.innerHTML = '';

  const chips = h(`
    <div class="chips" data-testid="day-chips">
      <span class="chip">Today <b>${summary.total}</b></span>
      <span class="chip ${summary.immediate > 0 ? 'hot' : ''}">Immediate <b>${summary.immediate}</b></span>
      <span class="chip ${summary.overdue > 0 ? 'hot' : ''}">Overdue <b>${summary.overdue}</b></span>
      <span class="chip">Callbacks <b>${summary.callbacks}</b></span>
      <span class="chip">Fresh <b>${summary.fresh}</b></span>
    </div>`);
  outlet.appendChild(chips);

  const leads = data.leads ?? [];

  const hot = leads.filter((l) => l.bucket === 'immediate');
  if (hot.length > 0) {
    const first = hot[0];
    const left = first.sla_minutes_remaining;
    outlet.appendChild(h(`
      <div class="banner bad" data-testid="immediate-banner">
        ${hot.length} immediate lead${hot.length > 1 ? 's' : ''} waiting —
        <a href="#/lead/${esc(first.lead_id)}">${esc(first.full_name ?? 'Unnamed lead')}</a>
        ${left !== null && left !== undefined
          ? (left >= 0 ? `· ${left} min left in the window` : `· window missed by ${-left} min`)
          : ''}
      </div>`));
  }

  if (leads.length === 0) {
    outlet.appendChild(h(`<div class="panel"><div class="empty">Queue clear — nothing due right now. New leads land here automatically.</div></div>`));
    return;
  }

  for (const [key, label] of BUCKETS) {
    const group = leads.filter((l) => l.bucket === key);
    if (group.length === 0) continue;

    outlet.appendChild(h(`<div class="section-h">${esc(label)} <span class="count">· ${group.length}</span></div>`));
    const wrap = h(`<div data-testid="bucket-${esc(key)}"></div>`);
    for (const l of group) wrap.appendChild(card(l));
    outlet.appendChild(wrap);
  }
}

function card(l) {
  const when =
    l.bucket === 'overdue' ? `<span class="badge b-bad">overdue ${agoLabel(l.minutes_overdue)}</span>`
    : l.bucket === 'immediate' ? `<span class="badge b-bad">CALL NOW</span>`
    : l.bucket === 'callback' ? `<span class="badge b-info">${esc(fmtDT(l.callback_at ?? l.next_action_at))}</span>`
    : `<span class="badge b-mute">${esc(fmtDT(l.next_action_at))}</span>`;

  return h(`
    <a class="leadcard" href="#/lead/${esc(l.lead_id)}">
      <div class="r1">
        <span class="name">${esc(l.full_name ?? 'Unnamed lead')}</span>
        <span class="phone mono">${esc(l.phone_e164)}</span>
        <span style="margin-left:auto">${when}</span>
      </div>
      <div class="r2">
        ${l.city ? `<span>${esc(l.city)}</span>` : ''}
        ${l.campaign_name ? `<span>${esc(l.campaign_name)}</span>` : ''}
        <span>attempts ${Number(l.attempt_count) || 0}${Number(l.na_streak) > 0 ? ` · NA streak ${Number(l.na_streak)}` : ''}</span>
        ${l.next_action_note ? `<span class="note">“${esc(l.next_action_note)}”</span>` : ''}
        ${l.callback_note && l.callback_note !== l.next_action_note
          ? `<span class="note">“${esc(l.callback_note)}”</span>` : ''}
      </div>
    </a>`);
}
