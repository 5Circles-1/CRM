import { get, put } from '../api.js';
import { badge, esc, fmtDT, h, openModal, toast } from '../util.js';

/**
 * Exclusive Events: a separate inflow for one-off campaigns. Leads from a sheet
 * marked as an event source arrive here tagged and live; old leads can be pulled
 * in by phone. Worked from here without cluttering the normal pipeline.
 */
export async function render(outlet, me) {
  const canManage = ['counsellor', 'admin', 'ops'].includes(me.role);
  let openEvent = null;

  const draw = async () => {
    const data = await get(`/exclusive-events${openEvent ? `?event=${encodeURIComponent(openEvent)}` : ''}`)
      .catch(() => ({ events: [], leads: [] }));
    outlet.innerHTML = '';

    const events = data.events ?? [];
    const panel = h(`
      <div class="panel">
        <div class="row spread">
          <h2 class="mt0">Exclusive Events <small>separate campaigns, live leads</small></h2>
          ${canManage ? '<button class="btn small" id="add-old">Add an old lead</button>' : ''}
        </div>
        ${events.length === 0
          ? `<div class="empty">No exclusive events yet. Mark a lead source as an
             Exclusive Event in Admin → Ingestion, or add an old lead to one.</div>`
          : `<div class="chips">
              ${events.map((e) => `
                <button class="chip ${openEvent === e.exclusive_event ? 'on' : ''}"
                  data-event="${esc(e.exclusive_event)}">
                  ${esc(e.exclusive_event)} <b>${Number(e.total)}</b>
                  ${Number(e.fresh) > 0 ? `<span class="hint">· ${Number(e.fresh)} fresh</span>` : ''}
                </button>`).join('')}
            </div>`}
        <div id="ev-leads" style="margin-top:12px"></div>
      </div>`);
    outlet.appendChild(panel);

    panel.querySelectorAll('[data-event]').forEach((b) =>
      b.addEventListener('click', () => { openEvent = openEvent === b.dataset.event ? null : b.dataset.event; draw(); }));

    const box = panel.querySelector('#ev-leads');
    if (openEvent && (data.leads ?? []).length > 0) {
      box.appendChild(h(`
        <table class="table" data-testid="exclusive-leads"><thead><tr>
          <th>Lead</th><th>Status</th><th>Last outcome</th><th>Next action</th><th></th>
        </tr></thead><tbody>
        ${data.leads.map((l) => `
          <tr>
            <td><a href="#/lead/${esc(l.lead_id)}">${esc(l.full_name ?? 'Unnamed')}</a>
                <span class="hint mono">${esc(l.phone_e164)}</span></td>
            <td>${badge(l.status)}${l.walked_in_at ? ' <span class="badge b-ok">walked in</span>' : ''}</td>
            <td>${l.last_disposition ? esc(String(l.last_disposition).replace(/_/g, ' ')) : '<span class="hint">not called</span>'}</td>
            <td>${esc(fmtDT(l.next_action_at))}</td>
            <td class="right">${canManage ? `<button class="btn small ev-remove" data-lead="${esc(l.lead_id)}">Remove</button>` : ''}</td>
          </tr>`).join('')}
        </tbody></table>`));
    } else if (openEvent) {
      box.appendChild(h('<div class="empty">No open leads in this event.</div>'));
    }

    box.addEventListener('click', async (e) => {
      if (!e.target.classList?.contains('ev-remove')) return;
      try {
        await put(`/leads/${e.target.dataset.lead}/exclusive-event`, { event: null });
        toast('Removed from the event.');
        draw();
      } catch (err) { toast(err.message, 'err'); }
    });

    panel.querySelector('#add-old')?.addEventListener('click', () => addOldLead(openEvent, events, draw));
  };

  await draw();
}

/** Pull an old lead into an event by searching for it, then tagging it. */
function addOldLead(currentEvent, events, onDone) {
  const body = h(`
    <div>
      <label class="f">Event name
        <input name="event" list="ev-list" placeholder="e.g. Diwali 2026" value="${esc(currentEvent ?? '')}">
        <datalist id="ev-list">${events.map((e) => `<option value="${esc(e.exclusive_event)}">`).join('')}</datalist>
      </label>
      <label class="f">Find the lead by name or phone
        <input name="q" placeholder="name or 98…" autocomplete="off">
      </label>
      <div id="ev-results" class="hint">Type at least two characters.</div>
    </div>`);
  const footer = h('<div><span class="hint">Pick a lead from the results to add it.</span></div>');
  const { close } = openModal('Add an old lead to an event', body, footer);

  const results = body.querySelector('#ev-results');
  let timer = null;
  body.querySelector('[name=q]').addEventListener('input', (e) => {
    const q = e.target.value.trim();
    clearTimeout(timer);
    if (q.length < 2) { results.textContent = 'Type at least two characters.'; return; }
    timer = setTimeout(async () => {
      const data = await get(`/leads?q=${encodeURIComponent(q)}&limit=10`).catch(() => ({ leads: [] }));
      const event = body.querySelector('[name=event]').value.trim();
      if (!data.leads.length) { results.textContent = 'No matches.'; return; }
      results.innerHTML = '';
      for (const l of data.leads) {
        const row = h(`<div class="row spread" style="padding:6px 0;border-bottom:1px solid var(--line)">
          <span>${esc(l.full_name ?? 'Unnamed')} <span class="mono hint">${esc(l.phone_e164)}</span></span>
          <button class="btn small primary">Add</button></div>`);
        row.querySelector('button').addEventListener('click', async () => {
          if (!event) { toast('Enter an event name first.', 'err'); return; }
          try {
            await put(`/leads/${l.id}/exclusive-event`, { event });
            toast(`Added to ${event}.`);
            close();
            onDone();
          } catch (err) { toast(err.message, 'err'); }
        });
        results.appendChild(row);
      }
    }, 250);
  });
}
