import { get, post } from '../api.js';
import { esc, fmtDT, fmtINR, h, openModal, toast, tomorrowAt, localToIso } from '../util.js';
import { barChart, statTile } from '../charts.js';

/**
 * The Office visits tab: a walk-in from the moment it is booked to the moment
 * the counsellor says what happened.
 *
 * This tab exists because "office visits to conversions" was not a ratio the
 * CRM could compute. A visit was one timestamp on the lead - it could say a
 * visit happened and nothing else, so the numerator (deals, per counsellor)
 * and the denominator (walk-ins, belonging to nobody) could not be divided.
 *
 * Three lists, in the order the office works them:
 *   Expected   - booked in by a caller, not here yet
 *   At the desk - in the building, waiting for the counselling response
 *   Answered for - counselled today, with what was said
 *
 * The one rule worth knowing before using it: you never mark a visit
 * "converted". You book the deal, and the visit is marked converted for you.
 * That is why the ratio on this page and the money on Collections can never
 * disagree.
 */

const OUTCOME_LABEL = {
  converted: '🏆 Converted',
  thinking: '🤔 Thinking it over',
  revisit: '🔁 Coming back in',
  not_interested: '✖ Not interested',
  not_eligible: '⛔ Not eligible',
  no_show: '👻 Did not come',
};

const OUTCOME_BADGE = {
  converted: 'b-ok',
  thinking: 'b-warn',
  revisit: 'b-info',
  not_interested: 'b-mute',
  not_eligible: 'b-mute',
  no_show: 'b-bad',
};

const istToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());

