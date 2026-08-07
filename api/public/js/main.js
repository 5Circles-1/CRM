import { get, post } from './api.js';
import { esc, h, minsLabel, toast, wireLogoFallback } from './util.js';
import { renderLogin } from './views/login.js';
import * as day from './views/day.js';
import * as lead from './views/lead.js';
import * as score from './views/score.js';
import * as attendance from './views/attendance.js';
import * as floor from './views/floor.js';
import * as collections from './views/collections.js';
import * as dash from './views/dash.js';
import * as admin from './views/admin.js';
import * as leads from './views/leads.js';
import * as people from './views/people.js';
import * as team from './views/team.js';
import * as history from './views/history.js';
import { bellMarkup, startAlerts, stopAlerts, wireBell } from './alerts.js';

const NAV = [
  { hash: '#/day', label: 'My Pipeline', roles: ['caller', 'counsellor'] },
  { hash: '#/floor', label: 'Floor', roles: ['counsellor', 'admin'] },
  { hash: '#/collections', label: 'Collections', roles: ['counsellor', 'admin', 'ops'] },
  { hash: '#/dash', label: 'Dashboards', roles: ['counsellor', 'admin', 'ops', 'viewer'] },
  { hash: '#/leads', label: 'Find lead', roles: ['caller', 'counsellor', 'admin', 'ops'] },
  { hash: '#/people', label: 'Performance', roles: ['caller', 'counsellor', 'admin', 'ops'] },
  { hash: '#/history', label: 'Previous months', roles: ['counsellor', 'admin', 'ops', 'viewer'] },
  { hash: '#/team', label: 'Team', roles: ['caller', 'counsellor', 'admin', 'ops', 'viewer'] },
  { hash: '#/score', label: 'My Score', roles: ['caller', 'counsellor'] },
  { hash: '#/attendance', label: 'Attendance', roles: ['caller', 'counsellor', 'admin', 'ops', 'viewer'] },
  { hash: '#/admin', label: 'Admin', roles: ['admin', 'ops'] },
];

const DEFAULT_ROUTE = {
  caller: '#/day', counsellor: '#/floor', ops: '#/dash', admin: '#/floor', viewer: '#/dash',
};

const VIEWS = {
  day, floor, collections, dash, leads, people, score, attendance, admin, lead, team, history,
};

const TITLES = {
  day: 'My Pipeline', floor: 'Floor', collections: 'Collections', dash: 'Dashboards',
  leads: 'Find lead', people: 'Performance', score: 'My Score',
  attendance: 'Attendance', admin: 'Admin', lead: 'Lead',
  team: 'Team', history: 'Previous months',
};

let me = null;
let showingLogin = false;

/** Idempotent: a burst of 401s (boot + shift widget) renders login once. */
function showLogin() {
  if (showingLogin) return;
  showingLogin = true;
  stopAlerts();
  me = null;
  renderLogin(document.getElementById('app'), () => {
    showingLogin = false;
    boot();
  });
}

async function boot() {
  const app = document.getElementById('app');
  try {
    me = await get('/me');
  } catch {
    showLogin();
    return;
  }
  showingLogin = false;
  renderShell(app);
  if (!location.hash || location.hash === '#/') {
    location.hash = DEFAULT_ROUTE[me.role] ?? '#/attendance';
  } else {
    route();
  }
}

function renderShell(app) {
  const items = NAV.filter((n) => n.roles.includes(me.role));
  app.innerHTML = '';
  app.appendChild(h(`
    <div class="shell">
      <nav class="sidebar">
        <div class="logo">
          <img data-logo alt="" class="logo-mark">
          <span class="logo-text">5 Circles <b>CRM</b></span>
        </div>
        ${items.map((n) => `<a class="nav" data-nav="${n.hash}" href="${n.hash}">${esc(n.label)}</a>`).join('')}
        <div class="foot">Sales floor · IST</div>
      </nav>
      <div class="main">
        <div class="topbar">
          <h1 id="page-title"></h1>
          <span class="live-badge" id="live-badge" title="This page refreshes itself — no F5 needed"><span class="live-dot"></span>Live</span>
          <div class="shift" id="shift-widget"></div>
          ${bellMarkup()}
          <div class="userchip"><b>${esc(me.full_name)}</b>${esc(me.role)}${me.team_name ? ' · ' + esc(me.team_name) : ''}</div>
          <button class="btn small" id="logout-btn">Log out</button>
        </div>
        <div class="content" id="outlet"></div>
      </div>
    </div>`));

  document.getElementById('logout-btn').addEventListener('click', async () => {
    await post('/auth/logout').catch(() => {});
    stopAlerts();
    me = null;
    location.hash = '';
    boot();
  });

  wireLogoFallback(app);
  wireBell();
  startAlerts();
  startLiveRefresh();
  refreshShift();
}

