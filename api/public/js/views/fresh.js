import { get } from '../api.js';
import { agoLabel, esc, h } from '../util.js';
import { addLeadModal } from '../addlead.js';

/**
 * Fresh: every lead nobody has ever contacted.
 *
 * The one list that answers "did anything arrive and just sit there?" — and
 * it answers it for leads held with no caller too, which appear in nobody's
 * personal pipeline and were therefore the easiest thing on the floor to miss.
 *
 * A late fresh lead is never demoted or hidden. It stays here, flagged, until
 * somebody actually speaks to the person. That is the whole promise of the
 * tab: leads cannot be lost by being quietly re-categorised.
 *
 * Under the fresh list: "Enquired again" (0064) — people who filled a form
 * again and were attached to their existing lead instead of duplicated. This
 * tab is what the Google Sheet gets reconciled against, so a sheet row that
 * deliberately did not become a new lead has to be visible here too.
 */

const FLAGS = [
  ['', 'All'],
  ['breached', 'Badly late'],
  ['flagged', 'Late'],
  ['waiting', 'Still in time'],
];

const flagBadge = (l) => {
  if (l.flag === 'breached') {
    return `<span class="badge b-bad">badly late · ${esc(agoLabel(l.minutes_late))}</span>`;
  }
  if (l.flag === 'flagged') {
    return `<span class="badge b-warn">late · ${esc(agoLabel(l.minutes_late))}</span>`;
  }
  return `<span class="badge b-ok">in time${
    l.minutes_late !== null ? ` · ${esc(agoLabel(Math.abs(Number(l.minutes_late))))} left` : ''}</span>`;
};

