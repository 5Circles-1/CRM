import { get, post } from './api.js';
import { esc, h, minsLabel, toast } from './util.js';
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
import { bellMarkup, startAlerts, stopAlerts, wireBell } from './alerts.js';

const NAV = [
  { hash: '#/day', label: 'My Day', roles: ['caller'] },
  { hash: '#/floor', label: 'Floor', roles: ['counsellor', 'admin'] },
  { hash: '#/collections', label: 'Collections', roles: ['counsellor', 'admin', 'ops'] },
  { hash: '#/dash', label: 'Dashboards', roles: ['counsellor', 'admin', 'ops', 'viewer'] },
  { hash: '#/leads', label: 'Find lead', roles: ['caller', 'counsellor', 'admin', 'ops'] },
  { hash: '#/score', label: 'My Score', roles: ['caller', 'counsellor'] },
  { hash: '#/attendance', label: 'Attendance', roles: ['caller', 'counsellor', 'admin', 'ops', 'viewer'] },
  { hash: '#/admin', label: 'Admin', roles: ['admin', 'ops'] },
];

const DEFAULT_ROUTE = {
  caller: '#/day', counsellor: '#/floor', ops: '#/dash', admin: '#/floor', viewer: '#/dash',
};

const VIEWS = {
  day, floor, collections, dash, leads, score, attendance, admin, lead,
};

const TITLES = {
  day: 'My Day', floor: 'Floor', collections: 'Collections', dash: 'Dashboards',
  leads: 'Find lead', score: 'My Score', attendance: 'Attendance', admin: 'Admin',
  lead: 'Lead',
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
        <div class="logo">5 Circles <span>CRM</span></div>
        ${items.map((n) => `<a class="nav" data-nav="${n.hash}" href="${n.hash}">${esc(n.label)}</a>`).join('')}
        <div class="foot">Sales floor · IST</div>
      </nav>
      <div class="main">
        <div class="topbar">
          <h1 id="page-title"></h1>
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

  wireBell();
  startAlerts();
  refreshShift();
}

async function refreshShift() {
  const el = document.getElementById('shift-widget');
  if (!el) return;
  try {
    const [profile, att] = await Promise.all([get('/me'), get('/me/attendance?days=1')]);
    const today = Array.isArray(att) ? att[0] : null;
    const mins = today?.currently_logged_in || today ? today?.logged_minutes ?? 0 : 0;
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

async function route() {
  if (!me) return;
  let outlet = document.getElementById('outlet');
  if (!outlet) return;

  // Fresh outlet per navigation: views attach listeners to it, and reusing
  // the node would stack a new handler on every visit.
  const fresh = outlet.cloneNode(false);
  outlet.replaceWith(fresh);
  outlet = fresh;

  const parts = (location.hash || '#/').slice(2).split('/');
  const name = parts[0] || (DEFAULT_ROUTE[me.role] ?? '#/attendance').slice(2);
  const view = VIEWS[name];

  document.querySelectorAll('.sidebar a.nav').forEach((a) => {
    a.classList.toggle('active', a.dataset.nav === `#/${name}`);
  });
  document.getElementById('page-title').textContent = TITLES[name] ?? '5 Circles CRM';

  if (!view) {
    location.hash = DEFAULT_ROUTE[me.role] ?? '#/attendance';
    return;
  }

  outlet.innerHTML = '<div class="spin"></div>';
  try {
    await view.render(outlet, me, parts.slice(1));
  } catch (err) {
    outlet.innerHTML = '';
    outlet.appendChild(h(`<div class="panel"><h2>Could not load this page</h2><p class="hint">${esc(err.message)}</p></div>`));
  }
  refreshShift();
}

window.addEventListener('hashchange', route);
window.addEventListener('crm:unauthorized', showLogin);

boot();