async function refreshShift() {
  const el = document.getElementById('shift-widget');
  if (!el) return;
  try {
    const [profile, att] = await Promise.all([get('/me'), get('/me/attendance?days=1')]);
    const today = Array.isArray(att) ? att[0] : null;
    const mins = today?.logged_minutes ?? 0;
    const on = Boolean(profile.on_shift);
    el.className = `shift ${on ? 'on' : ''}`;
    el.innerHTML = `
      <span class="dot"></span>
      <span>${on ? 'On floor' : 'Off floor'}</span>
      <span class="mins">${minsLabel(mins)} / 9h</span>
      <button class="btn small" id="shift-btn">${on ? 'End shift' : 'Start shift'}</button>`;
    el.querySelector('#shift-btn').addEventListener('click', async () => {
      try {
        await post(on ? '/attendance/logout' : '/attendance/login');
        toast(on ? 'Shift ended.' : 'Shift started — you are on the floor.');
      } catch (err) {
        toast(err.message, 'err');
      }
      refreshShift();
    });
  } catch {
    el.textContent = '';
  }
}

/**
 * Render the current hash into the outlet.
 *
 * Two modes, and the difference is the whole fix for "the page keeps
 * refreshing": a NAVIGATION (soft = false) swaps the outlet immediately and
 * shows a spinner, because the user asked for a new page and feedback beats a
 * frozen screen. A LIVE REFRESH (soft = true) renders the new page into a
 * detached node first and swaps only once the data has arrived - the user
 * never sees a spinner, a blank flash, or a scroll jump, just numbers that
 * are suddenly current. If the refresh fails it keeps the page it has; stale
 * beats broken.
 */
async function route(soft = false) {
  if (!me) return;
  const outlet = document.getElementById('outlet');
  if (!outlet) return;

  const parts = (location.hash || '#/').slice(2).split('/');
  const name = parts[0] || (DEFAULT_ROUTE[me.role] ?? '#/attendance').slice(2);
  const view = VIEWS[name];

  document.querySelectorAll('.sidebar a.nav').forEach((a) => {
    a.classList.toggle('active', a.dataset.nav === `#/${name}`);
  });
  document.getElementById('page-title').textContent = TITLES[name] ?? '5 Circles CRM';
  document.getElementById('live-badge')?.classList.toggle('show', LIVE_VIEWS.has(name));

  if (!view) {
    location.hash = DEFAULT_ROUTE[me.role] ?? '#/attendance';
    return;
  }

  // Fresh outlet per render: views attach listeners to it, and reusing the
  // node would stack a new handler on every visit.
  const fresh = outlet.cloneNode(false);

  if (!soft) {
    outlet.replaceWith(fresh);
    fresh.innerHTML = '<div class="spin"></div>';
    try {
      await view.render(fresh, me, parts.slice(1));
    } catch (err) {
      fresh.innerHTML = '';
      fresh.appendChild(h(`<div class="panel"><h2>Could not load this page</h2><p class="hint">${esc(err.message)}</p></div>`));
    }
    refreshShift();
    return;
  }

  try {
    await view.render(fresh, me, parts.slice(1));
  } catch {
    return; // failed refresh: keep the page we have
  }
  // The world may have moved while the data was loading. If the user
  // navigated away or opened a form mid-fetch, throw this render away.
  const current = document.getElementById('outlet');
  if (!current || currentViewName() !== name) return;
  if (document.querySelector('.overlay, .modal')) return;
  const scrollY = window.scrollY;
  const scrollTop = current.scrollTop;
  current.replaceWith(fresh);
  fresh.scrollTop = scrollTop;
  window.scrollTo(0, scrollY);
  markLive();
  refreshShift();
}

function markLive() {
  const badge = document.getElementById('live-badge');
  if (!badge) return;
  const t = new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(new Date());
  badge.title = `Auto-refreshing — last update ${t} IST`;
  badge.classList.remove('pulse');
  void badge.offsetWidth; // restart the pulse animation
  badge.classList.add('pulse');
}

/**
 * Redraw the current page on a timer, so a new lead appears without anyone
 * pressing F5. The floor was refreshing by hand to find out whether work had
 * arrived, which is both tedious and unreliable - a lead nobody refreshes for
 * is a lead nobody calls.
 *
 * Only the views that show live work refresh, the cadence is a setting
 * (ui.refresh_seconds), and the redraw is the seamless kind above. Redrawing
 * a page underneath someone who is typing, selecting text, or mid-form is
 * worse than a stale number, so all three suppress the tick.
 */
const LIVE_VIEWS = new Set(['day', 'floor', 'collections', 'people', 'dash', 'team']);
let liveTimer = null;

function currentViewName() {
  return (location.hash || '#/').slice(2).split('/')[0];
}

async function startLiveRefresh() {
  if (liveTimer) clearInterval(liveTimer);
  let everyMs = 30_000;
  try {
    const cfg = await get('/meta/ui-settings');
    const secs = Number(cfg['ui.refresh_seconds']);
    if (Number.isFinite(secs) && secs >= 5) everyMs = secs * 1000;
  } catch { /* the default above is sane */ }
  liveTimer = setInterval(() => {
    if (!me) return;
    if (!LIVE_VIEWS.has(currentViewName())) return;
    if (document.hidden) return;                    // not while the tab is in the background
    if (document.querySelector('.overlay, .modal')) return;  // not mid-form
    if (document.activeElement && ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) return;
    if (String(window.getSelection() ?? '').length > 0) return; // not under a text selection
    route(true);
  }, everyMs);
}

window.addEventListener('hashchange', () => route());
window.addEventListener('crm:unauthorized', showLogin);

boot();