const shiftDays = (ymd, days) => {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

/** The window survives leaving and returning, like Overview's. */
let range = null;

function presets() {
  const today = istToday();
  const monthStart = `${today.slice(0, 7)}-01`;
  return [
    { label: 'Today', from: today, to: today },
    { label: 'Last 7 days', from: shiftDays(today, -6), to: today },
    { label: 'This month', from: monthStart, to: today },
    { label: 'Last 30 days', from: shiftDays(today, -29), to: today },
  ];
}

const pct = (v) => (v === null || v === undefined ? '—' : `${Number(v)}%`);

export async function render(outlet, me) {
  if (!range) range = presets()[2];
  const canCounsel = me.role === 'counsellor' || me.role === 'admin';

  const draw = async () => {
    outlet.innerHTML = '<div class="spin"></div>';
    const [desk, stats] = await Promise.all([
      get('/walkins/desk'),
      get(`/dashboards/walkins?from=${range.from}&to=${range.to}`),
    ]);
    outlet.innerHTML = '';

    drawExplainer(outlet, me, canCounsel, desk, draw);
    drawDesk(outlet, desk, me, canCounsel, draw);
    drawRatio(outlet, stats, range, draw);
  };

  await draw();
}

/* ------------------------------------------------------------------ */

function drawExplainer(outlet, me, canCounsel, desk, redraw) {
  const panel = h(`
    <div class="panel" data-testid="walkin-explainer">
      <div class="row spread wrap">
        <h2 class="mt0">Office visits <small>booked in, walked in, counselled, converted</small></h2>
        <div class="row" style="gap:8px">
          ${canCounsel ? '<button class="btn primary" data-act="punch" data-testid="punch-walkin">＋ Punch in a walk-in</button>' : ''}
          <button class="btn" data-act="book" data-testid="book-walkin">📅 Book a visit</button>
        </div>
      </div>
      <div class="grid cols-3">
        <div>
          <div class="section-h">How a visit gets here</div>
          <p class="hint" style="margin:0">
            <b>Either door.</b> A <b>caller books it</b> from the lead — "Send to counsellor" —
            naming the counsellor and the day; it lands under <b>Expected</b>.
            Or a <b>counsellor punches it in</b> at the desk when somebody walks through the
            door, booked or not. A booked client who turns up is completed, never duplicated,
            so one person is one visit.
          </p>
        </div>
        <div>
          <div class="section-h">What the counsellor does</div>
          <p class="hint" style="margin:0">
            When the counselling is finished, press <b>Record response</b> and say what
            happened — thinking it over, coming back in, not interested, not eligible.
            That is the feedback the whole ratio is built on, and a visit left with no
            response is flagged on this tab until somebody records one.
          </p>
        </div>
        <div>
          <div class="section-h">How a conversion is counted</div>
          <p class="hint" style="margin:0">
            <b>You never type "converted".</b> Book the deal the way you always have and this
            visit is marked converted for you, carrying the product and the amount across.
            That is deliberate: a hand-typed conversion is a second record of the money, and
            two records of the same money always drift apart.
          </p>
        </div>
      </div>
    </div>`);

  panel.addEventListener('click', (e) => {
    const act = e.target?.dataset?.act;
    if (act === 'punch') punchInModal(desk.counsellors, me, redraw);
    if (act === 'book') bookVisitModal(desk.counsellors, me, redraw);
  });
  outlet.appendChild(panel);
}

/* ------------------------------------------------------------------ */

function drawDesk(outlet, desk, me, canCounsel, redraw) {
  const visits = desk.visits ?? [];
  const expected = visits.filter((v) => v.status === 'expected');
  const atDesk = visits.filter((v) => v.status === 'arrived');
  const done = visits.filter((v) => v.status === 'counselled' || v.status === 'no_show');
  const waiting = atDesk.filter((v) => v.response_overdue);

  const tiles = h('<div class="grid cols-4" style="margin-bottom:16px"></div>');
  tiles.appendChild(statTile('At the desk now', atDesk.length, 'in the building'));
  tiles.appendChild(statTile('Expected', expected.length, 'booked in, not here yet'));
  tiles.appendChild(statTile('Counselled today', done.length, 'response recorded'));
  tiles.appendChild(statTile('Waiting on a response', waiting.length,
    waiting.length ? 'a client has been seen and nothing recorded' : 'nothing outstanding',
    waiting.length ? 'bad' : 'good'));
  outlet.appendChild(tiles);

  const section = (title, sub, rows, kind) => {
    const panel = h(`
      <div class="panel" data-testid="walkin-${kind}">
        <h2 class="mt0">${esc(title)} <small>${esc(sub)}</small></h2>
      </div>`);
    if (rows.length === 0) {
      panel.appendChild(h(`<div class="empty">${
        kind === 'expected' ? 'Nobody is booked in. A caller books a visit from the lead page.'
        : kind === 'desk' ? 'Nobody is waiting at the desk.'
        : 'No counselling recorded today yet.'}</div>`));
      outlet.appendChild(panel);
      return;
    }
    panel.appendChild(h(`
      <div style="overflow-x:auto">
      <table class="table"><thead><tr>
        <th>Client</th><th>City</th><th>Sent in by</th><th>Counsellor</th>
        <th>${kind === 'expected' ? 'Expected' : kind === 'desk' ? 'Arrived' : 'Counselled'}</th>
        ${kind === 'answered' ? '<th>Response</th><th>Product</th><th class="num">Booked</th>' : ''}
        <th></th>
      </tr></thead><tbody>
      ${rows.map((v) => `
        <tr>
          <td>
            <a class="linklike" data-lead="${esc(v.lead_id)}"><b>${esc(v.full_name ?? 'Unnamed')}</b></a>
            <span class="hint mono">${esc(v.phone_e164)}</span>
            ${v.green_reason ? '<span class="badge b-ok" title="Showed real intent">🟢</span>' : ''}
          </td>
          <td>${esc(v.city ?? '—')}</td>
          <td>${esc(v.caller_name ?? '—')}</td>
          <td>${esc(v.counsellor_name ?? '—')}</td>
          <td>${esc(fmtDT(v.counselled_at ?? v.arrived_at ?? v.expected_at))}
            ${v.response_overdue ? '<span class="badge b-bad">no response yet</span>' : ''}</td>
          ${kind === 'answered' ? `
            <td><span class="badge ${OUTCOME_BADGE[v.outcome] ?? 'b-mute'}">${
              esc(OUTCOME_LABEL[v.outcome] ?? v.outcome ?? '—')}</span></td>
            <td>${esc(v.product_name ?? '—')}</td>
            <td class="num">${v.booked_amount ? fmtINR(v.booked_amount) : '—'}</td>` : ''}
          <td class="num">
            ${kind === 'expected'
              ? `<button class="btn small primary" data-arrive="${esc(v.lead_id)}">They are here</button>`
              : kind === 'desk'
                ? `${canCounsel
                     ? `<button class="btn small primary" data-respond="${esc(v.visit_id)}" data-testid="record-response">Record response</button>`
                     : '<span class="hint">counsellor to record</span>'}`
                : ''}
            <button class="btn small" data-lead="${esc(v.lead_id)}">Open</button>
          </td>
        </tr>`).join('')}
      </tbody></table></div>`));
    outlet.appendChild(panel);
  };

  section('At the desk', 'in the building right now', atDesk, 'desk');
  section('Expected', 'booked in by a caller', expected, 'expected');
  section('Answered for today', 'counselling response recorded', done, 'answered');

  outlet.onclick = async (e) => {
    const el = e.target.closest('[data-lead], [data-arrive], [data-respond]');
    if (!el) return;
    if (el.dataset.arrive) {
      try {
        await post(`/leads/${el.dataset.arrive}/walkin-arrival`, {});
        toast('Marked as arrived — record the counselling response when you are done.');
        redraw();
      } catch (err) {
        toast(err.message, 'err');
      }
      return;
    }
    if (el.dataset.respond) {
      responseModal(el.dataset.respond, redraw);
      return;
    }
    if (el.dataset.lead) location.hash = `#/lead/${el.dataset.lead}`;
  };
}

/* ------------------------------------------------------------------ */

function drawRatio(outlet, stats, current, redraw) {
  const f = stats.funnel ?? {};
  const n = (v) => Number(v ?? 0);
  const ratio = (a, b) => (n(b) > 0 ? `${Math.round((n(a) / n(b)) * 100)}%` : '—');

  const controls = h(`
    <div class="panel">
      <div class="row spread wrap">
        <h2 class="mt0">Office visits → conversions
          <small>${esc(stats.from === stats.to ? stats.from : `${stats.from} → ${stats.to}`)}</small></h2>
        <div class="row wrap" style="gap:6px">
          ${presets().map((p) => `<button class="chip${p.from === current.from && p.to === current.to ? ' on' : ''}"
            data-from="${p.from}" data-to="${p.to}">${esc(p.label)}</button>`).join('')}
        </div>
      </div>
    </div>`);
  controls.addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    range = { from: chip.dataset.from, to: chip.dataset.to };
    redraw();
  });
  outlet.appendChild(controls);

  const tiles = h('<div class="grid cols-4" style="margin-bottom:16px" data-testid="walkin-funnel"></div>');
  tiles.appendChild(statTile('Promised on calls', n(f.promised), 'clients who said they would come'));
  tiles.appendChild(statTile('Actually walked in', n(f.arrived),
    `${ratio(f.arrived, f.promised)} of the promises kept`));
  tiles.appendChild(statTile('Converted', n(f.converted),
    `${ratio(f.converted, f.arrived)} of the visits — this is the ratio`,
    n(f.arrived) > 0 && n(f.converted) / n(f.arrived) >= 0.3 ? 'good' : ''));
  tiles.appendChild(statTile('Revenue from visits', fmtINR(f.converted_amount),
    `${fmtINR(f.collected_amount)} collected so far`));
  outlet.appendChild(tiles);

  const grid = h('<div class="chart-grid"></div>');

  // Who converted the most walk-ins.
  const cns = h(`<div class="panel"><h2 class="mt0">Who converted the most
    <small>counsellors, by walk-ins turned into deals</small></h2></div>`);
  if ((stats.counsellors ?? []).length === 0) {
    cns.appendChild(h('<div class="empty">No counselled visits in this window.</div>'));
  } else {
    cns.appendChild(barChart(stats.counsellors.map((c) => ({
      label: c.full_name, value: Number(c.converted),
    }))));
    cns.appendChild(h(`
      <table class="table" data-testid="walkin-counsellors" style="margin-top:12px"><thead><tr>
        <th>Counsellor</th><th class="num">Visits</th><th class="num">Converted</th>
        <th class="num">Rate</th><th class="num">Booked</th>
      </tr></thead><tbody>
      ${stats.counsellors.map((c) => `
        <tr>
          <td>${esc(c.full_name)}</td>
          <td class="num">${Number(c.visits)}</td>
          <td class="num"><b>${Number(c.converted)}</b></td>
          <td class="num">${pct(c.conversion_pct)}</td>
          <td class="num">${fmtINR(c.booked_amount)}</td>
        </tr>`).join('')}
      </tbody></table>`));
  }
  grid.appendChild(cns);

  // Who put the most people in the building.
  const callers = h(`<div class="panel"><h2 class="mt0">Who called the most walk-ins
    <small>credited to whoever sent them in, never to whoever greeted them</small></h2></div>`);
  if ((stats.callers ?? []).length === 0) {
    callers.appendChild(h('<div class="empty">No walk-ins in this window.</div>'));
  } else {
    callers.appendChild(barChart(stats.callers.map((c) => ({
      label: c.full_name, value: Number(c.walkins),
    }))));
    callers.appendChild(h(`
      <table class="table" data-testid="walkin-callers" style="margin-top:12px"><thead><tr>
        <th>Person</th><th>Role</th><th class="num">Walk-ins</th>
        <th class="num">Still booked</th><th class="num">Converted</th><th class="num">Rate</th>
      </tr></thead><tbody>
      ${stats.callers.map((c) => `
        <tr>
          <td>${esc(c.full_name)}</td>
          <td class="hint">${esc(c.role ?? '—')}</td>
          <td class="num"><b>${Number(c.walkins)}</b></td>
          <td class="num">${Number(c.booked_pending)}</td>
          <td class="num">${Number(c.converted)}</td>
          <td class="num">${pct(c.conversion_pct)}</td>
        </tr>`).join('')}
      </tbody></table>`));
  }
  grid.appendChild(callers);
  outlet.appendChild(grid);

  const grid2 = h('<div class="chart-grid"></div>');

  const prod = h(`<div class="panel"><h2 class="mt0">Which product converts
    <small>counted on the visits where it was pitched</small></h2></div>`);
  if ((stats.products ?? []).length === 0) {
    prod.appendChild(h('<div class="empty">No products recorded against visits in this window.</div>'));
  } else {
    prod.appendChild(h(`
      <table class="table" data-testid="walkin-products"><thead><tr>
        <th>Product</th><th class="num">Visits</th><th class="num">Converted</th>
        <th class="num">Rate</th><th class="num">Booked</th>
      </tr></thead><tbody>
      ${stats.products.map((p) => `
        <tr>
          <td>${esc(p.product_name)}</td>
          <td class="num">${Number(p.visits)}</td>
          <td class="num"><b>${Number(p.converted)}</b></td>
          <td class="num">${pct(p.conversion_pct)}</td>
          <td class="num">${fmtINR(p.booked_amount)}</td>
        </tr>`).join('')}
      </tbody></table>
      <div class="hint" style="margin-top:8px">
        "Not recorded" means the counsellor did not name a product on a visit that did not
        convert. A converted visit always carries its product — the deal supplies it.
      </div>`));
  }
  grid2.appendChild(prod);

  const out = h(`<div class="panel"><h2 class="mt0">What was said at the desk
    <small>every visit that arrived in this window</small></h2></div>`);
  if ((stats.outcomes ?? []).length === 0) {
    out.appendChild(h('<div class="empty">No visits in this window.</div>'));
  } else {
    out.appendChild(barChart(stats.outcomes.map((o) => ({
      label: OUTCOME_LABEL[o.outcome] ?? o.outcome, value: Number(o.count),
    }))));
    out.appendChild(h(`<div class="hint" style="margin-top:8px">
      This is the coaching material. A pile of "thinking it over" is usually a pitch
      problem rather than a lead problem; a pile of "not eligible" is a qualifying problem
      upstream, on the phones.
    </div>`));
  }
  grid2.appendChild(out);
  outlet.appendChild(grid2);
}

