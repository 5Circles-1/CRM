import { get, post } from '../api.js';
import { badge, esc, fmtDT, fmtINR, fmtTalk, h, localToIso, openModal, parseTalk, toast, tomorrowAt } from '../util.js';

const OPEN_STATUSES = new Set(['new', 'working', 'callback', 'qualified', 'negotiation']);

/**
 * Call outcomes come from the API, which reads them from the database enum.
 * Keeping a copy here meant every new outcome had to be added in three places,
 * and the one that got forgotten was always this one.
 */
let DISPOSITIONS = [];
let NEEDS_FOLLOWUP = new Set();

async function loadDispositions() {
  if (DISPOSITIONS.length) return;
  DISPOSITIONS = await get('/meta/dispositions');
  NEEDS_FOLLOWUP = new Set(DISPOSITIONS.filter((d) => d.followUp).map((d) => d.value));
}


export async function render(outlet, me, params) {
  const id = params[0];
  const [data] = await Promise.all([get(`/leads/${id}`), loadDispositions()]);
  const { lead } = data;
  const open = OPEN_STATUSES.has(lead.status);
  const canTransfer = me.role === 'counsellor' || me.role === 'admin';
  const canBook = canTransfer && open;

  outlet.innerHTML = '';
  outlet.appendChild(h(`
    <div class="panel">
      <div class="row spread">
        <div>
          <h2 class="mt0" style="font-size:19px" data-testid="lead-name">${esc(lead.full_name ?? 'Unnamed lead')}
            <span data-testid="lead-status">${badge(lead.status)}</span>
            ${lead.priority === 'immediate' ? '<span class="badge b-bad">immediate</span>' : ''}
          </h2>
          <div class="row" style="color:var(--muted)">
            <a href="tel:${esc(lead.phone_e164)}" class="mono" style="font-size:16px;font-weight:700">${esc(lead.phone_e164)}</a>
            ${lead.city ? `<span>· ${esc(lead.city)}</span>` : ''}
            ${lead.email ? `<span>· ${esc(lead.email)}</span>` : ''}
          </div>
        </div>
        <div class="row">
          ${open ? '<button class="btn primary" data-act="call" data-testid="log-call-btn">Log a call</button>' : ''}
          <button class="btn" data-act="whatsapp" data-testid="whatsapp-btn">${lead.whatsapp_sent_at ? '✓ WhatsApp sent' : 'Mark WhatsApp sent'}</button>
          <button class="btn" data-act="walkin" data-testid="walkin-btn">${lead.walked_in_at ? '✓ Walked in' : 'Mark walked in'}</button>
          ${open ? '<button class="btn" data-act="callback">Set callback</button>' : ''}
          ${open && me.role === 'caller' ? '<button class="btn" data-act="qualify">Qualify → counsellor</button>' : ''}
          ${open && canTransfer ? '<button class="btn" data-act="transfer" data-testid="transfer-btn">Transfer</button>' : ''}
          ${canBook ? '<button class="btn primary" data-act="deal" data-testid="book-deal-btn">Book deal</button>' : ''}
        </div>
      </div>

      <div class="grid cols-4" style="margin-top:14px">
        <div class="stat"><div class="k">Next action</div>
          <div class="v" style="font-size:15px" data-testid="next-action">${esc(fmtDT(lead.next_action_at))}</div>
          <div class="s">${esc(lead.next_action_note ?? '')}</div></div>
        <div class="stat"><div class="k">WhatsApp / walk-in</div>
          <div class="v" style="font-size:15px">${lead.whatsapp_sent_at ? esc(fmtDT(lead.whatsapp_sent_at)) : 'not sent'}</div>
          <div class="s">${lead.walked_in_at ? 'walked in ' + esc(fmtDT(lead.walked_in_at))
             : lead.walkin_expected_at ? 'expected ' + esc(fmtDT(lead.walkin_expected_at)) : 'no visit expected'}</div></div>
        <div class="stat"><div class="k">Attempts / connects</div>
          <div class="v">${Number(lead.attempt_count)} / ${Number(lead.connect_count)}</div>
          <div class="s">NA streak ${Number(lead.na_streak)} · transfers ${Number(lead.transfer_count)}</div></div>
        <div class="stat"><div class="k">Source</div>
          <div class="v" style="font-size:15px">${esc(lead.campaign_name ?? '—')}</div>
          <div class="s">${esc(lead.ad_name ?? lead.form_name ?? '')}</div></div>
        <div class="stat"><div class="k">Created</div>
          <div class="v" style="font-size:15px">${esc(fmtDT(lead.created_at))}</div>
          <div class="s">re-enquiries ${Number(lead.reenquiry_count)}</div></div>
      </div>
    </div>`));

  // Call attempts
  const attempts = h(`<div class="panel"><h2>Calls <small>${data.attempts.length}</small></h2></div>`);
  if (data.attempts.length === 0) {
    attempts.appendChild(h('<div class="empty">No calls logged yet.</div>'));
  } else {
    attempts.appendChild(h(`
      <table class="table"><thead><tr>
        <th>When</th><th>By</th><th>Disposition</th><th class="num">Duration</th><th>Verified</th><th>Notes</th>
      </tr></thead><tbody>
      ${data.attempts.map((a) => `
        <tr>
          <td>${esc(fmtDT(a.started_at))}</td>
          <td>${esc(a.by_name)}</td>
          <td>${badge(a.disposition)}${a.is_connect ? ' <span class="badge b-ok">connect</span>' : ''}</td>
          <td class="num">${esc(fmtTalk(a.duration_seconds))}</td>
          <td>${a.is_verified ? '<span class="badge b-ok">device</span>' : '<span class="badge b-mute">manual</span>'}</td>
          <td>${esc(a.notes ?? '')}</td>
        </tr>`).join('')}
      </tbody></table>`));
  }
  outlet.appendChild(attempts);

  // Timeline
  const tl = h(`<div class="panel"><h2>Timeline</h2></div>`);
  if (data.timeline.length === 0) {
    tl.appendChild(h('<div class="empty">Nothing yet.</div>'));
  } else {
    tl.appendChild(h(`<ul class="timeline">
      ${data.timeline.map((e) => `
        <li><div>${esc(eventLabel(e))}</div><div class="t">${esc(fmtDT(e.occurred_at))}</div></li>`).join('')}
    </ul>`));
  }
  outlet.appendChild(tl);

  // Assignment, not addEventListener: this view re-renders in place after
  // every action (log a call, set a callback...), and each render was stacking
  // one more listener on the same outlet - by the third call of the day,
  // pressing "Log a call" opened three copies of the modal on top of each
  // other. Assigning replaces the previous handler instead of joining it.
  outlet.onclick = async (e) => {
    const act = e.target?.dataset?.act;
    if (!act) return;
    if (act === 'call') logCallModal(lead, () => render(outlet, me, params));

    if (act === 'whatsapp' || act === 'walkin') {
      const sent = act === 'whatsapp' ? !lead.whatsapp_sent_at : !lead.walked_in_at;
      try {
        await post(`/leads/${lead.id}/${act}`,
          act === 'whatsapp' ? { sent } : { walkedIn: sent });
        toast(act === 'whatsapp'
          ? (sent ? 'Marked as messaged on WhatsApp.' : 'WhatsApp mark cleared.')
          : (sent ? 'Marked as walked in.' : 'Walk-in mark cleared.'));
        render(outlet, me, params);
      } catch (err) {
        toast(err.message, 'err');
      }
      return;
    }
    if (act === 'callback') callbackModal(lead, () => render(outlet, me, params));
    if (act === 'qualify') qualifyModal(lead, () => render(outlet, me, params));
    if (act === 'transfer') transferModal(lead, () => render(outlet, me, params));
    if (act === 'deal') dealModal(lead, () => render(outlet, me, params));
  };
}

