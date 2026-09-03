import { get } from '../api.js';
import { agoLabel, esc, h } from '../util.js';
import { addLeadModal } from '../addlead.js';

/**
 * Fresh: every enquiry waiting on a call.
 *
 * Two kinds of row share one list, because the floor works one list:
 *
 *  - Leads nobody has ever contacted. They stay here, flagged, until
 *    somebody actually speaks to the person — never dropped for getting old.
 *  - Leads whose person ENQUIRED AGAIN (0064/0065). The enquiry was attached
 *    to their existing lead — one live lead per phone, never a duplicate for
 *    two callers to fight over — but the owner's rule is that every enquiry
 *    lands on this tab: the earlier call may have hit a spam-flagged number
 *    and never been picked up. The row wears an "enquired again" badge and
 *    leaves the list only when somebody dials the person after they asked.
 *
 * This is also the screen the Google Sheet gets reconciled against: every
 * sheet row is here, either as a fresh lead or as a badged re-enquiry.
 */

const FLAGS = [
  ['', 'All'],
  ['breached', 'Badly late'],
  ['flagged', 'Late'],
  ['waiting', 'Still in time'],
];

const FLAG_RANK = { breached: 0, flagged: 1, waiting: 2 };

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

    // One worklist: never-contacted leads and re-enquiries, most urgent
    // first — the same order the fresh list has always used.
    const lateness = (l) => (l.minutes_late == null ? -1e15 : Number(l.minutes_late));
    const rows = [
      ...data.leads,
      ...(data.reenquired ?? []).map((l) => ({ ...l, reenquired: true })),
    ].sort((a, b) =>
      (FLAG_RANK[a.flag] ?? 2) - (FLAG_RANK[b.flag] ?? 2)
      || lateness(b) - lateness(a)
      || (Number(b.age_minutes) || 0) - (Number(a.age_minutes) || 0));

    const again = rows.filter((l) => l.reenquired).length;
    const late = rows.filter((l) => l.flag !== 'waiting').length;
    const badly = rows.filter((l) => l.flag === 'breached').length;
    const noOwner = rows.filter((l) => !l.user_id).length;
    const oldest = rows.reduce((m, l) => Math.max(m, Number(l.age_minutes) || 0), 0);

    outlet.appendChild(h(`
      <div>
      <div class="grid cols-4" style="margin-bottom:16px">
        <div class="stat"><div class="k">Waiting for a call</div><div class="v">${rows.length}</div>
          <div class="s">${rows.length - again} never contacted · ${again} enquired again · oldest ${esc(agoLabel(oldest))}</div></div>
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
            <h2 class="mt0">Fresh leads <small>${rows.length}</small></h2>
            <div class="hint">
              Every enquiry waiting on a call — leads nobody has ever spoken
              to, and people who <b>enquired again</b> and haven't been dialled
              since. Rows stay here, flagged, until somebody actually calls —
              a lead is never dropped off here for getting old.
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
        ${rows.length === 0 ? `<div class="empty">
          ${scope === 'mine' && canSeeAll
            ? 'None of <b>your own</b> leads are waiting. Switch to <b>Whole floor</b> to see everyone’s.'
            : 'Nothing is waiting for a call. This is the state to end every day in.'}
        </div>` : `
        <div style="overflow-x:auto">
        <table class="table"><thead><tr>
          <th>Lead</th><th>City</th><th>Source</th>
          <th class="num">Waiting</th><th>Status</th>
          ${scope === 'all' ? '<th>Owner</th>' : ''}
          <th></th>
        </tr></thead><tbody>
        ${rows.map((l) => `
          <tr class="click ${l.flag !== 'waiting' ? 'radar-hot' : ''}" data-lead="${esc(l.lead_id)}">
            <td><b>${esc(l.full_name ?? 'Unnamed')}</b>
              ${l.priority === 'immediate' ? '<span class="badge b-bad">immediate</span>' : ''}
              ${l.reenquired ? `<span class="badge b-warn">enquired again${
                Number(l.reenquiry_count) > 1 ? ` ×${Number(l.reenquiry_count)}` : ''}</span>` : ''}
              <span class="hint mono">${esc(l.phone_e164)}</span></td>
            <td>${esc(l.city ?? '—')}</td>
            <td class="hint">${esc((l.reenquired ? l.reenquiry_source_name : null) ?? l.source_name ?? l.campaign_name ?? '—')}</td>
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
