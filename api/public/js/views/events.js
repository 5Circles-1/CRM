import { get, post, put } from '../api.js';
import { esc, fmtDate, fmtINR, h, openModal, toast } from '../util.js';

/**
 * Events: seminars, webinars and office days, with the roster of who was
 * invited and who actually came.
 *
 * Importing leads copies them onto the roster — the original lead's owner,
 * stage and history are never touched. That is why both teams can work the
 * same roster without the lead-book fence hiding half of it.
 */

const KINDS = [['in_office', 'In office'], ['online', 'Online'], ['external', 'External venue']];
const STATUSES = [
  ['draft', 'Draft'], ['published', 'Published'], ['live', 'Live'],
  ['completed', 'Completed'], ['cancelled', 'Cancelled'],
];
const ATTENDEE = [
  ['invited', 'Invited'], ['confirmed', 'Confirmed'], ['attended', 'Attended'],
  ['no_show', 'No-show'], ['converted', 'Converted'],
];
const LEAD_STATUSES = ['new', 'working', 'callback', 'qualified', 'nurture', 'won', 'lost'];

const label = (pairs, v) => (pairs.find(([k]) => k === v) ?? [null, v ?? '—'])[1];

const STATUS_BADGE = {
  draft: '', published: 'b-info', live: 'b-ok', completed: 'b-info', cancelled: 'b-bad',
};
const ATT_BADGE = {
  invited: '', confirmed: 'b-info', attended: 'b-ok', no_show: 'b-bad', converted: 'b-ok',
};

const dtLocal = (ts) => {
  if (!ts) return '';
  // datetime-local wants the wall clock in Asia/Kolkata, not UTC.
  const d = new Date(new Date(ts).getTime() + (330 + new Date().getTimezoneOffset()) * 60000);
  return d.toISOString().slice(0, 16);
};
const fromLocal = (v) => (v ? new Date(`${v}:00+05:30`).toISOString() : null);

const fmtWhen = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata', weekday: 'short', day: 'numeric', month: 'short',
  hour: '2-digit', minute: '2-digit', hour12: false,
});

