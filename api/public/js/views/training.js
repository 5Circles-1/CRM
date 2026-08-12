import { get, post } from '../api.js';
import { esc, fmtDate, h, toast } from '../util.js';
import { outline, renderMarkdown } from '../markdown.js';

/**
 * The Training academy: every rule and every screen, in the CRM rather than in
 * a PDF nobody opens.
 *
 * Content comes from the server with the live configuration already
 * substituted in, so the page cannot quote a stale SLA. Acknowledgements are
 * signed against the exact version of the words read — edit a module and
 * everyone is asked to read it again.
 */

const ROLE_LABEL = {
  all: 'Everyone', caller: 'Callers', counsellor: 'Counsellors',
  mentor: 'Mentors', admin: 'Admins',
};

export async function render(outlet, me) {
  let pane = 'modules';
  let openSlug = null;

  const draw = async () => {
    outlet.innerHTML = '<div class="spin"></div>';
    const data = await get('/training');
    outlet.innerHTML = '';

    // One root element: h() returns firstElementChild, so a two-root template
    // would silently drop the second half.
    outlet.appendChild(h(`
      <div>
      <div class="panel" style="margin-bottom:16px">
        <div class="row spread wrap">
          <div>
            <h2 class="mt0">Training <small>${data.modules.length} modules</small></h2>
            <div class="hint">Everything the CRM does, and every rule it enforces.
              Your track is highlighted; you can read all of them.</div>
          </div>
          <div class="row" style="gap:8px">
            <div class="chips" style="margin:0">
              <button class="chip ${pane === 'modules' ? 'on' : ''}" data-pane="modules">Modules</button>
              <button class="chip ${pane === 'glossary' ? 'on' : ''}" data-pane="glossary">Glossary</button>
              ${['admin', 'ops', 'counsellor'].includes(me.role)
                ? `<button class="chip ${pane === 'compliance' ? 'on' : ''}" data-pane="compliance">Who has read what</button>` : ''}
            </div>
            <button class="btn small" id="start-tour">Replay tour</button>
          </div>
        </div>
        ${data.outstanding > 0 ? `
          <div class="banner warn" style="margin-top:10px">
            <b>${data.outstanding}</b> module${data.outstanding === 1 ? '' : 's'} on your track
            ${data.outstanding === 1 ? 'is' : 'are'} unread or changed since you read
            ${data.outstanding === 1 ? 'it' : 'them'}. Please read and acknowledge.
          </div>` : `
          <div class="banner ok" style="margin-top:10px">
            Your track is complete and up to date.
          </div>`}
        <input id="tsearch" placeholder="Search every module — try “callback”, “freeze”, “restricted”…"
               style="width:100%;margin-top:12px;padding:10px 12px;border:1px solid var(--line);border-radius:8px">
        <div id="tsearch-out"></div>
      </div>
      <div id="tpane"></div>
      </div>`));

    const paneEl = outlet.querySelector('#tpane');
    if (pane === 'modules') drawModules(paneEl, data, me, draw);
    else if (pane === 'glossary') await drawGlossary(paneEl);
    else await drawCompliance(paneEl);

    outlet.querySelectorAll('[data-pane]').forEach((b) =>
      b.addEventListener('click', () => { pane = b.dataset.pane; openSlug = null; draw(); }));
    outlet.querySelector('#start-tour').addEventListener('click', () => startTour(me));

    const search = outlet.querySelector('#tsearch');
    let timer = null;
    search.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        const term = search.value.trim();
        const box = outlet.querySelector('#tsearch-out');
        if (term.length < 2) { box.innerHTML = ''; return; }
        const { results } = await get(`/training/search?q=${encodeURIComponent(term)}`);
        box.innerHTML = results.length === 0
          ? '<div class="hint" style="margin-top:10px">Nothing matches that.</div>'
          : `<div style="margin-top:10px">${results.map((r) => `
              <div style="padding:8px 0;border-bottom:1px solid var(--line)">
                <a href="#" data-open="${esc(r.slug)}"><b>${esc(r.title)}</b></a>
                ${r.hits.map((hit) => `<div class="hint">${esc(hit)}</div>`).join('')}
              </div>`).join('')}</div>`;
        box.querySelectorAll('[data-open]').forEach((a) =>
          a.addEventListener('click', (e) => {
            e.preventDefault();
            openModule(a.dataset.open, me, draw);
          }));
      }, 200);
    });

    if (openSlug) {
      const slug = openSlug;
      openSlug = null;
      await openModule(slug, me, draw);
    }
  };

  // A deep link like #/training/the-rulebook opens that module directly.
  const deep = location.hash.split('/')[2];
  if (deep) openSlug = deep;

  await draw();
}

