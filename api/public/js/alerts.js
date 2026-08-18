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

/**
 * Poll interval and which alerts interrupt are both settings, not constants.
 *
 * The floor's complaint was being interrupted too often about leads going
 * nowhere. Whether that is fixed by polling less, by popping fewer kinds, or by
 * widening the retry gaps depends on the day, so ops can change all three in
 * Admin -> Settings without a deploy.
 */
let pollMs = 20_000;
// Only appointments a person chose interrupt: the callback the client asked
// for, and the reminder the lead's owner set for themselves. Everything else
// waits quietly in the bell - the floor asked for the popups to stop.
let popupKinds = new Set(['callback_due', 'custom_reminder']);
// 0 = a reminder pops ONCE and then waits in the bell. The old ten-minute
// re-pop trained everyone to dismiss without reading, which is how the popup
// that actually mattered got clicked away.
let repeatMs = 0;
let chimeOn = true;

async function loadAlertSettings() {
  try {
    const cfg = await get('/meta/ui-settings');
    const secs = Number(cfg['alerts.poll_seconds']);
    if (Number.isFinite(secs) && secs >= 5) pollMs = secs * 1000;
    if (Array.isArray(cfg['alerts.popup_kinds'])) popupKinds = new Set(cfg['alerts.popup_kinds']);
    const rep = Number(cfg['alerts.repeat_minutes']);
    if (Number.isFinite(rep)) repeatMs = rep > 0 ? rep * 60_000 : 0;
    if (cfg['alerts.chime'] !== undefined) chimeOn = cfg['alerts.chime'] === true;
  } catch {
    // Defaults above are deliberately sane, so a failed read leaves the bell
    // working rather than failing shut.
  }
}

/* ---- the bell sound -------------------------------------------------------
 * One soft two-note chime when a reminder pops - the floor asked for a bell,
 * not a siren. Browsers keep audio suspended until the person has interacted
 * with the page, so the context is primed on the first click and a chime that
 * cannot sound is skipped silently rather than erroring.
 */
let audioCtx = null;

function primeAudio() {
  if (!chimeOn || audioCtx) return;
  try {
    audioCtx = new (window.AudioContext ?? window.webkitAudioContext)();
  } catch { audioCtx = null; }
}
document.addEventListener('pointerdown', primeAudio, { once: true });

function chime() {
  if (!chimeOn || !audioCtx || audioCtx.state !== 'running') return;
  try {
    const t0 = audioCtx.currentTime;
    for (const [freq, at] of [[880, 0], [1174.7, 0.18]]) {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t0 + at);
      gain.gain.exponentialRampToValueAtTime(0.12, t0 + at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + at + 0.9);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(t0 + at);
      osc.stop(t0 + at + 1);
    }
  } catch { /* a failed chime is never worth an error */ }
}

/** Alert key -> when it last popped, so re-polling does not re-interrupt early. */
const announced = new Map();

let timer = null;

const KEY = (a) => `${a.kind}:${a.lead_id}:${a.callback_id ?? ''}`;

