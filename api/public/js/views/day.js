import { get } from '../api.js';
import { agoLabel, esc, fmtDT, h } from '../util.js';

/**
 * Requirements 4 and 5: the caller's pipeline, ordered so it can be worked top
 * to bottom without a single prioritisation decision.
 *
 * The tabs are the fix for "everything is in one list". They are also the fix
 * for a subtler problem: this screen used to stop at midnight tonight, so a
 * follow-up agreed for Thursday was on no screen at all between Monday night
 * and Thursday morning. Upcoming work now has a home.
 */

const BUCKETS = [
  { key: 'immediate', label: 'Call now', hot: true,
    blurb: 'Immediate leads still inside their first-touch window' },
  { key: 'overdue', label: 'Overdue', hot: true,
    blurb: 'Past the time you promised — clear these first' },
  { key: 'callback', label: 'Callbacks today',
    blurb: 'Times the client asked for' },
  { key: 'fresh', label: 'Fresh',
    blurb: 'Never dialled' },
  { key: 'followup_today', label: 'Follow-ups today',
    blurb: 'Already contacted, due again today' },
  { key: 'callback_upcoming', label: 'Callbacks later',
    blurb: 'Booked for a future day' },
  { key: 'followup_upcoming', label: 'Follow-ups later',
    blurb: 'Agreed for a future day — nothing to do yet' },
];

export async function render(outlet) {
  let active = null; // null = everything, in priority order

  const draw = async () => {
    const data = await get(`/me/pipeline${active ? `?bucket=${active}` : ''}`);
    const counts = data.counts ?? {};
    outlet.innerHTML = '';

    // Tabs, each with its own count. Clicking one filters; clicking it again
    // goes back to everything - a filter you cannot leave is a trap.
    const tabs = h(`
      <div class="chips" data-testid="day-chips">
        <button class="chip ${active === null ? 'on' : ''}" data-bucket="">
          Everything <b>${Number(data.total ?? 0)}</b></button>
        ${BUCKETS.map((b) => {
          const n = Number(counts[b.key] ?? 0);
          if (n === 0 && active !== b.key) return '';
          return `<button class="chip ${b.hot && n > 0 ? 'hot' : ''} ${active === b.key ? 'on' : ''}"
                    data-bucket="${esc(b.key)}" title="${esc(b.blurb)}">
                    ${esc(b.label)} <b>${n}</b></button>`;
        }).join('')}
      </div>`);
    outlet.appendChild(tabs);

    tabs.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-bucket]');
      if (!btn) return;
      const key = btn.dataset.bucket || null;
      active = active === key ? null : key;
      draw();
    });

    const leads = data.leads ?? [];

    // The one thing worth interrupting the layout for.
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
      outlet.appendChild(h(`<div class="panel"><div class="empty">${
        active
          ? 'Nothing in this list right now.'
          : 'Queue clear — nothing open. New leads land here automatically.'
      }</div></div>`));
      return;
    }

    // Grouped even when unfiltered, so "one bulk list" never happens again.
    for (const b of BUCKETS) {
      const group = leads.filter((l) => l.bucket === b.key);
      if (group.length === 0) continue;
      outlet.appendChild(h(`
        <div class="section-h">${esc(b.label)} <span class="count">· ${group.length}</span>
          ${b.blurb ? `<span class="hint" style="font-weight:400"> — ${esc(b.blurb)}</span>` : ''}
        </div>`));
      const wrap = h(`<div data-testid="bucket-${esc(b.key)}"></div>`);
      for (const l of group) wrap.appendChild(card(l));
      outlet.appendChild(wrap);
    }
  };

  await draw();
}

function card(l) {
  const when =
    l.bucket === 'overdue' ? `<span class="badge b-bad">overdue ${agoLabel(l.minutes_overdue)}</span>`
    : l.bucket === 'immediate' ? '<span class="badge b-bad">CALL NOW</span>'
    : l.bucket === 'callback' || l.bucket === 'callback_upcoming'
      ? `<span class="badge b-info">${esc(fmtDT(l.callback_at ?? l.next_action_at))}</span>`
    : `<span class="badge b-mute">${esc(fmtDT(l.next_action_at))}</span>`;

  return h(`
    <a class="leadcard" href="#/lead/${esc(l.lead_id)}">
      <div class="r1">
        <span class="name">${esc(l.full_name ?? 'Unnamed lead')}</span>
        <span class="phone mono">${esc(l.phone_e164)}</span>
        ${l.whatsapp_sent_at ? '<span class="badge b-ok" title="WhatsApp sent">WA</span>' : ''}
        <span style="margin-left:auto">${when}</span>
      </div>
      <div class="r2">
        ${l.city ? `<span>${esc(l.city)}</span>` : ''}
        ${l.campaign_name ? `<span>${esc(l.campaign_name)}</span>` : ''}
        <span>${l.last_disposition
          ? `last: ${esc(String(l.last_disposition).replace(/_/g, ' '))}`
          : 'never contacted'}</span>
        <span>attempts ${Number(l.attempt_count) || 0}${Number(l.na_streak) > 0 ? ` · NA streak ${Number(l.na_streak)}` : ''}</span>
        ${l.next_action_note ? `<span class="note">“${esc(l.next_action_note)}”</span>` : ''}
        ${l.callback_note && l.callback_note !== l.next_action_note
          ? `<span class="note">“${esc(l.callback_note)}”</span>` : ''}
      </div>
    </a>`);
}
