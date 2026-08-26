import { get, post } from '../api.js';
import { badge, esc, fmtDate, fmtINR, h, openModal, toast } from '../util.js';
import { addClientModal } from './advisory.js';

/**
 * Outstanding payments (route #/collections; renamed at the floor's request -
 * the client book took the name Collections): every open instalment, most
 * urgent first. The counsellor who closed the deal chases it - that
 * accountability is the highest-leverage rule in the build.
 */
// The team the admin was looking at, kept for the session so working through
// one team's book survives a payment being punched in.
let teamFilter = '';

export async function render(outlet, me) {
  const allRows = await get('/collections/due');
  outlet.innerHTML = '';

  // One box per team, plus the whole floor. RLS already scopes a counsellor
  // to their own team, so the chips only appear when there is genuinely more
  // than one team's book on screen - the admin's view.
  const teams = [...new Map(allRows
    .filter((r) => r.team_name)
    .map((r) => [r.team_name, true])).keys()].sort();
  if (teamFilter && !teams.includes(teamFilter)) teamFilter = '';
  const rows = teamFilter ? allRows.filter((r) => r.team_name === teamFilter) : allRows;

  const sums = (list) => {
    const od = list.filter((r) => r.status === 'overdue');
    return {
      count: list.length,
      due: list.reduce((a, r) => a + (Number(r.amount) - Number(r.paid_amount)), 0),
      overdue: od.reduce((a, r) => a + (Number(r.amount) - Number(r.paid_amount)), 0),
      overdueCount: od.length,
    };
  };
  const t = sums(rows);

  outlet.appendChild(h(`
    <div class="row spread wrap" style="margin-bottom:14px">
      ${teams.length > 1 ? `
      <div class="chips" style="margin:0" data-testid="team-chips">
        <button class="chip ${teamFilter === '' ? 'on' : ''}" data-team="">Whole floor</button>
        ${teams.map((name) => `
          <button class="chip ${teamFilter === name ? 'on' : ''}" data-team="${esc(name)}">${esc(name)}</button>`).join('')}
      </div>` : '<div></div>'}
      <button class="btn primary" id="punch-in" data-testid="punch-in">Punch in a payment</button>
    </div>
    <div class="grid cols-3" style="margin-bottom:${teams.length > 1 && !teamFilter ? '10px' : '18px'}">
      <div class="stat"><div class="k">Open instalments${teamFilter ? ` — ${esc(teamFilter)}` : ''}</div><div class="v">${t.count}</div></div>
      <div class="stat"><div class="k">Outstanding</div><div class="v">${fmtINR(t.due)}</div></div>
      <div class="stat"><div class="k">Overdue</div>
        <div class="v" style="color:${t.overdueCount ? 'var(--bad)' : 'inherit'}">${fmtINR(t.overdue)}</div>
        <div class="s">${t.overdueCount} instalment${t.overdueCount === 1 ? '' : 's'}</div></div>
    </div>
    ${teams.length > 1 && !teamFilter ? `
    <div class="row wrap" style="gap:18px;margin-bottom:18px" data-testid="team-split">
      ${teams.map((name) => {
        const ts = sums(allRows.filter((r) => r.team_name === name));
        return `
        <div>
          <div class="hint">${esc(name)}</div>
          <div style="font-weight:700">${fmtINR(ts.due)} outstanding</div>
          <div class="hint">${ts.count} instalment${ts.count === 1 ? '' : 's'}${ts.overdueCount
            ? ` · <span style="color:var(--bad)">${fmtINR(ts.overdue)} overdue</span>` : ' · nothing overdue'}</div>
        </div>`;
      }).join('')}
    </div>` : ''}`));

  outlet.querySelectorAll('[data-team]').forEach((b) =>
    b.addEventListener('click', () => { teamFilter = b.dataset.team; render(outlet, me); }));

  outlet.querySelector('#punch-in')?.addEventListener('click', () =>
    punchInModal(me, () => render(outlet, me)));

  if (rows.length === 0) {
    outlet.appendChild(h(`<div class="panel"><div class="empty">${teamFilter
      ? `Nothing outstanding for ${esc(teamFilter)}.`
      : 'Nothing outstanding. Every rupee booked has been collected.'}</div></div>`));
    return;
  }

  const panel = h(`
    <div class="panel">
      <h2>Still to collect <small>most urgent first — the closer chases their own deals</small></h2>
      <table class="table" data-testid="dues-table"><thead><tr>
        <th>Due</th><th>Client</th><th>Instalment</th><th class="num">Amount</th>
        <th>Status</th><th>Promise</th><th>Closer</th>${teams.length > 1 && !teamFilter ? '<th>Team</th>' : ''}<th></th>
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
          ${teams.length > 1 && !teamFilter ? `<td>${esc(r.team_name ?? '—')}</td>` : ''}
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


/**
 * The direct punch-in: type a name or number, pick the client, enter the
 * amount. The database spreads it oldest-instalment-first and refuses an
 * overpayment, so the person at the desk never does instalment arithmetic.
 *
 * Somebody NEW — no open deal in the book — is one button away: the same
 * Add-a-client form the Collections tab uses opens right here, prefilled with
 * whatever was typed, and asks who converted them and what the lead source
 * was. Both doors create the same audited lead + deal + payment.
 */
function punchInModal(me, onDone) {
  const today = new Date().toISOString().slice(0, 10);
  let picked = null;

  const bodyEl = h(`
    <div>
      <label class="f">Client
        <input name="q" placeholder="name, or the last digits of their number…" autocomplete="off">
      </label>
      <div id="pi-results"></div>
      <div id="pi-new-row" class="row spread" style="margin-top:10px">
        <span class="hint">Not in the book yet — a first payment from somebody new?</span>
        <button class="btn small" id="pi-new" data-testid="punch-in-new">Punch in for a new client</button>
      </div>
      <div id="pi-form" style="display:none">
        <div class="row spread" style="margin:8px 0">
          <div id="pi-picked"></div>
          <button class="btn small" id="pi-change">Change</button>
        </div>
        <div class="frow">
          <label class="f">Amount received (₹) <input name="amount" type="number" min="1" step="0.01"></label>
          <label class="f">Mode
            <select name="mode">
              ${['upi', 'cash', 'neft', 'card', 'netbanking', 'cheque', 'other']
                .map((m) => `<option value="${m}">${m}</option>`).join('')}
            </select>
          </label>
        </div>
        <div class="frow">
          <label class="f">Reference <input name="reference" maxlength="120" placeholder="UTR / receipt no."></label>
          <label class="f">Paid on <input name="paidOn" type="date" value="${today}" max="${today}"></label>
        </div>
      </div>
    </div>`);

  const footer = h('<div><button class="btn primary" id="pi-save" disabled>Record payment</button></div>');
  const { close } = openModal('Punch in a payment', bodyEl, footer);

  const qInp = bodyEl.querySelector('[name=q]');
  const results = bodyEl.querySelector('#pi-results');
  const form = bodyEl.querySelector('#pi-form');
  const saveBtn = footer.querySelector('#pi-save');

  const newRow = bodyEl.querySelector('#pi-new-row');

  bodyEl.querySelector('#pi-new').addEventListener('click', () => {
    const term = qInp.value.trim();
    const digits = term.replace(/[^0-9]/g, '');
    close();
    // Same form as Collections → Add a client: name, phone, who converted them
    // (and so which team), the lead source, product, amount, mode.
    addClientModal(() => onDone?.(), me,
      digits.length >= 6 ? { phone: term } : { name: term });
  });

  const pick = (d) => {
    picked = d;
    qInp.parentElement.style.display = 'none';
    newRow.style.display = 'none';
    results.innerHTML = '';
    form.style.display = '';
    bodyEl.querySelector('#pi-picked').innerHTML = `
      <b>${esc(d.full_name ?? 'Unnamed')}</b> <span class="hint mono">${esc(d.phone_e164)}</span>
      <div class="hint">${esc(d.product)} · ${fmtINR(d.outstanding)} outstanding of ${fmtINR(d.booked_amount)}</div>`;
    const amt = bodyEl.querySelector('[name=amount]');
    amt.value = Number(d.outstanding).toFixed(2);
    amt.max = Number(d.outstanding).toFixed(2);
    saveBtn.disabled = false;
    amt.focus();
  };

  let timer = null;
  qInp.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const term = qInp.value.trim();
      if (term.length < 2) { results.innerHTML = ''; return; }
      try {
        const found = await get(`/collections/deal-search?q=${encodeURIComponent(term)}`);
        results.innerHTML = found.length === 0
          ? '<div class="hint" style="padding:6px 0">No open deal matches — they may be fully paid, or new. For somebody new, use “Punch in for a new client” below.</div>'
          : found.map((d, i) => `
              <div class="alert-row" data-pi="${i}" style="cursor:pointer">
                <span><b>${esc(d.full_name ?? 'Unnamed')}</b>
                  <span class="hint mono">${esc(d.phone_e164)}</span></span>
                <span class="hint">${esc(d.product)}</span>
                <span class="num"><b>${fmtINR(d.outstanding)}</b> <span class="hint">due</span></span>
              </div>`).join('');
        results.querySelectorAll('[data-pi]').forEach((row) =>
          row.addEventListener('click', () => pick(found[Number(row.dataset.pi)])));
      } catch { results.innerHTML = ''; }
    }, 250);
  });

  bodyEl.querySelector('#pi-change').addEventListener('click', () => {
    picked = null;
    form.style.display = 'none';
    qInp.parentElement.style.display = '';
    newRow.style.display = '';
    saveBtn.disabled = true;
    qInp.focus();
  });

  saveBtn.addEventListener('click', async () => {
    const v = (n) => bodyEl.querySelector(`[name=${n}]`).value.trim();
    if (!picked || !v('amount')) { toast('Pick the client and enter the amount.', 'err'); return; }
    saveBtn.disabled = true;
    try {
      const r = await post('/collections/punch-in', {
        dealId: picked.deal_id,
        amount: Number(v('amount')),
        mode: v('mode'),
        reference: v('reference') || undefined,
        paidOn: v('paidOn') || undefined,
      });
      toast(`${fmtINR(v('amount'))} recorded for ${picked.full_name ?? 'the client'} — ${
        fmtINR(r.deal?.outstanding ?? 0)} still outstanding.`);
      close();
      onDone?.();
    } catch (err) { toast(err.message, 'err'); saveBtn.disabled = false; }
  });

  qInp.focus();
}
