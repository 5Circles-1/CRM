import { get, post } from '../api.js';
import { agoLabel, esc, h, toast } from '../util.js';

/**
 * Alerts, as a place to work rather than a popup to dismiss.
 *
 * The bell is a glance; a hundred items in a dropdown is a wall. This is the
 * list you sit down with: grouped by what is wrong, every row one tap from the
 * lead, and every row clearable by doing something real.
 *
 * Nothing here hides an alert. An overdue follow-up is a promise to a customer
 * that has passed its time — the only honest ways to clear it are to work the
 * lead or to move the promise, so "snooze" reschedules the next action on the
 * working clock and writes that decision into the lead's history.
 */

/**
 * Kinds as the database emits them, with names the floor actually uses.
 *
 * "SLA breached" was jargon — it named a policy, not the thing you should do.
 * Every label here says what is true about the person and implies the action:
 * somebody has never been called, or a promise has passed.
 */
const GROUPS = [
  ['sla_breach', 'Never called — overdue', 'Nobody has phoned this person yet and the promised time has passed. Call them.'],
  ['callback_due', 'Callbacks due now', 'They named this time themselves. The most expensive miss on the floor.'],
  ['callback_soon', 'Callbacks shortly', 'Coming up — be ready, do not start something long.'],
  ['action_overdue', 'Follow-ups overdue', 'You promised a next step and the time has passed.'],
  ['follow_up_due', 'Follow-ups due now', 'Due right now. Work them before they go overdue.'],
  ['custom_reminder', 'Your own reminders', 'Reminders you set for yourself on a lead.'],
  ['reassigned_in', 'Just landed with you', 'Moved to you — first contact still owed.'],
  ['cross_team_in', 'From the other team', 'Escalated across teams and now yours.'],
  ['new_lead', 'New leads', 'Fresh, never contacted.'],
  ['retap_due', 'Ready to re-tap', 'Gone quiet after repeated no-answers. Worked as a batch from the Re-tap tab.'],
  ['intake_stalled', 'Leads stopped arriving', 'The intake watchdog. It clears itself the moment leads flow again — an alarm here is a live problem, not history.'],
  ['intake_recovered', 'Intake recovered', 'The all-clear: leads are arriving again. The alarms above were resolved automatically.'],
  ['daily_brief_morning', 'Morning brief', 'Your numbers for the day ahead.'],
  ['daily_brief_midday', 'Pace check', 'Where you stand against what the month needs.'],
  ['daily_brief_evening', 'End of day', 'What closed, and what carries into tomorrow.'],
];

const SNOOZE = [
  ['1 hour', 60],
  ['3 hours', 180],
  ['Tomorrow morning', 'tomorrow'],
];

/** Working minutes from now until 09:30 tomorrow, so "tomorrow" means it. */
function minutesToTomorrowMorning() {
  const nowIst = new Date(Date.now() + (330 + new Date().getTimezoneOffset()) * 60000);
  const mins = nowIst.getHours() * 60 + nowIst.getMinutes();
  // The working clock skips the closed hours by itself; asking for the rest of
  // today plus a few minutes lands on the next working morning.
  return Math.max(30, 1110 - mins + 30);
}

