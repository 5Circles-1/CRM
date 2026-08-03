import { get, post } from '../api.js';
import { badge, esc, fmtDate, fmtINR, h, openModal, toast } from '../util.js';

/**
 * The collections queue: every open instalment, most urgent first. The
 * counsellor who closed the deal chases it - that accountability is the
 * highest-leverage rule in the build.
 */
export async function render(outlet, me) {
  const rows = await get('/collections/due');
  outlet.innerHTML = '';

  const overdue = rows.filter((r) => r.status === 'overdue');
  const totalDue = rows.reduce((a, r) => a + (Number(r.amount) - Number(r.paid_amount)), 0);
  const overdueAmt = overdue.reduce((a, r) => a + (Number(r.amount) - Number(r.paid_amount)), 0);

  outlet.appendChild(h(`
    <div class="grid cols-3" style="margin-bottom:18px">
      <div class="stat"><div class="k">Open instalments</div><div class="v">${rows.length}</div></div>
      <div class="stat"><div class="k">Outstanding</div><div class="v">${fmtINR(totalDue)}</div></div>
      <div class="stat"><div class="k">Overdue</div>
        <div class="v" style="color:${overdue.length ? 'var(--bad)' : 'inherit'}">${fmtINR(overdueAmt)}</div>
        <div class="s">${overdue.length} instalment${overdue.length === 1 ? '' : 's'}</div></div>
    </div>`));

  if (rows.length === 0) {
    outlet.appendChild(h('<div class="panel"><div class="empty">Nothing outstanding. Every rupee booked has been collected.</div></div>'));
    return;
  }

  const panel = h(`
    <div class="panel">
      <h2>Dues queue <small>sorted by due date</small></h2>
      <table class="table" data-testid="dues-table"><thead><tr>
        <th>Due</th><th>Client</th><th>Instalment</th><th class="num">Amount</th>
        <th>Status</th><th>Promise</th><th>Closer</th><th></th>
      </tr></thead><tbody>
      ${rows.map((r) => {
        const outstanding = Number(r.amount) - Number(r.paid_amount);
        return `
        <tr data-inst="${esc(r.instalment_id)}" data-deal="${esc(r.deal_id)}" data-out="${outstanding}">
          <td>${esc(fmtDate(r.due_date))}${r.is_late ? ' <span class="badge b-bad">late</span>' : ''}</td>
          <td><a href="#/lead/${esc(r.lead_id)}">${esc(r.full_name ?? 'Unnamed')}</a>
              <span class="hint mono">${esc(r.phone_e164)}</span></td>
          <td>${Number(r.seq)} of ${Number(r.instalment_count)}</td>
          <td class="num">${fmtINR(outstanding)}${Number(r.paid_amount) > 0 ? `<div class="hint">${fmtINR(r.paid_amount)} paid</div>` : ''}</td>
          <td>${badge(r.status)}</td>
          <td>${r.promised_date
            ? `${esc(fmtDate(r.promised_date))} · ${fmtINR(r.promised_amount)} <span class="badge b-mute">${esc(r.confidence)}</span>`
            : '<span class="hint">none</span>'}</td>
          <td>${esc(r.counsellor_name)}</td>
          <td class="right row" style="justify-content:flex-end">
            <button class="btn small primary act-pay" data-testid="record-payment">Payment</button>
            <button class="btn small act-promise">Promise</button>
          </td>
        </tr>`;
      }).join('')}
      </tbody></table>
    </div>`);
  outlet.appendChild(panel);

  panel.addEventListener('click', (e) => {
    const row = e.target.closest?.('tr[data-inst]');
    if (!row) return;
    if (e.target.classList.contains('act-pay')) {
      paymentModal(row.dataset.deal, row.dataset.inst, Number(row.dataset.out), () => render(outlet, me));
    }
    if (e.target.classList.contains('act-promise')) {
      promiseModal(row.dataset.inst, Number(row.dataset.out), () => render(outlet, me));
    }
  });
}

function paymentModal(dealId, instalmentId, outstanding, onDone) {
  const body = h(`
    <div>
      <label class="f">Amount (₹) <span class="hint">outstanding ${esc(fmtINR(outstanding))}</span>
        <input name="amount" type="number" min="1" max="${outstanding}" step="0.01" value="${outstanding}" data-testid="pay-amount">
      </label>
      <div class="frow">
        <label class="f">Mode
          <select name="mode">
            <option value="upi">UPI</option><option value="netbanking">Netbanking</option>
            <option value="card">Card</option><option value="cash">Cash</option>
            <option value="cheque">Cheque</option><option value="neft">NEFT</option>
            <option value="other">Other</option>
          </select>
        </label>
        <label class="f">Reference <input name="reference" maxlength="120" placeholder="UTR / receipt no."></label>
      </div>
    </div>`);
  const footer = h('<div><button class="btn primary" data-testid="pay-save">Record payment</button></div>');
  const { close } = openModal('Record a payment', body, footer);

  footer.querySelector('button').addEventListener('click', async () => {
    try {
      await post(`/deals/${dealId}/payments`, {
        instalmentId,
        amount: Number(body.querySelector('[name=amount]').value),
        mode: body.querySelector('[name=mode]').value,
        reference: body.querySelector('[name=reference]').value.trim() || undefined,
      });
      toast('Payment recorded.');
      close();
      onDone();
    } catch (err) {
      toast(err.message, 'err');
    }
  });
}

function promiseModal(instalmentId, outstanding, onDone) {
  const tomorrow = new Date(Date.now() + 86400_000).toISOString().slice(0, 10);
  const body = h(`
    <div>
      <p class="hint mt0">“I’ll pay on the 12th” becomes a date, an amount and a confidence —
        broken promises are tracked, not forgotten.</p>
      <div class="frow">
        <label class="f">Promised date <input name="date" type="date" value="${tomorrow}"></label>
        <label class="f">Amount (₹) <input name="amount" type="number" min="1" step="0.01" value="${outstanding}"></label>
      </div>
      <label class="f">Confidence
        <select name="confidence">
          <option value="high">High — gave a firm date unprompted</option>
          <option value="medium" selected>Medium</option>
          <option value="low">Low — vague or a repeat promise</option>
        </select>
      </label>
    </div>`);
  const footer = h('<div><button class="btn primary">Save promise</button></div>');
  const { close } = openModal('Promise to pay', body, footer);

  footer.querySelector('button').addEventListener('click', async () => {
    try {
      await post(`/instalments/${instalmentId}/promise`, {
        promisedDate: body.querySelector('[name=date]').value,
        amount: Number(body.querySelector('[name=amount]').value),
        confidence: body.querySelector('[name=confidence]').value,
      });
      toast('Promise captured.');
      close();
      onDone();
    } catch (err) {
      toast(err.message, 'err');
    }
  });
}
