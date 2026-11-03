import { get, post } from '../api.js';
import {
  avatarHtml, esc, fmtDT, h, localToIso, outcomeLabel, OUTCOME_LABEL, stageBadge,
  toast, tomorrowAt,
} from '../util.js';

/**
 * One lead: who they are, where they stand, the one form that logs a call,
 * and the full timeline of everything anyone ever did.
 *
 * The outcome form is five buttons - the owner's rule: a response is either
 * "no, don't call me" (Not qualified) or the lead stays alive as one of the
 * four live answers. No pre-selected outcome: a default saved by reflex
 * invents data.
 */

const KIND_ICON = {
  call: '📞', note: '📝', assign: '👤', checkpoint: '✅', enquiry: '🔁', system: '•',
};

export async function render(outlet, me, params) {
  const id = params[0];
  const { lead, activities } = await get(`/leads/${id}`);
  const { users } = await get('/leads/meta/options');

  outlet.innerHTML = '';
  const overdue = lead.due_bucket === 'overdue';

  const root = h(`
    <div>
      <div class="frow" style="margin-bottom:12px">
        <a class="btn small" href="#/leads">← All leads</a>
      </div>
      <div class="grid lead-grid">
        <div class="panel">
          <h2 style="margin-top:0">${esc(lead.full_name ?? 'No name')}
            ${Number(lead.enquiry_count) > 1 ? `<span class="badge b-warn">enquired ×${lead.enquiry_count}</span>` : ''}
          </h2>
          <table class="table kv">
            <tr><td>Phone</td><td class="mono">
              <a href="tel:${esc(lead.phone_e164)}">${esc(lead.phone_e164)}</a>
              <button class="btn small" data-copy="${esc(lead.phone_e164)}">Copy</button>
            </td></tr>
            <tr><td>Email</td><td>${esc(lead.email ?? '—')}</td></tr>
            <tr><td>City</td><td>${esc(lead.city ?? '—')}</td></tr>
            <tr><td>Source</td><td>${esc(lead.source_name)}${lead.campaign ? ` · ${esc(lead.campaign)}` : ''}</td></tr>
            <tr><td>Received</td><td>${esc(fmtDT(lead.created_at))}</td></tr>
          </table>
        </div>
        <div class="panel">
          <div class="frow" style="align-items:center">
            ${stageBadge(lead.stage)}
            <span>${esc(outcomeLabel(lead))}</span>
          </div>
          <table class="table kv">
            <tr><td>Assigned to</td><td data-assign-cell>
              ${lead.assigned_name
                ? `${avatarHtml(lead.assigned_name, 22)} ${esc(lead.assigned_name)}`
                : '<span class="badge b-bad">Unassigned</span>'}
            </td></tr>
            <tr><td>Next follow-up</td><td class="${overdue ? 't-red' : ''}">
              ${lead.next_follow_up_at
                ? `${esc(fmtDT(lead.next_follow_up_at))}${
                    overdue ? (lead.stage === 'new' ? ' — make the first call' : ' — overdue') : ''
                  }`
                : '—'}
            </td></tr>
            ${lead.follow_up_note ? `<tr><td>Note</td><td>${esc(lead.follow_up_note)}</td></tr>` : ''}
          </table>
          <div class="frow" data-assign-row></div>
          <div class="section-h">Webinar checkpoints</div>
          <div class="frow" data-checkpoints>
            ${checkpointBtn('template_sent', '✉ Invite sent', lead.template_sent_at)}
            ${checkpointBtn('confirmed', '✓ Confirmed', lead.confirmed_at)}
            ${checkpointBtn('converted', '★ Converted', lead.converted_at)}
          </div>
          <div class="frow" data-stage-actions style="margin-top:10px"></div>
        </div>
      </div>

      <div class="panel" data-callform>
        <div class="section-h" style="margin-top:0">Log a call</div>
        <div class="chips" data-outcomes>
          ${Object.entries(OUTCOME_LABEL)
            .map(([k, label]) => `<button class="chip" data-outcome="${k}">${esc(label)}</button>`)
            .join('')}
        </div>
        <div class="frow" data-when hidden>
          <label class="f" style="margin:0">
            <span data-when-label>Next follow-up</span>
            <input type="datetime-local" name="next" value="${tomorrowAt(11)}">
          </label>
        </div>
        <label class="f">What they said <textarea name="note" rows="2" placeholder="One line is enough — it shows on the timeline and the list"></textarea></label>
        <div class="frow">
          <button class="btn primary" data-save disabled>Save call</button>
          <span class="hint" data-save-hint>Pick what happened on the call first.</span>
        </div>
      </div>

      <div class="panel">
        <div class="section-h" style="margin-top:0">Timeline</div>
        <div class="frow">
          <input name="quicknote" placeholder="Add a note…" style="flex:1">
          <button class="btn" data-add-note>Add note</button>
        </div>
        <div class="timeline" data-timeline>
          ${activities.map((a) => activityRow(a)).join('') || '<div class="empty">Nothing yet.</div>'}
        </div>
      </div>
    </div>`);
  outlet.appendChild(root);

  const reload = () => render(outlet, me, params);

  // copy phone
  root.querySelector('[data-copy]')?.addEventListener('click', async (e) => {
    try {
      await navigator.clipboard.writeText(e.target.dataset.copy);
      toast('Phone number copied.');
    } catch {
      toast('Could not copy — select it by hand.', 'err');
    }
  });

  // ---- assignment ----
  const assignRow = root.querySelector('[data-assign-row]');
  if (me.role === 'admin') {
    const sel = h(`
      <select>
        <option value="">Give to…</option>
        ${users.map((u) => `<option value="${u.id}">${esc(u.full_name)} (${esc(u.role)})</option>`).join('')}
      </select>`);
    sel.addEventListener('change', async () => {
      if (!sel.value) return;
      try {
        await post(`/leads/${lead.id}/assign`, { userId: sel.value });
        toast('Moved.');
        reload();
      } catch (err) {
        toast(err.message, 'err');
      }
    });
    assignRow.appendChild(sel);
  } else if (!lead.assigned_to) {
    const btn = h('<button class="btn">Take this lead</button>');
    btn.addEventListener('click', async () => {
      try {
        await post(`/leads/${lead.id}/assign`, { userId: me.id });
        toast('It’s yours.');
        reload();
      } catch (err) {
        toast(err.message, 'err');
      }
    });
    assignRow.appendChild(btn);
  }

  // ---- checkpoints ----
  root.querySelectorAll('[data-ck]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const kind = btn.dataset.ck;
      const on = btn.dataset.on !== '1';
      if (kind === 'converted' && !on && me.role !== 'admin') {
        toast('Only an admin can undo a conversion.', 'err');
        return;
      }
      try {
        await post(`/leads/${lead.id}/checkpoint`, { kind, on });
        toast(on ? 'Marked.' : 'Unmarked.');
        reload();
      } catch (err) {
        toast(err.message, 'err');
      }
    });
  });

  // ---- reopen ----
  const stageActions = root.querySelector('[data-stage-actions]');
  if (lead.stage === 'not_qualified') {
    const btn = h('<button class="btn">Reopen this lead</button>');
    btn.addEventListener('click', async () => {
      try {
        await post(`/leads/${lead.id}/reopen`);
        toast('Reopened.');
        reload();
      } catch (err) {
        toast(err.message, 'err');
      }
    });
    stageActions.appendChild(btn);
    stageActions.appendChild(h('<span class="hint">Closed — reopen before working it again.</span>'));
  }

  // ---- the call form ----
  let outcome = null;
  const whenRow = root.querySelector('[data-when]');
  const whenLabel = root.querySelector('[data-when-label]');
  const saveBtn = root.querySelector('[data-save]');
  const saveHint = root.querySelector('[data-save-hint]');

  root.querySelectorAll('[data-outcome]').forEach((chip) => {
    chip.addEventListener('click', () => {
      outcome = chip.dataset.outcome;
      root.querySelectorAll('[data-outcome]').forEach((c) =>
        c.classList.toggle('on', c === chip),
      );
      const needsTime = outcome === 'call_back';
      const noTime = outcome === 'not_qualified';
      whenRow.hidden = noTime;
      whenLabel.textContent = needsTime
        ? 'When did they ask to be called? (required)'
        : 'Next follow-up (change it if they said a day)';
      saveBtn.disabled = false;
      saveHint.textContent =
        outcome === 'qualified'
          ? 'Saves the call and passes the lead to follow-up.'
          : noTime
            ? 'Closes the lead. Only for a clear "no, don’t call me".'
            : '';
    });
  });

  saveBtn.addEventListener('click', async () => {
    if (!outcome) return;
    const note = root.querySelector('[name=note]').value.trim();
    const nextRaw = root.querySelector('[name=next]').value;
    const payload = { outcome, note: note || undefined };
    if (outcome !== 'not_qualified' && nextRaw) payload.nextFollowUpAt = localToIso(nextRaw);
    if (outcome === 'call_back' && !nextRaw) {
      toast('A call-back needs the date and time the client asked for.', 'err');
      return;
    }
    saveBtn.disabled = true;
    try {
      const updated = await post(`/leads/${lead.id}/call`, payload);
      toast(
        outcome === 'qualified' && updated.assigned_name && updated.assigned_to !== lead.assigned_to
          ? `Saved — passed to ${updated.assigned_name} for follow-up.`
          : 'Call saved.',
      );
      reload();
    } catch (err) {
      saveBtn.disabled = false;
      toast(err.message, 'err');
    }
  });

  // ---- quick note ----
  root.querySelector('[data-add-note]').addEventListener('click', async () => {
    const input = root.querySelector('[name=quicknote]');
    const note = input.value.trim();
    if (!note) return;
    try {
      await post(`/leads/${lead.id}/note`, { note });
      reload();
    } catch (err) {
      toast(err.message, 'err');
    }
  });
}

function checkpointBtn(kind, label, at) {
  const on = Boolean(at);
  return `<button class="chip ck${on ? ' on' : ''}" data-ck="${kind}" data-on="${on ? 1 : 0}"
            title="${on ? `Done ${fmtDT(at)} — click to undo` : 'Click when done'}">${esc(label)}</button>`;
}

function activityRow(a) {
  const icon = KIND_ICON[a.kind] ?? '•';
  const who = a.user_name ?? 'System';
  const what =
    a.kind === 'call'
      ? `${OUTCOME_LABEL[a.outcome] ?? a.outcome}${a.note ? ` — ${a.note}` : ''}`
      : a.note ?? a.kind;
  const next = a.meta?.next_follow_up_at
    ? ` <span class="hint">· next: ${esc(fmtDT(a.meta.next_follow_up_at))}</span>`
    : '';
  return `
    <div class="tl-row">
      <span class="tl-icon">${icon}</span>
      <div class="tl-body">
        <div>${esc(what)}${next}</div>
        <div class="hint">${esc(who)} · ${esc(fmtDT(a.created_at))}</div>
      </div>
    </div>`;
}