export async function render(outlet, me) {
  let statusFilter = '';
  let view = 'list';
  const canEdit = ['admin', 'ops', 'counsellor'].includes(me.role);

  const draw = async () => {
    outlet.innerHTML = '<div class="spin"></div>';
    const [events, followups] = await Promise.all([
      get(`/events${statusFilter ? `?status=${statusFilter}` : ''}`),
      get('/events/followups/open').catch(() => []),
    ]);
    outlet.innerHTML = '';

    const upcoming = events.filter((e) => new Date(e.starts_at) >= new Date());
    const invited = events.reduce((s, e) => s + Number(e.invited || 0), 0);
    const attended = events.reduce((s, e) => s + Number(e.attended || 0), 0);
    const revenue = events.reduce((s, e) => s + Number(e.revenue_attributed || 0), 0);

    outlet.appendChild(h(`
      <div class="grid cols-4" style="margin-bottom:16px">
        <div class="stat"><div class="k">Events</div><div class="v">${events.length}</div>
          <div class="s">${upcoming.length} still to come</div></div>
        <div class="stat"><div class="k">Invited</div><div class="v">${invited}</div>
          <div class="s">across every roster</div></div>
        <div class="stat"><div class="k">Attended</div><div class="v">${attended}</div>
          <div class="s">${invited ? Math.round((attended / invited) * 100) : 0}% turnout</div></div>
        <div class="stat ${revenue ? 'tone-good' : ''}"><div class="k">Revenue attributed</div>
          <div class="v">${fmtINR(revenue)}</div>
          <div class="s">collected after the event</div></div>
      </div>`));

    if (followups.length) {
      outlet.appendChild(h(`
        <div class="panel" style="margin-bottom:16px">
          <h3 class="mt0">Post-event follow-ups <small>${followups.length} still unworked</small></h3>
          <div style="max-height:220px;overflow-y:auto">
          <table class="table"><thead><tr>
            <th>Who</th><th>Event</th><th>Outcome</th><th>Owner</th><th></th>
          </tr></thead><tbody>
          ${followups.slice(0, 50).map((f) => `
            <tr>
              <td><b>${esc(f.full_name ?? 'Unnamed')}</b> <span class="hint mono">${esc(f.phone_e164 ?? '')}</span></td>
              <td>${esc(f.event_name)}</td>
              <td><span class="badge ${ATT_BADGE[f.status] ?? ''}">${esc(label(ATTENDEE, f.status))}</span></td>
              <td>${esc(f.owner_name ?? '—')}</td>
              <td class="num"><button class="btn small" data-done="${esc(f.roster_id)}"
                    data-event="${esc(f.event_id)}">Mark done</button></td>
            </tr>`).join('')}
          </tbody></table></div>
        </div>`));
    }

    outlet.appendChild(h(`
      <div class="panel">
        <div class="row spread wrap">
          <h2 class="mt0">Events <small>${events.length}</small></h2>
          <div class="row" style="gap:8px">
            <div class="chips" style="margin:0">
              <button class="chip ${view === 'list' ? 'on' : ''}" data-view="list">List</button>
              <button class="chip ${view === 'calendar' ? 'on' : ''}" data-view="calendar">Calendar</button>
            </div>
            ${canEdit ? '<button class="btn primary" id="new-event">New event</button>' : ''}
          </div>
        </div>
        <div class="chips" style="margin:8px 0 14px">
          <button class="chip ${statusFilter === '' ? 'on' : ''}" data-status="">All</button>
          ${STATUSES.map(([v, l]) => `<button class="chip ${statusFilter === v ? 'on' : ''}" data-status="${v}">${l}</button>`).join('')}
        </div>
        <div id="event-body"></div>
      </div>`));

    const body = outlet.querySelector('#event-body');
    if (events.length === 0) {
      body.innerHTML = '<div class="empty">No events yet. Create one, then pull leads onto its roster with a filter.</div>';
    } else if (view === 'calendar') {
      body.appendChild(calendarEl(events));
    } else {
      body.appendChild(h(`
        <div style="overflow-x:auto">
        <table class="table"><thead><tr>
          <th>Event</th><th>When</th><th>Where</th><th>Host</th>
          <th class="num">Invited</th><th class="num">Attended</th><th class="num">Converted</th>
          <th class="num">Revenue</th><th>Status</th>
        </tr></thead><tbody>
        ${events.map((e) => `
          <tr data-event="${esc(e.event_id)}" style="cursor:pointer">
            <td><b>${esc(e.name)}</b>
              ${e.audience_tags?.length ? `<span class="hint">${e.audience_tags.map(esc).join(' · ')}</span>` : ''}</td>
            <td>${esc(fmtWhen.format(new Date(e.starts_at)))}</td>
            <td>${esc(label(KINDS, e.kind))}${e.venue ? ` <span class="hint">${esc(e.venue)}</span>` : ''}</td>
            <td>${esc(e.host_name ?? '—')}</td>
            <td class="num">${e.invited}${e.capacity ? ` <span class="hint">/ ${e.capacity}</span>` : ''}</td>
            <td class="num">${e.attended}${e.attendance_pct !== null ? ` <span class="hint">${e.attendance_pct}%</span>` : ''}</td>
            <td class="num">${e.converted}</td>
            <td class="num">${fmtINR(e.revenue_attributed)}</td>
            <td><span class="badge ${STATUS_BADGE[e.status] ?? ''}">${esc(label(STATUSES, e.status))}</span></td>
          </tr>`).join('')}
        </tbody></table></div>
        <div class="hint" style="margin-top:8px">
          Importing leads onto a roster copies them — the original lead keeps its owner,
          stage and history untouched. Tap an event to work its roster.
        </div>`));
    }

    outlet.querySelectorAll('[data-status]').forEach((b) =>
      b.addEventListener('click', () => { statusFilter = b.dataset.status; draw(); }));
    outlet.querySelectorAll('[data-view]').forEach((b) =>
      b.addEventListener('click', () => { view = b.dataset.view; draw(); }));
    outlet.querySelector('#new-event')?.addEventListener('click', () => editEventModal(null, me, draw));
    outlet.querySelectorAll('tr[data-event]').forEach((tr) =>
      tr.addEventListener('click', () => eventModal(tr.dataset.event, me, draw)));
    outlet.querySelectorAll('[data-done]').forEach((btn) =>
      btn.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        try {
          await put(`/events/${btn.dataset.event}/roster/${btn.dataset.done}`, { followedUp: true });
          toast('Follow-up marked done.');
          draw();
        } catch (err) { toast(err.message, 'err'); }
      }));
  };

  await draw();
}