function eventLabel(e) {
  const p = e.payload ?? {};
  switch (e.event_type) {
    case 'assigned': return 'Assigned to a caller';
    case 'assignment_deferred': return 'Arrived while nobody was on the floor — held for shift start';
    case 'call_logged': return `Call logged: ${String(p.disposition ?? '').replace(/_/g, ' ')} · ${fmtTalk(p.duration_seconds)}${p.is_connect ? ' · connect' : ''}${p.verified ? ' · device-verified' : ''}`;
    case 'callback_scheduled': return `Callback set for ${fmtDT(p.scheduled_at)}${p.note ? ` — “${p.note}”` : ''}`;
    case 'callback_missed': return `Callback missed (was due ${fmtDT(p.scheduled_at)})`;
    case 'transferred': return `Transferred to another caller (${String(p.reason ?? '').replace(/_/g, ' ')})`;
    case 'qualified': return 'Qualified — handed to the counsellor';
    case 'deal_booked': return `Deal booked · ${fmtINR(p.amount)}`;
    case 're_enquiry': return 'Re-enquired through a lead form — priority raised';
    case 'parked_nurture': return 'Parked in nurture after exhausting attempts';
    default: return String(e.event_type).replace(/_/g, ' ');
  }
}

/* ------------------------------------------------------------------ */

