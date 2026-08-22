import { get, post } from './api.js';
import { esc, h, openModal, toast } from './util.js';

/**
 * The add-a-lead modal, shared by Find lead and Fresh leads.
 *
 * Two kinds of lead enter here:
 *
 * - Hand entry (walk-past, referral): admin/ops/counsellor only. Assignment
 *   defaults to fair distribution — the same engine every sheet lead goes
 *   through — so typing a lead in by hand is never a way to jump the queue.
 *
 * - 📞 Inbound call — the client called US. The highest-quality lead on the
 *   floor, loggable by WHOEVER answered, including a caller (who always
 *   keeps it — they cannot route it elsewhere). Always immediate priority,
 *   and the follow-up date the client was promised is required: it becomes
 *   a pending callback, which is the loudest machinery the CRM has.
 */
export async function addLeadModal(me, onDone) {
  const isCaller = me?.role === 'caller';

  // The caller list comes from lead flow, which counsellors and admins can
  // read. A caller cannot (and does not need to): their inbound call is
  // theirs by rule.
  const flow = isCaller
    ? { callers: [] }
    : await get('/dashboards/lead-flow').catch(() => ({ callers: [] }));
  const callers = (flow.callers ?? []).filter((c) => c.is_active);

  // Default the follow-up to tomorrow morning 10:00 IST-ish (local clock):
  // a real, editable suggestion rather than an empty box.
  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
  tomorrow.setHours(10, 0, 0, 0);
  const followupDefault = new Date(tomorrow.getTime() - tomorrow.getTimezoneOffset() * 60000)
    .toISOString().slice(0, 16);

  const bodyEl = h(`
    <div>
      <div class="chips" style="margin-bottom:10px" data-testid="lead-kind">
        <button class="chip ${isCaller ? '' : 'on'}" data-kind="manual" ${isCaller ? 'disabled' : ''}>Entered by hand</button>
        <button class="chip ${isCaller ? 'on' : ''}" data-kind="inbound">📞 Inbound call</button>
      </div>
      <div class="hint" style="margin-bottom:10px" data-kind-hint></div>
      <label class="f">Full name <input name="name" maxlength="120" required></label>
      <div class="frow">
        <label class="f">Phone <input name="phone" placeholder="98xxxxxxxx" required></label>
        <label class="f">City <input name="city" maxlength="60"></label>
      </div>
      <div class="frow">
        <label class="f" data-f="priority">Priority
          <select name="priority">
            <option value="normal">Normal</option>
            <option value="immediate">Immediate — asked to be called now</option>
          </select>
        </label>
        ${isCaller ? '' : `
        <label class="f">Give it to
          <select name="assign">
            <option value="">Fair distribution (recommended)</option>
            <option value="${esc(me?.id ?? '')}" data-self>Keep it with me — I took the call</option>
            ${callers.map((c) => `<option value="${esc(c.user_id)}">${esc(c.full_name)}${
              c.flow_status === 'receiving' ? '' : ' (off floor)'}</option>`).join('')}
          </select>
        </label>`}
      </div>
      <label class="f" data-f="followup" style="display:none">Follow up on — the date the client was told
        <input name="followup" type="datetime-local" value="${followupDefault}">
      </label>
      <label class="f">Note <input name="note" maxlength="300"
        placeholder="how they reached us — walk-past, referral…"></label>
    </div>`);

  const footer = h('<div><button class="btn primary">Add lead</button></div>');
  const { close } = openModal('Add a lead', bodyEl, footer);

  let kind = isCaller ? 'inbound' : 'manual';
  const applyKind = () => {
    bodyEl.querySelectorAll('[data-kind]').forEach((b) =>
      b.classList.toggle('on', b.dataset.kind === kind));
    bodyEl.querySelector('[data-f=followup]').style.display = kind === 'inbound' ? '' : 'none';
    bodyEl.querySelector('[data-f=priority]').style.display = kind === 'inbound' ? 'none' : '';
    bodyEl.querySelector('[data-kind-hint]').textContent = kind === 'inbound'
      ? 'The client called us — the warmest lead there is. It is immediate priority '
        + 'automatically, and the follow-up date becomes a callback that rings, so it '
        + 'cannot be skipped.'
      : 'For a lead that did not come through the sheet — somebody walked past or was '
        + 'referred. Leads from the Google Sheet arrive on their own; never re-type those.';
    const note = bodyEl.querySelector('[name=note]');
    note.placeholder = kind === 'inbound'
      ? 'what they asked about, and anything promised on the call'
      : 'how they reached us — walk-past, referral…';
    // Answering the phone makes the lead yours by default; fair distribution
    // stays one click away for the receptionist case.
    const assign = bodyEl.querySelector('[name=assign]');
    if (assign && kind === 'inbound' && !assign.value) {
      assign.value = assign.querySelector('[data-self]')?.value ?? '';
    }
    footer.querySelector('button').textContent =
      kind === 'inbound' ? 'Log inbound call' : 'Add lead';
  };
  applyKind();

  bodyEl.querySelectorAll('[data-kind]').forEach((b) =>
    b.addEventListener('click', () => { kind = b.dataset.kind; applyKind(); }));

  footer.querySelector('button').addEventListener('click', async () => {
    const v = (n) => bodyEl.querySelector(`[name=${n}]`)?.value.trim() ?? '';
    if (!v('name') || !v('phone')) {
      toast('Name and phone are both required.', 'err');
      return;
    }
    if (kind === 'inbound' && !v('followup')) {
      toast('An inbound call needs its follow-up date — the client was told when we would call.', 'err');
      return;
    }
    try {
      const lead = await post('/leads/manual', {
        fullName: v('name'),
        phone: v('phone'),
        city: v('city') || undefined,
        priority: v('priority') || 'normal',
        assignTo: isCaller ? null : (v('assign') || null),
        note: v('note') || undefined,
        kind,
        followupAt: kind === 'inbound' ? new Date(v('followup')).toISOString() : undefined,
      });
      toast(kind === 'inbound'
        ? 'Inbound call logged — the follow-up will ring when it is due.'
        : lead.caller_id
          ? 'Lead added and assigned — it is in their pipeline now.'
          : 'Lead added — it will hand out the moment a caller is on the floor.');
      close();
      onDone?.(lead);
    } catch (err) { toast(err.message, 'err'); }
  });
}
