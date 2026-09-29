import { get, post } from './api.js';
import { addLeadModal } from './addlead.js';
import { esc, fmtDT, h, toast } from './util.js';

/**
 * "You answered a call from a new number - log it" (0078).
 *
 * Tata Tele reports every call on the office line, so the CRM knows about an
 * inbound call from a number no lead has - but the client exists nowhere
 * else until somebody types them in, and that used to depend on memory.
 * This puts each such call in front of the person who answered it, with the
 * number already filled in, until they log the lead or say it was not a
 * client. Returns null when there is nothing to log, so a screen can place
 * it without an empty box.
 */
export async function inboundToLogBanner(me, onChange) {
  const data = await get('/me/inbound-to-log').catch(() => ({ calls: [] }));
  const calls = data.calls ?? [];
  if (calls.length === 0) return null;

  const talk = (s) => {
    const n = Number(s) || 0;
    return n >= 60 ? `${Math.floor(n / 60)}m ${String(n % 60).padStart(2, '0')}s` : `${n}s`;
  };
  const el = h(`
    <div class="banner warn" data-testid="inbound-to-log">
      <b>📞 You answered ${calls.length === 1 ? 'a call' : `${calls.length} calls`} on the office line from
        ${calls.length === 1 ? 'a number' : 'numbers'} not in the CRM yet.</b>
      Log each one so the client is not lost — the number is filled in for you.
      ${calls.map((c) => `
        <div class="row wrap" style="gap:8px;margin-top:6px;align-items:center" data-call="${esc(c.device_log_id)}">
          <span class="mono">${esc(c.phone)}</span>
          <span class="hint">${esc(fmtDT(c.started_at))} · talked ${esc(talk(c.duration_seconds))}</span>
          <button class="btn small primary" data-log="${esc(c.device_log_id)}" data-testid="inbound-to-log-log">
            📞 Log inbound call</button>
          <button class="btn small" data-dismiss="${esc(c.device_log_id)}" data-testid="inbound-to-log-dismiss"
            title="A supplier, a wrong number - no lead needed">Not a client</button>
        </div>`).join('')}
    </div>`);

  el.addEventListener('click', async (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    const call = calls.find((c) => c.device_log_id === (btn.dataset.log ?? btn.dataset.dismiss));
    if (!call) return;
    if (btn.dataset.log) {
      addLeadModal(me, (lead) => onChange?.(lead), 'inbound', { phone: call.phone });
      return;
    }
    btn.disabled = true;
    try {
      await post(`/me/inbound-to-log/${call.device_log_id}/dismiss`, {});
      toast('Marked as not a client.');
      onChange?.(null);
    } catch (err) {
      btn.disabled = false;
      toast(err.message, 'err');
    }
  });
  return el;
}
