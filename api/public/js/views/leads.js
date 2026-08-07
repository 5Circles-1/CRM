import { get, post } from '../api.js';
import { badge, esc, fmtDT, h, toast } from '../util.js';

/**
 * Find a lead, or build a re-tap list and work it.
 *
 * The search box alone was not enough. The lists a caller actually works from —
 * "everyone who did not answer", "everyone who asked for a callback", "everyone
 * I have not messaged" — are not things you can type into a name search. Those
 * are one click each, and the filters combine, so "not answered AND overdue AND
 * no WhatsApp yet" is three clicks rather than a support request.
 */

/** One-click lists, in the order a caller would reach for them. */
const PRESETS = [
  { label: 'Everything', filters: {} },
  { label: 'Did not answer', filters: { lastDisposition: 'not_answered' } },
  { label: 'Asked for a callback', filters: { lastDisposition: 'callback_requested' } },
  { label: 'Will call us back', filters: { lastDisposition: 'will_call_back_self' } },
  { label: 'Will visit', filters: { lastDisposition: 'will_visit' } },
  { label: 'Busy or switched off', filters: { lastDisposition: 'busy' } },
  { label: 'Overdue now', filters: { due: 'overdue' } },
  { label: 'Never contacted', filters: { due: 'untouched' } },
  { label: 'No WhatsApp yet', filters: { whatsapp: 'not_sent' } },
];

const DUE = [
  ['', 'Any time'],
  ['overdue', 'Overdue now'],
  ['today', 'Due today'],
  ['untouched', 'Never contacted'],
  ['contacted', 'Already contacted'],
];

const STATUS = [
  ['', 'Any status'],
  ['new', 'New'],
  ['working', 'Working'],
  ['callback', 'Callback'],
  ['qualified', 'Qualified'],
  ['negotiation', 'Negotiation'],
  ['nurture', 'Nurture'],
];

/**
 * The follow-up round a lead is on, in the language of the old Excel, whose
 * FU1..FU5 columns are how the floor still thinks. One call made means the
 * next dial is the 1st follow-up, and so on.
 */
const ROUNDS = [
  ['', 'Any round'],
  ['0', 'Fresh — no call yet'],
  ['1', 'Due 1st follow-up'],
  ['2', 'Due 2nd follow-up'],
  ['3', 'Due 3rd follow-up'],
  ['4', 'Due 4th follow-up'],
  ['5plus', 'Due 5th follow-up or later'],
];

const WHATSAPP = [
  ['', 'WhatsApp: any'],
  ['sent', 'WhatsApp sent'],
  ['not_sent', 'WhatsApp not sent'],
];

