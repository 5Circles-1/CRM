import { get } from '../api.js';
import { badge, esc, fmtDT, h } from '../util.js';

/** Search within whatever RLS lets this user see. */
export async function render(outlet) {
  outlet.innerHTML = '';
  const panel = h(`
    <div class="panel">
      <h2>Find a lead</h2>
      <label class="f">Search by name or phone
        <input name="q" placeholder="e.g. Asha or 98765…" autocomplete="off" data-testid="lead-search">
      </label>
      <div id="results"></div>
    </div>`);
  outlet.appendChild(panel);

  const input = panel.querySelector('[name=q]');
  const results = panel.querySelector('#results');
  let timer = null;

  const run = async () => {
    const q = input.value.trim();
    if (q.length < 2) { results.innerHTML = '<div class="empty">Type at least two characters.</div>'; return; }
    results.innerHTML = '<div class="spin"></div>';
    try {
      const data = await get(`/leads?q=${encodeURIComponent(q)}&limit=50`);
      if (data.leads.length === 0) {
        results.innerHTML = '<div class="empty">No lead you can see matches that.</div>';
        return;
      }
      results.innerHTML = '';
      results.appendChild(h(`
        <table class="table"><thead><tr>
          <th>Name</th><th>Phone</th><th>Status</th><th>Next action</th><th class="num">Attempts</th><th></th>
        </tr></thead><tbody>
        ${data.leads.map((l) => `
          <tr>
            <td>${esc(l.full_name ?? 'Unnamed')}</td>
            <td class="mono">${esc(l.phone_e164)}</td>
            <td>${badge(l.status)}</td>
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

  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(run, 300);
  });
  input.focus();
}
