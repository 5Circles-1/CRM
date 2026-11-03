import { get, post } from './api.js';
import { esc, h, openModal, toast, wireLogoFallback } from './util.js';
import { renderLogin } from './views/login.js';
import * as dash from './views/dash.js';
import * as leads from './views/leads.js';
import * as lead from './views/lead.js';
import * as reminders from './views/reminders.js';
import * as admin from './views/admin.js';

/**
 * Four screens. The whole product fits in the left-hand column:
 *
 *   Dashboard - what happened and what needs attention
 *   Leads     - the spreadsheet: every lead, filter and work it
 *   Reminders - what is due now / today / next, per person
 *   Admin     - accounts, sources, import (admins only)
 *
 * The only thing that ever pops up is a reminder whose time has come - once,
 * with one soft chime - and the same reminder then sits in the Reminders tab
 * until the call is logged. Nothing else interrupts anyone.
 */

const NAV = [
  { hash: '#/dash', label: 'Dashboard', roles: ['admin', 'caller', 'followup'] },
  { hash: '#/leads', label: 'Leads', roles: ['admin', 'caller', 'followup'] },
  { hash: '#/reminders', label: 'Reminders', roles: ['admin', 'caller', 'followup'], badge: true },
  { hash: '#/admin', label: 'Admin', roles: ['admin'] },
];

const DEFAULT_ROUTE = { admin: '#/dash', caller: '#/leads', followup: '#/leads' };

const VIEWS = { dash, leads, lead, reminders, admin };

const TITLES = {
  dash: 'Dashboard',
  leads: 'Leads',
  reminders: 'Reminders',
  admin: 'Admin',
  lead: 'Lead',
};

let me = null;
let showingLogin = false;

/** Idempotent: a burst of 401s renders login once. */
function showLogin() {
  if (showingLogin) return;
  showingLogin = true;
  stopReminderWatch();
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
    location.hash = DEFAULT_ROUTE[me.role] ?? '#/leads';
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
        ${items
          .map(
            (n) => `<a class="nav" data-nav="${n.hash}" href="${n.hash}">${esc(n.label)}${
              n.badge ? ' <span class="nav-badge" id="reminder-badge" hidden></span>' : ''
            }</a>`,
          )
          .join('')}
        <div class="foot">Pan-India · IST</div>
      </nav>
      <div class="main">
        <div class="topbar">
          <h1 id="page-title"></h1>
          <div class="userchip"><b>${esc(me.full_name)}</b>${esc(roleLabel(me.role))}</div>
          <button class="btn small" id="theme-btn" title="Light or dark">◐</button>
          <button class="btn small" id="pwd-btn" title="Change my password">Password</button>
          <button class="btn small" id="logout-btn">Log out</button>
        </div>
        <div class="content" id="outlet"></div>
      </div>
    </div>`));

  // Two token-driven themes; default follows the operating system.
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
    route(); // charts read their colours at draw time
  });

  document.getElementById('pwd-btn').addEventListener('click', () => changeMyPassword());
  document.getElementById('logout-btn').addEventListener('click', async () => {
    await post('/auth/logout').catch(() => {});
    stopReminderWatch();
    me = null;
    location.hash = '';
    boot();
  });

  wireLogoFallback(app);
  startReminderWatch();
}

export function roleLabel(role) {
  return { admin: 'Admin', caller: 'Caller', followup: 'Follow-up' }[role] ?? role;
}

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

/* ---- the one popup: a reminder whose time has come -------------------- */

let reminderTimer = null;

/**
 * Every minute: anything of mine now due pops ONCE (tracked per lead per due
 * time, in this browser), with one soft chime. The badge on the Reminders nav
 * item keeps the count visible after the popup is gone. Doing the work -
 * logging the call - is what clears both.
 */
async function checkReminders() {
  if (!me) return;
  let due = [];
  try {
    ({ due } = await get('/reminders/due'));
  } catch {
    return; // a failed poll is never worth an error popup
  }

  const badge = document.getElementById('reminder-badge');
  if (badge) {
    badge.hidden = due.length === 0;
    badge.textContent = String(due.length);
  }

  let chimed = false;
  for (const r of due) {
    const key = `crm-popped-${r.id}-${r.next_follow_up_at}`;
    if (localStorage.getItem(key)) continue;
    localStorage.setItem(key, '1');
    if (!chimed) { chime(); chimed = true; }
    const note = r.follow_up_note ? ` — ${r.follow_up_note}` : '';
    const el = h(`
      <div class="toast reminder-toast" role="alert">
        <b>⏰ ${esc(r.full_name ?? r.phone_e164)}</b>
        <span>${esc(note)}</span>
        <a href="#/lead/${r.id}">Open lead</a>
      </div>`);
    document.getElementById('toasts').appendChild(el);
    el.querySelector('a').addEventListener('click', () => el.remove());
    setTimeout(() => el.remove(), 30_000);
  }
}

function startReminderWatch() {
  stopReminderWatch();
  checkReminders();
  reminderTimer = setInterval(checkReminders, 60_000);
}

function stopReminderWatch() {
  if (reminderTimer) clearInterval(reminderTimer);
  reminderTimer = null;
}

/** One quiet two-tone chime. Never repeats for the same reminder. */
function chime() {
  try {
    const ctx = new AudioContext();
    const play = (freq, at, dur) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = freq;
      osc.type = 'sine';
      gain.gain.setValueAtTime(0.0001, ctx.currentTime + at);
      gain.gain.exponentialRampToValueAtTime(0.08, ctx.currentTime + at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + at + dur);
      osc.connect(gain).connect(ctx.destination);
      osc.start(ctx.currentTime + at);
      osc.stop(ctx.currentTime + at + dur + 0.05);
    };
    play(880, 0, 0.35);
    play(1174.66, 0.18, 0.4);
    setTimeout(() => ctx.close(), 1500);
  } catch {
    /* no audio permission: the toast still shows */
  }
}

/* ---- routing ----------------------------------------------------------- */

async function route() {
  if (!me) return;
  const outlet = document.getElementById('outlet');
  if (!outlet) return;

  const parts = (location.hash || '#/').slice(2).split('?')[0].split('/');
  const name = parts[0] || (DEFAULT_ROUTE[me.role] ?? '#/leads').slice(2);
  const view = VIEWS[name];

  document.querySelectorAll('.sidebar a.nav').forEach((a) => {
    a.classList.toggle('active', a.dataset.nav === `#/${name}` || (name === 'lead' && a.dataset.nav === '#/leads'));
  });
  document.getElementById('page-title').textContent = TITLES[name] ?? '5 Circles CRM';

  if (!view) {
    location.hash = DEFAULT_ROUTE[me.role] ?? '#/leads';
    return;
  }

  // Fresh outlet per render: views attach listeners to it, and reusing the
  // node would stack a new handler on every visit.
  const fresh = outlet.cloneNode(false);
  outlet.replaceWith(fresh);
  fresh.innerHTML = '<div class="spin"></div>';
  try {
    await view.render(fresh, me, parts.slice(1));
  } catch (err) {
    fresh.innerHTML = '';
    fresh.appendChild(h(`<div class="panel"><h2>Could not load this page</h2><p class="hint">${esc(err.message)}</p></div>`));
  }
}

window.addEventListener('hashchange', () => route());
window.addEventListener('crm:unauthorized', showLogin);

boot();