export async function render(outlet, me) {
  let openGroup = null;
  let ownerFilter = '';
  // 'bell' = what actually rings: the client's callback, your own reminder,
  // a real emergency. 'work' = every open item the engines track, one
  // deliberate click away - never the default, never the badge.
  let scope = 'bell';

  const draw = async () => {
    outlet.innerHTML = '<div class="spin"></div>';
    const data = await get(`/me/alerts${scope === 'work' ? '?scope=work' : ''}`);
    outlet.innerHTML = '';

    // This list is RLS-scoped, not personal: a counsellor sees their team's
    // alerts and an admin the whole floor's. So show whose lead each one is,
    // and let a manager narrow to one person.
    const owners = [...new Map(
      data.alerts.filter((a) => a.owner_id)
        .map((a) => [a.owner_id, a.owner_name ?? 'Unnamed']),
    ).entries()].sort((a, b) => String(a[1]).localeCompare(String(b[1])));
    const showOwners = owners.length > 1;
    if (ownerFilter && !owners.some(([id]) => id === ownerFilter)) ownerFilter = '';
    if (ownerFilter) data.alerts = data.alerts.filter((a) => a.owner_id === ownerFilter);

    const byKind = new Map();
    for (const a of data.alerts) {
      if (!byKind.has(a.kind)) byKind.set(a.kind, []);
      byKind.get(a.kind).push(a);
    }
    // Any kind the list above does not name still gets a group of its own -
    // an alert nobody planned for must never become an invisible alert.
    const known = new Set(GROUPS.map(([k]) => k));
    const extra = [...byKind.keys()].filter((k) => !known.has(k)).map((k) => [k, k, '']);
    const groups = [...GROUPS, ...extra].filter(([k]) => byKind.has(k));

    if (openGroup === null && groups.length) openGroup = groups[0][0];

    outlet.appendChild(h(`
      <div class="panel" style="margin-bottom:16px">
        <div class="row spread wrap">
          <div>
            <h2 class="mt0">Alerts <small>${data.count} open${data.critical ? ` · ${data.critical} critical` : ''}</small></h2>
            <div class="hint">${scope === 'bell'
              ? 'Only what a person scheduled rings here — client callbacks, your own reminders, and real emergencies. Zero is the healthy state.'
              : 'Every open item the system tracks, grouped by what is wrong. This list never rings — it is here to be worked through.'}</div>
          </div>
          <div class="chips" style="margin:0">
            <button class="chip ${scope === 'bell' ? 'on' : ''}" data-scope="bell">Ringing now</button>
            <button class="chip ${scope === 'work' ? 'on' : ''}" data-scope="work">All waiting work</button>
          </div>
        </div>
        ${data.count === 0 ? '' : `
        <div class="chips" style="margin-top:10px">
          ${groups.map(([kind, label]) => `
            <button class="chip ${openGroup === kind ? 'on' : ''}" data-group="${esc(kind)}">
              ${esc(label)} · ${byKind.get(kind).length}
            </button>`).join('')}
        </div>
        ${showOwners ? `
          <div class="hint" style="margin-top:10px">Whose leads:</div>
          <div class="chips" style="margin-top:4px">
            <button class="chip ${ownerFilter === '' ? 'on' : ''}" data-owner="">Everyone</button>
            ${owners.map(([id, name]) => `
              <button class="chip ${ownerFilter === id ? 'on' : ''}" data-owner="${esc(id)}">${esc(name)}</button>`).join('')}
          </div>` : ''}`}
      </div>`));

    const wireScope = () => {
      outlet.querySelectorAll('[data-scope]').forEach((b) =>
        b.addEventListener('click', () => {
          if (scope === b.dataset.scope) return;
          scope = b.dataset.scope;
          openGroup = null;
          draw();
        }));
    };

    if (data.count === 0) {
      outlet.appendChild(h(`
        <div class="panel"><div class="empty">
          ${scope === 'bell'
            ? `Nothing is ringing — the bell is at zero, which is exactly right.
               Follow-up work lives in <a href="#/day">My Pipeline</a>, never-called
               leads in <a href="#/fresh">Fresh leads</a>, and the quiet ones in
               <a href="#/retap">Re-tap</a>.`
            : 'Nothing open anywhere. A clean floor.'}
        </div></div>`));
      wireScope();
      return;
    }

    const [kind, label, why] = groups.find(([k]) => k === openGroup) ?? groups[0];
    const rows = byKind.get(kind) ?? [];
    const leadRows = rows.filter((r) => r.lead_id);

    outlet.appendChild(h(`
      <div class="panel">
        <div class="row spread wrap">
          <div>
            <h3 class="mt0">${esc(label)} <small>${rows.length}</small></h3>
            <div class="hint">${esc(why)}</div>
          </div>
          ${leadRows.length > 1 ? `
            <button class="btn small" id="bulk">Reschedule all ${leadRows.length} to tomorrow</button>` : ''}
        </div>
        <div style="overflow-x:auto;margin-top:10px">
        <table class="table"><thead><tr>
          <th>Who</th>${showOwners ? '<th>Whose lead</th>' : ''}
          <th class="num">Late by</th><th style="width:280px">Do something</th>
        </tr></thead><tbody>
        ${rows.map((a) => `
          <tr>
            <td>
              ${a.lead_id
                ? `<a href="#/lead/${esc(a.lead_id)}"><b>${esc(a.lead_name ?? 'Lead')}</b></a>`
                : `<b>${esc(a.title ?? 'Notification')}</b>`}
              <span class="hint mono">${esc(a.phone_e164 ?? '')}</span>
              ${a.title && a.lead_id ? `<div class="hint">${esc(a.title)}</div>` : ''}
            </td>
            ${showOwners ? `<td>${a.owner_name
              ? esc(a.owner_name)
              : '<span class="badge b-warn">no caller</span>'}</td>` : ''}
            <td class="num">${Number(a.minutes_late) > 0
              ? `<span class="badge ${a.severity === 'critical' ? 'b-bad' : 'b-warn'}">${esc(agoLabel(a.minutes_late))}</span>`
              : '<span class="hint">due now</span>'}</td>
            <td>
              ${a.lead_id ? `
                <button class="btn small" data-open="${esc(a.lead_id)}">Open</button>
                ${SNOOZE.map(([lbl, mins]) => `
                  <button class="btn small" data-snooze="${esc(a.lead_id)}" data-mins="${mins}"
                          title="Move the next action, and record that you did">${lbl}</button>`).join('')}
              ` : `<button class="btn small" data-read="${esc(a.notification_id)}">${
                a.kind === 'intake_stalled' ? 'Problem resolved — clear it' : 'Mark read'}</button>`}
            </td>
          </tr>`).join('')}
        </tbody></table></div>
        <div class="hint" style="margin-top:8px">
          Rescheduling writes the new time into the lead's own history, so the next
          person to open it can see the promise was moved and by whom.
        </div>
      </div>`));

    wireScope();

    outlet.querySelectorAll('[data-group]').forEach((b) =>
      b.addEventListener('click', () => { openGroup = b.dataset.group; draw(); }));

    outlet.querySelectorAll('[data-owner]').forEach((b) =>
      b.addEventListener('click', () => { ownerFilter = b.dataset.owner; draw(); }));

    outlet.querySelectorAll('[data-open]').forEach((b) =>
      b.addEventListener('click', () => { location.hash = `#/lead/${b.dataset.open}`; }));

    outlet.querySelectorAll('[data-snooze]').forEach((b) =>
      b.addEventListener('click', async () => {
        b.disabled = true;
        const mins = b.dataset.mins === 'tomorrow' ? minutesToTomorrowMorning() : Number(b.dataset.mins);
        try {
          await post('/me/alerts/act', { leadId: b.dataset.snooze, action: 'snooze', minutes: mins });
          toast('Rescheduled — and recorded on the lead.');
          draw();
        } catch (err) { toast(err.message, 'err'); b.disabled = false; }
      }));

    outlet.querySelectorAll('[data-read]').forEach((b) =>
      b.addEventListener('click', async () => {
        try {
          await post('/me/alerts/act', { notificationId: b.dataset.read, action: 'read' });
          draw();
        } catch (err) { toast(err.message, 'err'); }
      }));

    outlet.querySelector('#bulk')?.addEventListener('click', async (ev) => {
      // Deliberately a confirm: moving a hundred customer promises at once is
      // a real decision, not a tidy-up.
      if (!window.confirm(
        `Move all ${leadRows.length} of these to tomorrow morning?\n\n`
        + 'Each one is a promise to a customer. Only do this if the whole group '
        + 'genuinely cannot be worked today — it is recorded on every lead.',
      )) return;
      ev.currentTarget.disabled = true;
      const mins = minutesToTomorrowMorning();
      let done = 0;
      for (const a of leadRows) {
        try {
          await post('/me/alerts/act', { leadId: a.lead_id, action: 'snooze', minutes: mins });
          done += 1;
        } catch { /* keep going: one failure must not strand the rest */ }
      }
      toast(`${done} rescheduled to tomorrow morning.`);
      draw();
    });
  };

  await draw();
}
