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
