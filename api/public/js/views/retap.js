import { get, post } from '../api.js';
import { esc, fmtDT, h, toast } from '../util.js';

/**
 * The Re-tap tab: leads that stopped answering, worked as a batch.
 *
 * A lead that has gone unanswered past the quiet threshold no longer raises
 * alerts. That is deliberate — left in the bell they crowd out the callbacks
 * that genuinely matter, and a bell nobody trusts is worse than no bell. They
 * are not lost: they keep their next action, still appear in Find lead and My
 * Pipeline, still count in every leakage figure. They just stop interrupting,
 * and live here until somebody sits down with the list.
 *
 * Sorted by longest silence first, because that is the order worth calling in.
 */

const DISPO = {
  not_answered: 'No answer',
  switched_off: 'Switched off',
  busy: 'Busy',
  incoming_unavailable: 'Incoming unavailable',
  disconnected_after_intro: 'Cut off after intro',
  wrong_number: 'Wrong number',
  callback_requested: 'Asked for a callback',
  will_call_back: 'Said they would call',
};

const BANDS = [
  ['all', 'All'],
  ['week', 'Silent 7 days+'],
  ['fortnight', 'Silent 14 days+'],
  ['nowhatsapp', 'No WhatsApp sent'],
];

export async function render(outlet, me) {
  let band = 'all';
  let scope = 'mine';
  const canSeeTeam = ['counsellor', 'admin', 'ops'].includes(me.role);

  const draw = async () => {
    outlet.innerHTML = '<div class="spin"></div>';
    const data = await get(`/me/no-answer-pool?scope=${scope}`);
    outlet.innerHTML = '';

    const match = (l) => {
      if (band === 'week') return Number(l.days_since_touch) >= 7;
      if (band === 'fortnight') return Number(l.days_since_touch) >= 14;
      if (band === 'nowhatsapp') return !l.whatsapp_sent_at;
      return true;
    };
    const rows = data.leads.filter(match);
    const silent7 = data.leads.filter((l) => Number(l.days_since_touch) >= 7).length;
    const noWa = data.leads.filter((l) => !l.whatsapp_sent_at).length;

    outlet.appendChild(h(`
      <div>
      <div class="grid cols-4" style="margin-bottom:16px">
        <div class="stat"><div class="k">Waiting to re-tap</div><div class="v">${data.leads.length}</div>
          <div class="s">unanswered more than ${data.threshold} times</div></div>
        <div class="stat"><div class="k">Silent a week or more</div><div class="v">${silent7}</div>
          <div class="s">call these first</div></div>
        <div class="stat"><div class="k">Never messaged</div><div class="v">${noWa}</div>
          <div class="s">a WhatsApp often restarts these</div></div>
        <div class="stat tone-good"><div class="k">Alerts they raise</div><div class="v">0</div>
          <div class="s">by design — that is why they are here</div></div>
      </div>

      <div class="panel">
        <div class="row spread wrap">
          <div>
            <h2 class="mt0">Re-tap <small>${rows.length} shown</small></h2>
            <div class="hint">
              These went unanswered more than ${data.threshold} times, so they stopped
              interrupting you. Nothing is lost — they keep their next action and still
              appear everywhere else. You get one reminder every few days, not one per lead.
            </div>
          </div>
          <div class="row" style="gap:8px">
            ${canSeeTeam ? `
              <div class="chips" style="margin:0">
                <button class="chip ${scope === 'mine' ? 'on' : ''}" data-scope="mine">Mine</button>
                <button class="chip ${scope === 'team' ? 'on' : ''}" data-scope="team">Whole team</button>
              </div>` : ''}
          </div>
        </div>
        <div class="chips" style="margin:10px 0 14px">
          ${BANDS.map(([v, l]) => `<button class="chip ${band === v ? 'on' : ''}" data-band="${v}">${l}</button>`).join('')}
        </div>
        ${rows.length === 0 ? `<div class="empty">
          ${data.leads.length === 0
            ? 'Nothing here — nobody has gone repeatedly unanswered. This is the good state.'
            : 'Nothing matches that filter.'}
        </div>` : `
        <div style="overflow-x:auto">
        <table class="table"><thead><tr>
          <th>Lead</th><th>City</th><th class="num">No-answers</th>
          <th class="num">Silent for</th><th>Last outcome</th><th>WhatsApp</th>
          ${scope === 'team' ? '<th>Owner</th>' : ''}
          <th></th>
        </tr></thead><tbody>
        ${rows.map((l) => `
          <tr class="click" data-lead="${esc(l.lead_id)}">
            <td><b>${esc(l.full_name ?? 'Unnamed')}</b>
                <span class="hint mono">${esc(l.phone_e164)}</span></td>
            <td>${esc(l.city ?? '—')}</td>
            <td class="num">${Number(l.na_streak)}</td>
            <td class="num">${Number(l.days_since_touch) >= 14
              ? `<span class="badge b-bad">${Number(l.days_since_touch)}d</span>`
              : Number(l.days_since_touch) >= 7
                ? `<span class="badge b-warn">${Number(l.days_since_touch)}d</span>`
                : `${Number(l.days_since_touch)}d`}</td>
            <td>${esc(DISPO[l.last_disposition] ?? l.last_disposition ?? '—')}</td>
            <td>${l.whatsapp_sent_at
              ? `<span class="hint">${esc(fmtDT(l.whatsapp_sent_at))}</span>`
              : '<span class="badge b-mute">not sent</span>'}</td>
            ${scope === 'team' ? `<td class="hint">${esc(l.team_name ?? '—')}</td>` : ''}
            <td class="num"><button class="btn small" data-open="${esc(l.lead_id)}">Call</button></td>
          </tr>`).join('')}
        </tbody></table></div>
        <div class="hint" style="margin-top:8px">
          Work top down: longest silence first. If a lead genuinely will never answer,
          close it with the honest outcome rather than leaving it here forever.
        </div>`}
      </div>
      </div>`));

    outlet.querySelectorAll('[data-band]').forEach((b) =>
      b.addEventListener('click', () => { band = b.dataset.band; draw(); }));
    outlet.querySelectorAll('[data-scope]').forEach((b) =>
      b.addEventListener('click', () => { scope = b.dataset.scope; draw(); }));
    outlet.querySelectorAll('[data-lead], [data-open]').forEach((el) =>
      el.addEventListener('click', (ev) => {
        ev.stopPropagation();
        location.hash = `#/lead/${el.dataset.lead ?? el.dataset.open}`;
      }));
  };

  await draw();
}