/** Month grid, current month, events dropped on their day. */
function calendarEl(events) {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth();
  const first = new Date(y, m, 1);
  const days = new Date(y, m + 1, 0).getDate();
  const lead = (first.getDay() + 6) % 7; // Monday-first grid

  const onDay = (d) => events.filter((e) => {
    const s = new Date(e.starts_at);
    return s.getFullYear() === y && s.getMonth() === m && s.getDate() === d;
  });

  const cells = [];
  for (let i = 0; i < lead; i += 1) cells.push('<div class="cal-cell cal-mute"></div>');
  for (let d = 1; d <= days; d += 1) {
    const list = onDay(d);
    cells.push(`
      <div class="cal-cell ${d === now.getDate() ? 'cal-today' : ''}">
        <div class="cal-day">${d}</div>
        ${list.map((e) => `<div class="cal-ev" data-event="${esc(e.event_id)}" title="${esc(e.name)}">${esc(e.name)}</div>`).join('')}
      </div>`);
  }

  return h(`
    <div>
      <div class="hint" style="margin-bottom:6px">${first.toLocaleString('en-IN', { month: 'long', year: 'numeric' })}</div>
      <div class="cal-grid">
        ${['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => `<div class="cal-head">${d}</div>`).join('')}
        ${cells.join('')}
      </div>
    </div>`);
}

/** Create or edit the event itself. */
function editEventModal(existing, me, onDone) {
  const e = existing ?? {};
  const bodyEl = h(`
    <div>
      <label class="f">Name <input name="name" required value="${esc(e.name ?? '')}"></label>
      <div class="frow">
        <label class="f">Type <select name="kind">
          ${KINDS.map(([v, l]) => `<option value="${v}" ${e.kind === v ? 'selected' : ''}>${l}</option>`).join('')}
        </select></label>
        <label class="f">Status <select name="status">
          ${STATUSES.map(([v, l]) => `<option value="${v}" ${e.status === v ? 'selected' : ''}>${l}</option>`).join('')}
        </select></label>
      </div>
      <div class="frow">
        <label class="f">Starts <input type="datetime-local" name="starts" value="${esc(dtLocal(e.starts_at))}" required></label>
        <label class="f">Ends <input type="datetime-local" name="ends" value="${esc(dtLocal(e.ends_at))}"></label>
      </div>
      <label class="f">Venue address <input name="venue" value="${esc(e.venue ?? '')}" placeholder="office / address"></label>
      <label class="f">Meeting link <input name="link" value="${esc(e.meeting_link ?? '')}" placeholder="https://…">
        <span class="hint">Required to publish an online event.</span></label>
      <div class="frow">
        <label class="f">Capacity <input type="number" name="capacity" min="1" value="${e.capacity ?? ''}"></label>
        <label class="f">Audience tags <input name="tags" value="${esc((e.audience_tags ?? []).join(', '))}"
          placeholder="options, beginners"></label>
      </div>
      <label class="f">Description <input name="desc" value="${esc(e.description ?? '')}"></label>
    </div>`);
  const footer = h(`<div><button class="btn primary">${existing ? 'Save changes' : 'Create event'}</button></div>`);
  const { close } = openModal(existing ? 'Edit event' : 'New event', bodyEl, footer);

  footer.querySelector('button').addEventListener('click', async () => {
    const v = (n) => bodyEl.querySelector(`[name=${n}]`).value.trim();
    if (!v('name') || !v('starts')) { toast('Name and start time are required.', 'err'); return; }
    const payload = {
      name: v('name'),
      kind: v('kind'),
      status: v('status'),
      startsAt: fromLocal(v('starts')),
      endsAt: fromLocal(v('ends')),
      venue: v('venue') || undefined,
      meetingLink: v('link') || undefined,
      capacity: v('capacity') ? Number(v('capacity')) : null,
      description: v('desc') || undefined,
      audienceTags: v('tags') ? v('tags').split(',').map((s) => s.trim()).filter(Boolean) : [],
    };
    try {
      if (existing) await put(`/events/${existing.event_id}`, payload);
      else await post('/events', payload);
      toast(existing ? 'Event updated.' : 'Event created — now import some leads.');
      close();
      onDone();
    } catch (err) { toast(err.message, 'err'); }
  });
}