export async function render(outlet, me) {
  let flag = '';
  const canSeeAll = ['counsellor', 'admin', 'ops', 'viewer'].includes(me.role);
  // Managers own no leads of their own, so "Mine" would open on an empty page
  // and read as "nothing is waiting" when the floor has hundreds.
  let scope = canSeeAll ? 'all' : 'mine';

  const draw = async () => {
    outlet.innerHTML = '<div class="spin"></div>';
    const params = new URLSearchParams({ scope });
    if (flag) params.set('flag', flag);
    const data = await get(`/me/fresh?${params}`);
    outlet.innerHTML = '';

    const all = data.leads;
    const reenquired = data.reenquired ?? [];
    const late = all.filter((l) => l.flag !== 'waiting').length;
    const badly = all.filter((l) => l.flag === 'breached').length;
    const noOwner = all.filter((l) => !l.user_id).length;
    const oldest = all.reduce((m, l) => Math.max(m, Number(l.age_minutes) || 0), 0);

    outlet.appendChild(h(`
      <div>
      <div class="grid cols-4" style="margin-bottom:16px">
        <div class="stat"><div class="k">Never contacted</div><div class="v">${all.length}</div>
          <div class="s">oldest waiting ${esc(agoLabel(oldest))}</div></div>
        <div class="stat ${late ? 'tone-bad' : 'tone-good'}"><div class="k">Past their deadline</div>
          <div class="v">${late}</div><div class="s">call these first</div></div>
        <div class="stat ${badly ? 'tone-bad' : ''}"><div class="k">Badly late</div>
          <div class="v">${badly}</div><div class="s">well past the window</div></div>
        <div class="stat ${noOwner ? 'tone-bad' : ''}"><div class="k">With no caller</div>
          <div class="v">${noOwner}</div>
          <div class="s">${noOwner ? 'held at team level — see Floor → Lead flow' : 'everything is owned'}</div></div>
      </div>

      <div class="panel">
        <div class="row spread wrap">
          <div>
            <h2 class="mt0">Fresh leads <small>${all.length}</small></h2>
            <div class="hint">
              Nobody has ever spoken to these. They stay on this list, flagged,
              until somebody actually does — a lead is never dropped off here for
              getting old.
            </div>
          </div>
          <div class="row" style="gap:8px">
            ${canSeeAll ? `
              <div class="chips" style="margin:0">
                <button class="chip ${scope === 'mine' ? 'on' : ''}" data-scope="mine">Mine</button>
                <button class="chip ${scope === 'all' ? 'on' : ''}" data-scope="all">Whole floor</button>
              </div>` : ''}
            ${['counsellor', 'admin', 'ops'].includes(me.role)
              ? `<button class="btn small" id="add-inbound">📞 Inbound call</button>
                 <button class="btn primary small" id="add-lead">Add lead</button>`
              : me.role === 'caller'
                ? '<button class="btn primary small" id="add-inbound">📞 Log inbound call</button>' : ''}
          </div>
        </div>
        <div class="chips" style="margin:10px 0 14px">
          ${FLAGS.map(([v, l]) => `<button class="chip ${flag === v ? 'on' : ''}" data-flag="${v}">${l}</button>`).join('')}
        </div>
        ${all.length === 0 ? `<div class="empty">
          ${scope === 'mine' && canSeeAll
            ? 'None of <b>your own</b> leads are waiting. Switch to <b>Whole floor</b> to see everyone’s.'
            : 'Nothing is waiting for a first call. This is the state to end every day in.'}
        </div>` : `
        <div style="overflow-x:auto">
        <table class="table"><thead><tr>
          <th>Lead</th><th>City</th><th>Source</th>
          <th class="num">Waiting</th><th>Status</th>
          ${scope === 'all' ? '<th>Owner</th>' : ''}
          <th></th>
        </tr></thead><tbody>
        ${all.map((l) => `
          <tr class="click ${l.flag !== 'waiting' ? 'radar-hot' : ''}" data-lead="${esc(l.lead_id)}">
            <td><b>${esc(l.full_name ?? 'Unnamed')}</b>
              ${l.priority === 'immediate' ? '<span class="badge b-bad">immediate</span>' : ''}
              <span class="hint mono">${esc(l.phone_e164)}</span></td>
            <td>${esc(l.city ?? '—')}</td>
            <td class="hint">${esc(l.source_name ?? l.campaign_name ?? '—')}</td>
            <td class="num">${esc(agoLabel(l.age_minutes))}</td>
            <td>${flagBadge(l)}</td>
            ${scope === 'all' ? `<td>${l.owner_name
              ? esc(l.owner_name)
              : '<span class="badge b-warn">no caller</span>'}</td>` : ''}
            <td class="num"><button class="btn small" data-open="${esc(l.lead_id)}">Call</button></td>
          </tr>`).join('')}
        </tbody></table></div>
        ${data.teams?.length > 1 ? `
          <div class="hint" style="margin-top:8px">
            By team: ${data.teams.map((t) => `<b>${esc(t.team_name)}</b> ${t.fresh}
              (${t.flagged + t.breached} late${t.unassigned ? `, ${t.unassigned} with no caller` : ''})`).join(' · ')}
          </div>` : ''}`}
      </div>

      ${reenquired.length === 0 ? '' : `
      <div class="panel">
        <h2 class="mt0">Enquired again <small>${reenquired.length}</small></h2>
        <div class="hint">
          These people filled a lead form again. They are already in the CRM —
          the new enquiry was attached to their existing lead (never a second
          lead for one phone number) and pushed to the top of its owner's list.
          A repeat enquiry usually means the person is still waiting, so treat
          it as a missed follow-up until proven otherwise.
        </div>
        <div style="overflow-x:auto;margin-top:12px">
        <table class="table"><thead><tr>
          <th>Lead</th><th>Enquired again</th><th>Via</th><th>Lead lives under</th>
          <th>Owner</th><th>Status</th><th></th>
        </tr></thead><tbody>
        ${reenquired.map((l) => `
          <tr class="click" data-lead="${esc(l.lead_id)}">
            <td><b>${esc(l.full_name ?? 'Unnamed')}</b>
              <span class="hint mono">${esc(l.phone_e164)}</span></td>
            <td>${esc(agoLabel(l.minutes_ago))} ago
              ${Number(l.reenquiry_count) > 1 ? `<span class="badge b-warn">×${Number(l.reenquiry_count)}</span>` : ''}</td>
            <td class="hint">${esc(l.reenquiry_source_name ?? '—')}</td>
            <td class="hint">${esc(l.source_name ?? '—')}</td>
            <td>${l.owner_name ? esc(l.owner_name) : '<span class="badge b-warn">no caller</span>'}</td>
            <td>${l.never_contacted
              ? '<span class="badge b-bad">never contacted</span>'
              : `<span class="badge">${esc(l.status)} · ${Number(l.attempt_count)} call${Number(l.attempt_count) === 1 ? '' : 's'}</span>`}</td>
            <td class="num"><button class="btn small" data-open="${esc(l.lead_id)}">Call</button></td>
          </tr>`).join('')}
        </tbody></table></div>
      </div>`}
      </div>`));

    outlet.querySelector('#add-lead')?.addEventListener('click', () => addLeadModal(me, () => draw()));
    outlet.querySelector('#add-inbound')?.addEventListener('click', () => addLeadModal(me, () => draw(), 'inbound'));
    outlet.querySelectorAll('[data-flag]').forEach((b) =>
      b.addEventListener('click', () => { flag = b.dataset.flag; draw(); }));
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
