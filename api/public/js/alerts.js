import { get } from './api.js';
import { esc, h } from './util.js';

/**
 * The alert bell and the reminder that pops up on its own.
 *
 * Two different jobs, deliberately. The bell is a list you consult; the popup
 * is something that interrupts you. A caller mid-dial will not go looking for
 * a callback that fell due sixty seconds ago, so a callback coming due has to
 * arrive on its own - but only ONCE per alert, because a reminder that keeps
 * reappearing gets dismissed reflexively and then ignored when it matters.
 */

const POLL_MS = 30_000;

/** Alerts already popped, so re-polling does not re-interrupt. */
const announced = new Set();

let timer = null;

const KEY = (a) => `${a.kind}:${a.lead_id}:${a.callback_id ?? ''}`;

const LABEL = {
  sla_breach: 'SLA breached',
  callback_due: 'Callback due now',
  callback_soon: 'Callback shortly',
  action_overdue: 'Follow-up overdue',
  reassigned_in: 'New lead for you',
};

function lateLabel(a) {
  const m = Number(a.minutes_late ?? 0);
  if (m > 0) return `${m}m late`;
  if (m < 0) return `in ${Math.abs(m)}m`;
  return 'now';
}

/**
 * The interrupting reminder. Anchored bottom-right rather than a modal: a modal
 * would steal the keyboard from someone typing call notes, which is exactly
 * when a callback alert is most likely to fire.
 */
function popup(alert) {
  let host = document.getElementById('alert-popups');
  if (!host) {
    host = h('<div id="alert-popups" class="alert-popups"></div>');
    document.body.appendChild(host);
  }

  const card = h(`
    <div class="alert-pop ${esc(alert.severity)}">
      <div class="alert-pop-head">
        <b>${esc(LABEL[alert.kind] ?? alert.title)}</b>
        <button class="alert-pop-x" aria-label="Dismiss">×</button>
      </div>
      <div class="alert-pop-body">
        <a href="#/lead/${esc(alert.lead_id)}">${esc(alert.lead_name ?? 'Lead')}</a>
        <span class="mono">${esc(alert.phone_e164 ?? '')}</span>
      </div>
      <div class="alert-pop-foot">${esc(alert.title)} · ${esc(lateLabel(alert))}</div>
    </div>`);

  card.querySelector('.alert-pop-x').addEventListener('click', () => card.remove());
  card.querySelector('a').addEventListener('click', () => card.remove());
  host.appendChild(card);

  // Critical alerts stay until dismissed. A missed callback that quietly faded
  // after eight seconds would be worse than not showing it at all.
  if (alert.severity !== 'critical') setTimeout(() => card.remove(), 12_000);
}

function renderPanel(data) {
  const existing = document.getElementById('alert-panel');
  if (existing) existing.remove();

  const panel = h(`
    <div id="alert-panel" class="alert-panel">
      <div class="alert-panel-head">
        <b>Alerts</b>
        <span class="hint">${data.count} open${data.critical ? ` · ${data.critical} critical` : ''}</span>
      </div>
      <div class="alert-panel-list">
        ${data.alerts.length === 0
          ? '<div class="empty">Nothing needs you right now.</div>'
          : data.alerts.map((a) => `
            <a class="alert-row ${esc(a.severity)}" href="#/lead/${esc(a.lead_id)}">
              <span class="alert-kind">${esc(LABEL[a.kind] ?? a.kind)}</span>
              <span class="alert-lead">${esc(a.lead_name ?? 'Lead')}
                <span class="mono hint">${esc(a.phone_e164 ?? '')}</span></span>
              <span class="alert-when">${esc(lateLabel(a))}</span>
            </a>`).join('')}
      </div>
    </div>`);

  document.body.appendChild(panel);
  panel.addEventListener('click', (e) => {
    if (e.target.closest('a')) panel.remove();
  });

  const closeOnOutside = (e) => {
    if (!panel.contains(e.target) && !e.target.closest('#alert-bell')) {
      panel.remove();
      document.removeEventListener('click', closeOnOutside);
    }
  };
  setTimeout(() => document.addEventListener('click', closeOnOutside), 0);
}

let latest = { count: 0, critical: 0, alerts: [] };

async function poll(firstRun) {
  const bell = document.getElementById('alert-bell');
  if (!bell) return;
  try {
    latest = await get('/me/alerts');
  } catch {
    return; // A failed poll is not worth a toast every thirty seconds.
  }

  const badge = bell.querySelector('.alert-badge');
  badge.textContent = latest.count > 99 ? '99+' : String(latest.count);
  badge.classList.toggle('hide', latest.count === 0);
  bell.classList.toggle('critical', latest.critical > 0);

  const live = document.getElementById('alert-panel');
  if (live) { live.remove(); renderPanel(latest); }

  for (const a of latest.alerts) {
    const key = KEY(a);
    if (announced.has(key)) continue;
    announced.add(key);
    // On the first poll after a page load, fill the set without popping: a
    // caller who refreshes should not be buried under every alert at once.
    if (!firstRun && (a.kind === 'callback_due' || a.kind === 'callback_soon' || a.kind === 'reassigned_in')) {
      popup(a);
    }
  }
}

export function startAlerts() {
  if (timer) clearInterval(timer);
  announced.clear();
  poll(true);
  timer = setInterval(() => poll(false), POLL_MS);
}

export function stopAlerts() {
  if (timer) clearInterval(timer);
  timer = null;
  announced.clear();
}

export function bellMarkup() {
  return `
    <button class="alert-bell" id="alert-bell" title="Alerts" aria-label="Alerts">
      <span class="alert-bell-icon">🔔</span>
      <span class="alert-badge hide">0</span>
    </button>`;
}

export function wireBell() {
  const bell = document.getElementById('alert-bell');
  if (!bell) return;
  bell.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = document.getElementById('alert-panel');
    if (open) open.remove();
    else renderPanel(latest);
  });
}
