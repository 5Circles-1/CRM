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

const inr0 = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });
export const fmtINR = (v) => (v === null || v === undefined || v === '' ? '—' : inr0.format(Number(v)));

const dtFmt = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
});
const dFmt = new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric' });

export const fmtDT = (ts) => (ts ? dtFmt.format(new Date(ts)) : '—');
export const fmtDate = (ts) => (ts ? dFmt.format(new Date(ts)) : '—');

export function minsLabel(mins) {
  const m = Math.max(0, Math.round(Number(mins) || 0));
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

export function agoLabel(mins) {
  const m = Math.round(Number(mins) || 0);
  if (m < 60) return `${m}m`;
  if (m < 60 * 24) return `${Math.floor(m / 60)}h ${m % 60}m`;
  return `${Math.floor(m / (60 * 24))}d ${Math.floor((m % (60 * 24)) / 60)}h`;
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

const STATUS_BADGE = {
  new: 'b-info', working: 'b-info', callback: 'b-info', qualified: 'b-warn',
  negotiation: 'b-warn', won: 'b-ok', lost: 'b-mute', invalid: 'b-mute',
  nurture: 'b-mute', handed_off: 'b-ok',
  due: 'b-info', part_paid: 'b-warn', overdue: 'b-bad', paid: 'b-ok', written_off: 'b-mute',
  pending: 'b-info', completed: 'b-ok', missed: 'b-bad', cancelled: 'b-mute',
};
export const badge = (status) =>
  `<span class="badge ${STATUS_BADGE[status] ?? 'b-mute'}">${esc(String(status ?? '—').replace(/_/g, ' '))}</span>`;

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
 * Talk time as MM:SS, which is how anyone on a phone thinks about it.
 *
 * Raw seconds forced the floor to do arithmetic to answer "was that a long
 * call?" - 187 seconds means nothing at a glance, 3:07 means something.
 * Hours only appear when there are some, so the common case stays short.
 */
export function fmtTalk(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  const mm = Math.floor(s / 60);
  const ss = String(s % 60).padStart(2, '0');
  if (mm < 60) return `${mm}:${ss}`;
  return `${Math.floor(mm / 60)}:${String(mm % 60).padStart(2, '0')}:${ss}`;
}

/**
 * Read a duration a person typed. Accepts "3:07", "3.5" and "187".
 *
 * A field labelled MM:SS that only accepts seconds is a trap, and one that
 * silently reads "3:07" as 3 is worse - it would log a three-second call and
 * quietly destroy the connect rate it feeds.
 */
export function parseTalk(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return 0;
  if (raw.includes(':')) {
    const parts = raw.split(':').map((p) => Number(p.trim()));
    if (parts.some((n) => !Number.isFinite(n) || n < 0)) return null;
    return parts.length === 3
      ? parts[0] * 3600 + parts[1] * 60 + parts[2]
      : parts[0] * 60 + parts[1];
  }
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
}

/**
 * A person as a face: their uploaded icon, or initials on a colour that stays
 * stable for that name. Every board and table uses this one helper, so a
 * person looks the same everywhere.
 */
const AVATAR_HUES = [14, 42, 96, 152, 200, 232, 268, 310, 338];

export function avatarHtml(name, url, size = 32) {
  const s = Number(size) || 32;
  if (url) {
    return `<img class="avatar" src="${esc(url)}" alt="" width="${s}" height="${s}"
      style="width:${s}px;height:${s}px">`;
  }
  const clean = String(name ?? '').trim();
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
 * Party poppers for the leaderboard winner. A short confetti burst on a
 * throwaway full-screen canvas - no library, no leftover DOM. Respects a
 * reduced-motion preference, because a celebration should never be a headache.
 */
export function confettiBurst() {
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
  const canvas = document.createElement('canvas');
  canvas.style.cssText =
    'position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:9999';
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  document.body.appendChild(canvas);
  const ctx = canvas.getContext('2d');
  const colours = ['#eb6834', '#2a78d6', '#1baf7a', '#eda100', '#e87ba4', '#7c4dff'];
  const N = 140;
  // Poppers fly in from the two top corners, as if launched over the board.
  const bits = Array.from({ length: N }, (_, i) => {
    const left = i < N / 2;
    return {
      x: left ? 40 : canvas.width - 40,
      y: 60,
      vx: (left ? 1 : -1) * (3 + Math.random() * 5),
      vy: -(4 + Math.random() * 6),
      g: 0.15 + Math.random() * 0.1,
      size: 5 + Math.random() * 6,
      rot: Math.random() * Math.PI,
      vr: (Math.random() - 0.5) * 0.3,
      colour: colours[i % colours.length],
    };
  });
  const start = performance.now();
  const DURATION = 2600;
  const tick = (now) => {
    const t = now - start;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const b of bits) {
      b.vy += b.g; b.x += b.vx; b.y += b.vy; b.rot += b.vr;
      ctx.save();
      ctx.translate(b.x, b.y);
      ctx.rotate(b.rot);
      ctx.globalAlpha = Math.max(0, 1 - t / DURATION);
      ctx.fillStyle = b.colour;
      ctx.fillRect(-b.size / 2, -b.size / 2, b.size, b.size * 0.6);
      ctx.restore();
    }
    if (t < DURATION) requestAnimationFrame(tick);
    else canvas.remove();
  };
  requestAnimationFrame(tick);
}

/**
 * Point every brand image at the real artwork, falling back to the bundled SVG.
 *
 * Done here rather than with an inline onerror attribute: inline handlers are
 * the first thing a Content-Security-Policy blocks, and the failure would be
 * an invisible broken image rather than an error anyone notices.
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
