import { get, post } from '../api.js';
import { esc, fmtDT, h, toast } from '../util.js';

/**
 * Previous months: the uploaded history, month by month, tappable.
 *
 * The admin uploads a month's records team-wise (Excel saved as CSV); they
 * land parked so they never touch the live queue, and the counsellor works
 * them from here whenever there is a gap. Picking one up puts it back into
 * live work on that person's list.
 */
export async function render(outlet, me) {
  const canUpload = ['admin', 'ops'].includes(me.role);
  let openMonth = null;

  const draw = async () => {
    const [data, teams] = await Promise.all([
      get(`/dashboards/previous-months${openMonth ? `?month=${openMonth}` : ''}`).catch(() => ({ months: [], leads: [] })),
      canUpload ? get('/admin/teams').catch(() => []) : Promise.resolve([]),
    ]);
    outlet.innerHTML = '';

    if (canUpload) {
      const up = h(`
        <div class="panel">
          <h2 class="mt0">Upload a previous month <small>Excel → Save As CSV, then paste below</small></h2>
          <div class="frow">
            <label class="f">Team
              <select name="team">${teams.map((t) => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join('')}</select>
            </label>
            <label class="f">Month <input name="month" type="month" value="2026-04"></label>
          </div>
          <label class="f">CSV <span class="hint">first row = headers (Full Name, Phone Number, City…)</span>
            <textarea name="csv" rows="5" placeholder="Full Name,Phone Number,City&#10;Asha Rao,9876543210,Pune"></textarea>
          </label>
          <div class="row"><button class="btn primary" id="hist-import">Import month</button>
            <span class="hint">records land parked in the pool for this team and month; re-uploading the same month is safe</span></div>
          <div id="hist-result" style="margin-top:10px"></div>
        </div>`);
      outlet.appendChild(up);
      up.querySelector('#hist-import').addEventListener('click', async (e) => {
        const csv = up.querySelector('[name=csv]').value;
        const month = up.querySelector('[name=month]').value;
        const teamId = up.querySelector('[name=team]').value;
        if (!csv.trim()) { toast('Paste the CSV first.', 'err'); return; }
        if (!month) { toast('Pick a month.', 'err'); return; }
        e.target.disabled = true;
        e.target.textContent = 'Importing…';
        try {
          const s = await post('/admin/history/import', { csv, teamId, month });
          up.querySelector('#hist-result').innerHTML =
            `<div class="banner" style="background:var(--info-bg);color:var(--info);border-color:#c7d7f8">
               Imported ${Number(s.created)} · duplicates ${Number(s.duplicate)} · skipped ${Number(s.skipped)}
               ${s.errors?.length ? ` · <b>${s.errors.length} row errors</b>` : ''}</div>`;
          toast(`Imported ${s.created} record${s.created === 1 ? '' : 's'} for ${month}.`);
          draw();
        } catch (err) {
          toast(err.message, 'err');
        } finally {
          e.target.disabled = false;
          e.target.textContent = 'Import month';
        }
      });
    }

    const months = data.months ?? [];
    const panel = h(`
      <div class="panel">
        <h2 class="mt0">Months on file</h2>
        ${months.length === 0 ? '<div class="empty">No history uploaded yet.</div>' : `
        <div class="chips">
          ${months.map((m) => `
            <button class="chip ${openMonth === m.month ? 'on' : ''}" data-month="${esc(m.month)}">
              ${esc(m.month_label)}${m.team_name ? ` · ${esc(m.team_name)}` : ''} <b>${Number(m.leads)}</b></button>`).join('')}
        </div>`}
        <div id="hist-leads" style="margin-top:12px"></div>
      </div>`);
    outlet.appendChild(panel);

    panel.querySelectorAll('[data-month]').forEach((b) =>
      b.addEventListener('click', () => { openMonth = openMonth === b.dataset.month ? null : b.dataset.month; draw(); }));

    const leadBox = panel.querySelector('#hist-leads');
    if (openMonth && (data.leads ?? []).length > 0) {
      leadBox.appendChild(h(`
        <table class="table" data-testid="history-leads"><thead><tr>
          <th>Name</th><th>Phone</th><th>City</th><th>Last outcome</th><th></th>
        </tr></thead><tbody>
        ${data.leads.map((l) => `
          <tr data-lead="${esc(l.lead_id)}">
            <td><a href="#/lead/${esc(l.lead_id)}">${esc(l.full_name ?? 'Unnamed')}</a></td>
            <td class="mono">${esc(l.phone_e164)}</td>
            <td>${esc(l.city ?? '—')}</td>
            <td>${l.last_disposition ? esc(String(l.last_disposition).replace(/_/g, ' ')) : '<span class="hint">not called</span>'}</td>
            <td class="right"><button class="btn small primary h-claim" data-lead="${esc(l.lead_id)}">Pick up &amp; work</button></td>
          </tr>`).join('')}
        </tbody></table>`));
    } else if (openMonth) {
      leadBox.appendChild(h('<div class="empty">No records in this month.</div>'));
    }

    leadBox.addEventListener('click', async (e) => {
      if (!e.target.classList?.contains('h-claim')) return;
      try {
        await post(`/leads/${e.target.dataset.lead}/claim`);
        toast('Picked up — it is on your list now.');
        draw();
      } catch (err) {
        toast(err.message, 'err');
      }
    });
  };

  await draw();
}
