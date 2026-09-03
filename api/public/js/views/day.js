import { get } from '../api.js';
import { addLeadModal } from '../addlead.js';
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

// Order matters: fresh leads sit at the very top of the day, breached work in
// its own bucket near the bottom, and promised visits get a home of their own.
const BUCKETS = [
  { key: 'immediate', label: 'Call now', hot: true,
    blurb: 'Immediate leads still inside their first-touch window' },
  { key: 'fresh', label: 'Fresh — call first', hot: true,
    blurb: 'Never dialled — work these before anything else' },
  { key: 'callback', label: 'Callbacks today',
    blurb: 'Times the client asked for' },
  { key: 'will_visit', label: 'Visits promised',
    blurb: 'Said they would come in — confirm and chase the walk-in' },
  { key: 'followup_today', label: 'Follow-ups today',
    blurb: 'Already contacted, due again today' },
  { key: 'overdue', label: 'Overdue', hot: true,
    blurb: 'Past the time you promised — clear these next' },
  { key: 'breached', label: 'Breached',
    blurb: 'Long past due — its own tab; may move to the other team if left' },
  { key: 'callback_upcoming', label: 'Callbacks later',
    blurb: 'Booked for a future day' },
  { key: 'followup_upcoming', label: 'Follow-ups later',
    blurb: 'Agreed for a future day — nothing to do yet' },
];

export async function render(outlet, me) {
  let active = null; // null = everything, in priority order
  // Columns by default (owner ask): the funnel laid side by side, so the
  // not-answered and callback work is one glance, not a scroll. The list
  // stays one click away and the choice is remembered per browser.
  let view = 'board';
  try { view = localStorage.getItem('crm_day_view') || 'board'; } catch { /* private mode */ }

  const draw = async () => {
    const data = await get(`/me/pipeline${active ? `?bucket=${active}` : ''}`);
    const counts = data.counts ?? {};
    outlet.innerHTML = '';

    // The inbound-call door, on the screen the floor actually sits on all day.
    //
    // It has existed since 0055 and been a visible button since the Fresh
    // leads rework - but only there and on Find lead, and a caller lands on
    // My Pipeline and stays there. A button on a page nobody opens is the
    // same as no button, which is exactly what the floor kept reporting.
    // The client is on the phone NOW; the door has to be where the person
    // answering already is.
    outlet.appendChild(h(`
      <div class="row spread wrap" style="margin-bottom:10px">
        <div class="hint">
          The client rang us? Log it here — an inbound call is the warmest lead
          on the floor and its follow-up date rings when it is due.
        </div>
        <div class="row" style="gap:8px">
          <div class="chips" style="margin:0">
            <button class="chip ${view === 'board' ? 'on' : ''}" data-view="board" title="The funnel as side-by-side columns">Columns</button>
            <button class="chip ${view === 'list' ? 'on' : ''}" data-view="list" title="One list, top to bottom in priority order">List</button>
          </div>
          <button class="btn primary" data-testid="day-inbound" id="day-inbound">
            📞 Log inbound call
          </button>
        </div>
      </div>`));
    outlet.querySelector('#day-inbound').addEventListener('click', () =>
      addLeadModal(me, (lead) => {
        if (lead?.id) location.hash = `#/lead/${lead.id}`; else draw();
      }, 'inbound'));
    outlet.querySelectorAll('[data-view]').forEach((b) =>
      b.addEventListener('click', () => {
        view = b.dataset.view;
        try { localStorage.setItem('crm_day_view', view); } catch { /* private mode */ }
        draw();
      }));

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
    } else if (view === 'board' && !active) {
      await drawBoard(outlet, me, leads);
      return;
    } else {
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
    }

    // Extra lists that live beside the day, not inside its priority order:
    // the "moving soon" warning for everyone, and the re-tap pool the
    // counsellor works when they choose. Only shown while unfiltered.
    if (!active) await drawExtras(outlet, me);
  };

  await draw();
}

