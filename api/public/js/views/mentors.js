import { get, post, put } from '../api.js';
import { esc, fmtDate, fmtINR, h, openModal, toast } from '../util.js';
import { addClientModal } from './advisory.js';

/**
 * Mentors: every paying client, kept warm on purpose.
 *
 * The health chip is computed by the database from the rules in the training
 * module - nobody maintains a colour by hand. Logging a touchpoint is three
 * taps (channel, outcome, upsell); everything else is optional. Counsellors
 * see the same book because upsell-flagged clients are their warm pipeline.
 */

const CHANNELS = [
  ['call', 'Call'], ['whatsapp', 'WhatsApp'], ['email', 'Email'],
  ['in_person', 'In person'], ['video', 'Video'],
];
const OUTCOMES = [
  ['reached_positive', 'Reached — positive'],
  ['reached_neutral', 'Reached — neutral'],
  ['reached_concern', 'Reached — concern raised'],
  ['no_answer', 'No answer'],
  ['rescheduled', 'Rescheduled'],
];
const UPSELLS = [['none', 'None'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High']];

const label = (pairs, v) => (pairs.find(([k]) => k === v) ?? [null, v ?? '—'])[1];

const HEALTH_BADGE = { green: 'b-ok', amber: 'b-warn', red: 'b-bad' };
const healthChip = (hlt) =>
  `<span class="badge ${HEALTH_BADGE[hlt] ?? ''}">${esc(hlt ?? '—')}</span>`;

const upsellChip = (u) =>
  u ? `<span class="badge ${u === 'high' ? 'b-bad' : u === 'medium' ? 'b-warn' : 'b-info'}">↑ ${esc(u)}</span>` : '—';

const STATUS_TABS = [['active', 'Active'], ['expired', 'Expired'], ['refunded', 'Refunded'], ['', 'All']];

export async function render(outlet, me) {
  const f = { status: 'active', health: '', mentorId: '', untouchedDays: '', upsell: '', q: '', mineOnly: false };

  const draw = async () => {
    outlet.innerHTML = '<div class="spin"></div>';
    const params = new URLSearchParams();
    if (f.status) params.set('status', f.status);
    if (f.health) params.set('health', f.health);
    if (f.upsell) params.set('upsell', f.upsell);
    if (f.untouchedDays) params.set('untouchedDays', f.untouchedDays);
    if (f.q) params.set('q', f.q);
    if (f.mineOnly) params.set('mentorId', me.id);
    else if (f.mentorId === 'unassigned') params.set('unassigned', 'true');
    else if (f.mentorId) params.set('mentorId', f.mentorId);

    let book;
    try {
      book = await get(`/mentors/book?${params}`);
    } catch (err) {
      outlet.innerHTML = `<div class="panel"><div class="empty">${esc(err.message)}</div></div>`;
      return;
    }
    const { clients, mentors } = book;
    outlet.innerHTML = '';

    // The tiles answer the mentor's first question of the day: who needs me?
    const n = (hlt) => clients.filter((c) => c.health === hlt).length;
    const overdue = clients.filter(
      (c) => c.health !== 'green' || (c.next_touch_on && c.next_touch_on <= new Date().toISOString().slice(0, 10)),
    ).length;
    const upsellCount = clients.filter((c) => c.upsell_potential).length;
    const never = clients.filter((c) => c.touch_count === 0).length;

    outlet.appendChild(h(`
      <div class="grid cols-4" style="margin-bottom:16px">
        <div class="stat"><div class="k">Clients in view</div><div class="v">${clients.length}</div>
          <div class="s">${never} never touched</div></div>
        <div class="stat ${n('red') ? 'tone-bad' : ''}"><div class="k">Red</div><div class="v">${n('red')}</div>
          <div class="s">concern, gone quiet, or overdue</div></div>
        <div class="stat"><div class="k">Amber</div><div class="v">${n('amber')}</div>
          <div class="s">due for a touch soon</div></div>
        <div class="stat ${upsellCount ? 'tone-good' : ''}"><div class="k">Upsell pipeline</div><div class="v">${upsellCount}</div>
          <div class="s">${overdue} need attention now</div></div>
      </div>`));

    // Upsell pipeline, grouped by potential - the counsellor's warm list.
    const byPot = (p) => clients.filter((c) => c.upsell_potential === p);
    if (upsellCount) {
      outlet.appendChild(h(`
        <div class="panel" style="margin-bottom:16px">
          <div class="row spread">
            <h3 class="mt0">Warm pipeline <small>flagged by mentors, freshest first</small></h3>
            <div class="chips" style="margin:0">
              ${['high', 'medium', 'low'].map((p) =>
                `<button class="chip ${f.upsell === p ? 'on' : ''}" data-upsell="${p}">${label(UPSELLS, p)} · ${byPot(p).length}</button>`).join('')}
            </div>
          </div>
          ${f.upsell ? '' : `<div class="hint">Tap a group to filter the book to just those clients.</div>`}
        </div>`));
    }

    // Admin coverage: is anyone's book being neglected?
    if ((me.role === 'admin' || me.role === 'ops' || me.role === 'viewer') && mentors.length && !f.mineOnly) {
      const rows = [...mentors, { id: null, full_name: '— unassigned —' }].map((m) => {
        const mine = clients.filter((c) => (m.id ? c.mentor_id === m.id : !c.mentor_id));
        const red = mine.filter((c) => c.health === 'red').length;
        const stale = mine.filter((c) => Number(c.days_since_touch) >= 30).length;
        return { name: m.full_name, id: m.id, count: mine.length, red, stale };
      }).filter((r) => r.count);
      if (rows.length) {
        outlet.appendChild(h(`
          <div class="panel" style="margin-bottom:16px">
            <h3 class="mt0">Coverage <small>per mentor, in the current view</small></h3>
            <div class="chips" style="margin:0">
              ${rows.map((r) => `<button class="chip ${f.mentorId === (r.id ?? 'unassigned') ? 'on' : ''}"
                  data-mentor="${esc(r.id ?? 'unassigned')}">
                  ${esc(r.name)} · ${r.count}${r.red ? ` · <b style="color:var(--bad)">${r.red} red</b>` : ''}${r.stale ? ` · ${r.stale} silent 30d+` : ''}</button>`).join('')}
            </div>
          </div>`));
      }
    }

    const today = new Date().toISOString().slice(0, 10);
    outlet.appendChild(h(`
      <div class="panel">
        <div class="row spread wrap">
          <h2 class="mt0">Client book <small>${clients.length} paying ${clients.length === 1 ? 'client' : 'clients'}</small></h2>
          <div class="row" style="gap:8px">
            <div class="chips" style="margin:0">
              ${STATUS_TABS.map(([v, l]) => `<button class="chip ${v === f.status ? 'on' : ''}" data-status="${v}">${l}</button>`).join('')}
            </div>
            ${['admin', 'ops', 'counsellor'].includes(me.role)
              ? '<button class="btn primary" id="add-client">Add a client</button>' : ''}
          </div>
        </div>
        <div class="row wrap" style="gap:8px;margin:8px 0 14px">
          ${['', 'red', 'amber', 'green'].map((v) =>
            `<button class="chip ${f.health === v ? 'on' : ''}" data-health="${v}">${v ? v[0].toUpperCase() + v.slice(1) : 'All health'}</button>`).join('')}
          <button class="chip ${f.untouchedDays === '30' ? 'on' : ''}" data-stale="30">No touch 30d+</button>
          ${me.role === 'mentor' ? `<button class="chip ${f.mineOnly ? 'on' : ''}" data-mine="1">My clients</button>` : ''}
          <input name="q" placeholder="Search name or phone…" value="${esc(f.q)}"
                 style="margin-left:auto;min-width:220px">
        </div>
        ${clients.length === 0 ? '<div class="empty">Nobody matches this view. Money recorded on a deal puts the client here automatically.</div>' : `
        <div style="overflow-x:auto">
        <table class="table"><thead><tr>
          <th>Client</th><th>Program</th><th class="num">Paid</th><th>Mentor</th>
          <th>Last touch</th><th>Next follow-up</th><th>Health</th><th>Upsell</th>
        </tr></thead><tbody>
        ${clients.map((c) => `
          <tr data-deal="${esc(c.deal_id)}" style="cursor:pointer">
            <td><b>${esc(c.full_name ?? 'Unnamed')}</b>
                ${c.is_manual ? '<span class="badge b-mute" title="Entered by hand">manual</span>' : ''}
                <span class="hint mono">${esc(c.phone_e164)}</span></td>
            <td>${esc(c.product)}${c.client_status !== 'active' ? ` <span class="badge ${c.client_status === 'expired' ? 'b-warn' : 'b-bad'}">${esc(c.client_status)}</span>` : ''}
                ${Number(c.mitc_done_at !== null) + Number(c.kyc_done_at !== null) + Number(c.group_added_at !== null) < 3
                  ? '<span class="badge b-warn" title="Group, KYC or MITC still open — see Advisory clients">paperwork open</span>' : ''}</td>
            <td class="num">${fmtINR(c.paid_amount)}</td>
            <td>${esc(c.mentor_name ?? '—')}</td>
            <td>${c.last_touch_on
                ? `${esc(fmtDate(c.last_touch_on))} <span class="hint">${esc(label(OUTCOMES, c.last_outcome))}, ${esc(label(CHANNELS, c.last_channel))}</span>`
                : `<span class="hint">never — paid ${esc(fmtDate(c.first_paid_at))}</span>`}</td>
            <td>${c.next_touch_on
                ? (c.next_touch_on <= today ? `<b style="color:var(--bad)">${esc(fmtDate(c.next_touch_on))}</b>` : esc(fmtDate(c.next_touch_on)))
                : '—'}</td>
            <td>${healthChip(c.health)}</td>
            <td>${upsellChip(c.upsell_potential)}</td>
          </tr>`).join('')}
        </tbody></table></div>
        <div class="hint" style="margin-top:8px">
          Health is computed, never set by hand: <b>red</b> means a concern was raised, a follow-up is
          badly overdue, or the client has gone quiet; <b>amber</b> means a touch is due. The exact
          day-counts live in Settings and the rules in the training module. Tap a row to see the
          timeline and log a touchpoint.
        </div>`}
      </div>`));

    // --- wiring ---------------------------------------------------------
    outlet.querySelector('#add-client')?.addEventListener('click', () => addClientModal(draw));
    outlet.querySelectorAll('[data-status]').forEach((b) =>
      b.addEventListener('click', () => { f.status = b.dataset.status; draw(); }));
    outlet.querySelectorAll('[data-health]').forEach((b) =>
      b.addEventListener('click', () => { f.health = b.dataset.health; draw(); }));
    outlet.querySelectorAll('[data-upsell]').forEach((b) =>
      b.addEventListener('click', () => { f.upsell = f.upsell === b.dataset.upsell ? '' : b.dataset.upsell; draw(); }));
    outlet.querySelectorAll('[data-stale]').forEach((b) =>
      b.addEventListener('click', () => { f.untouchedDays = f.untouchedDays ? '' : b.dataset.stale; draw(); }));
    outlet.querySelectorAll('[data-mine]').forEach((b) =>
      b.addEventListener('click', () => { f.mineOnly = !f.mineOnly; f.mentorId = ''; draw(); }));
    outlet.querySelectorAll('[data-mentor]').forEach((b) =>
      b.addEventListener('click', () => {
        f.mentorId = f.mentorId === b.dataset.mentor ? '' : b.dataset.mentor;
        f.mineOnly = false;
        draw();
      }));
    const qInp = outlet.querySelector('input[name=q]');
    qInp?.addEventListener('change', () => { f.q = qInp.value.trim(); draw(); });
    qInp?.addEventListener('keydown', (e) => { if (e.key === 'Enter') { f.q = qInp.value.trim(); draw(); } });

    outlet.querySelectorAll('tr[data-deal]').forEach((tr) =>
      tr.addEventListener('click', () => clientModal(tr.dataset.deal, me, mentors, draw)));
  };

  await draw();
}

/** The client drawer: timeline on the record, touchpoint logging in 3 taps. */
async function clientModal(dealId, me, mentors, redraw) {
  let data;
  try {
    data = await get(`/mentors/${dealId}/timeline`);
  } catch (err) { toast(err.message, 'err'); return; }
  const { client: c, touchpoints } = data;
  const canLog = me.role === 'mentor' || me.role === 'admin' || me.role === 'ops';
  const today = new Date().toISOString().slice(0, 10);

  const sel = { channel: '', outcome: '', upsell: 'none' };

  const bodyEl = h(`
    <div>
      <div class="row spread wrap" style="margin-bottom:6px">
        <div>
          <div><b>${esc(c.full_name ?? 'Unnamed')}</b> <span class="hint mono">${esc(c.phone_e164)}</span></div>
          <div class="hint">${esc(c.product)} · paid ${fmtINR(c.paid_amount)} · counsellor ${esc(c.counsellor_name ?? '—')}
            ${c.subscription_ends_at ? `· ends ${esc(fmtDate(c.subscription_ends_at))}` : ''}</div>
        </div>
        <div>${healthChip(c.health)} ${upsellChip(c.upsell_potential)}</div>
      </div>
      ${me.role === 'admin' ? `
      <label class="f">Assigned mentor
        <select name="assign">
          <option value="">— unassigned —</option>
          ${mentors.map((m) => `<option value="${esc(m.id)}" ${m.id === c.mentor_id ? 'selected' : ''}>${esc(m.full_name)}</option>`).join('')}
        </select>
      </label>` : ''}
      ${canLog ? `
      <div style="border-top:1px solid var(--line);margin:10px 0;padding-top:10px">
        <b>Log a touchpoint</b> <span class="hint">three taps — the rest is optional</span>
        <div class="hint" style="margin-top:8px">1 · How did you reach out?</div>
        <div class="chips" data-pick="channel" style="margin:4px 0">
          ${CHANNELS.map(([v, l]) => `<button class="chip" data-v="${v}">${l}</button>`).join('')}
        </div>
        <div class="hint">2 · How did it go?</div>
        <div class="chips" data-pick="outcome" style="margin:4px 0">
          ${OUTCOMES.map(([v, l]) => `<button class="chip" data-v="${v}">${l}</button>`).join('')}
        </div>
        <div class="hint">3 · Upsell potential?</div>
        <div class="chips" data-pick="upsell" style="margin:4px 0">
          ${UPSELLS.map(([v, l]) => `<button class="chip ${v === 'none' ? 'on' : ''}" data-v="${v}">${l}</button>`).join('')}
        </div>
        <label class="f" data-upsell-note style="display:none">What to offer
          <input name="upsellNote" maxlength="500" placeholder="e.g. annual renewal, options course"></label>
        <label class="f">Note <input name="note" maxlength="2000" placeholder="optional"></label>
        <div class="frow">
          <label class="f">When <input type="date" name="touchedOn" value="${today}" max="${today}"></label>
          <label class="f">Next follow-up <input type="date" name="nextTouchOn" min="${today}"></label>
        </div>
      </div>` : ''}
      <div style="border-top:1px solid var(--line);margin:10px 0;padding-top:10px">
        <b>Timeline</b> <span class="hint">${touchpoints.length} touchpoint${touchpoints.length === 1 ? '' : 's'}</span>
        ${touchpoints.length === 0 ? '<div class="empty">No touchpoints yet — this client has never been contacted post-sale.</div>' : `
        <div style="max-height:240px;overflow-y:auto;margin-top:6px">
          ${touchpoints.map((t) => `
            <div style="padding:7px 0;border-bottom:1px solid var(--line)">
              <b>${esc(fmtDate(t.touched_on))}</b> · ${esc(label(CHANNELS, t.channel))} ·
              ${esc(label(OUTCOMES, t.outcome))}
              ${t.upsell !== 'none' ? upsellChip(t.upsell) : ''}
              <span class="hint">by ${esc(t.mentor_name ?? '—')}</span>
              ${t.note ? `<div class="hint">${esc(t.note)}</div>` : ''}
              ${t.upsell_note ? `<div class="hint">offer: ${esc(t.upsell_note)}</div>` : ''}
              ${t.next_touch_on ? `<div class="hint">next: ${esc(fmtDate(t.next_touch_on))}</div>` : ''}
            </div>`).join('')}
        </div>`}
      </div>
    </div>`);

  const footer = canLog ? h('<div><button class="btn primary">Save touchpoint</button></div>') : null;
  const { close } = openModal(c.full_name ?? 'Client', bodyEl, footer);

  bodyEl.querySelectorAll('[data-pick]').forEach((group) => {
    group.querySelectorAll('.chip').forEach((chip) =>
      chip.addEventListener('click', () => {
        sel[group.dataset.pick] = chip.dataset.v;
        group.querySelectorAll('.chip').forEach((x) => x.classList.toggle('on', x === chip));
        if (group.dataset.pick === 'upsell') {
          bodyEl.querySelector('[data-upsell-note]').style.display =
            chip.dataset.v === 'none' ? 'none' : '';
        }
      }));
  });

  bodyEl.querySelector('[name=assign]')?.addEventListener('change', async (e) => {
    try {
      await put(`/mentors/${dealId}/assign`, { mentorId: e.target.value || null });
      toast('Mentor assignment updated.');
      redraw();
    } catch (err) { toast(err.message, 'err'); }
  });

  footer?.querySelector('button').addEventListener('click', async () => {
    if (!sel.channel || !sel.outcome) {
      toast('Pick the channel and the outcome — that is the whole point of the log.', 'err');
      return;
    }
    const val = (name) => bodyEl.querySelector(`[name=${name}]`)?.value.trim() || undefined;
    try {
      await post(`/mentors/${dealId}/touchpoints`, {
        channel: sel.channel,
        outcome: sel.outcome,
        upsell: sel.upsell,
        note: val('note'),
        upsellNote: sel.upsell === 'none' ? undefined : val('upsellNote'),
        touchedOn: val('touchedOn'),
        nextTouchOn: val('nextTouchOn'),
      });
      toast('Touchpoint logged.');
      close();
      redraw();
    } catch (err) { toast(err.message, 'err'); }
  });
}