const LABEL = {
  // Plain English, not policy names: the label should say what is true about
  // the person, so the next action is obvious without translating jargon.
  sla_breach: 'Never called',
  callback_due: 'Callback due now',
  callback_soon: 'Callback shortly',
  action_overdue: 'Follow-up overdue',
  follow_up_due: 'Follow-up due',
  custom_reminder: 'Your reminder',
  new_lead: 'New lead',
  reassigned_in: 'New lead for you',
  cross_team_in: 'From the other team',
  retap_due: 'Re-tap',
  daily_brief_morning: 'Morning brief',
  daily_brief_midday: 'Pace check',
  daily_brief_evening: 'End of day',
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
 *
 * At most two cards on screen at once. A wall of popups is exactly the
 * disturbance the floor complained about, and past two the information is
 * "several reminders are due", which one summary card says better. Every card
 * dismisses itself - nothing squats on the screen; the bell keeps the list.
 */
const MAX_POPUPS = 2;

function popupHost() {
  let host = document.getElementById('alert-popups');
  if (!host) {
    host = h('<div id="alert-popups" class="alert-popups"></div>');
    document.body.appendChild(host);
  }
  return host;
}

function popup(alert) {
  const host = popupHost();

  if (host.querySelectorAll('.alert-pop:not(.alert-pop-more)').length >= MAX_POPUPS) {
    let more = host.querySelector('.alert-pop-more');
    if (!more) {
      more = h(`
        <div class="alert-pop warning alert-pop-more">
          <div class="alert-pop-head"><b>More reminders waiting</b>
            <button class="alert-pop-x" aria-label="Dismiss">×</button></div>
          <div class="alert-pop-body"><a href="#/reminders">Open the Alerts tab →</a></div>
        </div>`);
      more.querySelector('.alert-pop-x').addEventListener('click', () => more.remove());
      more.querySelector('a').addEventListener('click', () => more.remove());
      host.appendChild(more);
      setTimeout(() => more.remove(), 30_000);
    }
    return;
  }

  const card = h(`
    <div class="alert-pop ${esc(alert.severity)}">
      <div class="alert-pop-head">
        <b>🔔 ${esc(LABEL[alert.kind] ?? alert.title)}</b>
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

  // Self-dismissing, criticals included: the card is the nudge, the bell is
  // the record. A popup that stays until dismissed becomes furniture.
  setTimeout(() => card.remove(), alert.severity === 'critical' ? 45_000 : 12_000);
}

/**
 * The shape of what is waiting, in one line.
 *
 * A hundred rows in a dropdown is not information; the counts are. The list
 * below shows only the most urgent handful, and the footer goes to the Alerts
 * tab where the whole thing is workable. Nothing is dropped — the badge and
 * the Alerts page always carry the full count.
 */
function summaryStrip(data) {
  if (data.count === 0) return '';
  const counts = new Map();
  for (const a of data.alerts) counts.set(a.kind, (counts.get(a.kind) ?? 0) + 1);
  const parts = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([kind, n]) => `<span class="alert-sum-item">${esc(LABEL[kind] ?? kind)}
      <b>${n}</b></span>`);
  return `<div class="alert-sum">${parts.join('')}</div>`;
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
      ${summaryStrip(data)}
      <div class="alert-panel-list">
        ${data.alerts.length === 0
          ? '<div class="empty">Nothing needs you right now.</div>'
          : data.alerts.slice(0, 12).map((a) => `
            <a class="alert-row ${esc(a.severity)}" href="${
              a.kind === 'retap_due' ? '#/retap'
                : a.lead_id ? `#/lead/${esc(a.lead_id)}` : '#/reminders'}">
              <span class="alert-kind">${esc(LABEL[a.kind] ?? a.kind)}</span>
              <span class="alert-lead">${esc(a.lead_name ?? a.title ?? 'Notification')}
                <span class="mono hint">${esc(a.phone_e164 ?? '')}${
                  a.owner_name ? ` · ${esc(a.owner_name)}` : ''}</span></span>
              <span class="alert-when">${esc(lateLabel(a))}</span>
            </a>`).join('')}
      </div>
      ${data.count > 0 ? `
        <a class="alert-row alert-all" href="#/reminders">
          <b>${data.count > 12 ? `Work through all ${data.count}` : 'Open the Alerts tab'} →</b>
        </a>` : ''}
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

  // The tab keeps the plain product name. The bell already carries the count
  // on screen, and a title that reads "(100) 5 Circles CRM" in the tab strip
  // is noise rather than information.
  document.title = '5 Circles CRM';

  const live = document.getElementById('alert-panel');
  if (live) { live.remove(); renderPanel(latest); }

  const now = Date.now();
  const openKeys = new Set(latest.alerts.map(KEY));
  // An alert that was handled and later fires again (a new callback on the
  // same lead) should interrupt again - forget keys that are no longer open.
  for (const key of announced.keys()) {
    if (!openKeys.has(key)) announced.delete(key);
  }

  let popped = 0;
  for (const a of latest.alerts) {
    const key = KEY(a);
    const lastPopped = announced.get(key);
    // Each alert interrupts once. The repeat cadence is a setting and ships
    // OFF (alerts.repeat_minutes = 0): a reminder that keeps reappearing gets
    // dismissed reflexively, and then ignored when it matters.
    const due =
      lastPopped === undefined ||
      (a.severity === 'critical' && repeatMs > 0 && now - lastPopped >= repeatMs);
    if (!due) continue;
    announced.set(key, now);
    // On the first poll after a page load, fill the map without popping: a
    // caller who refreshes should not be buried under every alert at once.
    if (!firstRun && popupKinds.has(a.kind)) {
      popup(a);
      popped += 1;
    }
  }
  // One chime per batch, however many cards it brought - a bell, not a siren.
  if (popped > 0) chime();
}

export async function startAlerts() {
  if (timer) clearInterval(timer);
  announced.clear();
  await loadAlertSettings();
  poll(true);
  timer = setInterval(() => poll(false), pollMs);
}

export function stopAlerts() {
  if (timer) clearInterval(timer);
  timer = null;
  announced.clear();
  document.title = '5 Circles CRM';
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