function drawModules(host, data, me, redraw) {
  const mine = data.modules.filter((m) => m.isMyTrack);
  const others = data.modules.filter((m) => !m.isMyTrack);

  const card = (m) => `
    <div class="panel tmod" data-slug="${esc(m.slug)}" style="cursor:pointer">
      <div class="row spread">
        <div>
          <b>${m.order}. ${esc(m.title)}</b>
          <span class="badge ${m.audience === 'all' ? 'b-info' : ''}">${esc(ROLE_LABEL[m.audience] ?? m.audience)}</span>
          ${m.ackedAt && !m.stale ? '<span class="badge b-ok">read</span>' : ''}
          ${m.stale ? '<span class="badge b-warn">changed — read again</span>' : ''}
          ${!m.ackedAt ? '<span class="badge b-bad">not read</span>' : ''}
        </div>
        <div class="hint">${m.quizLength} question${m.quizLength === 1 ? '' : 's'}
          ${m.ackedAt ? `· read ${esc(fmtDate(m.ackedAt))}` : ''}</div>
      </div>
      <div class="hint" style="margin-top:4px">${esc(m.summary)}</div>
    </div>`;

  host.innerHTML = `
    <h3 class="section-h">Your track — ${esc(ROLE_LABEL[me.role] ?? me.role)}</h3>
    <div class="tlist">${mine.map(card).join('')}</div>
    ${others.length ? `
      <h3 class="section-h" style="margin-top:18px">Other roles — read any time</h3>
      <div class="tlist">${others.map(card).join('')}</div>` : ''}`;

  host.querySelectorAll('.tmod').forEach((el) =>
    el.addEventListener('click', () => openModule(el.dataset.slug, me, redraw)));
}

/** The module reader: contents, body, quiz, acknowledgement. */
async function openModule(slug, me, onAck) {
  const outletEl = document.getElementById('outlet');
  outletEl.innerHTML = '<div class="spin"></div>';
  let m;
  try { m = await get(`/training/${slug}`); } catch (err) { toast(err.message, 'err'); return; }

  const toc = outline(m.body);
  const answers = new Array(m.quiz.length).fill(null);

  outletEl.innerHTML = '';
  outletEl.appendChild(h(`
    <div>
      <div class="row spread wrap" style="margin-bottom:10px">
        <button class="btn small" id="t-back">← All modules</button>
        <div class="hint">
          ${m.ackedAt && !m.stale ? `You read this on ${esc(fmtDate(m.ackedAt))}.`
            : m.stale ? 'This module changed since you read it.' : 'You have not read this yet.'}
        </div>
      </div>
      <div class="grid" style="grid-template-columns: 1fr 240px; gap:16px; align-items:start">
        <div class="panel">
          <h2 class="mt0">${esc(m.title)}</h2>
          <div class="hint" style="margin-bottom:12px">${esc(m.summary)}</div>
          <div class="md">${renderMarkdown(m.body)}</div>

          ${m.quiz.length ? `
          <div id="quiz" style="border-top:1px solid var(--line);margin-top:18px;padding-top:14px">
            <h3 class="mt0">Quick check <small>${m.quiz.length} questions — not a test, just a check</small></h3>
            ${m.quiz.map((qq, qi) => `
              <div class="qq" data-q="${qi}" style="margin-bottom:14px">
                <div style="font-weight:600;margin-bottom:6px">${qi + 1}. ${esc(qq.q)}</div>
                <div class="chips" style="margin:0">
                  ${qq.options.map((o, oi) =>
                    `<button class="chip" data-q="${qi}" data-o="${oi}">${esc(o)}</button>`).join('')}
                </div>
                <div class="hint qwhy" style="margin-top:5px"></div>
              </div>`).join('')}
          </div>` : ''}

          <div style="border-top:1px solid var(--line);margin-top:16px;padding-top:14px">
            <label class="ck" style="display:flex;gap:8px;align-items:flex-start">
              <input type="checkbox" id="t-understood">
              <span>I have read and understood this module. I know these rules apply to my work.</span>
            </label>
            <button class="btn primary" id="t-ack" disabled style="margin-top:10px">
              ${m.ackedAt && !m.stale ? 'Acknowledge again' : 'Acknowledge'}
            </button>
          </div>
        </div>

        <div class="panel" style="position:sticky;top:12px">
          <div class="hint" style="text-transform:uppercase;letter-spacing:.06em;font-size:10.5px;font-weight:700">
            On this page</div>
          <div style="margin-top:6px">
            ${toc.map((t) => `<div style="padding:3px 0;padding-left:${(t.depth - 2) * 12}px">
              <a href="#" data-goto="${esc(t.id)}" class="hint">${esc(t.text)}</a></div>`).join('')}
          </div>
        </div>
      </div>
    </div>`));

  outletEl.querySelector('#t-back').addEventListener('click', () => {
    location.hash = '#/training';
    onAck();
  });

  outletEl.querySelectorAll('[data-goto]').forEach((a) =>
    a.addEventListener('click', (e) => {
      e.preventDefault();
      document.getElementById(a.dataset.goto)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }));

  outletEl.querySelectorAll('#quiz .chip').forEach((chip) =>
    chip.addEventListener('click', () => {
      const qi = Number(chip.dataset.q);
      const oi = Number(chip.dataset.o);
      answers[qi] = oi;
      const row = outletEl.querySelector(`.qq[data-q="${qi}"]`);
      const correct = oi === m.quiz[qi].answer;
      row.querySelectorAll('.chip').forEach((c) => {
        c.classList.remove('on', 'wrong');
        if (Number(c.dataset.o) === oi) c.classList.add(correct ? 'on' : 'wrong');
      });
      row.querySelector('.qwhy').textContent = correct
        ? `Correct. ${m.quiz[qi].why ?? ''}`
        : `Not quite — ${m.quiz[qi].why ?? 'read the section above again.'}`;
    }));

  const box = outletEl.querySelector('#t-understood');
  const btn = outletEl.querySelector('#t-ack');
  box.addEventListener('change', () => { btn.disabled = !box.checked; });

  btn.addEventListener('click', async () => {
    const answered = answers.filter((a) => a !== null).length;
    const right = answers.filter((a, i) => a === m.quiz[i]?.answer).length;
    const score = m.quiz.length && answered
      ? Math.round((right / m.quiz.length) * 100)
      : undefined;
    try {
      await post(`/training/${m.slug}/ack`, score === undefined ? {} : { quizScore: score });
      toast('Acknowledged — thank you.');
      location.hash = '#/training';
      onAck();
    } catch (err) { toast(err.message, 'err'); }
  });
}