/**
 * The funnel as columns (owner ask, 3 Sep): every stage side by side, so a
 * caller or counsellor sees the whole shape of their day and can work the
 * not-answered and callback stacks without scrolling past everything else.
 *
 * The "Not answered" column is the reason this view exists: those leads live
 * scattered through the time buckets (a callback that went unanswered sits
 * under Callbacks), so they also stack here, together, ready to be re-tapped
 * — plus the quiet re-tap pool for those who can see it.
 */
async function drawBoard(outlet, me, leads) {
  const pool = ['counsellor', 'admin', 'ops'].includes(me?.role)
    ? await get('/me/retap-pool').catch(() => ({ leads: [] }))
    : { leads: [] };

  const notAnswered = leads.filter(
    (l) => Number(l.na_streak) >= 2 || l.last_disposition === 'not_answered',
  );

  const columns = BUCKETS
    .map((b) => ({ ...b, items: leads.filter((l) => l.bucket === b.key) }))
    .filter((c) => c.items.length > 0);
  columns.push({
    key: 'not_answered',
    label: '📵 Not answered — re-tap these',
    blurb: 'Also shown in their time column; stacked here so re-tapping is one pass.',
    hot: notAnswered.length > 0,
    items: notAnswered,
    extra: pool.leads ?? [],
  });

  const board = h(`<div data-testid="day-board" style="display:grid;grid-auto-flow:column;
    grid-auto-columns:minmax(250px,300px);gap:12px;align-items:start;overflow-x:auto;
    padding-bottom:8px"></div>`);

  for (const c of columns) {
    const total = c.items.length + (c.extra?.length ?? 0);
    const col = h(`
      <div class="panel" style="margin:0;padding:10px" data-testid="board-${esc(c.key)}">
        <div style="font-weight:700;margin-bottom:2px">${esc(c.label)}
          <span class="count">· ${total}</span></div>
        <div class="hint" style="margin-bottom:8px">${esc(c.blurb ?? '')}</div>
      </div>`);
    if (total === 0) {
      col.appendChild(h('<div class="empty">Nothing here — clear.</div>'));
    }
    for (const l of c.items) col.appendChild(card(l));
    for (const l of c.extra ?? []) {
      col.appendChild(h(`
        <a class="leadcard" href="#/lead/${esc(l.lead_id)}">
          <div class="r1">
            <span class="name">${esc(l.full_name ?? 'Unnamed lead')}</span>
            <span class="phone mono">${esc(l.phone_e164)}</span>
            <span style="margin-left:auto"><span class="badge b-mute">quiet · ${Number(l.attempt_count)} tries</span></span>
          </div>
          <div class="r2">
            <span>last: ${l.last_disposition ? esc(String(l.last_disposition).replace(/_/g, ' ')) : '—'}</span>
          </div>
        </a>`));
    }
    board.appendChild(col);
  }
  outlet.appendChild(board);
}

/**
 * The lists that sit beside the day: leads about to move to the other team
 * (a warning, so they get worked first), and the re-tap pool of leads nobody
 * could reach (worked when there is a gap, never nagging).
 */
