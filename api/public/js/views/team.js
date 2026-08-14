import { get, post } from '../api.js';
import { avatarHtml, esc, fmtDT, h, toast } from '../util.js';

/**
 * The Team page: the admin's megaphone and everyone's notifications, in one
 * place inside the CRM so the floor never needs a side WhatsApp group.
 *
 * Left: the message feed (admin/ops can post to a team or the whole floor).
 * Right: this person's notifications - cross-team arrivals and the like.
 */
export async function render(outlet, me) {
  const canPost = true;  // everyone may reply; RLS scopes them to their team or the floor
  // Only managers may aim a message at a specific team, so only they get the
  // team list - asking as anyone else was a guaranteed 403 in the console.
  const canTarget = me.role === 'admin' || me.role === 'ops';

  const draw = async () => {
    const [messages, teams, notifs] = await Promise.all([
      get('/messages').catch(() => []),
      canTarget ? get('/admin/teams').catch(() => []) : Promise.resolve([]),
      get('/me/notifications').catch(() => ({ notifications: [], unread: 0 })),
    ]);
    outlet.innerHTML = '';

    const grid = h('<div class="chart-grid"></div>');

    // --- messages ---
    const feed = h(`
      <div class="panel">
        <h2 class="mt0">Team messages <small>from your admin</small></h2>
        ${canPost ? `
          <div class="compose">
            <textarea id="msg-body" rows="2" placeholder="Message the floor…"
              style="width:100%;border:1px solid var(--line);border-radius:8px;padding:9px"></textarea>
            <div class="row" style="margin-top:8px">
              <select id="msg-team" style="border:1px solid var(--line);border-radius:8px;padding:8px">
                <option value="">Whole floor</option>
                ${teams.map((t) => `<option value="${esc(t.id)}">${esc(t.name)} only</option>`).join('')}
              </select>
              <label class="row" style="gap:6px"><input type="checkbox" id="msg-pin" style="width:auto"> Pin</label>
              <button class="btn primary" id="msg-send" style="margin-left:auto">Send</button>
            </div>
          </div>` : ''}
        <div id="msg-list" style="margin-top:12px"></div>
      </div>`);
    const list = feed.querySelector('#msg-list');
    if (messages.length === 0) {
      list.appendChild(h('<div class="empty">No messages yet.</div>'));
    } else {
      for (const m of messages) {
        list.appendChild(h(`
          <div class="msg ${m.pinned ? 'pinned' : ''}">
            <div class="msg-head">
              ${avatarHtml(m.author_name ?? 'Admin', m.author_avatar, 22)}
              <b>${esc(m.author_name ?? 'Admin')}</b>
              <span class="hint">${m.team_name ? esc(m.team_name) : 'whole floor'} · ${esc(fmtDT(m.created_at))}</span>
              ${m.pinned ? '<span class="badge b-info" style="margin-left:auto">pinned</span>' : ''}
            </div>
            <div class="msg-body">${esc(m.body)}</div>
          </div>`));
      }
    }
    grid.appendChild(feed);

    // --- notifications ---
    const nbox = h(`
      <div class="panel">
        <div class="row spread">
          <h2 class="mt0">Your notifications ${notifs.unread ? `<small>${notifs.unread} unread</small>` : ''}</h2>
          ${notifs.unread ? '<button class="btn small" id="notif-read">Mark all read</button>' : ''}
        </div>
        <div id="notif-list"></div>
      </div>`);
    const nlist = nbox.querySelector('#notif-list');
    if (!notifs.notifications || notifs.notifications.length === 0) {
      nlist.appendChild(h('<div class="empty">Nothing new. You are all caught up.</div>'));
    } else {
      for (const n of notifs.notifications) {
        const row = h(`
          <div class="notif ${n.read_at ? '' : 'unread'}">
            <div><b>${esc(n.title)}</b> <span class="hint">${esc(fmtDT(n.created_at))}</span></div>
            ${n.body ? `<div class="hint">${esc(n.body)}</div>` : ''}
            ${n.lead_id ? `<a href="#/lead/${esc(n.lead_id)}">open the lead →</a>` : ''}
          </div>`);
        nlist.appendChild(row);
      }
    }
    grid.appendChild(nbox);
    outlet.appendChild(grid);

    feed.querySelector('#msg-send')?.addEventListener('click', async () => {
      const body = feed.querySelector('#msg-body').value.trim();
      if (!body) { toast('Type a message first.', 'err'); return; }
      try {
        await post('/messages', {
          body,
          teamId: feed.querySelector('#msg-team').value || null,
          pinned: feed.querySelector('#msg-pin').checked,
        });
        toast('Message sent to the floor.');
        draw();
      } catch (err) {
        toast(err.message, 'err');
      }
    });

    nbox.querySelector('#notif-read')?.addEventListener('click', async () => {
      try {
        await post('/me/notifications/read', {});
        draw();
      } catch (err) {
        toast(err.message, 'err');
      }
    });
  };

  await draw();
}