function logCallModal(lead, onDone) {
  const body = h(`
    <div>
      <div id="suggestion-slot"></div>
      <label class="f">What happened?
        <select name="disposition" data-testid="disposition">
          ${DISPOSITIONS.map((d) => `<option value="${esc(d.value)}">${esc(d.label)}</option>`).join('')}
        </select>
      </label>
      <div class="frow">
        <label class="f">Talk time <span class="hint">mm:ss — e.g. 3:07</span>
          <input name="duration" inputmode="numeric" placeholder="0:00" value="0:00" data-testid="duration">
        </label>
      </div>
      <div id="followup" style="display:none">
        <div class="frow">
          <label class="f"><span id="followup-label">Callback time</span>
            <input name="callbackAt" type="datetime-local" value="${tomorrowAt(11)}" data-testid="callback-at">
          </label>
        </div>
        <label class="f">Callback note
          <input name="callbackNote" maxlength="500" placeholder="e.g. Call after 4pm, discuss annual plan">
        </label>
      </div>
      <label class="f">Notes
        <textarea name="notes" rows="2" maxlength="2000"></textarea>
      </label>
      <input type="hidden" name="deviceLogId" value="">
      <div class="hint">A call cannot be closed without a next step: pick a terminal outcome,
        set a callback, or the system schedules the retry itself.</div>
    </div>`);

  const footer = h(`<div><button class="btn primary" data-testid="save-call">Save call</button></div>`);
  const { close } = openModal('Log a call', body, footer);

  const sel = body.querySelector('[name=disposition]');
  const followup = body.querySelector('#followup');
  const followupLabel = body.querySelector('#followup-label');
  const syncFollowup = () => {
    const needs = NEEDS_FOLLOWUP.has(sel.value);
    followup.style.display = needs ? '' : 'none';
    followupLabel.textContent = sel.value === 'callback_requested'
      ? 'Callback time (client asked)'
      : 'Next follow-up (required for an interested client)';
  };
  sel.addEventListener('change', syncFollowup);
  syncFollowup();

  // If the device log already saw this call, offer it: one click makes the
  // attempt verified and the duration honest.
  get(`/leads/${lead.id}/device-log-suggestion`).then(({ suggestion }) => {
    if (!suggestion) return;
    const slot = body.querySelector('#suggestion-slot');
    slot.appendChild(h(`
      <div class="banner" style="background:var(--info-bg);color:var(--info);border-color:#c7d7f8">
        Phone shows a ${esc(suggestion.direction)} call of ${esc(fmtTalk(suggestion.duration_seconds))} at
        ${esc(fmtDT(suggestion.started_at))}.
        <button class="btn small" style="margin-left:8px" data-testid="use-suggestion">Use it</button>
      </div>`));
    slot.querySelector('[data-testid=use-suggestion]').addEventListener('click', () => {
      body.querySelector('[name=duration]').value = fmtTalk(suggestion.duration_seconds);
      body.querySelector('[name=deviceLogId]').value = suggestion.id;
      slot.firstElementChild.textContent = 'Linked to the device call — this dial counts as verified.';
    });
  }).catch(() => {});

  footer.querySelector('[data-testid=save-call]').addEventListener('click', async () => {
    const disposition = sel.value;
    const seconds = parseTalk(body.querySelector('[name=duration]').value);
    if (seconds === null) {
      toast('Talk time should look like 3:07, or just a number of seconds.', 'err');
      return;
    }
    const payload = {
      disposition,
      durationSeconds: seconds,
      notes: body.querySelector('[name=notes]').value.trim() || undefined,
      deviceLogId: body.querySelector('[name=deviceLogId]').value || undefined,
    };
    if (NEEDS_FOLLOWUP.has(disposition)) {
      const at = body.querySelector('[name=callbackAt]').value;
      if (!at) { toast('Set the follow-up time first.', 'err'); return; }
      payload.callbackAt = localToIso(at);
      payload.callbackNote = body.querySelector('[name=callbackNote]').value.trim() || undefined;
    }
    try {
      await post(`/leads/${lead.id}/calls`, payload);
      toast('Call saved.');
      close();
      onDone();
    } catch (err) {
      toast(err.message, 'err');
    }
  });
}