/* ------------------------------------------------------------------ */
/* The three things a person does on this tab.                         */
/* ------------------------------------------------------------------ */

/** Find a lead by name or phone, so a walk-in can be punched in at the desk. */
function leadPicker(placeholder) {
  const box = h(`
    <div>
      <label class="f">${esc(placeholder)}
        <input name="q" placeholder="Name or phone" autocomplete="off" data-testid="walkin-search">
      </label>
      <div class="tlist" data-results style="max-height:220px;overflow:auto"></div>
      <input type="hidden" name="leadId">
      <div class="hint" data-chosen></div>
    </div>`);
  const results = box.querySelector('[data-results]');
  const hidden = box.querySelector('[name=leadId]');
  const chosen = box.querySelector('[data-chosen]');
  let timer = null;

  box.querySelector('[name=q]').addEventListener('input', (e) => {
    const q = e.target.value.trim();
    clearTimeout(timer);
    hidden.value = '';
    chosen.textContent = '';
    if (q.length < 3) { results.innerHTML = '<div class="hint">Type at least three characters.</div>'; return; }
    timer = setTimeout(async () => {
      try {
        const res = await get(`/leads?q=${encodeURIComponent(q)}&limit=12`);
        const leads = res.leads ?? [];
        results.innerHTML = leads.length === 0
          ? '<div class="hint">No lead matches that. An office visit always belongs to a lead — log an inbound call first if this person is new.</div>'
          : leads.map((l) => `
            <button class="btn small" style="display:block;width:100%;text-align:left;margin:3px 0"
                    data-pick="${esc(l.id)}" data-name="${esc(l.full_name ?? 'Unnamed')}">
              ${esc(l.full_name ?? 'Unnamed')} <span class="mono hint">${esc(l.phone_e164)}</span>
              <span class="hint">${esc(l.city ?? '')} ${esc(l.status)}</span>
            </button>`).join('');
      } catch (err) {
        results.innerHTML = `<div class="hint">${esc(err.message)}</div>`;
      }
    }, 250);
  });

  results.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-pick]');
    if (!btn) return;
    hidden.value = btn.dataset.pick;
    chosen.innerHTML = `Chosen: <b>${esc(btn.dataset.name)}</b>`;
    results.innerHTML = '';
  });

  return { el: box, leadId: () => hidden.value };
}

