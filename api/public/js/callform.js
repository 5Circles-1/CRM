import { get, post } from './api.js';
import { esc, fmtDT, fmtTalk, h, localToIso, openModal, parseTalk, toast, tomorrowAt } from './util.js';

/**
 * The one "what happened on this call" form, shared by the lead page's Log a
 * call and the Power dial screen. Two copies of this form would be two
 * copies of the green-lead date rule, and the one that drifted would be the
 * one that let a promised visit go dark.
 */

/**
 * Call outcomes come from the API, which reads them from the database enum.
 * Keeping a copy here meant every new outcome had to be added in three places,
 * and the one that got forgotten was always this one.
 */
let DISPOSITIONS = [];
let NEEDS_FOLLOWUP = new Set();
let TERMINAL = new Set();

export async function loadDispositions() {
  if (DISPOSITIONS.length) return;
  DISPOSITIONS = await get('/meta/dispositions');
  NEEDS_FOLLOWUP = new Set(DISPOSITIONS.filter((d) => d.followUp).map((d) => d.value));
  TERMINAL = new Set(DISPOSITIONS.filter((d) => d.terminal).map((d) => d.value));
}

/** Webhooks land seconds after hangup; the pull every 15 minutes backs them up. */
const POLL_MS = 4000;
const POLL_TRIES = 45; // three minutes

/**
 * Build the form. `lead` needs `id` and `green_reason`.
 *
 * opts.since     only a call record that started at or after this moment
 *                (ISO) can be this call - the dialler passes the click time,
 *                so yesterday's unlogged call to the same number is never
 *                attached to today's dial.
 * opts.autoLink  link the call record the moment it arrives instead of
 *                offering "Use it" - right when the dialler placed the call.
 * opts.startedAt when the call happened (the dialler's click time).
 * opts.onLinked  told when a call record is linked.
 *
 * Returns { el, submit(override), validate(override), linked(), waitForLink(ms) }.
 */
