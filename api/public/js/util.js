/** Small shared helpers. Every interpolation of server data goes through esc(). */

export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);

export function h(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

const dtFmt = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
});
const dFmt = new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric' });

export const fmtDT = (ts) => (ts ? dtFmt.format(new Date(ts)) : '—');
export const fmtDate = (ts) => (ts ? dFmt.format(new Date(ts)) : '—');

/** Today's date in IST as YYYY-MM-DD, for date inputs and filters. */
export const istToday = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());

export function agoLabel(ts) {
  if (!ts) return '—';
  const m = Math.round((Date.now() - new Date(ts).getTime()) / 60000);
  if (m < 1) return 'now';
  if (m < 60) return `${m}m ago`;
  if (m < 60 * 24) return `${Math.floor(m / 60)}h ago`;
  return `${Math.floor(m / (60 * 24))}d ago`;
}

export function toast(msg, kind = 'ok') {
  const el = h(`<div class="toast ${kind === 'err' ? 'err' : ''}"></div>`);
  el.textContent = msg;
  document.getElementById('toasts').appendChild(el);
  setTimeout(() => el.remove(), 4200);
}

/** Modal helper: returns { el, close }. Save wiring is the caller's job. */
export function openModal(title, bodyEl, footerEl) {
  const root = document.getElementById('modal-root');
  const overlay = h(`
    <div class="overlay">
      <div class="modal" role="dialog" aria-modal="true">
        <header><h3></h3><button class="x" aria-label="Close">✕</button></header>
        <div class="body"></div>
        <footer></footer>
      </div>
    </div>`);
  overlay.querySelector('h3').textContent = title;
  overlay.querySelector('.body').appendChild(bodyEl);
  if (footerEl) overlay.querySelector('footer').appendChild(footerEl);
  else overlay.querySelector('footer').remove();

  const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  overlay.querySelector('.x').addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', onKey);
  root.appendChild(overlay);
  return { el: overlay, close };
}

export const spinner = () => h('<div class="spin" role="status" aria-label="Loading"></div>');

/* ---- the five stages and five outcomes, named once ---------------------- */

export const STAGE_LABEL = {
  new: 'New',
  calling: 'Calling',
  qualified: 'Qualified',
  converted: 'Converted',
  not_qualified: 'Not qualified',
};

export const OUTCOME_LABEL = {
  qualified: 'Qualified — interested',
  call_back: 'Call back later',
  not_answered: 'Not answered',
  switched_off: 'Switched off',
  not_qualified: 'Not qualified — don’t call',
};

const STAGE_BADGE = {
  new: 'b-info',
  calling: 'b-info',
  qualified: 'b-warn',
  converted: 'b-ok',
  not_qualified: 'b-mute',
};

export const stageBadge = (stage) =>
  `<span class="badge ${STAGE_BADGE[stage] ?? 'b-mute'}">${esc(STAGE_LABEL[stage] ?? stage ?? '—')}</span>`;

/** The latest response, the way the floor reads it: "Not answered ×3". */
export function outcomeLabel(lead) {
  if (!lead.last_outcome) return '';
  const base = OUTCOME_LABEL[lead.last_outcome] ?? lead.last_outcome;
  if (['not_answered', 'switched_off'].includes(lead.last_outcome) && Number(lead.na_streak) > 1) {
    return `${base} ×${lead.na_streak}`;
  }
  return base;
}

/** datetime-local input value -> ISO string (browser local tz = floor IST). */
export const localToIso = (value) => new Date(value).toISOString();

/** Default follow-up suggestion: tomorrow 11:00 local, as datetime-local value. */
export function tomorrowAt(hour = 11) {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(hour, 0, 0, 0);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * A person as initials on a colour that stays stable for that name, so a
 * person looks the same on every list.
 */
const AVATAR_HUES = [14, 42, 96, 152, 200, 232, 268, 310, 338];

export function avatarHtml(name, size = 28) {
  const s = Number(size) || 28;
  const clean = String(name ?? '').trim();
  if (!clean) return '';
  const initials = clean
    .split(/\s+/).slice(0, 2).map((w) => w[0] ?? '').join('').toUpperCase() || '?';
  let hash = 0;
  for (const ch of clean) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  const hue = AVATAR_HUES[hash % AVATAR_HUES.length];
  return `<span class="avatar avatar-fallback" aria-hidden="true"
    style="width:${s}px;height:${s}px;font-size:${Math.round(s * 0.4)}px;
           background:hsl(${hue} 55% 88%);color:hsl(${hue} 55% 28%)">${esc(initials)}</span>`;
}

/**
 * Point every brand image at the real artwork, falling back to the bundled SVG.
 */
export function wireLogoFallback(root = document) {
  root.querySelectorAll('img[data-logo]').forEach((img) => {
    img.addEventListener('error', function once() {
      img.removeEventListener('error', once);
      img.src = 'brand/logo.svg';
    });
    img.src = 'brand/logo.png';
  });
}