async function drawExtras(outlet, me) {
  const [watch, pool] = await Promise.all([
    get('/me/cross-team-watch').catch(() => ({ leads: [] })),
    ['counsellor', 'admin', 'ops'].includes(me?.role)
      ? get('/me/retap-pool').catch(() => ({ leads: [] }))
      : Promise.resolve({ leads: [] }),
  ]);

  if (watch.leads.length > 0) {
    outlet.appendChild(h(`
      <div class="section-h">Moving to the other team soon <span class="count">· ${watch.leads.length}</span>
        <span class="hint" style="font-weight:400"> — work these before they transfer away</span></div>`));
    const wrap = h('<div data-testid="cross-team-watch"></div>');
    for (const l of watch.leads) {
      wrap.appendChild(h(`
        <a class="leadcard" href="#/lead/${esc(l.lead_id)}">
          <div class="r1">
            <span class="name">${esc(l.full_name ?? 'Unnamed lead')}</span>
            <span class="phone mono">${esc(l.phone_e164)}</span>
            <span style="margin-left:auto"><span class="badge b-warn">moves ${esc(fmtDT(l.moves_at))}</span></span>
          </div>
          <div class="r2"><span>idle since ${esc(fmtDT(l.idle_since))}</span></div>
        </a>`));
    }
    outlet.appendChild(wrap);
  }

  if (pool.leads.length > 0) {
    outlet.appendChild(h(`
      <div class="section-h">Re-tap pool <span class="count">· ${pool.leads.length}</span>
        <span class="hint" style="font-weight:400"> — nobody could reach these; tap when you have a gap</span></div>`));
    const wrap = h('<div data-testid="retap-pool"></div>');
    for (const l of pool.leads) {
      wrap.appendChild(h(`
        <a class="leadcard" href="#/lead/${esc(l.lead_id)}">
          <div class="r1">
            <span class="name">${esc(l.full_name ?? 'Unnamed lead')}</span>
            <span class="phone mono">${esc(l.phone_e164)}</span>
            <span style="margin-left:auto"><span class="badge b-mute">${Number(l.attempt_count)} attempts</span></span>
          </div>
          <div class="r2">
            <span>last: ${l.last_disposition ? esc(String(l.last_disposition).replace(/_/g, ' ')) : '—'}</span>
            <span>in pool since ${esc(fmtDT(l.retap_since))}</span>
          </div>
        </a>`));
    }
    outlet.appendChild(wrap);
  }
}

function card(l) {
  const when =
    l.bucket === 'overdue' ? `<span class="badge b-bad">overdue ${agoLabel(l.minutes_overdue)}</span>`
    : l.bucket === 'breached' ? `<span class="badge b-bad">breached ${agoLabel(l.minutes_overdue)}</span>`
    : l.bucket === 'immediate' ? '<span class="badge b-bad">CALL NOW</span>'
    : l.bucket === 'fresh' ? '<span class="badge b-warn">FRESH</span>'
    : l.bucket === 'will_visit'
      ? `<span class="badge b-ok" title="Visit expected">🚶 ${esc(fmtDT(l.walkin_expected_at ?? l.next_action_at))}</span>`
    : l.bucket === 'callback' || l.bucket === 'callback_upcoming'
      ? `<span class="badge b-info">${esc(fmtDT(l.callback_at ?? l.next_action_at))}</span>`
    : `<span class="badge b-mute">${esc(fmtDT(l.next_action_at))}</span>`;

  return h(`
    <a class="leadcard" href="#/lead/${esc(l.lead_id)}">
      <div class="r1">
        <span class="name">${esc(l.full_name ?? 'Unnamed lead')}</span>
        <span class="phone mono">${esc(l.phone_e164)}</span>
        ${l.whatsapp_sent_at ? '<span class="badge b-ok" title="WhatsApp sent">WA</span>' : ''}
        ${Number(l.na_streak) >= 2
          ? `<span class="badge b-bad" title="Not answered ${Number(l.na_streak)} times in a row">📵 Not answered ×${Number(l.na_streak)}</span>`
          : ''}
        <span style="margin-left:auto">${when}</span>
      </div>
      <div class="r2">
        ${l.city ? `<span>${esc(l.city)}</span>` : ''}
        ${l.campaign_name ? `<span>${esc(l.campaign_name)}</span>` : ''}
        <span>${l.last_disposition
          ? `last: ${esc(String(l.last_disposition).replace(/_/g, ' '))}`
          : 'never contacted'}</span>
        <span>attempts ${Number(l.attempt_count) || 0}</span>
        ${l.next_action_note ? `<span class="note">“${esc(l.next_action_note)}”</span>` : ''}
        ${l.callback_note && l.callback_note !== l.next_action_note
          ? `<span class="note">“${esc(l.callback_note)}”</span>` : ''}
      </div>
    </a>`);
}