/** The event drawer: counters, roster, import, manual add. */
async function eventModal(eventId, me, onDone) {
  const canEdit = ['admin', 'ops', 'counsellor'].includes(me.role);
  let attFilter = '';

  const bodyEl = h('<div><div class="spin"></div></div>');
  const { close } = openModal('Event', bodyEl);

  const load = async () => {
    const { event: e, roster } = await get(
      `/events/${eventId}${attFilter ? `?attendee=${attFilter}` : ''}`,
    );
    bodyEl.innerHTML = '';
    bodyEl.appendChild(h(`
      <div>
        <div class="row spread wrap" style="margin-bottom:8px">
          <div>
            <div><b>${esc(e.name)}</b> <span class="badge ${STATUS_BADGE[e.status] ?? ''}">${esc(label(STATUSES, e.status))}</span></div>
            <div class="hint">${esc(fmtWhen.format(new Date(e.starts_at)))}
              · ${esc(label(KINDS, e.kind))}${e.venue ? ` · ${esc(e.venue)}` : ''}
              ${e.meeting_link ? ` · <a href="${esc(e.meeting_link)}" target="_blank" rel="noopener">link</a>` : ''}
              ${e.host_name ? ` · host ${esc(e.host_name)}` : ''}</div>
          </div>
          ${canEdit ? '<div class="row" style="gap:6px"><button class="btn small" id="ev-edit">Edit</button>'
            + '<button class="btn small" id="ev-import">Import leads</button>'
            + '<button class="btn small" id="ev-add">Add person</button>'
            + '<button class="btn small" id="ev-csv">Export CSV</button></div>' : ''}
        </div>
        <div class="grid cols-4" style="margin-bottom:10px">
          <div class="stat"><div class="k">Invited</div><div class="v">${e.invited}</div></div>
          <div class="stat"><div class="k">Attended</div><div class="v">${e.attended}</div>
            <div class="s">${e.attendance_pct ?? 0}% turnout</div></div>
          <div class="stat"><div class="k">Converted</div><div class="v">${e.converted}</div>
            <div class="s">${e.conversion_pct ?? 0}% of those who came</div></div>
          <div class="stat ${Number(e.revenue_attributed) ? 'tone-good' : ''}">
            <div class="k">Revenue</div><div class="v">${fmtINR(e.revenue_attributed)}</div></div>
        </div>
        <div class="chips" style="margin:0 0 8px">
          <button class="chip ${attFilter === '' ? 'on' : ''}" data-att="">All ${e.invited}</button>
          ${ATTENDEE.map(([v, l]) => `<button class="chip ${attFilter === v ? 'on' : ''}" data-att="${v}">${l}</button>`).join('')}
        </div>
        ${roster.length === 0 ? '<div class="empty">Nobody on the roster yet. Use “Import leads” to pull a filtered set in.</div>' : `
        <div style="max-height:320px;overflow-y:auto">
        <table class="table"><thead><tr>
          <th>Who</th><th>City</th><th>Source</th><th>Status</th><th>Notes</th>
        </tr></thead><tbody>
        ${roster.map((r) => `
          <tr>
            <td>${r.lead_id ? `<a href="#/lead/${esc(r.lead_id)}"><b>${esc(r.full_name ?? 'Unnamed')}</b></a>`
                             : `<b>${esc(r.full_name ?? 'Unnamed')}</b>`}
              <span class="hint mono">${esc(r.phone_e164 ?? '')}</span></td>
            <td>${esc(r.city ?? '—')}</td>
            <td>${esc(r.source_name ?? '—')}</td>
            <td><select data-roster="${esc(r.id)}" ${me.role === 'viewer' ? 'disabled' : ''}>
              ${ATTENDEE.map(([v, l]) => `<option value="${v}" ${r.status === v ? 'selected' : ''}>${l}</option>`).join('')}
            </select></td>
            <td class="hint">${esc(r.notes ?? '')}</td>
          </tr>`).join('')}
        </tbody></table></div>`}
      </div>`));

    bodyEl.querySelectorAll('[data-att]').forEach((b) =>
      b.addEventListener('click', () => { attFilter = b.dataset.att; load(); }));

    bodyEl.querySelectorAll('select[data-roster]').forEach((sel) =>
      sel.addEventListener('change', async () => {
        try {
          await put(`/events/${eventId}/roster/${sel.dataset.roster}`, { status: sel.value });
          toast('Roster updated.');
          load();
          onDone();
        } catch (err) { toast(err.message, 'err'); }
      }));

    bodyEl.querySelector('#ev-edit')?.addEventListener('click', () =>
      editEventModal(e, me, () => { load(); onDone(); }));
    bodyEl.querySelector('#ev-import')?.addEventListener('click', () =>
      importModal(eventId, () => { load(); onDone(); }));
    bodyEl.querySelector('#ev-add')?.addEventListener('click', () =>
      addPersonModal(eventId, () => { load(); onDone(); }));
    bodyEl.querySelector('#ev-csv')?.addEventListener('click', () => exportCsv(e, roster));
  };

  await load();
}