async function drawGlossary(host) {
  const { entries } = await get('/training/registry');
  const areas = [...new Set(entries.map((e) => e.area))];
  host.innerHTML = `
    <div class="panel">
      <h3 class="mt0">Glossary <small>every tab, button, filter and badge — ${entries.length} entries</small></h3>
      <div class="hint" style="margin-bottom:10px">
        This is the same text the app shows in its tooltips, so the manual and
        the screen can never disagree.
      </div>
      <input id="gsearch" placeholder="Filter…" style="width:100%;padding:9px 11px;
             border:1px solid var(--line);border-radius:8px;margin-bottom:12px">
      ${areas.map((area) => `
        <div class="garea" data-area="${esc(area)}">
          <h4 class="section-h">${esc(area)}</h4>
          <div style="overflow-x:auto"><table class="table"><thead><tr>
            <th style="width:180px">Name</th><th>What it does</th><th>When to use it</th>
          </tr></thead><tbody>
          ${entries.filter((e) => e.area === area).map((e) => `
            <tr class="gitem" data-t="${esc((e.label + ' ' + e.does + ' ' + e.when).toLowerCase())}">
              <td><b>${esc(e.label)}</b></td>
              <td>${esc(e.does)}</td>
              <td class="hint">${esc(e.when)}</td>
            </tr>`).join('')}
          </tbody></table></div>
        </div>`).join('')}
    </div>`;

  const gs = host.querySelector('#gsearch');
  gs.addEventListener('input', () => {
    const term = gs.value.trim().toLowerCase();
    host.querySelectorAll('.gitem').forEach((tr) => {
      tr.style.display = !term || tr.dataset.t.includes(term) ? '' : 'none';
    });
    host.querySelectorAll('.garea').forEach((sec) => {
      const any = [...sec.querySelectorAll('.gitem')].some((tr) => tr.style.display !== 'none');
      sec.style.display = any ? '' : 'none';
    });
  });
}

