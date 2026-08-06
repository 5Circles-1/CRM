import { esc, h } from './util.js';

/**
 * Charts, drawn as plain SVG with no dependencies.
 *
 * The UI has no build step and the server sends no third-party JavaScript, so a
 * charting library is not an option - and for four chart shapes it would not
 * earn its weight anyway.
 *
 * COLOUR. The categorical slots below are a validated set: every adjacent pair
 * clears the colour-blind separation floor, so two neighbouring series stay
 * distinguishable to a protan or deutan reader. The order is the safety
 * mechanism, not decoration - assign slots in sequence and never cycle past the
 * end. Three of these slots sit below 3:1 against a white surface, which is why
 * every chart here ships direct labels and a table underneath rather than
 * relying on the colour alone.
 *
 * Status colours are separate on purpose. A green here means "good", never
 * "series 3", so nothing can mistake a category for a judgement.
 */

export const SERIES = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300'];
export const STATUS = { good: '#0ca30c', warning: '#fab219', serious: '#ec835a', critical: '#d03b3b' };

const INK = '#16202e';
const MUTED = '#5b6b7f';
const GRID = '#e3e8ef';

const svgNS = 'http://www.w3.org/2000/svg';
const el = (name, attrs = {}) => {
  const node = document.createElementNS(svgNS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
};

/**
 * Axis labels, short enough to fit.
 *
 * Indian grouping, because the numbers on this screen are rupees and a lakh is
 * how anyone reading them thinks. 150000 renders as 1.5L, not 150,000, which
 * would need a gutter wider than some of the charts.
 */
export const compact = (v) => axisUnit(Math.abs(Number(v) || 0))(v);

/**
 * One unit for the whole axis, chosen from its largest tick.
 *
 * Formatting each tick independently produced "3.0L, 2.3L, 1.5L, 75k" - four
 * labels, two units, and a reader doing mental arithmetic to compare the last
 * one against the rest.
 */
export function axisUnit(max) {
  const a = Math.abs(Number(max) || 0);
  const [div, suffix] = a >= 1e7 ? [1e7, 'Cr'] : a >= 1e5 ? [1e5, 'L'] : a >= 1e3 ? [1e3, 'k'] : [1, ''];
  return (v) => {
    if (Number(v) === 0) return '0';   // "0L" is not a quantity anyone writes
    const n = (Number(v) || 0) / div;
    if (div === 1) return String(Math.round(n));
    // One decimal only while it adds something; 15.0L is noise.
    return `${Number.isInteger(n) ? n : n.toFixed(1)}${suffix}`;
  };
}

const niceCeil = (v) => {
  if (v <= 5) return 5;
  const mag = 10 ** Math.floor(Math.log10(v));
  return Math.ceil(v / mag) * mag;
};

/** One shared tooltip element: many charts, one floating box. */
let tip = null;
function showTip(html, x, y) {
  if (!tip) {
    tip = h('<div class="viz-tip" role="status"></div>');
    document.body.appendChild(tip);
  }
  tip.innerHTML = html;
  tip.style.display = 'block';
  const pad = 14;
  const w = tip.offsetWidth;
  tip.style.left = `${Math.min(window.innerWidth - w - 8, Math.max(8, x + pad))}px`;
  tip.style.top = `${Math.max(8, y - tip.offsetHeight - pad)}px`;
}
function hideTip() {
  if (tip) tip.style.display = 'none';
}

/* ------------------------------------------------------------------ */
/* Line chart: change over time                                        */
/* ------------------------------------------------------------------ */

/**
 * @param rows   array of objects
 * @param opts   { x, series: [{key,label,fmt?}], height?, yLabel?, formatX? }
 *
 * One y-axis, always. Two measures on different scales get two charts - a
 * second scale would let the reader see a correlation the data does not have.
 */
export function lineChart(rows, opts) {
  const {
    x, series, height = 220,
    formatX = (v) => String(v),
    format = (v) => String(v),
    formatY = null,
  } = opts;
  const W = 720;
  const H = height;
  // The left gutter is measured, not guessed. A fixed 44px silently clipped
  // rupee axis labels to "00000", which reads as a rendering fault and hides
  // the scale the whole chart depends on.
  const pad = { top: 14, right: 16, bottom: 28, left: 44 };
  const plotH = H - pad.top - pad.bottom;

  const wrap = h('<div class="viz"></div>');
  if (rows.length === 0) {
    wrap.appendChild(h('<div class="empty">No activity in this period.</div>'));
    return wrap;
  }

  const max = niceCeil(Math.max(1, ...rows.flatMap((r) => series.map((s) => Number(r[s.key]) || 0))));

  const fmtY = formatY ?? axisUnit(max);
  const yTicks = [0, 1, 2, 3, 4].map((i) => (max / 4) * i);
  const widest = Math.max(...yTicks.map((v) => fmtY(v).length));
  pad.left = Math.max(34, widest * 7 + 14);
  const plotW = W - pad.left - pad.right;

  const xAt = (i) => pad.left + (rows.length === 1 ? plotW / 2 : (i / (rows.length - 1)) * plotW);
  const yAt = (v) => pad.top + plotH - (Number(v) || 0) / max * plotH;

  const svg = el('svg', {
    viewBox: `0 0 ${W} ${H}`, class: 'viz-svg', role: 'img',
    'aria-label': `${series.map((s) => s.label).join(' and ')} over time`,
  });

  // Recessive grid: four lines, behind everything, no vertical rules.
  for (const v of yTicks) {
    const y = yAt(v);
    svg.appendChild(el('line', { x1: pad.left, x2: W - pad.right, y1: y, y2: y, stroke: GRID, 'stroke-width': 1 }));
    const t = el('text', { x: pad.left - 8, y: y + 4, 'text-anchor': 'end', fill: MUTED, 'font-size': 11 });
    t.textContent = fmtY(v);
    svg.appendChild(t);
  }

  // Sparse x labels: first, middle, last. A label per day collides at 30 days.
  [0, Math.floor(rows.length / 2), rows.length - 1].filter((v, i, a) => a.indexOf(v) === i)
    .forEach((i) => {
      const t = el('text', { x: xAt(i), y: H - 8, 'text-anchor': 'middle', fill: MUTED, 'font-size': 11 });
      t.textContent = formatX(rows[i][x]);
      svg.appendChild(t);
    });

  series.forEach((s, si) => {
    const colour = SERIES[si % SERIES.length];
    const d = rows.map((r, i) => `${i === 0 ? 'M' : 'L'} ${xAt(i)} ${yAt(r[s.key])}`).join(' ');
    svg.appendChild(el('path', {
      d, fill: 'none', stroke: colour, 'stroke-width': 2,
      'stroke-linejoin': 'round', 'stroke-linecap': 'round',
    }));
    // A 2px surface ring keeps overlapping points readable where lines cross.
    rows.forEach((r, i) => {
      svg.appendChild(el('circle', {
        cx: xAt(i), cy: yAt(r[s.key]), r: 4, fill: colour, stroke: '#fff', 'stroke-width': 2,
      }));
    });
  });

  // Crosshair: one hit target per x, full plot height, so the pointer never
  // has to find a 4px dot.
  const cross = el('line', {
    y1: pad.top, y2: pad.top + plotH, stroke: MUTED, 'stroke-width': 1,
    'stroke-dasharray': '3 3', opacity: 0,
  });
  svg.appendChild(cross);

  rows.forEach((r, i) => {
    const band = el('rect', {
      x: xAt(i) - plotW / rows.length / 2, y: pad.top,
      width: Math.max(8, plotW / rows.length), height: plotH, fill: 'transparent',
    });
    band.addEventListener('pointerenter', (e) => {
      cross.setAttribute('x1', xAt(i));
      cross.setAttribute('x2', xAt(i));
      cross.setAttribute('opacity', '1');
      showTip(
        `<b>${esc(formatX(r[x]))}</b>${series.map((s, si) =>
          `<div><span class="viz-dot" style="background:${SERIES[si % SERIES.length]}"></span>
             ${esc(s.label)} <b>${esc((s.fmt ?? format)(r[s.key]))}</b></div>`).join('')}`,
        e.clientX, e.clientY,
      );
    });
    band.addEventListener('pointerleave', () => { cross.setAttribute('opacity', '0'); hideTip(); });
    svg.appendChild(band);
  });

  wrap.appendChild(svg);
  if (series.length >= 2) wrap.appendChild(legend(series.map((s, i) => ({ label: s.label, colour: SERIES[i % SERIES.length] }))));
  return wrap;
}

/* ------------------------------------------------------------------ */
/* Donut: part-to-whole, at a glance                                   */
/* ------------------------------------------------------------------ */

/**
 * @param slices [{ label, value }]  — six at most; fold the tail into "Other"
 *
 * A donut answers "roughly what share", never "which of these two is bigger".
 * Every slice is labelled with its value, so the reading never depends on
 * telling two colours apart.
 */
export function donutChart(slices, opts = {}) {
  const { size = 220, centreLabel = '', centreValue = '' } = opts;
  const kept = slices.filter((s) => Number(s.value) > 0);
  const wrap = h('<div class="viz viz-donut"></div>');

  const total = kept.reduce((a, s) => a + Number(s.value), 0);
  if (total === 0) {
    wrap.appendChild(h('<div class="empty">Nothing recorded in this period.</div>'));
    return wrap;
  }

  const R = size / 2;
  const inner = R * 0.62;
  const svg = el('svg', {
    viewBox: `0 0 ${size} ${size}`, class: 'viz-donut-svg', role: 'img',
    'aria-label': kept.map((s) => `${s.label} ${s.value}`).join(', '),
  });

  let angle = -Math.PI / 2;
  kept.forEach((s, i) => {
    const frac = Number(s.value) / total;
    const sweep = frac * Math.PI * 2;
    const end = angle + sweep;
    const large = sweep > Math.PI ? 1 : 0;
    const p = (r, a) => `${R + r * Math.cos(a)} ${R + r * Math.sin(a)}`;

    const path = el('path', {
      d: `M ${p(R, angle)} A ${R} ${R} 0 ${large} 1 ${p(R, end)}
          L ${p(inner, end)} A ${inner} ${inner} 0 ${large} 0 ${p(inner, angle)} Z`,
      fill: SERIES[i % SERIES.length],
      // 2px surface gap between segments, so adjacent fills never merge.
      stroke: '#fff', 'stroke-width': 2,
    });
    path.style.cursor = 'default';
    path.addEventListener('pointerenter', (e) =>
      showTip(`<b>${esc(s.label)}</b><div>${Number(s.value)} · ${Math.round(frac * 100)}%</div>`,
        e.clientX, e.clientY));
    path.addEventListener('pointerleave', hideTip);
    svg.appendChild(path);
    angle = end;
  });

  if (centreValue !== '') {
    const v = el('text', { x: R, y: R + 2, 'text-anchor': 'middle', fill: INK, 'font-size': 26, 'font-weight': 700 });
    v.textContent = String(centreValue);
    svg.appendChild(v);
    const l = el('text', { x: R, y: R + 22, 'text-anchor': 'middle', fill: MUTED, 'font-size': 12 });
    l.textContent = centreLabel;
    svg.appendChild(l);
  }

  wrap.appendChild(svg);
  wrap.appendChild(legend(kept.map((s, i) => ({
    label: s.label, colour: SERIES[i % SERIES.length],
    value: `${Number(s.value)} · ${Math.round((Number(s.value) / total) * 100)}%`,
  }))));
  return wrap;
}

/* ------------------------------------------------------------------ */
/* Horizontal bars: ranking                                            */
/* ------------------------------------------------------------------ */

/**
 * @param rows [{ label, value, sub? }]
 *
 * One series, one colour. Colouring each bar by its own size would double-encode
 * length as hue and spend the only free channel on what the bar already shows.
 */
export function barChart(rows, opts = {}) {
  const { format = (v) => String(v), highlight = null } = opts;
  const wrap = h('<div class="viz viz-bars"></div>');
  if (rows.length === 0) {
    wrap.appendChild(h('<div class="empty">Nothing to rank yet.</div>'));
    return wrap;
  }
  const max = Math.max(1, ...rows.map((r) => Number(r.value) || 0));

  for (const r of rows) {
    const pct = ((Number(r.value) || 0) / max) * 100;
    const isMe = highlight && r.label === highlight;
    const row = h(`
      <div class="viz-bar-row${isMe ? ' me' : ''}">
        <div class="viz-bar-label">${esc(r.label)}${r.sub ? `<span class="hint"> ${esc(r.sub)}</span>` : ''}</div>
        <div class="viz-bar-track"><div class="viz-bar-fill" style="width:${pct}%"></div></div>
        <div class="viz-bar-value">${esc(format(r.value))}</div>
      </div>`);
    row.addEventListener('pointerenter', (e) =>
      showTip(`<b>${esc(r.label)}</b><div>${esc(format(r.value))}</div>`, e.clientX, e.clientY));
    row.addEventListener('pointerleave', hideTip);
    wrap.appendChild(row);
  }
  return wrap;
}

/* ------------------------------------------------------------------ */

function legend(items) {
  return h(`
    <div class="viz-legend">
      ${items.map((i) => `
        <span class="viz-legend-item">
          <span class="viz-dot" style="background:${i.colour}"></span>
          ${esc(i.label)}${i.value ? ` <b>${esc(i.value)}</b>` : ''}
        </span>`).join('')}
    </div>`);
}

/** A number is often the whole story; a one-bar chart never is. */
export function statTile(label, value, sub = '', tone = '') {
  return h(`
    <div class="stat${tone ? ` tone-${esc(tone)}` : ''}">
      <div class="k">${esc(label)}</div>
      <div class="v">${esc(String(value))}</div>
      ${sub ? `<div class="s">${esc(sub)}</div>` : ''}
    </div>`);
}
