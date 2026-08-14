import { get, post, put } from '../api.js';
import { esc, fmtDate, fmtINR, h, openModal, toast } from '../util.js';

/**
 * Collections — the client book (route #/advisory; the tab was renamed at the
 * floor's request, the hash stays so old links keep working).
 *
 * Everyone who has paid, and the three things that must be
 * done for each of them before paid advisory is delivered —
 *
 *   1. Added to the client group
 *   2. KYC done
 *   3. MITC signed
 *
 * A register and a checklist, deliberately not service delivery: research,
 * consent artefacts and the long-term client record stay in the advisory
 * pipeline. What lives here is the one question nobody should ever have to
 * ask — "we took their money; is their paperwork finished?"
 */
const TABS = [['', 'All'], ['active', 'Active'], ['expired', 'Expired'], ['refunded', 'Refunded']];

const CHECKS = [
  ['groupAdded', 'group_added_at', 'Group'],
  ['kycDone', 'kyc_done_at', 'KYC'],
  ['mitcDone', 'mitc_done_at', 'MITC'],
];

export async function render(outlet, me) {
  let status = '';
  let pendingOnly = false;
  const canEdit = me.role === 'admin' || me.role === 'counsellor' || me.role === 'ops';

  const draw = async () => {
    outlet.innerHTML = '<div class="spin"></div>';
    const all = await get(`/advisory${status ? `?status=${status}` : ''}`);
    const rows = pendingOnly ? all.filter((r) => Number(r.checkpoints_done) < 3) : all;
    outlet.innerHTML = '';

    const outstanding = all.filter((r) => Number(r.checkpoints_done) < 3).length;

    outlet.appendChild(h(`
      <div>
      <div class="grid cols-4" style="margin-bottom:16px">
        <div class="stat"><div class="k">Paying clients</div><div class="v">${all.length}</div>
          <div class="s">money actually received</div></div>
        <div class="stat ${outstanding ? 'tone-bad' : 'tone-good'}">
          <div class="k">Paperwork open</div><div class="v">${outstanding}</div>
          <div class="s">group, KYC or MITC missing</div></div>
        ${(() => {
          const owed = all.reduce((a, r) => a + Number(r.outstanding ?? 0), 0);
          const owing = all.filter((r) => Number(r.outstanding) > 0).length;
          return `<div class="stat ${owed ? 'tone-bad' : 'tone-good'}">
            <div class="k">Still to collect</div><div class="v">${fmtINR(owed)}</div>
            <div class="s">${owing} client${owing === 1 ? '' : 's'} part-paid</div></div>`;
        })()}
        <div class="stat"><div class="k">Active</div>
          <div class="v">${all.filter((r) => r.client_status === 'active').length}</div>
          <div class="s">subscription running</div></div>
      </div>

      <div class="panel">
        <div class="row spread wrap">
          <h2 class="mt0">Everyone who has paid <small>${rows.length} record${rows.length === 1 ? '' : 's'} — one per product bought</small></h2>
          <div class="row" style="gap:8px">
            <div class="chips" style="margin:0">
              ${TABS.map(([v, l]) => `<button class="chip ${v === status ? 'on' : ''}" data-status="${v}">${l}</button>`).join('')}
              <button class="chip ${pendingOnly ? 'on' : ''}" data-pending="1">Paperwork open</button>
            </div>
            ${canEdit ? '<button class="btn primary" id="add-client">Add a client</button>' : ''}
          </div>
        </div>
        ${rows.length === 0 ? '<div class="empty">Nobody in this list yet. A client appears here the moment a payment is recorded against their deal.</div>' : `
        <div style="overflow-x:auto">
        <table class="table"><thead><tr>
          <th>Client</th><th>Product</th>
          <th class="num" title="The full fee agreed">Total</th>
          <th class="num" title="Money actually received">Paid</th>
          <th class="num" title="Still to collect">Due</th>
          <th>Last payment</th>
          <th title="Who converted this client, and their team">Converted by</th><th>Status</th>
          <th title="Added to the client group">Group</th>
          <th title="KYC completed">KYC</th>
          <th title="MITC signed">MITC</th>
          <th>Subscription ends</th>
        </tr></thead><tbody>
        ${rows.map((r, i) => `
          <tr${Number(r.checkpoints_done) < 3 ? ' class="radar-hot"' : ''}>
            <td><a href="#/lead/${esc(r.lead_id)}"><b>${esc(r.full_name ?? 'Unnamed')}</b></a>
                ${r.is_manual ? '<span class="badge b-mute" title="Entered by hand, not through a recorded sale">manual</span>' : ''}
                <span class="hint mono">${esc(r.phone_e164)}</span>
                ${canEdit ? `<div style="margin-top:4px"><button class="btn small act-edit" data-i="${i}"
                  title="Correct the name, phone${r.is_manual ? ', product, amount, who converted them or the source' : ''}"
                  data-testid="edit-client">✎ Edit</button></div>` : ''}</td>
            <td>${esc(r.product)}${r.source ? `<div class="hint">${esc(r.source)}</div>` : ''}</td>
            <td class="num">${fmtINR(r.booked_amount)}</td>
            <td class="num">${fmtINR(r.paid_amount)}</td>
            <td class="num">${Number(r.outstanding) > 0
              ? `<b style="color:var(--bad)">${fmtINR(r.outstanding)}</b>${r.balance_due_on
                  ? `<div class="hint">${r.balance_overdue ? 'overdue since ' : 'by '}${esc(fmtDate(r.balance_due_on))}</div>`
                  : ''}`
              : '<span class="hint">—</span>'}</td>
            <td>${esc(fmtDate(r.last_paid_at))}</td>
            <td>${esc(r.counsellor_name ?? '—')}${r.team_name ? `<div class="hint">${esc(r.team_name)}</div>` : ''}</td>
            <td>${r.client_status === 'active' ? '<span class="badge b-ok">active</span>'
                : r.client_status === 'expired' ? '<span class="badge b-warn">expired</span>'
                : '<span class="badge b-bad">refunded</span>'}</td>
            ${CHECKS.map(([key, col]) => `
              <td><label class="ck" style="white-space:nowrap">
                <input type="checkbox" data-deal="${esc(r.deal_id)}" data-k="${key}"
                  ${r[col] ? 'checked disabled' : ''} ${canEdit ? '' : 'disabled'}>
                <span class="hint">${r[col] ? esc(fmtDate(r[col])) : 'pending'}</span>
              </label></td>`).join('')}
            <td>${canEdit
                ? `<input type="date" data-deal="${esc(r.deal_id)}" data-k="subEnd"
                     value="${r.subscription_ends_at ? esc(String(r.subscription_ends_at).slice(0, 10)) : ''}"
                     style="border:1px solid var(--line);border-radius:7px;padding:5px;width:140px">`
                : esc(fmtDate(r.subscription_ends_at))}</td>
          </tr>`).join('')}
        </tbody></table></div>
        <div class="hint" style="margin-top:8px">
          Highlighted rows are missing a checkpoint — money is in and the group, KYC or
          MITC is not done. Ticks are one-way and record who ticked them and when;
          service delivery itself stays in the advisory pipeline, not in this CRM.
        </div>`}
      </div>
      </div>`));

    outlet.querySelectorAll('[data-status]').forEach((b) =>
      b.addEventListener('click', () => { status = b.dataset.status; draw(); }));
    outlet.querySelector('[data-pending]')?.addEventListener('click', () => {
      pendingOnly = !pendingOnly; draw();
    });
    outlet.querySelector('#add-client')?.addEventListener('click', () => addClientModal(draw, me));
    outlet.querySelectorAll('.act-edit').forEach((b) =>
      b.addEventListener('click', () => editClientModal(rows[Number(b.dataset.i)], me, draw)));

    outlet.querySelectorAll('input[type=checkbox][data-deal]').forEach((cb) =>
      cb.addEventListener('change', async () => {
        if (!cb.checked) return;
        const label = CHECKS.find(([k]) => k === cb.dataset.k)?.[2] ?? 'Checkpoint';
        try {
          await put(`/advisory/${cb.dataset.deal}`, { [cb.dataset.k]: true });
          toast(`${label} recorded with your name and the time.`);
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

/**
 * Add a client who arrived outside the normal flow.
 *
 * This builds a real lead, deal and payment — the same objects a recorded sale
 * creates — so the client behaves identically everywhere and counts in the
 * same totals. It is marked "manual" so reporting stays honest about how they
 * arrived, not to give them a separate life.
 *
 * "Converted by" and "Lead source" are on the form because the person typing
 * is often not the person who made the sale: the deal, its team and the
 * collections chasing all follow the named counsellor, and the source keeps
 * source reporting honest. Also opened from Collections → Punch in a payment
 * for a client who is not in the book yet — `prefill` carries whatever was
 * already typed into the search box.
 */
export async function addClientModal(onDone, me = null, prefill = {}) {
  const [products, mentorList, options] = await Promise.all([
    get('/advisory/products'),
    get('/mentors/book').then((b) => b.mentors).catch(() => []),
    get('/advisory/entry-options').catch(() => ({ counsellors: [], sources: [] })),
  ]);
  const today = new Date().toISOString().slice(0, 10);

  // A counsellor entering their own sale is the common case — preselect them.
  // An admin or ops person is doing data entry for somebody else's sale, so
  // they must say whose; "recorded by" is already captured automatically.
  const iAmListed = options.counsellors.some((c) => c.id === me?.id);
  const convOptions = [
    `<option value="" disabled ${me?.role === 'counsellor' && iAmListed ? '' : 'selected'}>— who converted them? —</option>`,
    ...options.counsellors.map((c) =>
      `<option value="${esc(c.id)}" ${c.id === me?.id ? 'selected' : ''}>${esc(c.full_name)}${
        c.team_name ? ` — ${esc(c.team_name)}` : ''}</option>`),
    ...(me && !iAmListed
      ? ['<option value="self">' + esc(me.full_name) + ' (me — no counsellor credit)</option>']
      : []),
  ].join('');

  const sourceOptions = options.sources.map((s) =>
    `<option value="${esc(s.id)}" ${s.name === 'Manual entry' ? 'selected' : ''}>${esc(s.name)}</option>`).join('');

  const bodyEl = h(`
    <div>
      <div class="hint" style="margin-bottom:10px">
        For a client who paid outside the CRM — an offline sale, a migrated record,
        a payment taken before this system. Everyone who pays <b>through</b> the CRM
        appears automatically; you never need this for them.
      </div>
      <label class="f">Full name <input name="name" required value="${esc(prefill.name ?? '')}"></label>
      <div class="frow">
        <label class="f">Phone <input name="phone" placeholder="98xxxxxxxx" required value="${esc(prefill.phone ?? '')}"></label>
        <label class="f">Paid on <input type="date" name="paid" value="${today}" max="${today}"></label>
      </div>
      <div id="known-client"></div>
      <div class="frow">
        <label class="f">Converted by <span class="hint">the deal and its team follow this person</span>
          <select name="conv" data-testid="entry-converted-by">${convOptions}</select>
        </label>
        <label class="f">Lead source <span class="hint">where they originally came from</span>
          <select name="source" data-testid="entry-source">${sourceOptions}</select>
        </label>
      </div>
      <label class="f">Product / plan they bought
        <select name="product">
          ${products.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('')}
        </select>
      </label>
      <div class="frow">
        <label class="f">Total payment (₹) <span class="hint">the full fee agreed</span>
          <input type="number" name="total" min="1" step="1" required data-testid="entry-total">
        </label>
        <label class="f">Down payment (₹) <span class="hint">received now</span>
          <input type="number" name="amount" min="1" step="1" required data-testid="entry-down">
        </label>
      </div>
      <div id="balance-line"></div>
      <div class="frow">
        <label class="f">Mode
          <select name="mode">
            ${['upi', 'cash', 'neft', 'card', 'netbanking', 'cheque', 'other']
              .map((m) => `<option value="${m}">${m}</option>`).join('')}
          </select>
        </label>
        <label class="f" id="balance-due-wrap" style="display:none">Balance due by
          <input type="date" name="balanceDue" data-testid="entry-balance-due">
        </label>
      </div>
      <label class="f">Reference / note <input name="note" maxlength="300" placeholder="UTR, receipt no., or why this was entered by hand"></label>
      <label class="f">Assign a mentor <span class="hint">optional — can be set later on the Mentors tab</span>
        <select name="mentor">
          <option value="">— none yet —</option>
          ${mentorList.map((m) => `<option value="${esc(m.id)}">${esc(m.full_name)}</option>`).join('')}
        </select>
      </label>
    </div>`);

  const footer = h('<div><button class="btn primary" data-testid="entry-save">Add client</button></div>');
  const { close } = openModal('Add a paying client', bodyEl, footer);
  const v = (n) => bodyEl.querySelector(`[name=${n}]`).value.trim();

  /**
   * The truth while you type: if the phone already belongs to someone in the
   * book, say so HERE — who they are, what is open, with whom — and offer to
   * record this payment against the existing deal in one click, instead of
   * letting the whole form be filled and refused at the end.
   */
  const known = bodyEl.querySelector('#known-client');
  const showKnown = async () => {
    const phone = v('phone');
    if (phone.replace(/[^0-9]/g, '').length < 10) { known.innerHTML = ''; return; }
    let found = null;
    try { found = (await get(`/advisory/lookup?phone=${encodeURIComponent(phone)}`)).found; }
    catch { return; }
    if (!found) { known.innerHTML = ''; return; }

    const deals = found.open_deals ?? [];
    known.innerHTML = `
      <div class="panel" style="padding:10px 12px;margin:0 0 12px;border:1px solid var(--warn, #b58900)">
        <b>${esc(found.full_name ?? 'This number')} is already in the book</b>
        ${deals.length === 0 ? `
          <div class="hint">No open deal (status: ${esc(found.status)}). Saving this form adds a new
          deal to the same person — nothing gets duplicated.</div>` : deals.map((d, i) => `
          <div class="row spread" style="margin-top:8px">
            <span class="hint"><b>${esc(d.product)}</b> — ${fmtINR(d.paid_amount)} paid of
              ${fmtINR(d.booked_amount)}, with ${esc(d.counsellor_name ?? '—')}${d.team_name ? ` (${esc(d.team_name)})` : ''}</span>
            ${d.mine && Number(d.outstanding) > 0
              ? `<button class="btn small primary" data-pay="${i}" data-testid="pay-existing">Record this payment against it</button>`
              : d.mine
              ? '<span class="hint">fully paid — more money for the same product means correcting the amount (✎ Edit on their row); a new product goes below</span>'
              : '<span class="hint">recorded by that team or an admin</span>'}
          </div>`).join('')}
        ${deals.length ? '<div class="hint" style="margin-top:6px">A different product is a new purchase — just pick it below and save as usual.</div>' : ''}
      </div>`;

    known.querySelectorAll('[data-pay]').forEach((b) =>
      b.addEventListener('click', async () => {
        const deal = deals[Number(b.dataset.pay)];
        if (!v('amount')) { toast('Enter the amount first — then one click records it.', 'err'); return; }
        b.disabled = true;
        try {
          const r = await post('/collections/punch-in', {
            dealId: deal.deal_id,
            amount: Number(v('amount')),
            mode: v('mode'),
            reference: v('note').slice(0, 120) || undefined,
            paidOn: v('paid') || undefined,
          });
          toast(`${fmtINR(v('amount'))} recorded for ${found.full_name ?? 'the client'} — ${
            fmtINR(r.deal?.outstanding ?? 0)} still outstanding on ${deal.product}.`);
          close();
          onDone();
        } catch (err) { toast(err.message, 'err'); b.disabled = false; }
      }));
  };
  let lookupTimer = null;
  bodyEl.querySelector('[name=phone]').addEventListener('input', () => {
    clearTimeout(lookupTimer);
    lookupTimer = setTimeout(showKnown, 350);
  });
  if (prefill.phone) showKnown();

  /**
   * Total vs down payment: the balance is shown as it is typed, and the
   * "due by" date only appears when there is actually something to chase.
   * Typing the total mirrors into the down payment until somebody edits it,
   * so a client who paid in full is still one number.
   */
  const totalInp = bodyEl.querySelector('[name=total]');
  const downInp = bodyEl.querySelector('[name=amount]');
  const dueWrap = bodyEl.querySelector('#balance-due-wrap');
  const dueInp = bodyEl.querySelector('[name=balanceDue]');
  const balanceLine = bodyEl.querySelector('#balance-line');
  let downTouched = false;

  const inThirtyDays = new Date(Date.now() + 30 * 86400_000).toISOString().slice(0, 10);
  dueInp.value = inThirtyDays;
  dueInp.min = today;

  const drawBalance = () => {
    const total = Number(totalInp.value || 0);
    const down = Number(downInp.value || 0);
    const balance = Math.round((total - down) * 100) / 100;
    if (!total || !down) { balanceLine.innerHTML = ''; dueWrap.style.display = 'none'; return; }
    if (down > total) {
      balanceLine.innerHTML = `<div class="hint" style="color:var(--bad);margin:-4px 0 10px">
        The down payment cannot be more than the total.</div>`;
      dueWrap.style.display = 'none';
      return;
    }
    dueWrap.style.display = balance > 0 ? '' : 'none';
    balanceLine.innerHTML = balance > 0
      ? `<div class="hint" style="margin:-4px 0 10px">
           <b>${esc(fmtINR(balance))} still to collect</b> — it becomes an instalment on
           Outstanding payments, so it gets chased like any other due amount.</div>`
      : '<div class="hint" style="margin:-4px 0 10px">Paid in full — nothing left to collect.</div>';
  };

  totalInp.addEventListener('input', () => {
    if (!downTouched) downInp.value = totalInp.value;
    drawBalance();
  });
  downInp.addEventListener('input', () => { downTouched = true; drawBalance(); });

  footer.querySelector('button').addEventListener('click', async () => {
    if (!v('name') || !v('phone') || !v('total') || !v('amount')) {
      toast('Name, phone, total and down payment are all required — a client is someone who has paid.', 'err');
      return;
    }
    if (Number(v('amount')) > Number(v('total'))) {
      toast('The down payment cannot be more than the total.', 'err');
      return;
    }
    if (!v('conv')) {
      toast('Say who converted this client — the sale is credited to them.', 'err');
      return;
    }
    const balance = Number(v('total')) - Number(v('amount'));
    try {
      await post('/advisory/manual', {
        fullName: v('name'),
        phone: v('phone'),
        productId: v('product'),
        amount: Number(v('total')),
        paidAmount: Number(v('amount')),
        balanceDueOn: balance > 0 ? (v('balanceDue') || undefined) : undefined,
        paidAt: v('paid') ? new Date(`${v('paid')}T12:00:00+05:30`).toISOString() : undefined,
        mode: v('mode'),
        mentorId: v('mentor') || null,
        note: v('note') || undefined,
        counsellorId: v('conv') === 'self' ? null : v('conv') || null,
        sourceId: v('source') || null,
      });
      toast(balance > 0
        ? `Client added — ${fmtINR(balance)} still to collect, now on Outstanding payments.`
        : 'Client added — they are now on Collections and in the mentor book.');
      close();
      onDone();
    } catch (err) {
      toast(err.message, 'err');
      // The same-product refusal has a one-click way out: surface the
      // existing deal with its "record against it" button right here.
      if (/already has an open/.test(err.message ?? '')) showKnown();
    }
  });
}

/**
 * Correct a client record. What is editable depends on how the client
 * arrived: identity (name, phone) on anyone; product, amount, who converted
 * them and the lead source only on hand-entered clients — money recorded
 * through the CRM's own flow is an audit record and stays one. Every change
 * is written to the lead's history with old and new values.
 */
async function editClientModal(r, me, onDone) {
  const manual = !!r.is_manual;
  const [products, options] = await Promise.all([
    get('/advisory/products'),
    manual ? get('/advisory/entry-options').catch(() => ({ counsellors: [], sources: [] }))
           : Promise.resolve({ counsellors: [], sources: [] }),
  ]);

  const bodyEl = h(`
    <div>
      <label class="f">Full name <input name="name" value="${esc(r.full_name ?? '')}"></label>
      <label class="f">Phone <input name="phone" value="${esc(r.phone_e164 ?? '')}"></label>
      ${manual ? `
      <div class="frow">
        <label class="f">Product
          <select name="product" data-testid="edit-product">
            ${products.map((p) => `<option value="${esc(p.id)}" ${p.id === r.product_id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}
          </select>
        </label>
        <label class="f">Total payment (₹) <span class="hint">the full fee agreed</span>
          <input name="total" type="number" min="1" step="0.01"
            value="${Number(r.booked_amount)}" ${Number(r.payment_count) > 1 ? 'disabled' : ''}
            data-testid="edit-total">
        </label>
      </div>
      <div class="frow">
        <label class="f">Received so far (₹)
          <input name="amount" type="number" min="1" step="0.01"
            value="${Number(r.paid_amount)}" ${Number(r.payment_count) > 1 ? 'disabled' : ''}
            data-testid="edit-amount">
        </label>
        <label class="f">Balance due by
          <input name="balanceDue" type="date"
            value="${r.balance_due_on ? esc(String(r.balance_due_on).slice(0, 10)) : ''}"
            ${Number(r.payment_count) > 1 ? 'disabled' : ''} data-testid="edit-balance-due">
        </label>
      </div>
      <div id="edit-balance-line"></div>
      <div class="frow">
        <label class="f">Paid on
          <input name="paidOn" type="date" max="${new Date().toISOString().slice(0, 10)}"
            value="${r.first_paid_on ? esc(String(r.first_paid_on).slice(0, 10)) : ''}"
            ${Number(r.payment_count) > 1 ? 'disabled' : ''} data-testid="edit-paid-on">
        </label>
        <label class="f">Mode
          <select name="mode" ${Number(r.payment_count) > 1 ? 'disabled' : ''}>
            ${['upi', 'cash', 'neft', 'card', 'netbanking', 'cheque', 'other']
              .map((m) => `<option value="${m}" ${m === r.first_payment_mode ? 'selected' : ''}>${m}</option>`).join('')}
          </select>
        </label>
      </div>
      <label class="f">Reference / note
        <input name="reference" maxlength="300" value="${esc(r.first_payment_reference ?? '')}"
          ${Number(r.payment_count) > 1 ? 'disabled' : ''}>
      </label>
      ${Number(r.payment_count) > 1 ? `<div class="hint" style="margin:-6px 0 10px">
        This client has ${esc(String(r.payment_count))} payments recorded, so the original entry cannot honestly be
        “corrected” — punch in the difference on Outstanding payments instead.</div>` : ''}
      <div class="frow">
        <label class="f">Converted by
          <select name="conv" data-testid="edit-converted-by">
            ${options.counsellors.map((c) => `<option value="${esc(c.id)}" ${c.id === r.counsellor_id ? 'selected' : ''}>${esc(c.full_name)}${c.team_name ? ` — ${esc(c.team_name)}` : ''}</option>`).join('')}
            ${options.counsellors.some((c) => c.id === r.counsellor_id) ? ''
              : `<option value="${esc(r.counsellor_id ?? '')}" selected>${esc(r.counsellor_name ?? '— unchanged —')}</option>`}
          </select>
        </label>
        <label class="f">Lead source
          <select name="source" data-testid="edit-source">
            ${options.sources.map((s) => `<option value="${esc(s.id)}" ${s.id === r.source_id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}
          </select>
        </label>
      </div>` : `
      <div class="hint" style="margin-bottom:10px">
        This sale was recorded through the CRM, so its money and credit are audit
        records — the name and phone can be corrected here, anything else needs
        the admin.
      </div>`}
      <div class="hint">Every change is written into the client's history — what
        it was, what it became, and your name.</div>
    </div>`);

  const footer = h('<div><button class="btn primary" data-testid="edit-save">Save corrections</button></div>');
  const { close } = openModal(`Edit ${r.full_name ?? 'client'}`, bodyEl, footer);

  // The balance follows the two numbers as they are corrected, so nobody has
  // to work out what the change did to what is still owed.
  const eLine = bodyEl.querySelector('#edit-balance-line');
  const drawEditBalance = () => {
    if (!eLine) return;
    const total = Number(bodyEl.querySelector('[name=total]')?.value || 0);
    const got = Number(bodyEl.querySelector('[name=amount]')?.value || 0);
    const balance = Math.round((total - got) * 100) / 100;
    eLine.innerHTML = !total || !got ? ''
      : got > total
        ? '<div class="hint" style="color:var(--bad);margin:-4px 0 10px">Received cannot be more than the total.</div>'
      : balance > 0
        ? `<div class="hint" style="margin:-4px 0 10px"><b>${esc(fmtINR(balance))} still to collect</b> — kept on Outstanding payments.</div>`
        : '<div class="hint" style="margin:-4px 0 10px">Paid in full — nothing left to collect.</div>';
  };
  bodyEl.querySelector('[name=total]')?.addEventListener('input', drawEditBalance);
  bodyEl.querySelector('[name=amount]')?.addEventListener('input', drawEditBalance);
  drawEditBalance();

  footer.querySelector('button').addEventListener('click', async () => {
    const v = (n) => bodyEl.querySelector(`[name=${n}]`)?.value.trim();
    // Send only what actually changed; the database ignores no-ops anyway,
    // but a quiet request is easier to reason about in the log.
    const payload = {};
    if (v('name') && v('name') !== (r.full_name ?? '')) payload.fullName = v('name');
    if (v('phone') && v('phone') !== (r.phone_e164 ?? '')) payload.phone = v('phone');
    if (manual) {
      if (v('product') && v('product') !== r.product_id) payload.productId = v('product');
      const tot = v('total');
      const amt = v('amount');
      if (tot && Number(tot) !== Number(r.booked_amount)) payload.amount = Number(tot);
      if (amt && Number(amt) !== Number(r.paid_amount)) payload.paidAmount = Number(amt);
      const due = v('balanceDue');
      if (due && due !== String(r.balance_due_on ?? '').slice(0, 10)) payload.balanceDueOn = due;
      const paidOn = v('paidOn');
      if (paidOn && paidOn !== String(r.first_paid_on ?? '').slice(0, 10)) payload.paidOn = paidOn;
      if (v('mode') && v('mode') !== (r.first_payment_mode ?? '')) payload.mode = v('mode');
      if (v('reference') !== (r.first_payment_reference ?? '')) payload.reference = v('reference');
      if (v('conv') && v('conv') !== (r.counsellor_id ?? '')) payload.counsellorId = v('conv');
      if (v('source') && v('source') !== (r.source_id ?? '')) payload.sourceId = v('source');
    }
    if (Object.keys(payload).length === 0) { close(); return; }
    try {
      await put(`/advisory/${r.deal_id}/details`, payload);
      toast('Corrected — the change is recorded on the client’s history.');
      close();
      onDone();
    } catch (err) { toast(err.message, 'err'); }
  });
}