function punchInModal(counsellors, me, onDone) {
  const picker = leadPicker('Who walked in?');
  const body = h(`
    <div>
      <p class="hint mt0">
        Somebody is in the office now. This records the visit and puts the lead in front of
        the counsellor taking it — if they were already booked in, it completes that booking
        rather than opening a second visit.
      </p>
      <div data-slot></div>
      <label class="f">Counselled by
        <select name="counsellor" data-testid="punch-counsellor">
          ${counsellors.map((c) => `<option value="${esc(c.id)}"${c.id === me.id ? ' selected' : ''}>${
            esc(c.full_name)} — ${Number(c.open_visits)} open</option>`).join('')}
        </select>
      </label>
      <label class="f">Note <input name="note" maxlength="500" placeholder="Came with a friend, asked about…"></label>
    </div>`);
  body.querySelector('[data-slot]').appendChild(picker.el);

  const footer = h('<div><button class="btn primary" data-testid="punch-save">Record the visit</button></div>');
  const { close } = openModal('Punch in a walk-in', body, footer);

  footer.querySelector('button').addEventListener('click', async () => {
    const leadId = picker.leadId();
    if (!leadId) { toast('Choose which lead walked in.', 'err'); return; }
    try {
      await post(`/leads/${leadId}/walkin-arrival`, {
        counsellorId: body.querySelector('[name=counsellor]').value,
        note: body.querySelector('[name=note]').value.trim() || undefined,
      });
      toast('Walk-in recorded — they are at the desk.');
      close();
      onDone();
    } catch (err) {
      toast(err.message, 'err');
    }
  });
}

