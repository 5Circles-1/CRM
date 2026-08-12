import { get, post } from './api.js';
import { esc, h, minsLabel, openModal, toast, wireLogoFallback } from './util.js';
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
import * as advisory from './views/advisory.js';
import * as mentors from './views/mentors.js';
import * as events from './views/events.js';
import * as training from './views/training.js';
import * as reminders from './views/reminders.js';
import * as retap from './views/retap.js';
import { startTour } from './views/training.js';
import * as team from './views/team.js';
import * as history from './views/history.js';
import { bellMarkup, startAlerts, stopAlerts, wireBell } from './alerts.js';

const NAV = [
  { hash: '#/day', label: 'My Pipeline', roles: ['caller', 'counsellor'] },
  { hash: '#/reminders', label: 'Alerts', roles: ['caller', 'counsellor', 'mentor', 'admin', 'ops'] },
  { hash: '#/retap', label: 'Re-tap', roles: ['caller', 'counsellor', 'admin', 'ops'] },
  { hash: '#/floor', label: 'Floor', roles: ['counsellor', 'admin'] },
  { hash: '#/collections', label: 'Collections', roles: ['counsellor', 'admin', 'ops'] },
  { hash: '#/advisory', label: 'Advisory clients', roles: ['counsellor', 'admin', 'ops', 'viewer'] },
  { hash: '#/mentors', label: 'Mentors', roles: ['mentor', 'counsellor', 'admin', 'ops', 'viewer'] },
  { hash: '#/events', label: 'Events', roles: ['caller', 'counsellor', 'mentor', 'admin', 'ops', 'viewer'] },
  { hash: '#/dash', label: 'Dashboards', roles: ['counsellor', 'admin', 'ops', 'viewer'] },
  { hash: '#/leads', label: 'Find lead', roles: ['caller', 'counsellor', 'admin', 'ops'] },
  { hash: '#/people', label: 'Performance', roles: ['caller', 'counsellor', 'admin', 'ops'] },
  { hash: '#/history', label: 'Previous months', roles: ['counsellor', 'admin', 'ops', 'viewer'] },
  { hash: '#/team', label: 'Team', roles: ['caller', 'counsellor', 'mentor', 'admin', 'ops', 'viewer'] },
  { hash: '#/score', label: 'My Score', roles: ['caller', 'counsellor'] },
  { hash: '#/attendance', label: 'Attendance', roles: ['caller', 'counsellor', 'mentor', 'admin', 'ops', 'viewer'] },
  { hash: '#/training', label: 'Training', roles: ['caller', 'counsellor', 'mentor', 'admin', 'ops', 'viewer'] },
  { hash: '#/admin', label: 'Admin', roles: ['admin', 'ops'] },
];

const DEFAULT_ROUTE = {
  caller: '#/day', counsellor: '#/floor', mentor: '#/mentors', ops: '#/dash', admin: '#/floor', viewer: '#/dash',
};

const VIEWS = {
  day, reminders, retap, floor, collections, advisory, mentors, events, training,
  dash, leads, people, score, attendance, admin, lead, team, history,
};

/**
 * Which training module explains each screen. The "?" beside the page title
 * deep-links here, so help is always one click from the thing you are looking
 * at rather than a search away.
 */
const HELP_FOR = {
  day: 'the-callers-job', reminders: 'the-callers-job', retap: 'the-callers-job',
  floor: 'the-counsellors-job',
  collections: 'the-counsellors-job', advisory: 'the-counsellors-job',
  mentors: 'the-mentors-job', events: 'how-the-crm-works',
  dash: 'how-the-crm-works', leads: 'the-callers-job',
  people: 'the-counsellors-job', score: 'the-callers-job',
  attendance: 'how-the-crm-works', admin: 'the-admins-job',
  lead: 'the-callers-job', team: 'how-the-crm-works',
  history: 'the-counsellors-job', training: null,
};