function callbackModal(lead, onDone) {
  const body = h(`
    <div>
      <label class="f">When should we call?
        <input name="at" type="datetime-local" value="${tomorrowAt(11)}">
      </label>
      <label class="f">Note
        <input name="note" maxlength="500" placeholder="What the client said">
      </label>
    </div>`);
  const footer = h(`<div><button class="btn primary">Save callback</button></div>`);
  const { close } = openModal('Set a callback', body, footer);

  footer.querySelector('button').addEventListener('click', async () => {
    const at = body.querySelector('[name=at]').value;
    if (!at) { toast('Pick a time.', 'err'); return; }
    try {
      await post(`/leads/${lead.id}/callbacks`, {
        scheduledAt: localToIso(at),
        note: body.querySelector('[name=note]').value.trim() || undefined,
      });
      toast('Callback saved — it is now this lead’s next action.');
      close();
      onDone();
    } catch (err) {
      toast(err.message, 'err');
    }
  });
}

function qualifyModal(lead, onDone) {
  const body = h(`
    <div>
      <p class="hint mt0">Hands this lead to your counsellor with a fresh next action.</p>
      <label class="f">What makes them ready?
        <textarea name="note" rows="3" maxlength="1000" placeholder="Budget, interest, timeline…"></textarea>
      </label>
    </div>`);
  const footer = h(`<div><button class="btn primary">Qualify</button></div>`);
  const { close } = openModal('Qualify to counsellor', body, footer);

  footer.querySelector('button').addEventListener('click', async () => {
    try {
      await post(`/leads/${lead.id}/qualify`, {
        note: body.querySelector('[name=note]').value.trim() || undefined,
      });
      toast('Qualified — the counsellor has it now.');
      close();
      onDone();
    } catch (err) {
      toast(err.message, 'err');
    }
  });
}

