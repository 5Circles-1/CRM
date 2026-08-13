import { get, post } from './api.js';
import { esc, h, openModal, toast } from './util.js';

/**
 * The add-a-lead modal, shared by Find lead and Fresh leads.
 *
 * Assignment defaults to fair distribution — the same engine every sheet lead
 * goes through — so typing a lead in by hand is never a way to jump the
 * queue. Naming a specific caller is there for the genuine case: "this person
 * asked for Prabhjot".
 */
export async function addLeadModal(onDone) {
  // The caller list comes from lead flow, which the same roles can read.
  const flow = await get('/dashboards/lead-flow').catch(() => ({ callers: [] }));
  const callers = (flow.callers ?? []).filter((c) => c.is_active);

  const bodyEl = h(`
    <div>
      <div class="hint" style="margin-bottom:10px">
        For a lead that did not come through the sheet — somebody rang the
        office, walked past, or was referred. Leads from the Google Sheet
        arrive on their own; never re-type those.
      </div>
      <label class="f">Full name <input name="name" maxlength="120" required></label>
      <div class="frow">
        <label class="f">Phone <input name="phone" placeholder="98xxxxxxxx" required></label>
        <label class="f">City <input name="city" maxlength="60"></label>
      </div>
      <div class="frow">
        <label class="f">Priority
          <select name="priority">
            <option value="normal">Normal</option>
            <option value="immediate">Immediate — asked to be called now</option>
          </select>
        </label>
        <label class="f">Give it to
          <select name="assign">
            <option value="">Fair distribution (recommended)</option>
            ${callers.map((c) => `<option value="${esc(c.user_id)}">${esc(c.full_name)}${
              c.flow_status === 'receiving' ? '' : ' (off floor)'}</option>`).join('')}
          </select>
        </label>
      </div>
      <label class="f">Note <input name="note" maxlength="300"
        placeholder="how they reached us — walk-past, referral…"></label>
    </div>`);

  const footer = h('<div><button class="btn primary">Add lead</button></div>');
  const { close } = openModal('Add a lead', bodyEl, footer);

  footer.querySelector('button').addEventListener('click', async () => {
    const v = (n) => bodyEl.querySelector(`[name=${n}]`).value.trim();
    if (!v('name') || !v('phone')) {
      toast('Name and phone are both required.', 'err');
      return;
    }
    try {
      const lead = await post('/leads/manual', {
        fullName: v('name'),
        phone: v('phone'),
        city: v('city') || undefined,
        priority: v('priority'),
        assignTo: v('assign') || null,
        note: v('note') || undefined,
      });
      toast(lead.caller_id
        ? 'Lead added and assigned — it is in their pipeline now.'
        : 'Lead added — it will hand out the moment a caller is on the floor.');
      close();
      onDone?.(lead);
    } catch (err) { toast(err.message, 'err'); }
  });
}
