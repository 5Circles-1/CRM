import { get } from '../api.js';
import { badge, esc, fmtDT, h } from '../util.js';

/**
 * Search and re-tap lists, within whatever RLS lets this user see.
 *
 * The search box alone was not enough to work from. The two lists a caller
 * actually needs are "everyone who did not answer" and "everyone who asked to
 * be called back", and neither is something you can type into a name search.
 * Those are one click each now; the text box still filters within them.
 */

const QUICK = [
  { key: '', label: 'All' },
  { key: 'not_answered', label: 'Not answered', kind: 'disp' },
  { key: 'callback_requested', label: 'Asked for a callback', kind: 'disp' },
  { key: 'busy', label: 'Busy', kind: 'disp' },
  { key: 'switched_off', label: 'Switched off', kind: 'disp' },
  { key: 'overdue', label: 'Overdue now', kind: 'due' },
  { key: 'untouched', label: 'Never contacted', kind: 'due' },
];

export async function render(outlet) {
  outlet.innerHTML = '';
  const panel = h(`
    <div class="panel">
      <h2>Find a lead <small>search, or pick a list to work through</small></h2>
      <div class="tabs" id="quick">
        ${QUICK.map((f, i) => `
          <button class="btn ${i === 0 ? 'active' : ''}" data-key="${esc(f.key)}"
                  data-kind="${esc(f.kind ?? '')}">${esc(f.label)}</button>`).join('')}
      </div>
      <label class="f">Search by name or phone <span class="hint">optional — narrows the list above</span>
        <input name="q" placeholder="e.g. Asha or 98765…" autocomplete="off" data-testid="lead-search">
      </label>
      <div id="results"></div>
    </div>`);
  outlet.appendChild(panel);

  const input = panel.querySelector('[name=q]');
  const results = panel.querySelector('#results');
  let timer = null;
  let filter = { key: '', kind: '' };

  const run = async () => {
    const q = input.value.trim();

    // A filter is a complete instruction on its own; a bare search is not,
    // because two characters would match half the book.
    if (!filter.key && q.length < 2) {
      results.innerHTML = '<div class="empty">Type at least two characters, or pick a list above.</div>';
      return;
    }

    const params = new URLSearchParams({ limit: '50' });
    if (q.length >= 2) params.set('q', q);
    if (filter.kind === 'disp') params.set('lastDisposition', filter.key);
    if (filter.kind === 'due') params.set('due', filter.key);

    results.innerHTML = '<div class="spin"></div>';
    try {
      const data = await get(`/leads?${params.toString()}`);
      if (data.leads.length === 0) {
        results.innerHTML = '<div class="empty">Nothing you can see matches that.</div>';
        return;
      }
      results.innerHTML = '';
      results.appendChild(h(`
        <table class="table"><thead><tr>
          <th>Name</th><th>Phone</th><th>Status</th><th>Last outcome</th>
          <th>Next action</th><th class="num">Attempts</th><th></th>
        </tr></thead><tbody>
        ${data.leads.map((l) => `
          <tr>
            <td>${esc(l.full_name ?? 'Unnamed')}</td>
            <td class="mono">${esc(l.phone_e164)}</td>
            <td>${badge(l.status)}</td>
            <td>${l.last_disposition
                    ? esc(String(l.last_disposition).replace(/_/g, ' '))
                    : '<span class="hint">never contacted</span>'}</td>
            <td>${esc(fmtDT(l.next_action_at))}</td>
            <td class="num">${Number(l.attempt_count)}</td>
            <td class="right"><a href="#/lead/${esc(l.id)}">open</a></td>
          </tr>`).join('')}
        </tbody></table>`));
    } catch (err) {
      results.innerHTML = '';
      results.appendChild(h(`<div class="empty">${esc(err.message)}</div>`));
    }
  };

  panel.querySelector('#quick').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-key]');
    if (!btn) return;
    panel.querySelectorAll('#quick .btn').forEach((b) => b.classList.toggle('active', b === btn));
    filter = { key: btn.dataset.key, kind: btn.dataset.kind };
    run();
  });

  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(run, 300);
  });
  input.focus();
}
