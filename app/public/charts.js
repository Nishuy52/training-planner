// Progress charts as hand-written inline SVG (the CSP allows no chart library): scales, ticks and one builder
// per chart. Pure functions that return markup strings, shared by app.js and the unit tests
// (test/static/charts.test.ts). Colours are CSS custom properties from styles.css, passed as "var(--token)".

import { fmtMmss } from './format.js';

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const r1 = (n) => Math.round(n * 10) / 10;
const clean = (n) => +n.toFixed(10);

/** ISO date to a day number (UTC days since the epoch). */
export const dayNum = (iso) => Date.parse(`${iso}T00:00:00Z`) / 86400000;
/** "5 Oct" */
export const fmtDayMonth = (iso) => { const d = new Date(`${iso}T00:00:00Z`); return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`; };

/**
 * Round axis ticks covering [min, max] with about `count` intervals. The step is 1, 2, 2.5 or 5 × 10^k, or the
 * first of `steps` (ascending) that is large enough. An empty span is widened by 10 % (at least 1) each way.
 * @returns {{ min: number, max: number, step: number, ticks: number[] }}
 */
export function niceTicks(min, max, count = 4, steps) {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { min: 0, max: 1, step: 1, ticks: [0, 1] };
  if (max < min) [min, max] = [max, min];
  if (max === min) { const pad = Math.abs(min) * 0.1 || 1; min -= pad; max += pad; }
  const raw = (max - min) / Math.max(1, count);
  let step;
  if (steps && steps.length) {
    step = steps.find((s) => s >= raw);
    if (step === undefined) { const big = steps[steps.length - 1]; step = big * Math.ceil(raw / big); }
  } else {
    const p = 10 ** Math.floor(Math.log10(raw));
    const f = raw / p;
    step = (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
  }
  const lo = clean(Math.floor(min / step + 1e-9) * step);
  const hi = clean(Math.ceil(max / step - 1e-9) * step);
  const ticks = [];
  for (let v = lo; v <= hi + step / 1e6; v += step) ticks.push(clean(v));
  return { min: lo, max: hi, step, ticks };
}

/** Steps (seconds) for a time axis: labels land on whole minutes or tidy fractions of one. */
export const TIME_STEPS = [5, 10, 15, 20, 30, 60, 120, 300, 600, 900, 1800, 3600];

/** Maps [d0, d1] onto [r0, r1]; an empty domain maps to the middle of the range. */
export function linearScale(d0, d1, r0, r1) {
  const span = d1 - d0;
  return (v) => (span === 0 ? (r0 + r1) / 2 : r0 + ((v - d0) / span) * (r1 - r0));
}

/** A step line through points (sorted by x): hold each value until the next point, then to `xEnd`. */
export function stepPath(points, xEnd) {
  if (!points.length) return '';
  const f = (n) => r1(n);
  let d = `M${f(points[0].x)} ${f(points[0].y)}`;
  for (let i = 1; i < points.length; i++) d += ` H${f(points[i].x)} V${f(points[i].y)}`;
  if (xEnd !== undefined && xEnd > points[points.length - 1].x) d += ` H${f(xEnd)}`;
  return d;
}

/**
 * Spread label positions so neighbours are at least `gap` apart, staying inside [lo, hi] when there is room.
 * Returns the new positions in the input order.
 */
export function spreadLabels(ys, gap, lo, hi) {
  const order = ys.map((y, i) => ({ y, i })).sort((a, b) => a.y - b.y);
  for (let k = 1; k < order.length; k++) order[k].y = Math.max(order[k].y, order[k - 1].y + gap);
  if (order.length && order[order.length - 1].y > hi) {
    order[order.length - 1].y = hi;
    for (let k = order.length - 2; k >= 0; k--) order[k].y = Math.min(order[k].y, order[k + 1].y - gap);
  }
  if (order.length && order[0].y < lo) {
    order[0].y = lo;
    for (let k = 1; k < order.length; k++) order[k].y = Math.max(order[k].y, order[k - 1].y + gap);
  }
  const out = [];
  for (const o of order) out[o.i] = o.y;
  return out;
}

/** Content width for a chart at viewport width `vw`: the 720 px column (minus 16 px gutters), beside the 88 px rail from 900 px. */
export function chartWidth(vw) {
  const avail = vw >= 900 ? vw - 88 : vw;
  return Math.max(280, Math.min(688, Math.floor(avail) - 32));
}

/** Monday ticks between two dates, thinned so labels stay at least `minGapPx` apart. */
function weekTicks(start, end, sx, minGapPx = 48) {
  const out = [];
  const first = dayNum(start);
  const wd = (new Date(first * 86400000).getUTCDay() + 6) % 7;
  for (let d = first + ((7 - wd) % 7); d <= dayNum(end); d += 7) out.push(d);
  const every = Math.max(1, Math.ceil(minGapPx / Math.max(1, sx(first + 7) - sx(first))));
  return out.filter((_, i) => i % every === 0).map((d) => ({ x: sx(d), label: fmtDayMonth(new Date(d * 86400000).toISOString().slice(0, 10)) }));
}

/** The SVG root with its accessible title and description. */
function svgOpen(id, width, height, title, desc) {
  return `<svg class="chart" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-labelledby="${id}-t ${id}-d" focusable="false">
    <title id="${id}-t">${esc(title)}</title><desc id="${id}-d">${esc(desc)}</desc>`;
}

/** Horizontal grid lines with y labels, and x labels under the plot. */
function axes({ width, pad, height, yTicks, sy, yFmt, xTicks }) {
  const plotR = width - pad.r;
  const grid = yTicks.map((v) => `<line class="ch-grid" x1="${pad.l}" x2="${plotR}" y1="${r1(sy(v))}" y2="${r1(sy(v))}"/>
    <text class="ch-tick" x="${pad.l - 6}" y="${r1(sy(v) + 3.5)}" text-anchor="end">${esc(yFmt(v))}</text>`).join('');
  const xs = xTicks.map((t) => `<text class="ch-tick" x="${r1(t.x)}" y="${height - pad.b + 14}" text-anchor="middle">${esc(t.label)}</text>`).join('');
  return grid + xs;
}

/** A visually folded table with the chart's numbers. */
export function dataTable(caption, head, rows) {
  return `<details class="fold chart-table"><summary>Show table</summary>
    <div class="table-scroll"><table><caption class="sr-only">${esc(caption)}</caption>
      <thead><tr>${head.map((h) => `<th scope="col">${esc(h)}</th>`).join('')}</tr></thead>
      <tbody>${rows.map((r) => `<tr>${r.map((c, i) => (i === 0 ? `<th scope="row">${esc(c)}</th>` : `<td>${esc(c)}</td>`)).join('')}</tr>`).join('')}</tbody>
    </table></div></details>`;
}

/**
 * Training Max per lift as step lines over [start, end]; each line holds its last value to `end`, where it is labelled.
 * @param {{ id: string, width: number, start: string, end: string, unit?: string, title?: string,
 *   series: Array<{ name: string, color: string, points: Array<{ date: string, value: number }> }> }} o
 * @returns {string} SVG, or '' when no series has a point
 */
export function stepLineChart(o) {
  const series = o.series.filter((s) => s.points.length).map((s) => ({ ...s, points: [...s.points].sort((a, b) => (a.date < b.date ? -1 : 1)) }));
  if (!series.length) return '';
  const unit = o.unit || 'kg';
  const height = 200;
  const pad = { l: 36, r: 44, t: 12, b: 24 };
  const vals = series.flatMap((s) => s.points.map((p) => p.value));
  const yt = niceTicks(Math.min(...vals), Math.max(...vals), 4);
  const x0 = dayNum(o.start);
  const x1 = Math.max(dayNum(o.end), ...series.map((s) => dayNum(s.points[s.points.length - 1].date)));
  const sx = linearScale(x0, x1, pad.l, o.width - pad.r);
  const sy = linearScale(yt.min, yt.max, height - pad.b, pad.t);
  const fmt = (v) => String(+v.toFixed(2));
  const ends = spreadLabels(series.map((s) => sy(s.points[s.points.length - 1].value)), 12, pad.t + 4, height - pad.b);
  const lines = series.map((s, k) => {
    const pts = s.points.map((p) => ({ x: sx(Math.max(x0, dayNum(p.date))), y: sy(p.value) }));
    const last = s.points[s.points.length - 1].value;
    return `<g style="--c:${esc(s.color)}">
      <path class="ch-line" d="${stepPath(pts, o.width - pad.r)}"/>
      ${pts.map((p) => `<circle class="ch-dot" cx="${r1(p.x)}" cy="${r1(p.y)}" r="2.5"/>`).join('')}
      <text class="ch-end" x="${o.width - pad.r + 5}" y="${r1(ends[k] + 4)}">${esc(fmt(last))}</text>
    </g>`;
  }).join('');
  const desc = series.map((s) => `${s.name}: ${s.points.map((p) => `${fmt(p.value)} ${unit} from ${fmtDayMonth(p.date)}`).join(', then ')}`).join('. ');
  return `${svgOpen(o.id, o.width, height, o.title || 'Training Max per lift', `${desc}.`)}
    ${axes({ width: o.width, pad, height, yTicks: yt.ticks, sy, yFmt: fmt, xTicks: weekTicks(o.start, new Date(x1 * 86400000).toISOString().slice(0, 10), sx) })}
    ${lines}</svg>`;
}

/**
 * Dated points joined by a line (Benchmark Results). `fmt` formats values (axis, labels); `labelOf` puts a label
 * over each point (e.g. the auto-belay grade); otherwise the latest point is labelled with its value.
 * @param {{ id: string, width: number, start: string, end: string, title: string, color: string,
 *   points: Array<{ date: string, value: number, [k: string]: any }>, fmt?: (v: number) => string, steps?: number[],
 *   labelOf?: (p: any) => string, height?: number }} o
 * @returns {string} SVG, or '' with no points
 */
export function pointChart(o) {
  const pts = [...o.points].sort((a, b) => (a.date < b.date ? -1 : 1));
  if (!pts.length) return '';
  const fmt = o.fmt || ((v) => String(v));
  const height = o.height || 150;
  const pad = { l: 40, r: 16, t: 18, b: 24 };
  const vals = pts.map((p) => p.value);
  const yt = niceTicks(Math.min(...vals), Math.max(...vals), 3, o.steps);
  const x0 = dayNum(o.start);
  const x1 = Math.max(dayNum(o.end), dayNum(pts[pts.length - 1].date));
  const sx = linearScale(x0, x1, pad.l + 6, o.width - pad.r - 6);
  const sy = linearScale(yt.min, yt.max, height - pad.b, pad.t);
  const xy = pts.map((p) => ({ ...p, x: sx(Math.max(x0, dayNum(p.date))), y: sy(p.value) }));
  const line = xy.length > 1 ? `<path class="ch-line" d="M${xy.map((p) => `${r1(p.x)} ${r1(p.y)}`).join(' L')}"/>` : '';
  const labels = xy.map((p, i) => {
    const text = o.labelOf ? o.labelOf(p) : i === xy.length - 1 ? fmt(p.value) : '';
    if (!text) return '';
    const anchor = p.x > o.width - pad.r - 24 ? 'end' : p.x < pad.l + 24 ? 'start' : 'middle';
    return `<text class="ch-end" x="${r1(p.x)}" y="${r1(p.y - 7)}" text-anchor="${anchor}">${esc(text)}</text>`;
  }).join('');
  const desc = pts.map((p) => `${fmtDayMonth(p.date)}: ${o.labelOf ? `${o.labelOf(p)}, ` : ''}${fmt(p.value)}`).join('; ');
  return `${svgOpen(o.id, o.width, height, o.title, `${desc}.`)}
    ${axes({ width: o.width, pad, height, yTicks: yt.ticks, sy, yFmt: fmt, xTicks: weekTicks(o.start, new Date(x1 * 86400000).toISOString().slice(0, 10), sx, 56) })}
    <g style="--c:${esc(o.color)}">${line}${xy.map((p) => `<circle class="ch-dot" cx="${r1(p.x)}" cy="${r1(p.y)}" r="3.5"/>`).join('')}${labels}</g></svg>`;
}

/** Time axis formatter for Benchmark times. */
export const fmtTimeTick = (v) => fmtMmss(v);

/**
 * Weekly bars against a target marker. A week with `target: null` (before running started) is drawn empty;
 * a deload week is shaded.
 * @param {{ id: string, width: number, title: string, color: string, unit: string,
 *   weeks: Array<{ monday: string, value: number, target: number | null, deload: boolean }> }} o
 * @returns {string} SVG, or '' when no week has a target
 */
export function weeklyBarChart(o) {
  const weeks = o.weeks;
  if (!weeks.some((w) => w.target != null)) return '';
  const height = 170;
  const pad = { l: 36, r: 8, t: 10, b: 24 };
  const active = weeks.filter((w) => w.target != null);
  const max = Math.max(1, ...active.map((w) => Math.max(w.value || 0, w.target || 0)));
  const yt = niceTicks(0, max, 4);
  const sy = linearScale(0, yt.max, height - pad.b, pad.t);
  const slot = (o.width - pad.l - pad.r) / weeks.length;
  const barW = Math.min(26, slot * 0.6);
  const fmt = (v) => String(+v.toFixed(1));
  const every = Math.max(1, Math.ceil(44 / slot));
  const base = sy(0);
  const body = weeks.map((w, i) => {
    const cx = pad.l + slot * (i + 0.5);
    const label = (weeks.length - 1 - i) % every === 0 ? `<text class="ch-tick" x="${r1(cx)}" y="${height - pad.b + 14}" text-anchor="middle">${esc(fmtDayMonth(w.monday))}</text>` : '';
    if (w.target == null) {
      return `<line class="ch-empty" x1="${r1(cx - barW / 2)}" x2="${r1(cx + barW / 2)}" y1="${r1(base - 1)}" y2="${r1(base - 1)}"/>${label}`;
    }
    const top = sy(w.value || 0);
    const tw = Math.min(slot * 0.86, barW + 10);
    return `${w.deload ? `<rect class="ch-deload" x="${r1(pad.l + slot * i + 1)}" y="${pad.t}" width="${r1(slot - 2)}" height="${r1(base - pad.t)}" rx="3"/>` : ''}
      <rect class="ch-bar" x="${r1(cx - barW / 2)}" y="${r1(top)}" width="${r1(barW)}" height="${r1(Math.max(0, base - top))}" rx="2"/>
      <line class="ch-target" x1="${r1(cx - tw / 2)}" x2="${r1(cx + tw / 2)}" y1="${r1(sy(w.target))}" y2="${r1(sy(w.target))}"/>${label}`;
  }).join('');
  const desc = weeks.map((w) => `Week of ${fmtDayMonth(w.monday)}: ${w.target == null ? 'before running started' : `${fmt(w.value || 0)} of ${fmt(w.target)} ${o.unit}${w.deload ? ' (deload)' : ''}`}`).join('; ');
  return `${svgOpen(o.id, o.width, height, o.title, `${desc}.`)}
    ${axes({ width: o.width, pad, height, yTicks: yt.ticks, sy, yFmt: fmt, xTicks: [] })}
    <g style="--c:${esc(o.color)}">${body}</g></svg>`;
}

/**
 * Adherence per week as stacked bars (done · skipped · missed of what was expected, scaled to the busiest week)
 * with the % done; each row opens to the breakdown by kind (lift, run, climb).
 * @param {{ weeks: Array<{ monday: string, expected: number, done: number, skipped: number,
 *   byKind: Record<'lift' | 'run' | 'climb', { expected: number, done: number, skipped: number }> }> }} o
 * @returns {string} HTML, or '' when nothing was expected in any week
 */
export function adherenceRows(o) {
  const weeks = o.weeks;
  const maxExp = Math.max(0, ...weeks.map((w) => w.expected || 0));
  if (!maxExp) return '';
  const KIND = [['lift', 'Lift'], ['run', 'Run'], ['climb', 'Climb']];
  const rows = weeks.map((w) => {
    const exp = w.expected || 0;
    const done = Math.min(exp, w.done || 0);
    const skipped = Math.min(exp - done, w.skipped || 0);
    const missed = Math.max(0, exp - done - skipped);
    const pct = exp ? Math.round((done / exp) * 100) : null;
    const kinds = KIND.filter(([k]) => w.byKind && w.byKind[k] && w.byKind[k].expected)
      .map(([k, n]) => { const c = w.byKind[k]; return `${n} ${c.done}/${c.expected}${c.skipped ? ` (${c.skipped} skipped)` : ''}`; });
    const breakdown = kinds.length ? kinds.join(' · ') : 'Nothing expected';
    const seg = (cls, n) => (n ? `<i class="${cls}" style="width:${r1((n / exp) * 100)}%"></i>` : '');
    const said = exp ? `${done} of ${exp} done, ${skipped} skipped, ${missed} missed, ${pct}%` : 'nothing expected';
    return `<details class="adh-row">
      <summary title="${esc(breakdown)}"><span class="adh-wk">${esc(fmtDayMonth(w.monday))}</span>
        <span class="adh-track" aria-hidden="true">${exp ? `<span class="adh-bar" style="width:${r1((exp / maxExp) * 100)}%">${seg('d', done)}${seg('s', skipped)}${seg('m', missed)}</span>` : ''}</span>
        <span class="adh-num" aria-hidden="true">${exp ? `${done}/${exp} · ${pct}%` : '—'}</span>
        <span class="sr-only">Week of ${esc(fmtDayMonth(w.monday))}: ${esc(said)}</span></summary>
      <div class="adh-break small">${esc(breakdown)}</div>
    </details>`;
  }).join('');
  return `<div class="adh" role="group" aria-label="Adherence per week, Sessions done against what was expected. Open a week for the breakdown by kind.">
    <div class="ch-legend small" aria-hidden="true"><span><i class="sw adh-d"></i>Done</span><span><i class="sw adh-s"></i>Skipped</span><span><i class="sw adh-m"></i>Missed</span></div>
    ${rows}</div>`;
}