export async function render(outlet, me) {
  const dispositions = await get('/meta/dispositions').catch(() => []);
  let filters = {};
  let preset = 'Everything';

  // Who may hand a set of leads to a teammate: counsellors and admins always,
  // and a caller who has earned the transfer grant (the leaderboard reward).
  const canTransfer = ['counsellor', 'admin', 'ops'].includes(me?.role) || Boolean(me?.can_transfer_leads);
  let transferTargets = [];
  if (canTransfer) {
    const url = me.role === 'caller' ? '/me/transfer-targets' : '/transfers/targets';
    transferTargets = await get(url).catch(() => []);
  }
  const selected = new Set();

  // Every view starts by clearing the outlet; this one forgot, so the
  // router's loading spinner stayed on screen above the panel, spinning
  // forever - which read as "the page never finishes loading".
  outlet.innerHTML = '';

  const panel = h(`
    <div class="panel">
      <h2>Find and re-tap <small>pick a list, or combine the filters</small></h2>

      <div class="chips" id="presets">
        ${PRESETS.map((p) => `
          <button class="chip ${p.label === preset ? 'on' : ''}" data-preset="${esc(p.label)}">${esc(p.label)}</button>`).join('')}
      </div>

      <div class="frow" style="align-items:flex-end">
        <label class="f">Search <span class="hint">name or phone</span>
          <input name="q" placeholder="e.g. Asha or 98765…" autocomplete="off" data-testid="lead-search">
        </label>
        <label class="f">Last outcome
          <select name="lastDisposition">
            <option value="">Any outcome</option>
            ${dispositions.map((d) => `<option value="${esc(d.value)}">${esc(d.label)}</option>`).join('')}
          </select>
        </label>
        <label class="f">Timing
          <select name="due">${DUE.map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join('')}</select>
        </label>
        <label class="f">Status
          <select name="status">${STATUS.map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join('')}</select>
        </label>
        <label class="f">WhatsApp
          <select name="whatsapp">${WHATSAPP.map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join('')}</select>
        </label>
        <label class="f">Follow-up round
          <select name="attempts">${ROUNDS.map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join('')}</select>
        </label>
        <button class="btn" id="clear">Clear</button>
      </div>

      <div id="results"></div>
    </div>`);
  outlet.appendChild(panel);

  const input = panel.querySelector('[name=q]');
  const results = panel.querySelector('#results');
  const controls = ['lastDisposition', 'due', 'status', 'whatsapp', 'attempts'];
  let timer = null;

  const readControls = () => {
    filters = {};
    for (const name of controls) {
      const v = panel.querySelector(`[name=${name}]`).value;
      if (v) filters[name] = v;
    }
  };

  const applyPreset = (p) => {
    for (const name of controls) panel.querySelector(`[name=${name}]`).value = p.filters[name] ?? '';
    readControls();
  };

  const run = async () => {
    const q = input.value.trim();

    // A filter is a complete instruction; a two-character search is not, since
    // it would match half the book.
    if (Object.keys(filters).length === 0 && q.length < 2) {
      results.innerHTML = '<div class="empty">Pick a list above, set a filter, or type at least two characters.</div>';
      return;
    }

    const params = new URLSearchParams({ limit: '200', ...filters });
    if (q.length >= 2) params.set('q', q);

    results.innerHTML = '<div class="spin"></div>';
    try {
      const data = await get(`/leads?${params.toString()}`);
      results.innerHTML = '';
      if (data.leads.length === 0) {
        results.appendChild(h('<div class="empty">Nothing you can see matches that.</div>'));
        return;
      }
      selected.clear();
      results.appendChild(h(`
        <div class="row spread" style="margin:6px 0">
          <b>${data.leads.length} lead${data.leads.length === 1 ? '' : 's'}</b>
          <span class="hint">worked top to bottom, most overdue first</span>
        </div>`));

      // The transfer bar, for those allowed to reassign a whole set at once.
      let bar = null;
      if (canTransfer && transferTargets.length > 0) {
        bar = h(`
          <div class="row" data-testid="bulk-transfer-bar" style="margin:4px 0 10px;gap:10px;align-items:center;display:none">
            <b id="sel-count">0 selected</b>
            <span>→</span>
            <select id="bulk-target" style="border:1px solid var(--line);border-radius:8px;padding:7px">
              ${transferTargets.map((t) => `<option value="${esc(t.id)}">${esc(t.full_name)}${t.on_shift ? '' : ' (off floor)'} · ${Number(t.leads_today)} today</option>`).join('')}
            </select>
            <button class="btn small primary" id="bulk-go">Transfer selected</button>
          </div>`);
        results.appendChild(bar);
      }

      results.appendChild(h(`
        <div style="overflow-x:auto">
        <table class="table"><thead><tr>
          ${canTransfer ? '<th></th>' : ''}
          <th>Name</th><th>Phone</th><th>Status</th><th>Last outcome</th>
          <th>Next action</th><th class="num">Calls so far</th><th>WA</th><th></th>
        </tr></thead><tbody>
        ${data.leads.map((l) => `
          <tr>
            ${canTransfer ? `<td><input type="checkbox" class="sel" value="${esc(l.id)}"></td>` : ''}
            <td>${esc(l.full_name ?? 'Unnamed')}</td>
            <td class="mono">${esc(l.phone_e164)}</td>
            <td>${badge(l.status)}</td>
            <td>${l.last_disposition
                  ? esc(String(l.last_disposition).replace(/_/g, ' '))
                  : '<span class="hint">never contacted</span>'}</td>
            <td>${esc(fmtDT(l.next_action_at))}</td>
            <td class="num">${Number(l.attempt_count)}</td>
            <td>${l.whatsapp_sent_at ? '<span class="badge b-ok">sent</span>' : '<span class="hint">—</span>'}</td>
            <td class="right"><a href="#/lead/${esc(l.id)}">open</a></td>
          </tr>`).join('')}
        </tbody></table></div>`));

      if (bar) {
        const table = results.querySelector('table');
        const refreshBar = () => {
          bar.style.display = selected.size > 0 ? 'flex' : 'none';
          bar.querySelector('#sel-count').textContent = `${selected.size} selected`;
        };
        table.addEventListener('change', (e) => {
          if (!e.target.classList.contains('sel')) return;
          if (e.target.checked) selected.add(e.target.value); else selected.delete(e.target.value);
          refreshBar();
        });
        bar.querySelector('#bulk-go').addEventListener('click', async (e) => {
          if (selected.size === 0) return;
          const toCallerId = bar.querySelector('#bulk-target').value;
          e.target.disabled = true;
          try {
            const r = await post('/leads/transfer-bulk', { leadIds: [...selected], toCallerId, reason: 'load_balance' });
            toast(`Transferred ${r.moved}${r.failed?.length ? `, ${r.failed.length} could not move` : ''}.`,
              r.failed?.length ? 'err' : 'ok');
            run();
          } catch (err) {
            toast(err.message, 'err');
            e.target.disabled = false;
          }
        });
      }
    } catch (err) {
      results.innerHTML = '';
      results.appendChild(h(`<div class="empty">${esc(err.message)}</div>`));
    }
  };

  panel.querySelector('#presets').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-preset]');
    if (!btn) return;
    preset = btn.dataset.preset;
    panel.querySelectorAll('#presets .chip').forEach((b) => b.classList.toggle('on', b === btn));
    applyPreset(PRESETS.find((p) => p.label === preset));
    run();
  });

  // Changing a dropdown by hand leaves the preset chips highlighted on a list
  // that is no longer what is shown, so clear the highlight.
  controls.forEach((name) => {
    panel.querySelector(`[name=${name}]`).addEventListener('change', () => {
      readControls();
      panel.querySelectorAll('#presets .chip').forEach((b) => b.classList.remove('on'));
      run();
    });
  });

  panel.querySelector('#clear').addEventListener('click', () => {
    input.value = '';
    applyPreset(PRESETS[0]);
    panel.querySelectorAll('#presets .chip').forEach((b, i) => b.classList.toggle('on', i === 0));
    run();
  });

  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(run, 300);
  });

  input.focus();
  await run();
}