async function transferModal(lead, onDone) {
  const targets = await get('/transfers/targets').catch(() => []);
  const body = h(`
    <div>
      <label class="f">Give this lead to
        <select name="to" data-testid="transfer-target">
          ${targets
            .filter((t) => t.id !== lead.caller_id)
            .map((t) => `<option value="${esc(t.id)}">${esc(t.full_name)} — ${t.on_shift ? 'on floor' : 'off floor'}, ${Number(t.leads_today)} today</option>`)
            .join('')}
        </select>
      </label>
      <label class="f">Reason
        <select name="reason" data-testid="transfer-reason">
          <option value="not_answered_streak">Not answered repeatedly</option>
          <option value="language_mismatch">Language mismatch</option>
          <option value="caller_unavailable">Caller unavailable</option>
          <option value="load_balance">Load balancing</option>
          <option value="escalation">Escalation</option>
          <option value="other">Other</option>
        </select>
      </label>
      <label class="f">Note <input name="note" maxlength="500"></label>
      <div class="hint">Transfers are capped at 2 per lead; after that it parks in nurture.</div>
    </div>`);
  const footer = h(`<div><button class="btn primary" data-testid="transfer-save">Transfer</button></div>`);
  const { close } = openModal('Transfer lead', body, footer);

  footer.querySelector('button').addEventListener('click', async () => {
    try {
      await post(`/leads/${lead.id}/transfer`, {
        toCallerId: body.querySelector('[name=to]').value,
        reason: body.querySelector('[name=reason]').value,
        note: body.querySelector('[name=note]').value.trim() || undefined,
      });
      toast('Transferred.');
      close();
      onDone();
    } catch (err) {
      toast(err.message, 'err');
    }
  });
}

async function dealModal(lead, onDone) {
  const products = await get('/products');
  const body = h(`
    <div>
      <label class="f">Product
        <select name="product" data-testid="deal-product">
          ${products.map((p) => `<option value="${esc(p.id)}" data-price="${esc(p.list_price_inr)}">${esc(p.name)} — ${fmtINR(p.list_price_inr)}${p.is_sebi_regulated ? '' : ' (non-SEBI)'}</option>`).join('')}
        </select>
      </label>
      <div class="frow">
        <label class="f">Booked amount (₹) <input name="amount" type="number" min="1" step="0.01" data-testid="deal-amount"></label>
        <label class="f">Discount (₹) <input name="discount" type="number" min="0" step="0.01" value="0"></label>
      </div>
      <div class="f" style="font-weight:600;color:var(--muted);font-size:13.5px">Instalments <span class="hint">(must sum to the booked amount)</span></div>
      <div id="inst-rows"></div>
      <button class="btn small" id="add-inst">+ Add instalment</button>
    </div>`);

  const rows = body.querySelector('#inst-rows');
  const addRow = (date = '', amount = '') => {
    const row = h(`
      <div class="frow" style="margin-bottom:8px">
        <label class="f" style="margin:0">Due <input type="date" class="i-date" value="${esc(date)}"></label>
        <label class="f" style="margin:0">Amount <input type="number" class="i-amt" min="1" step="0.01" value="${esc(amount)}"></label>
        <button class="btn small danger" style="align-self:end">✕</button>
      </div>`);
    row.querySelector('.danger').addEventListener('click', () => row.remove());
    rows.appendChild(row);
  };
  const today = new Date().toISOString().slice(0, 10);
  addRow(today);
  body.querySelector('#add-inst').addEventListener('click', addRow);

  const amountInput = body.querySelector('[name=amount]');
  const productSel = body.querySelector('[name=product]');
  const syncPrice = () => {
    const opt = productSel.selectedOptions[0];
    if (opt && !amountInput.value) amountInput.value = Number(opt.dataset.price);
  };
  productSel.addEventListener('change', () => { amountInput.value = ''; syncPrice(); });
  syncPrice();

  const footer = h(`<div><button class="btn primary" data-testid="deal-save">Book deal</button></div>`);
  const { close } = openModal('Book a deal', body, footer);

  footer.querySelector('button').addEventListener('click', async () => {
    const instalments = [...rows.querySelectorAll('.frow')].map((r) => ({
      dueDate: r.querySelector('.i-date').value,
      amount: Number(r.querySelector('.i-amt').value),
    }));
    if (instalments.some((i) => !i.dueDate || !(i.amount > 0))) {
      toast('Every instalment needs a date and an amount.', 'err');
      return;
    }
    try {
      await post(`/leads/${lead.id}/deals`, {
        productId: productSel.value,
        bookedAmount: Number(amountInput.value),
        discountAmount: Number(body.querySelector('[name=discount]').value) || 0,
        instalments,
      });
      toast('Deal booked — the lead is won and collection is now tracked.');
      close();
      onDone();
    } catch (err) {
      toast(err.message, 'err');
    }
  });
}