const TITLES = {
  day: 'My Pipeline', reminders: 'Alerts', retap: 'Re-tap', floor: 'Floor', collections: 'Collections', advisory: 'Advisory clients', mentors: 'Mentors',
  events: 'Events', training: 'Training',
  dash: 'Dashboards', leads: 'Find lead', people: 'Performance', score: 'My Score',
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
          <button class="btn small" id="theme-btn" title="Light or dim">◐</button>
          <button class="btn small" id="pwd-btn" title="Change my password">Password</button>
          <button class="btn small" id="logout-btn">Log out</button>
        </div>
        <div id="ticker-strip"></div>
        <div id="freeze-banner"></div>
        <div id="brief-banner"></div>
        <div class="content" id="outlet"></div>
      </div>
    </div>`));

  // Dim theme: dark chrome, light cards - remembered per browser. The cards
  // stay light because every chart colour was validated on a light surface.
  // Two full themes, light and dark, both token-driven. "dim" (the old
  // half-measure) maps to dark so nobody's saved choice breaks. Default
  // follows the operating system.
  const applyTheme = () => {
    let t = localStorage.getItem('crm-theme');
    if (t === 'dim') t = 'dark';
    if (t === null) t = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : '';
    document.documentElement.dataset.theme = t;
    return t;
  };
  applyTheme();
  document.getElementById('theme-btn').addEventListener('click', () => {
    const cur = applyTheme();
    localStorage.setItem('crm-theme', cur === 'dark' ? 'light' : 'dark');
    applyTheme();
    route(); // charts read their colours at draw time, so redraw the page
  });

  document.getElementById('pwd-btn').addEventListener('click', () => changeMyPassword());

  document.getElementById('logout-btn').addEventListener('click', async () => {
    await post('/auth/logout').catch(() => {});
    stopAlerts();
    me = null;
    location.hash = '';
    boot();
  });

  wireLogoFallback(app);
  applyRegistryTooltips();
  wireBell();
  startAlerts();
  startLiveRefresh();
  refreshShift();
  startTicker();
  startFreezeBanner();
  drawBrief();
  celebrate(me);
  offerTour();
}

/**
 * A new starter is walked round the screen once. The flag lives on the user
 * row rather than in localStorage, so logging in from a second machine does
 * not restart the tour. It is replayable from Training at any time.
 */
/**
 * Tooltips come from the same registry file the Training glossary renders, so
 * the tooltip and the manual cannot drift apart - there is only one sentence,
 * and both read it. Nav items are matched by their #/hash.
 */
async function applyRegistryTooltips() {
  try {
    const { entries } = await get('/training/registry');
    const byKey = new Map(entries.map((e) => [e.key, e]));
    document.querySelectorAll('.sidebar a.nav').forEach((a) => {
      const e = byKey.get(`tab.${(a.dataset.nav ?? '').slice(2)}`);
      if (e) a.title = `${e.does}\n\nWhen: ${e.when}`;
    });
    for (const [id, key] of [
      ['shift-widget', 'btn.start_shift'], ['theme-btn', 'btn.theme'],
      ['pwd-btn', 'btn.password'], ['ticker-strip', 'panel.ticker'],
      ['brief-banner', 'panel.brief'],
    ]) {
      const el = document.getElementById(id);
      const e = byKey.get(key);
      if (el && e) el.title = `${e.does}\n\nWhen: ${e.when}`;
    }
  } catch { /* tooltips are a nicety; never break the shell over them */ }
}

async function offerTour() {
  try {
    const t = await get('/training');
    if (!t.tourCompleted) setTimeout(() => startTour(me), 900);
  } catch { /* the tour is never worth failing a page load over */ }
}

/**
 * Self-service password change, from anywhere in the app.
 *
 * This existed as an endpoint since day one and was reachable only through the
 * forced first-login flow - so the answer to "how do I change my password" was
 * "you can't, unless we make you". Forgetting it entirely is the other case:
 * the sign-in screen now says who to ask, and the admin's own lockout is
 * covered by the server-side rescue tool.
 */
function changeMyPassword() {
  const bodyEl = h(`
    <div>
      <label class="f">Current password <input name="cur" type="password" autocomplete="current-password"></label>
      <label class="f">New password
        <span class="hint">at least 10 characters</span>
        <input name="p1" type="password" autocomplete="new-password"></label>
      <label class="f">New password again <input name="p2" type="password" autocomplete="new-password"></label>
    </div>`);
  const footer = h('<div><button class="btn primary">Change password</button></div>');
  const { close } = openModal('Change my password', bodyEl, footer);

  footer.querySelector('button').addEventListener('click', async () => {
    const cur = bodyEl.querySelector('[name=cur]').value;
    const p1 = bodyEl.querySelector('[name=p1]').value;
    const p2 = bodyEl.querySelector('[name=p2]').value;
    if (p1.length < 10) { toast('The new password needs at least 10 characters.', 'err'); return; }
    if (p1 !== p2) { toast('The two new passwords do not match.', 'err'); return; }
    try {
      await post('/auth/change-password', { currentPassword: cur, newPassword: p1 });
      toast('Password changed.');
      close();
    } catch (err) {
      toast(err.message, 'err');
    }
  });
}

/* ---- the ticker strip: five numbers, deltas vs yesterday (WP A4) ---- */

const tickerDelta = (today, yday, fmt = (v) => String(v)) => {
  const d = Number(today) - Number(yday);
  const cls = d > 0 ? 'up' : d < 0 ? 'down' : 'flat';
  const glyph = d > 0 ? '\u25b2' : d < 0 ? '\u25bc' : '\u2022';
  return `<span class="tk-num">${esc(fmt(today))}</span>
          <span class="tk-delta ${cls}">${glyph} ${esc(fmt(Math.abs(d)))}</span>`;
};

async function drawTicker() {
  const host = document.getElementById('ticker-strip');
  if (!host) return;
  try {
    const t = await get('/dashboards/ticker');
    const inr = (v) => '\u20b9' + Number(v).toLocaleString('en-IN');
    host.innerHTML = `
      <div class="ticker">
        <span class="tk"><span class="tk-label">Collected today</span>${tickerDelta(t.collected_today, t.collected_yday, inr)}</span>
        <span class="tk"><span class="tk-label">Fresh leads</span>${tickerDelta(t.leads_today, t.leads_yday)}</span>
        <span class="tk"><span class="tk-label">Walk-ins</span>${tickerDelta(t.walkins_today, t.walkins_yday)}</span>
        <span class="tk"><span class="tk-label">Conversions</span>${tickerDelta(t.deals_today, t.deals_yday)}</span>
        <span class="tk"><span class="tk-label">On floor</span><span class="tk-num">${Number(t.on_floor)}</span></span>
      </div>`;
  } catch { host.innerHTML = ''; }
}
let tickerTimer = null;
function startTicker() {
  drawTicker();
  if (tickerTimer) clearInterval(tickerTimer);
  tickerTimer = setInterval(drawTicker, 60_000);
  tickerTimer.unref?.();
}

/* ---- the daily accountability banner (WP E) ---- */

const inrShort = (v) => {
  const n = Number(v ?? 0);
  if (!Number.isFinite(n)) return '₹0';
  if (Math.abs(n) >= 1e7) return '₹' + (n / 1e7).toFixed(2).replace(/\.?0+$/, '') + 'Cr';
  if (Math.abs(n) >= 1e5) return '₹' + (n / 1e5).toFixed(2).replace(/\.?0+$/, '') + 'L';
  return '₹' + Math.round(n).toLocaleString('en-IN');
};

/**
 * One line, dismissible for the day: what today is costing and the pace the
 * month now needs. Same numbers as the reminder in the bell - both read
 * crm.v_daily_brief, so they cannot drift apart.
 */
async function drawBrief() {
  const host = document.getElementById('brief-banner');
  if (!host) return;
  const today = new Date().toISOString().slice(0, 10);
  const key = `crm-brief-hidden-${me.id}-${today}`;
  if (localStorage.getItem(key)) { host.innerHTML = ''; return; }

  let b;
  let teams = [];
  try {
    const r = await get('/me/brief');
    b = r.brief;
    teams = r.teams ?? [];
  } catch { host.innerHTML = ''; return; }

  // Admin and ops carry no dial or revenue target of their own, so their
  // banner is the floor's: the same arithmetic, summed over the teams.
  if (!b && teams.length) {
    const sum = (k) => teams.reduce((s, t) => s + Number(t[k] || 0), 0);
    b = null;
    host.innerHTML = `
      <div class="brief">
        <span class="brief-title">Floor today</span>
        ${[
          ['Collected', inrShort(sum('collected_today')), sum('collected_today') > 0],
          ['Left this month', inrShort(sum('gap_to_target')), sum('gap_to_target') === 0],
          ['Needed per day', inrShort(sum('required_per_day')), null],
          ['Dials', sum('dials_today'), null],
          ['Untouched', sum('untouched_now'), sum('untouched_now') === 0],
          ['Overdue', sum('overdue_now'), sum('overdue_now') === 0],
          ['Walk-ins', sum('walkins_today'), null],
        ].map(([k, v, ok]) => `
          <span class="brief-cell"><span class="brief-k">${esc(k)}</span>
          <span class="brief-v ${ok === null ? '' : ok ? 'good' : 'bad'}">${esc(String(v))}</span></span>`).join('')}
        <button class="brief-x" title="Hide until tomorrow" aria-label="Hide">✕</button>
      </div>`;
    host.querySelector('.brief-x').addEventListener('click', () => {
      localStorage.setItem(key, '1');
      host.innerHTML = '';
    });
    return;
  }
  if (!b) { host.innerHTML = ''; return; }

  const cells = b.role === 'caller'
    ? [
        ['Dials today', `${b.dials_today} / ${b.dial_target ?? 0}`, Number(b.dials_today) >= Number(b.dial_target ?? 0)],
        ['Untouched', b.untouched_now, Number(b.untouched_now) === 0],
        ['Overdue', b.overdue_now, Number(b.overdue_now) === 0],
        ['Callbacks due', b.callbacks_today, true],
      ]
    : [
        ['Collected today', inrShort(b.collected_today), Number(b.collected_today) > 0],
        ['Left this month', inrShort(b.gap_to_target), Number(b.gap_to_target) === 0],
        ['Needed per day', `${inrShort(b.required_per_day)} × ${b.working_days_left}d`, null],
        ['Pace so far', `${inrShort(b.current_per_day)} / day`, Number(b.pace_pct ?? 0) >= 95],
        ['Overdue', b.overdue_now, Number(b.overdue_now) === 0],
      ];

  host.innerHTML = `
    <div class="brief">
      <span class="brief-title">Today</span>
      ${cells.map(([k, v, ok]) => `
        <span class="brief-cell">
          <span class="brief-k">${esc(k)}</span>
          <span class="brief-v ${ok === null ? '' : ok ? 'good' : 'bad'}">${esc(String(v))}</span>
        </span>`).join('')}
      <button class="brief-x" title="Hide until tomorrow" aria-label="Hide">✕</button>
    </div>`;
  host.querySelector('.brief-x').addEventListener('click', () => {
    localStorage.setItem(key, '1');
    host.innerHTML = '';
  });
}

/* ---- circuit breaker banner during the lunch freeze (WP C) ---- */

let freezeCfg = null;
async function startFreezeBanner() {
  try {
    const cfg = await get('/meta/ui-settings');
    freezeCfg = {
      start: Number(cfg['freeze.start_minutes'] ?? 840),
      end: Number(cfg['freeze.end_minutes'] ?? 870),
    };
  } catch { freezeCfg = { start: 840, end: 870 }; }
  const tick = () => {
    const host = document.getElementById('freeze-banner');
    if (!host) return;
    const ist = new Date(Date.now() + (330 + new Date().getTimezoneOffset()) * 60_000);
    const mow = ist.getHours() * 60 + ist.getMinutes();
    const inFreeze = ist.getDay() !== 0 && mow >= freezeCfg.start && mow < freezeCfg.end;
    if (!inFreeze) { host.innerHTML = ''; return; }
    const left = freezeCfg.end * 60 - (mow * 60 + ist.getSeconds());
    const mm = String(Math.floor(left / 60)).padStart(2, '0');
    const ss = String(left % 60).padStart(2, '0');
    const until = `${Math.floor(freezeCfg.end / 60) % 12 || 12}:${String(freezeCfg.end % 60).padStart(2, '0')} pm`;
    host.innerHTML = `<div class="freeze-banner">\u23f8 Circuit breaker \u2014 lunch hold.
      Nothing moves and no SLA runs. Resumes ${esc(until)} \u00b7 <b class="mono">${mm}:${ss}</b></div>`;
  };
  tick();
  setInterval(tick, 1000);
}

/* ---- once-a-day celebration (WP K) ---- */

function celebrate(user) {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
  const key = `crm-pop-${user.id}-${today}`;
  if (localStorage.getItem(key) || localStorage.getItem('crm-pop-off') === '1') return;
  localStorage.setItem(key, '1');

  if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
    toast('\ud83c\udf89 New day on the floor \u2014 go get it.');
    return;
  }
  const host = h('<div class="confetti" aria-hidden="true"></div>');
  document.body.appendChild(host);
  const colours = ['#0281C2', '#076F9E', '#eda100', '#1baf7a', '#e87ba4'];
  for (let i = 0; i < 80; i += 1) {
    const bit = document.createElement('i');
    bit.style.left = `${Math.random() * 100}vw`;
    bit.style.background = colours[i % colours.length];
    bit.style.animationDelay = `${Math.random() * 0.3}s`;
    bit.style.transform = `rotate(${Math.random() * 360}deg)`;
    host.appendChild(bit);
  }
  setTimeout(() => host.remove(), 1600);
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
  const titleEl = document.getElementById('page-title');
  titleEl.textContent = TITLES[name] ?? '5 Circles CRM';
  // The contextual "?": one click from any screen to the module explaining it.
  const helpSlug = HELP_FOR[name];
  if (helpSlug) {
    const dot = h(`<button class="help-dot" title="What is this screen for?" aria-label="Help">?</button>`);
    dot.addEventListener('click', () => { location.hash = `#/training/${helpSlug}`; });
    titleEl.appendChild(dot);
  }
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