function bookVisitModal(counsellors, me, onDone) {
  const picker = leadPicker('Which lead is coming in?');
  const body = h(`
    <div>
      <p class="hint mt0">
        Books this lead in to see a counsellor on a named day. The day is required —
        "coming in sometime" is how a promised visit quietly became nothing.
      </p>
      <div data-slot></div>
      <label class="f">Counsellor
        <select name="counsellor" data-testid="book-counsellor">
          ${counsellors.map((c) => `<option value="${esc(c.id)}">${esc(c.full_name)} — ${
            Number(c.open_visits)} open</option>`).join('')}
        </select>
      </label>
      <label class="f">Coming in on
        <input type="datetime-local" name="when" value="${tomorrowAt(12)}" data-testid="book-when">
      </label>
      <label class="f">Note <input name="note" maxlength="500" placeholder="What they want to discuss"></label>
    </div>`);
  body.querySelector('[data-slot]').appendChild(picker.el);

  const footer = h('<div><button class="btn primary" data-testid="book-save">Book the visit</button></div>');
  const { close } = openModal('Book an office visit', body, footer);

  footer.querySelector('button').addEventListener('click', async () => {
    const leadId = picker.leadId();
    const when = body.querySelector('[name=when]').value;
    if (!leadId) { toast('Choose which lead is coming in.', 'err'); return; }
    if (!when) { toast('Say which day they are coming in.', 'err'); return; }
    try {
      await post(`/leads/${leadId}/walkin-visit`, {
        counsellorId: body.querySelector('[name=counsellor]').value,
        expectedAt: localToIso(when),
        note: body.querySelector('[name=note]').value.trim() || undefined,
      });
      toast('Booked — it is on the Expected list.');
      close();
      onDone();
    } catch (err) {
      toast(err.message, 'err');
    }
  });
}