async function drawCompliance(host) {
  const { modules, people } = await get('/training/compliance');
  host.innerHTML = `
    <div class="panel">
      <h3 class="mt0">Who has read what <small>${people.length} people</small></h3>
      <div class="hint" style="margin-bottom:10px">
        A module counts as done only against its current wording. Edit a module
        and everyone is asked to read it again — the tick goes amber, not away.
      </div>
      <div style="overflow-x:auto"><table class="table"><thead><tr>
        <th>Person</th><th>Role</th><th class="num">Track</th>
        ${modules.map((m) => `<th title="${esc(m.title)}" style="writing-mode:vertical-rl;
          transform:rotate(180deg);white-space:nowrap;font-weight:600">${esc(m.title)}</th>`).join('')}
      </tr></thead><tbody>
      ${people.map((p) => `
        <tr>
          <td><b>${esc(p.fullName)}</b></td>
          <td class="hint">${esc(p.role)}</td>
          <td class="num ${p.done < p.required ? '' : ''}">
            <b style="color:${p.done >= p.required ? 'var(--ok)' : 'var(--bad)'}">${p.done}</b>
            <span class="hint">/ ${p.required}</span></td>
          ${modules.map((m) => {
            const a = p.acked[m.slug];
            return `<td class="num" title="${a ? esc(fmtDate(a.at)) : 'not read'}">${
              !a ? '<span class="hint">·</span>'
                : a.stale ? '<span style="color:var(--warn)">◐</span>'
                : '<span style="color:var(--ok)">✓</span>'}</td>`;
          }).join('')}
        </tr>`).join('')}
      </tbody></table></div>
      <div class="hint" style="margin-top:8px">
        ✓ read and current · ◐ read an earlier version · · not read
      </div>
    </div>`;
}

/* ---- the guided tour, replayable from here and offered on first login ---- */

const TOUR = [
  ['.sidebar', 'These are your tabs. You only see the ones your role uses.'],
  ['#ticker-strip', 'The floor’s live numbers — today against yesterday.'],
  ['#brief-banner', 'Your own numbers for today. Dismiss it once read; it returns tomorrow.'],
  ['#alert-bell', 'Anything needing you now: overdue follow-ups, callbacks, new leads.'],
  ['#shift-widget', 'Press Start shift when you sit down. No shift, no fresh leads, no hours.'],
  ['#theme-btn', 'Switch between light and dark whenever you like.'],
];

export function startTour(me) {
  let step = 0;
  const overlay = h('<div class="tour-overlay"></div>');
  // The box is a SIBLING of the overlay, not a child: the highlighted element
  // is lifted above the overlay and its ring shadow covers the whole screen,
  // which would paint straight over a box trapped in the overlay's stacking
  // context - visible, but unclickable.
  const box = h('<div class="tour-box"></div>');
  document.body.append(overlay, box);

  const show = () => {
    while (step < TOUR.length && !document.querySelector(TOUR[step][0])) step += 1;
    if (step >= TOUR.length) return finish();

    const [selector, text] = TOUR[step];
    const target = document.querySelector(selector);
    const r = target.getBoundingClientRect();
    document.querySelectorAll('.tour-spot').forEach((el) => el.classList.remove('tour-spot'));
    target.classList.add('tour-spot');
    target.scrollIntoView({ block: 'center', behavior: 'smooth' });

    box.innerHTML = `
      <div class="hint">Step ${step + 1} of ${TOUR.length}</div>
      <div style="margin:6px 0 10px">${esc(text)}</div>
      <div class="row" style="gap:8px">
        <button class="btn small" id="tour-skip">Skip</button>
        <button class="btn primary small" id="tour-next">${step === TOUR.length - 1 ? 'Done' : 'Next'}</button>
      </div>`;
    // Sit under the highlighted element unless that would fall off-screen.
    const top = r.bottom + 12 + 150 > window.innerHeight ? Math.max(12, r.top - 150) : r.bottom + 12;
    box.style.top = `${top}px`;
    box.style.left = `${Math.min(Math.max(12, r.left), window.innerWidth - 340)}px`;

    box.querySelector('#tour-skip').addEventListener('click', finish);
    box.querySelector('#tour-next').addEventListener('click', () => { step += 1; show(); });
  };

  const finish = () => {
    document.querySelectorAll('.tour-spot').forEach((el) => el.classList.remove('tour-spot'));
    overlay.remove();
    box.remove();
    post('/training/tour/complete', {}).catch(() => {});
  };

  show();
}