/** Filter → preview the count → import. The preview uses the same predicate. */
function importModal(eventId, onDone) {
  const bodyEl = h(`
    <div>
      <div class="hint" style="margin-bottom:8px">
        Matching leads are <b>copied</b> onto the roster. The original lead keeps its
        owner, stage and history — importing changes nothing in the pipeline.
      </div>
      <label class="f">Lead status
        <span class="hint">leave all unticked for any status</span>
        <div class="chips" data-statuses style="margin:4px 0">
          ${LEAD_STATUSES.map((s) => `<button class="chip" data-s="${s}">${s}</button>`).join('')}
        </div>
      </label>
      <div class="frow">
        <label class="f">Created from <input type="date" name="from"></label>
        <label class="f">Created to <input type="date" name="to"></label>
      </div>
      <div class="frow">
        <label class="f">City contains <input name="city"></label>
        <label class="f">Campaign contains <input name="campaign"></label>
      </div>
      <div id="preview" class="hint" style="margin-top:8px">No preview run yet.</div>
    </div>`);
  const footer = h(`
    <div class="row" style="gap:8px">
      <button class="btn" id="prev-btn">Preview</button>
      <button class="btn primary" id="imp-btn" disabled>Import</button>
    </div>`);
  const { close } = openModal('Import leads into this event', bodyEl, footer);

  const chosen = new Set();
  bodyEl.querySelectorAll('[data-statuses] .chip').forEach((c) =>
    c.addEventListener('click', () => {
      if (chosen.has(c.dataset.s)) chosen.delete(c.dataset.s);
      else chosen.add(c.dataset.s);
      c.classList.toggle('on');
    }));

  const payload = () => {
    const v = (n) => bodyEl.querySelector(`[name=${n}]`).value.trim();
    const p = { limit: 5000 };
    if (chosen.size) p.statuses = [...chosen];
    if (v('from')) p.from = v('from');
    if (v('to')) p.to = v('to');
    if (v('city')) p.city = v('city');
    if (v('campaign')) p.campaign = v('campaign');
    return p;
  };

  footer.querySelector('#prev-btn').addEventListener('click', async () => {
    try {
      const r = await post(`/events/${eventId}/import/preview`, payload());
      bodyEl.querySelector('#preview').innerHTML = r.matched === 0
        ? 'No leads match that filter — nothing would be imported.'
        : `<b>${r.matched}</b> lead${r.matched === 1 ? '' : 's'} match, already-invited excluded.
           ${r.sample.map((s) => esc(s.full_name ?? s.phone_e164)).slice(0, 8).join(', ')}${r.matched > 8 ? ' …' : ''}`;
      footer.querySelector('#imp-btn').disabled = r.matched === 0;
    } catch (err) { toast(err.message, 'err'); }
  });

  footer.querySelector('#imp-btn').addEventListener('click', async () => {
    try {
      const r = await post(`/events/${eventId}/import`, payload());
      toast(`${r.added} lead${r.added === 1 ? '' : 's'} added to the roster.`);
      close();
      onDone();
    } catch (err) { toast(err.message, 'err'); }
  });
}

function addPersonModal(eventId, onDone) {
  const bodyEl = h(`
    <div>
      <div class="hint" style="margin-bottom:8px">For a walk-up who was never a lead.</div>
      <label class="f">Name <input name="name" required></label>
      <div class="frow">
        <label class="f">Phone <input name="phone" placeholder="98xxxxxxxx" required></label>
        <label class="f">City <input name="city"></label>
      </div>
    </div>`);
  const footer = h('<div><button class="btn primary">Add to roster</button></div>');
  const { close } = openModal('Add a person', bodyEl, footer);

  footer.querySelector('button').addEventListener('click', async () => {
    const v = (n) => bodyEl.querySelector(`[name=${n}]`).value.trim();
    if (!v('name') || !v('phone')) { toast('Name and phone are required.', 'err'); return; }
    try {
      await post(`/events/${eventId}/roster`, {
        fullName: v('name'), phone: v('phone'), city: v('city') || undefined,
      });
      toast('Added to the roster.');
      close();
      onDone();
    } catch (err) { toast(err.message, 'err'); }
  });
}

/** Roster to CSV, built in the browser — no server round trip, no temp file. */
function exportCsv(event, roster) {
  const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const csv = [
    ['Name', 'Phone', 'City', 'Source', 'Status', 'Invite sent', 'Attended', 'Owner', 'Notes']
      .map(cell).join(','),
    ...roster.map((r) => [
      r.full_name, r.phone_e164, r.city, r.source_name, r.status,
      r.invite_sent_at ? fmtDate(r.invite_sent_at) : '',
      r.attended_at ? fmtDate(r.attended_at) : '',
      r.owner_name, r.notes,
    ].map(cell).join(',')),
  ].join('\n');

  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `${event.name.replace(/[^\w-]+/g, '-').toLowerCase()}-roster.csv`;
  a.click();
  URL.revokeObjectURL(url);
}
