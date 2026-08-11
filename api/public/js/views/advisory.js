import { get, put } from '../api.js';
import { esc, fmtDate, fmtINR, h, toast } from '../util.js';

/**
 * Advisory clients: paid money, so they left the sales pipeline - what remains
 * HERE is only the register and the two compliance checkpoints (MITC, KYC)
 * that must be complete before paid advisory is delivered. Sorted so anyone
 * missing a checkpoint floats to the top: money collected with MITC unticked
 * is the one state this screen exists to make impossible to miss.
 */
const TABS = [['', 'All'], ['active', 'Active'], ['expired', 'Expired'], ['refunded', 'Refunded']];

export async function render(outlet, me) {
  let status = '';
  const canEdit = me.role === 'admin' || me.role === 'counsellor';

  const draw = async () => {
    outlet.innerHTML = '<div class="spin"></div>';
    const rows = await get(`/advisory${status ? `?status=${status}` : ''}`);
    outlet.innerHTML = '';

    outlet.appendChild(h(`
      <div class="panel">
        <div class="row spread">
          <h2 class="mt0">Advisory clients <small>everyone who has paid — ${rows.length}</small></h2>
          <div class="chips" style="margin:0">
            ${TABS.map(([v, l]) => `<button class="chip ${v === status ? 'on' : ''}" data-status="${v}">${l}</button>`).join('')}
          </div>
        </div>
        ${rows.length === 0 ? '<div class="empty">No paying clients in this list yet.</div>' : `
        <div style="overflow-x:auto">
        <table class="table"><thead><tr>
          <th>Client</th><th>Product</th><th class="num">Paid</th><th>Last payment</th>
          <th>Counsellor</th><th>Status</th><th>MITC</th><th>KYC</th><th>Subscription ends</th>
        </tr></thead><tbody>
        ${rows.map((r) => `
          <tr${!r.mitc_done_at || !r.kyc_done_at ? ' style="background:var(--warn-bg)"' : ''}>
            <td><a href="#/lead/${esc(r.lead_id)}"><b>${esc(r.full_name ?? 'Unnamed')}</b></a>
                <span class="hint mono">${esc(r.phone_e164)}</span></td>
            <td>${esc(r.product)}</td>
            <td class="num">${fmtINR(r.paid_amount)}</td>
            <td>${esc(fmtDate(r.last_paid_at))}</td>
            <td>${esc(r.counsellor_name ?? '—')}</td>
            <td>${r.client_status === 'active' ? '<span class="badge b-ok">active</span>'
                : r.client_status === 'expired' ? '<span class="badge b-warn">expired</span>'
                : '<span class="badge b-bad">refunded</span>'}</td>
            <td><label class="ck"><input type="checkbox" data-deal="${esc(r.deal_id)}" data-k="mitcDone"
                  ${r.mitc_done_at ? 'checked disabled' : ''} ${canEdit ? '' : 'disabled'}>
                  ${r.mitc_done_at ? esc(fmtDate(r.mitc_done_at)) : 'pending'}</label></td>
            <td><label class="ck"><input type="checkbox" data-deal="${esc(r.deal_id)}" data-k="kycDone"
                  ${r.kyc_done_at ? 'checked disabled' : ''} ${canEdit ? '' : 'disabled'}>
                  ${r.kyc_done_at ? esc(fmtDate(r.kyc_done_at)) : 'pending'}</label></td>
            <td>${canEdit
                ? `<input type="date" data-deal="${esc(r.deal_id)}" data-k="subEnd"
                     value="${r.subscription_ends_at ? esc(String(r.subscription_ends_at).slice(0, 10)) : ''}"
                     style="border:1px solid var(--line);border-radius:7px;padding:5px">`
                : esc(fmtDate(r.subscription_ends_at))}</td>
          </tr>`).join('')}
        </tbody></table></div>
        <div class="hint" style="margin-top:8px">
          Amber rows are missing a checkpoint — money is in and MITC or KYC is not done.
          Ticks are one-way and record who ticked them and when; service delivery itself
          stays in the advisory pipeline, not in this CRM.
        </div>`}
      </div>`));

    outlet.querySelectorAll('[data-status]').forEach((b) =>
      b.addEventListener('click', () => { status = b.dataset.status; draw(); }));

    outlet.querySelectorAll('input[type=checkbox][data-deal]').forEach((cb) =>
      cb.addEventListener('change', async () => {
        if (!cb.checked) return;
        try {
          await put(`/advisory/${cb.dataset.deal}`, { [cb.dataset.k === 'mitcDone' ? 'mitcDone' : 'kycDone']: true });
          toast(`${cb.dataset.k === 'mitcDone' ? 'MITC' : 'KYC'} recorded with your name and the time.`);
          draw();
        } catch (err) { cb.checked = false; toast(err.message, 'err'); }
      }));

    outlet.querySelectorAll('input[type=date][data-deal]').forEach((inp) =>
      inp.addEventListener('change', async () => {
        try {
          await put(`/advisory/${inp.dataset.deal}`, {
            subscriptionEndsAt: inp.value ? new Date(`${inp.value}T18:30:00+05:30`).toISOString() : null,
          });
          toast('Subscription end updated.');
          draw();
        } catch (err) { toast(err.message, 'err'); }
      }));
  };

  await draw();
}