async function responseModal(visitId, onDone) {
  const products = await get('/products').catch(() => []);
  const body = h(`
    <div>
      <p class="hint mt0">
        What happened at the desk. <b>There is no "converted" here on purpose</b> — if they
        bought, close this and press <b>Book deal</b> on the lead: the deal marks the visit
        converted itself, so the ratio and the money can never disagree.
      </p>
      <label class="f">What was the outcome?
        <select name="outcome" data-testid="response-outcome">
          <option value="thinking">🤔 Thinking it over</option>
          <option value="revisit">🔁 Coming back in — another visit</option>
          <option value="not_interested">✖ Not interested</option>
          <option value="not_eligible">⛔ Not eligible for what we sell</option>
          <option value="no_show">👻 Did not actually come in</option>
        </select>
      </label>
      <label class="f">Product discussed
        <select name="product">
          <option value="">— not recorded —</option>
          ${products.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('')}
        </select>
      </label>
      <label class="f" data-when-row>Follow up on
        <input type="datetime-local" name="when" value="${tomorrowAt(11)}" data-testid="response-when">
      </label>
      <label class="f">What was said
        <textarea name="notes" rows="3" maxlength="2000"
          placeholder="Budget, objection, who else decides…"></textarea>
      </label>
      <div class="hint" data-explain></div>
    </div>`);

  const outcomeEl = body.querySelector('[name=outcome]');
  const whenRow = body.querySelector('[data-when-row]');
  const explain = body.querySelector('[data-explain]');
  const sync = () => {
    const v = outcomeEl.value;
    const closes = v === 'not_interested' || v === 'not_eligible';
    whenRow.hidden = closes;
    explain.innerHTML = closes
      ? 'This closes the lead as lost, with the reason recorded. Use it only when they said no — “thinking it over” is not a no.'
      : v === 'revisit'
        ? 'The day is required: a second visit with no date is not a second visit.'
        : 'The lead stays open with this as its next action, so nothing is left without one.';
  };
  outcomeEl.addEventListener('change', sync);
  sync();

  const footer = h('<div><button class="btn primary" data-testid="response-save">Save the response</button></div>');
  const { close } = openModal('Record the counselling response', body, footer);

  footer.querySelector('button').addEventListener('click', async () => {
    const outcome = outcomeEl.value;
    const when = body.querySelector('[name=when]').value;
    if (outcome === 'revisit' && !when) { toast('Say which day they are coming back.', 'err'); return; }
    try {
      await post(`/walkins/${visitId}/response`, {
        outcome,
        productId: body.querySelector('[name=product]').value || undefined,
        notes: body.querySelector('[name=notes]').value.trim() || undefined,
        nextActionAt: whenRow.hidden || !when ? undefined : localToIso(when),
      });
      toast('Response recorded.');
      close();
      onDone();
    } catch (err) {
      toast(err.message, 'err');
    }
  });
}