export function callForm(lead, opts = {}) {
  const el = h(`
    <div>
      <div data-slot="suggestion"></div>
      <label class="f">What happened?
        <select name="disposition" data-testid="disposition">
          <option value="" selected disabled>— choose what happened —</option>
          ${DISPOSITIONS.map((d) => `<option value="${esc(d.value)}">${esc(d.label)}</option>`).join('')}
        </select>
      </label>
      <div class="frow">
        <label class="f">Talk time <span class="hint">mm:ss — e.g. 3:07</span>
          <input name="duration" inputmode="numeric" placeholder="0:00" value="0:00" data-testid="duration">
        </label>
      </div>
      <div data-slot="followup" style="display:none">
        <div class="frow">
          <label class="f"><span data-slot="followup-label">Callback time</span>
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
      <div class="hint">A call cannot be closed without a next step: pick a terminal outcome,
        set a callback, or the system schedules the retry itself.</div>
    </div>`);

  const sel = el.querySelector('[name=disposition]');
  const durationInput = el.querySelector('[name=duration]');
  const followup = el.querySelector('[data-slot=followup]');
  const followupLabel = el.querySelector('[data-slot=followup-label]');
  const slot = el.querySelector('[data-slot=suggestion]');
  let linked = null;

  // The date is asked of the caller, never invented by the system, whenever
  // the outcome is positive OR the lead is green (0068): a promised visit or
  // an interested client who did not pick up today still gets a HUMAN-chosen
  // next date, so the lead keeps a live green light instead of a silent retry.
  const needsDate = (value) =>
    NEEDS_FOLLOWUP.has(value) || (!!lead.green_reason && !TERMINAL.has(value));
  const syncFollowup = () => {
    followup.style.display = needsDate(sel.value) ? '' : 'none';
    followupLabel.textContent =
      sel.value === 'callback_requested' ? 'Callback time (client asked)'
      : sel.value === 'will_visit' ? 'When will they visit? (the date the client gave)'
      : NEEDS_FOLLOWUP.has(sel.value) ? 'Next follow-up (required for an interested client)'
      : lead.green_reason === 'will_visit'
        ? 'They promised a visit — choose the next follow-up yourself'
        : 'This lead is green (showed interest) — choose the next follow-up yourself';
  };
  sel.addEventListener('change', syncFollowup);
  syncFollowup();

  const link = (s) => {
    linked = s;
    durationInput.value = fmtTalk(s.duration_seconds);
    slot.innerHTML = '';
    slot.appendChild(h(`
      <div class="banner ok" data-testid="call-linked">
        ✓ Call record received — ${esc(s.direction)}, ${esc(fmtTalk(s.duration_seconds))} talk.
        Linked: this dial counts as verified.
      </div>`));
    opts.onLinked?.(s);
  };

  // If the phone system already saw this call, offer it: one click makes the
  // attempt verified and the duration honest. Asked again until it arrives,
  // because the form is usually open while the call is still going on.
  const offer = (s) => {
    if (opts.autoLink) { link(s); return; }
    slot.innerHTML = '';
    slot.appendChild(h(`
      <div class="banner info">
        Phone shows a ${esc(s.direction)} call of ${esc(fmtTalk(s.duration_seconds))} at
        ${esc(fmtDT(s.started_at))}.
        <button class="btn small" style="margin-left:8px" data-testid="use-suggestion">Use it</button>
      </div>`));
    slot.querySelector('[data-testid=use-suggestion]').addEventListener('click', () => link(s));
  };

  let tries = 0;
  let found = false;
  const check = async () => {
    const qs = opts.since ? `?since=${encodeURIComponent(opts.since)}` : '';
    const { suggestion } = await get(`/leads/${lead.id}/device-log-suggestion${qs}`);
    if (suggestion && !found) { found = true; offer(suggestion); }
    return suggestion;
  };
  const poll = async () => {
    if (found || (tries > 0 && !el.isConnected)) return; // arrived, or the form closed
    tries += 1;
    try { await check(); } catch { /* a blip: keep asking */ }
    if (!found && tries < POLL_TRIES) setTimeout(poll, POLL_MS);
  };
  poll();

  if (opts.autoLink) {
    slot.appendChild(h(`<div class="banner info" data-testid="call-waiting">
      Waiting for the call record from Tata Tele — it arrives a few seconds after you hang up.</div>`));
  }

  /**
   * The payload as it stands, or null having said what is missing.
   * `override` lets a one-tap outcome skip the dropdown.
   */
  function build(override = {}) {
    const disposition = override.disposition ?? sel.value;
    // No default outcome: a pre-selected "Connected — interested" saved by
    // reflex between calls invents an interested client and a green lead.
    if (!disposition) {
      toast('Choose what happened on the call first.', 'err');
      sel.focus();
      return null;
    }
    const seconds = override.durationSeconds ?? parseTalk(durationInput.value);
    if (seconds === null) {
      toast('Talk time should look like 3:07, or just a number of seconds.', 'err');
      return null;
    }
    const payload = {
      disposition,
      durationSeconds: seconds,
      notes: el.querySelector('[name=notes]').value.trim() || undefined,
      deviceLogId: linked?.id,
      startedAt: opts.startedAt,
    };
    if (needsDate(disposition)) {
      const at = el.querySelector('[name=callbackAt]').value;
      if (!at) { toast('Set the follow-up time first.', 'err'); return null; }
      payload.callbackAt = localToIso(at);
      payload.callbackNote = el.querySelector('[name=callbackNote]').value.trim() || undefined;
    }
    return payload;
  }

  /** Check before any waiting, so a missing answer is said at once. */
  const validate = (override) => build(override) !== null;

  /** Save the attempt. Resolves true once saved; on refusal it has said why. */
  async function submit(override = {}) {
    const payload = build(override);
    if (!payload) return false;
    try {
      await post(`/leads/${lead.id}/calls`, payload);
      return true;
    } catch (err) {
      toast(err.message, 'err');
      return false;
    }
  }

  /** Give a late call record a moment to arrive, asking often. */
  async function waitForLink(ms) {
    const until = Date.now() + ms;
    while (!found && Date.now() < until) {
      try { await check(); } catch { /* keep waiting */ }
      if (!found) await new Promise((r) => setTimeout(r, 1500));
    }
    return linked;
  }

  return { el, submit, validate, linked: () => linked, waitForLink };
}

/** The lead page's Log a call. */
export function logCallModal(lead, onDone) {
  const form = callForm(lead);
  const footer = h(`<div><button class="btn primary" data-testid="save-call">Save call</button></div>`);
  const { close } = openModal('Log a call', form.el, footer);
  const btn = footer.querySelector('[data-testid=save-call]');
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    try {
      if (await form.submit()) {
        toast('Call saved.');
        close();
        onDone();
      }
    } finally {
      btn.disabled = false;
    }
  });
}
