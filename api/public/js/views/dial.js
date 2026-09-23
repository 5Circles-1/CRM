import { get, post } from '../api.js';
import { callForm, loadDispositions } from '../callform.js';
import { agoLabel, esc, fmtDT, h, toast } from '../util.js';

/**
 * Power dialling (0075): the CRM works the caller's due list back to back.
 *
 * Start once; from then on the next due lead is rung after a short countdown
 * (the window to skip or pause), Tata Tele rings the caller's phone first and
 * the client only once they answer, and the moment the outcome is saved the
 * next lead counts down. Which lead is next is crm.v_dial_queue's decision -
 * the same order the pipeline screen shows - never this file's.
 *
 * Its own screen rather than a mode of My Pipeline, because that page redraws
 * itself every half minute, and a redraw mid-call would throw the outcome
 * form away. Leaving this screen stops the dialler: nothing keeps ringing
 * from a tab nobody is looking at.
 */

const REASON = {
  immediate: ['⚡ Immediate lead — first call due now', 'b-bad'],
  callback_due: ['📅 Callback due — the time the client asked for', 'b-info'],
  reenquiry: ['🔁 Enquired again — treat as fresh', 'b-warn'],
  fresh: ['🆕 Fresh — never contacted', 'b-warn'],
  visit_followup: ['🚶 Visit follow-up due', 'b-ok'],
  overdue: ['⏰ Overdue follow-up', 'b-bad'],
  breached: ['⛔ Long overdue', 'b-bad'],
};

/** One tap and on to the next - the outcomes most calls end with. */
const QUICK = [
  ['not_answered', '📵 Not answered'],
  ['busy', '☎️ Busy'],
  ['switched_off', '📴 Switched off'],
];

/** How long a save waits for Tata Tele's call record, so the dial is verified. */
const LINK_WAIT_MS = 15_000;
/** How often a clear queue looks again for newly due work. */
const RECHECK_MS = 60_000;

let running = null;

export async function render(outlet, me, params) {
  running?.stop();
  await loadDispositions();
  running = session(outlet, me);
  if (params[0] === 'start') {
    // A refresh should not start dialling again by itself.
    history.replaceState(null, '', '#/dial');
    running.advance();
  } else {
    running.ready();
  }
}

function session(outlet, me) {
  let alive = true;
  let state = 'ready';
  let info = null;   // the last /me/dial-next answer
  let lead = null;   // the lead on screen
  let form = null;
  let errorMsg = '';
  let pauseAfterSave = false;
  let countTimer = null;
  let recheckTimer = null;
  let saveNow = null;
  // Consecutive saves whose call record never came. Two in a row means the
  // records are not arriving at all (webhook down or misconfigured): stop
  // making every save wait for one, and say so.
  let recordMisses = 0;
  const skipped = new Set();
  const handled = new Set();
  const stats = { called: 0, saved: 0, skipped: 0 };

  const onHash = () => { if (!location.hash.startsWith('#/dial')) stop(); };
  window.addEventListener('hashchange', onHash);

  function stop() {
    alive = false;
    clearInterval(countTimer);
    clearTimeout(recheckTimer);
    window.removeEventListener('hashchange', onHash);
  }
  const live = () => alive && outlet.isConnected;

  async function fetchNext() {
    const exclude = [...skipped, ...handled].slice(-400);
    info = await get(`/me/dial-next${exclude.length ? `?exclude=${exclude.join(',')}` : ''}`);
    lead = info.lead;
  }

  async function ready() {
    state = 'ready';
    try { await fetchNext(); } catch (err) { errorMsg = err.message; state = 'error'; }
    if (live()) draw();
  }

  async function advance() {
    if (!live()) return;
    clearInterval(countTimer);
    clearTimeout(recheckTimer);
    if (pauseAfterSave) {
      pauseAfterSave = false;
      state = 'paused';
      draw();
      return;
    }
    state = 'loading';
    draw();
    try {
      await fetchNext();
    } catch (err) {
      if (!live()) return;
      errorMsg = err.message;
      state = 'error';
      draw();
      return;
    }
    if (!live()) return;
    if (!info.open) { state = 'closed'; draw(); return; }
    if (!lead) {
      state = 'clear';
      draw();
      recheckTimer = setTimeout(advance, RECHECK_MS);
      return;
    }
    countdown();
  }

  function countdown() {
    state = 'countdown';
    let n = Math.max(0, Number(info.countdown_seconds ?? 5));
    draw(n);
    if (n === 0) { dial(); return; }
    countTimer = setInterval(() => {
      if (!live() || state !== 'countdown') { clearInterval(countTimer); return; }
      n -= 1;
      const el = outlet.querySelector('[data-slot=count]');
      if (el) el.textContent = String(n);
      if (n <= 0) { clearInterval(countTimer); dial(); }
    }, 1000);
  }

  async function dial() {
    if (!live() || !lead) return;
    clearInterval(countTimer);
    state = 'dialling';
    draw();
    try {
      const r = await post(`/leads/${lead.lead_id}/call`);
      if (!live()) return;
      stats.called += 1;
      // A minute of slack either side of the click: the call record carries
      // the time the phone system started the call, not the click.
      const since = new Date(new Date(r.requestedAt).getTime() - 60_000).toISOString();
      form = callForm(
        { id: lead.lead_id, green_reason: lead.green_reason },
        { since, autoLink: true, startedAt: r.requestedAt },
      );
      state = 'calling';
      draw();
    } catch (err) {
      if (!live()) return;
      if (err.status === 404) {
        // Transferred or closed by someone else since the queue was read.
        skipped.add(lead.lead_id);
        toast('That lead is no longer yours to call — moving on.');
        advance();
        return;
      }
      errorMsg = err.message;
      state = 'error';
      draw();
    }
  }

  function skip() {
    if (lead) { skipped.add(lead.lead_id); stats.skipped += 1; }
    lead = null;
    form = null;
    advance();
  }

  async function save(disposition) {
    if (!form || !lead) return;
    if (!form.validate(disposition ? { disposition } : {})) return;
    const buttons = outlet.querySelectorAll('[data-save]');
    buttons.forEach((b) => { b.disabled = true; });
    const note = outlet.querySelector('[data-slot=saving]');

    // An unverified dial reads as a fabricated one, so a save gives Tata
    // Tele's call record a moment to land - it follows the hangup by seconds.
    let waitedFully = false;
    if (!form.linked() && recordMisses < 2) {
      if (note) {
        note.innerHTML = `<div class="banner info" data-testid="dial-waiting-record">Saving — waiting a moment for
          Tata Tele's call record so this dial counts as verified…
          <button class="btn small" data-act="save-now" data-testid="dial-save-now"
            style="margin-left:8px">Save now without it</button></div>`;
      }
      // Only a wait that ran its whole course counts as a missing record -
      // not the caller choosing "Save now" while it was still on its way.
      let cut = false;
      await Promise.race([
        form.waitForLink(LINK_WAIT_MS).then(() => { waitedFully = !cut; }),
        new Promise((resolve) => { saveNow = () => { cut = true; resolve(); }; }),
      ]);
      saveNow = null;
    }
    if (!live()) return;
    if (form.linked()) recordMisses = 0;
    else if (waitedFully) recordMisses += 1;

    const override = disposition
      ? { disposition, durationSeconds: form.linked()?.duration_seconds ?? 0 }
      : {};
    const ok = await form.submit(override);
    if (!live()) return;
    if (note) note.innerHTML = '';
    if (!ok) {
      buttons.forEach((b) => { b.disabled = false; });
      return;
    }
    stats.saved += 1;
    handled.add(lead.lead_id);
    toast(`Saved — ${lead.full_name ?? 'lead'}.`);
    lead = null;
    form = null;
    advance();
  }

  outlet.onclick = (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn || !live()) return;
    const act = btn.dataset.act;
    if (act === 'start' || act === 'resume' || act === 'recheck') advance();
    else if (act === 'call-now' || act === 'retry' || act === 'redial') dial();
    else if (act === 'skip') skip();
    else if (act === 'pause') {
      clearInterval(countTimer);
      clearTimeout(recheckTimer);
      state = 'paused';
      draw();
    } else if (act === 'stop') {
      clearInterval(countTimer);
      clearTimeout(recheckTimer);
      state = 'stopped';
      lead = null;
      draw();
    } else if (act === 'pause-after') {
      pauseAfterSave = !pauseAfterSave;
      btn.textContent = pauseAfterSave ? '▶ Keep going after this call' : '⏸ Pause after this call';
    } else if (act === 'quick') save(btn.dataset.disp);
    else if (act === 'save') save(null);
    else if (act === 'save-now') saveNow?.();
  };

  function draw(count) {
    if (!live()) return;
    outlet.innerHTML = '';
    outlet.appendChild(header());
    const body = h('<div data-testid="dial-body"></div>');
    outlet.appendChild(body);

    if (!me.cloud_calling) {
      body.appendChild(h(`<div class="panel"><div class="empty">
        Power dialling needs Tata Tele cloud calling switched on — ask your admin.</div></div>`));
      return;
    }

    switch (state) {
      case 'ready': {
        body.appendChild(h(`
          <div class="panel">
            ${me.on_shift ? '' : `<div class="banner warn">You are off the floor — press <b>Start shift</b>
              at the top so today's hours count.</div>`}
            <p class="mt0">Power dialling calls your due leads one after another — you never pick a
              lead or press Call. Tata Tele rings <b>your phone first</b>, then the client the moment
              you answer. After each call, save what happened; the next lead is called
              ${Number(info?.countdown_seconds ?? 5)} seconds later.</p>
            <p class="hint">Order: immediate leads, callbacks whose time has come, fresh leads and
              re-enquiries, then overdue follow-ups — the same order as My Pipeline. Nothing booked
              for later is called early.</p>
            ${readyLine()}
            <button class="btn primary" data-act="start" data-testid="dial-start"
              ${info?.open === false ? 'disabled' : ''} style="font-size:16px;padding:12px 22px">
              ▶ Start power dialling</button>
          </div>`));
        break;
      }
      case 'loading':
      case 'dialling': {
        if (lead) body.appendChild(leadCard(lead));
        body.appendChild(h(`<div class="panel"><div class="row"><div class="spin"></div>
          <span>${state === 'dialling' ? `Calling ${esc(lead?.full_name ?? 'the lead')}…` : 'Finding your next lead…'}</span>
          </div></div>`));
        break;
      }
      case 'countdown': {
        body.appendChild(leadCard(lead));
        body.appendChild(h(`
          <div class="panel" data-testid="dial-countdown">
            <div class="row spread wrap">
              <div class="row" style="gap:16px">
                <div class="dial-count" data-slot="count">${Number(count ?? 0)}</div>
                <div>Calling <b>${esc(lead.full_name ?? 'this lead')}</b> in a moment…
                  <div class="hint">Skip if this is not a lead to call right now.</div></div>
              </div>
              <div class="row wrap">
                <button class="btn primary" data-act="call-now" data-testid="dial-call-now">📞 Call now</button>
                <button class="btn" data-act="skip" data-testid="dial-skip">Skip this lead</button>
                <button class="btn" data-act="pause" data-testid="dial-pause">⏸ Pause</button>
              </div>
            </div>
          </div>`));
        break;
      }
      case 'calling': {
        body.appendChild(leadCard(lead));
        const green = !!lead.green_reason;
        const panel = h(`
          <div class="panel" data-testid="dial-calling">
            <div class="banner info">📞 Tata Tele is ringing <b>your phone</b> — answer it, and
              ${esc(lead.full_name ?? 'the client')} is dialled at once.</div>
            ${green ? `<div class="hint">This lead is green, so choose its next follow-up below
              whatever happens on the call.</div>` : `
            <div class="hint">No conversation? One tap saves it and moves on:</div>
            <div class="dial-quick">
              ${QUICK.map(([v, label]) => `<button class="btn" data-act="quick" data-save
                data-disp="${esc(v)}" data-testid="dial-quick-${esc(v)}">${esc(label)}</button>`).join('')}
            </div>`}
            <div data-slot="form"></div>
            <div data-slot="saving"></div>
            <div class="row spread wrap" style="margin-top:10px">
              <button class="btn primary" data-act="save" data-save data-testid="dial-save">Save &amp; call next</button>
              <div class="row wrap">
                <button class="btn small" data-act="redial">Phone didn't ring — call again</button>
                <button class="btn small" data-act="skip">Skip (no call happened)</button>
                <button class="btn small" data-act="pause-after">${pauseAfterSave
                  ? '▶ Keep going after this call' : '⏸ Pause after this call'}</button>
              </div>
            </div>
          </div>`);
        panel.querySelector('[data-slot=form]').appendChild(form.el);
        body.appendChild(panel);
        break;
      }
      case 'paused': {
        if (lead) body.appendChild(leadCard(lead));
        body.appendChild(h(`
          <div class="panel" data-testid="dial-paused">
            <p class="mt0"><b>Paused.</b> Nothing will be called until you resume.</p>
            <div class="row wrap">
              <button class="btn primary" data-act="resume" data-testid="dial-resume">▶ Resume</button>
              <button class="btn" data-act="stop">Stop</button>
            </div>
          </div>`));
        break;
      }
      case 'clear': {
        body.appendChild(h(`
          <div class="panel" data-testid="dial-clear">
            <p class="mt0"><b>✅ Nothing is due right now.</b> ${outlookLine()}</p>
            <p class="hint">Still watching — the next lead that falls due is called automatically
              (checked every minute).</p>
            <div class="row wrap">
              <button class="btn" data-act="recheck">Check now</button>
              <button class="btn" data-act="stop">Stop</button>
            </div>
          </div>`));
        break;
      }
      case 'closed': {
        body.appendChild(h(`
          <div class="panel" data-testid="dial-closed">
            <p class="mt0"><b>Power dialling runs ${hourLabel(info.window.start_hour)}–${hourLabel(info.window.end_hour)} IST.</b>
              ${Number(info.remaining) > 0 ? `${Number(info.remaining)} lead${Number(info.remaining) === 1 ? ' is' : 's are'} due.` : ''}
              Outside those hours use the Call button on a lead for a one-off call.</p>
            <button class="btn" data-act="stop">Stop</button>
          </div>`));
        break;
      }
      case 'error': {
        if (lead) body.appendChild(leadCard(lead));
        body.appendChild(h(`
          <div class="panel" data-testid="dial-error">
            <div class="banner bad">${esc(errorMsg || 'Something went wrong.')}</div>
            <div class="row wrap">
              ${lead ? '<button class="btn primary" data-act="retry">Try again</button>' : '<button class="btn primary" data-act="recheck">Try again</button>'}
              ${lead ? '<button class="btn" data-act="skip">Skip this lead</button>' : ''}
              <button class="btn" data-act="stop">Stop</button>
            </div>
          </div>`));
        break;
      }
      case 'stopped': {
        body.appendChild(h(`
          <div class="panel" data-testid="dial-stopped">
            <p class="mt0"><b>Stopped.</b> This session: ${stats.called} called, ${stats.saved} saved,
              ${stats.skipped} skipped.</p>
            <div class="row wrap">
              <button class="btn primary" data-act="start">▶ Start again</button>
              <a class="btn" href="#/day">Back to My Pipeline</a>
            </div>
          </div>`));
        break;
      }
      default:
        break;
    }
  }

  function header() {
    const active = !['ready', 'stopped'].includes(state);
    const pill =
      state === 'calling' ? '<span class="badge b-ok">● on a call</span>'
      : state === 'countdown' || state === 'dialling' || state === 'loading' ? '<span class="badge b-info">● dialling</span>'
      : state === 'paused' ? '<span class="badge b-warn">paused</span>'
      : state === 'clear' ? '<span class="badge b-ok">queue clear</span>'
      : state === 'error' ? '<span class="badge b-bad">needs you</span>'
      : state === 'closed' ? '<span class="badge b-mute">outside hours</span>'
      : '<span class="badge b-mute">not running</span>';
    return h(`
      <div class="panel" data-testid="dial-head">
        <div class="row spread wrap">
          <div>
            <h2 class="mt0">📞 Power dialling ${pill}</h2>
            <div class="hint" data-testid="dial-stats">Called ${stats.called} · Saved ${stats.saved}
              · Skipped ${stats.skipped}${info ? ` · Due now ${Number(info.remaining ?? 0)}` : ''}</div>
          </div>
          ${active && state !== 'calling' ? '<button class="btn danger" data-act="stop" data-testid="dial-stop">■ Stop</button>' : ''}
        </div>
        ${recordMisses >= 2 ? `<div class="banner warn" style="margin-top:10px" data-testid="dial-no-records">
          Tata Tele's call records are not arriving, so these dials are being saved
          <b>unverified</b>. Ask your admin to check the webhook on Admin → Ingestion → Tata Tele
          ("last webhook").</div>` : ''}
      </div>`);
  }

  function readyLine() {
    if (!info) return '';
    if (info.open === false) {
      return `<div class="banner warn">Power dialling runs ${hourLabel(info.window.start_hour)}–${hourLabel(info.window.end_hour)} IST.</div>`;
    }
    if (!info.lead) return `<div class="banner ok">Nothing is due right now. ${outlookLine()}</div>`;
    return `<div class="banner info" data-testid="dial-ready-line"><b>${Number(info.remaining)}</b>
      lead${Number(info.remaining) === 1 ? ' is' : 's are'} due now. First up:
      <b>${esc(info.lead.full_name ?? 'Unnamed lead')}</b> — ${esc((REASON[info.lead.dial_reason] ?? [info.lead.dial_reason])[0])}.</div>`;
  }

  function outlookLine() {
    const bits = [];
    if (info?.next_due_at) bits.push(`The next follow-up falls due at ${esc(fmtDT(info.next_due_at))}.`);
    if (Number(info?.held) > 0) {
      bits.push(`${Number(info.held)} lead${Number(info.held) === 1 ? ' was' : 's were'} called in the
        last few minutes and will come back round${info.held_until ? ` from ${esc(fmtDT(info.held_until))}` : ''}.`);
    }
    if (skipped.size > 0) bits.push(`${skipped.size} skipped this session.`);
    return bits.join(' ');
  }

  return { stop, ready, advance };
}

function leadCard(l) {
  const [reason, tone] = REASON[l.dial_reason] ?? [String(l.dial_reason ?? ''), 'b-mute'];
  return h(`
    <div class="panel" data-testid="dial-lead">
      <div class="row spread wrap">
        <div>
          <h2 class="mt0" style="font-size:22px;margin-bottom:2px" data-testid="dial-lead-name">${esc(l.full_name ?? 'Unnamed lead')}</h2>
          <div class="mono" style="font-size:16px;font-weight:700">${esc(l.phone_e164)}</div>
        </div>
        <div class="row wrap" style="gap:6px">
          <span class="badge ${tone}" data-testid="dial-reason">${esc(reason)}</span>
          ${l.green_reason === 'will_visit' ? '<span class="badge b-ok" title="Promised to visit">🚶 will visit</span>'
            : l.green_reason === 'interested' ? '<span class="badge b-ok" title="Showed real interest">🟢 potential</span>' : ''}
          ${Number(l.na_streak) >= 2 ? `<span class="badge b-bad">📵 Not answered ×${Number(l.na_streak)}</span>` : ''}
        </div>
      </div>
      <div class="grid cols-4" style="margin-top:12px">
        <div class="stat"><div class="k">Attempts / connects</div>
          <div class="v" style="font-size:17px">${Number(l.attempt_count) || 0} / ${Number(l.connect_count) || 0}</div></div>
        <div class="stat"><div class="k">Last outcome</div>
          <div class="v" style="font-size:15px">${l.last_disposition
            ? esc(String(l.last_disposition).replace(/_/g, ' ')) : 'never contacted'}</div></div>
        <div class="stat"><div class="k">${l.callback_at ? 'Callback booked for' : 'Due since'}</div>
          <div class="v" style="font-size:15px">${esc(fmtDT(l.callback_at ?? l.next_action_at))}</div>
          <div class="s">${Number(l.minutes_overdue) > 0 ? `${esc(agoLabel(l.minutes_overdue))} ago` : ''}</div></div>
        <div class="stat"><div class="k">Source</div>
          <div class="v" style="font-size:15px">${esc(l.campaign_name ?? '—')}</div>
          <div class="s">${esc(l.city ?? '')}</div></div>
      </div>
      ${l.callback_note ? `<div class="banner info" style="margin-top:10px">Client said: “${esc(l.callback_note)}”</div>` : ''}
      ${l.next_action_note && l.next_action_note !== l.callback_note
        ? `<div class="hint" style="margin-top:8px">Note: ${esc(l.next_action_note)}</div>` : ''}
      <div style="margin-top:8px"><a href="#/lead/${esc(l.lead_id)}" target="_blank" rel="noopener">Open the full lead in a new tab ↗</a></div>
    </div>`);
}

const hourLabel = (hour) => `${String(Number(hour) % 24).padStart(2, '0')}:00`;
