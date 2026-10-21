import { describe, expect, it } from 'vitest';
import {
  TIME_STEPS, adherenceRows, chartWidth, dataTable, dayNum, fmtDayMonth, linearScale, niceTicks, pointChart, spreadLabels,
  stepLineChart, stepPath, weeklyBarChart,
} from '../../public/charts.js';
import { fmtMmss } from '../../public/format.js';

describe('niceTicks', () => {
  it('covers the span with 1/2/2.5/5 × 10^k steps', () => {
    expect(niceTicks(45, 135, 4)).toEqual({ min: 25, max: 150, step: 25, ticks: [25, 50, 75, 100, 125, 150] });
    expect(niceTicks(0, 17.1, 4)).toEqual({ min: 0, max: 20, step: 5, ticks: [0, 5, 10, 15, 20] });
    expect(niceTicks(0, 750, 4)).toMatchObject({ min: 0, max: 800, step: 200 });
    expect(niceTicks(0.1, 0.9, 4).ticks).toEqual([0, 0.2, 0.4, 0.6, 0.8, 1]);
  });
  it('widens an empty span and survives bad input', () => {
    expect(niceTicks(100, 100, 4)).toMatchObject({ min: 90, max: 110 });
    expect(niceTicks(0, 0, 4)).toMatchObject({ min: -1, max: 1 });
    expect(niceTicks(NaN, 3)).toEqual({ min: 0, max: 1, step: 1, ticks: [0, 1] });
    expect(niceTicks(10, 2, 4)).toMatchObject({ min: 2, max: 10 });
  });
  it('uses the given steps, so time ticks land on tidy seconds', () => {
    const t = niceTicks(642, 668, 3, TIME_STEPS);
    expect(t.step).toBe(10);
    expect(t.ticks.map(fmtMmss)).toEqual(['10:40', '10:50', '11:00', '11:10']);
    expect(niceTicks(0, 100000, 3, TIME_STEPS).step).toBe(36000); // past the largest step: a multiple of it
  });
});

describe('linearScale, stepPath, spreadLabels', () => {
  it('maps a domain onto a range (inverted for y)', () => {
    const y = linearScale(0, 100, 200, 0);
    expect(y(0)).toBe(200);
    expect(y(50)).toBe(100);
    expect(linearScale(5, 5, 0, 10)(5)).toBe(5);
  });
  it('draws a step line held to the end', () => {
    expect(stepPath([{ x: 0, y: 10 }, { x: 5, y: 4 }], 9)).toBe('M0 10 H5 V4 H9');
    expect(stepPath([{ x: 1, y: 2 }])).toBe('M1 2');
    expect(stepPath([])).toBe('');
  });
  it('pushes labels apart inside the bounds, keeping the input order', () => {
    expect(spreadLabels([50, 52, 100], 12, 0, 200)).toEqual([50, 62, 100]);
    expect(spreadLabels([195, 196], 12, 0, 200)).toEqual([188, 200]);
    expect(spreadLabels([3, 1], 12, 5, 200)).toEqual([17, 5]);
  });
});

describe('chartWidth', () => {
  it('fills the column minus the gutters, beside the rail from 900 px, up to 688', () => {
    expect(chartWidth(375)).toBe(343);
    expect(chartWidth(800)).toBe(688);
    expect(chartWidth(900)).toBe(688);
    expect(chartWidth(1280)).toBe(688);
    expect(chartWidth(300)).toBe(280);
  });
});

describe('dates', () => {
  it('day numbers and labels', () => {
    expect(dayNum('1970-01-02')).toBe(1);
    expect(fmtDayMonth('2026-10-05')).toBe('5 Oct');
  });
});

const count = (s: string, re: RegExp) => (s.match(re) || []).length;

describe('stepLineChart', () => {
  const series = [
    { name: 'Squat', color: 'var(--strength)', points: [{ date: '2026-10-28', value: 105 }, { date: '2026-09-28', value: 100 }] },
    { name: 'Bench', color: 'var(--accent)', points: [{ date: '2026-09-29', value: 70 }] },
    { name: 'OHP', color: 'var(--benchmark)', points: [] },
  ];
  const svg = stepLineChart({ id: 'tm', width: 343, start: '2026-09-21', end: '2026-11-09', series });
  it('draws one labelled step line per lift with points, with an accessible title and description', () => {
    expect(count(svg, /class="ch-line"/g)).toBe(2);
    expect(svg).toContain('role="img"');
    expect(svg).toContain('aria-labelledby="tm-t tm-d"');
    expect(svg).toMatch(/<desc id="tm-d">Squat: 100 kg from 28 Sep, then 105 kg from 28 Oct\. Bench: 70 kg from 29 Sep\.<\/desc>/);
    expect(svg).toMatch(/class="ch-end"[^>]*>105</);
    expect(svg).toMatch(/class="ch-end"[^>]*>70</);
    expect(svg).toContain('width="343"');
  });
  it('is empty with no points', () => {
    expect(stepLineChart({ id: 'tm', width: 343, start: '2026-09-21', end: '2026-11-09', series: [{ name: 'Squat', color: 'x', points: [] }] })).toBe('');
  });
  it('escapes what it prints', () => {
    const s = stepLineChart({ id: 'tm', width: 343, start: '2026-09-21', end: '2026-11-09', title: '<b>', series: [{ name: '<i>', color: '"x', points: [{ date: '2026-10-01', value: 1 }] }] });
    expect(s).not.toContain('<b>');
    expect(s).not.toContain('<i>');
    expect(s).toContain('--c:&quot;x');
  });
});

describe('pointChart', () => {
  it('joins the points, labels the latest value and formats the axis', () => {
    const svg = pointChart({ id: 'k', width: 300, start: '2026-09-21', end: '2026-11-09', title: '2.4 km', color: 'var(--benchmark)',
      points: [{ date: '2026-10-27', value: 642 }, { date: '2026-10-20', value: 668 }], fmt: fmtMmss, steps: TIME_STEPS });
    expect(count(svg, /class="ch-dot"/g)).toBe(2);
    expect(svg).toContain('class="ch-line"');
    expect(svg).toMatch(/class="ch-end"[^>]*>10:42</);
    expect(svg).toContain('20 Oct: 11:08; 27 Oct: 10:42.');
  });
  it('labels every point when asked (the auto-belay grade), with no line for one point', () => {
    const svg = pointChart({ id: 'a', width: 300, start: '2026-09-21', end: '2026-11-09', title: 'Auto-belay', color: 'var(--climb)',
      points: [{ date: '2026-10-29', value: 18, grade: '6b' }], labelOf: (p) => p.grade });
    expect(svg).not.toContain('class="ch-line"');
    expect(svg).toMatch(/class="ch-end"[^>]*>6b</);
    expect(svg).toContain('29 Oct: 6b, 18.');
  });
  it('is empty with no points', () => {
    expect(pointChart({ id: 'a', width: 300, start: '2026-09-21', end: '2026-11-09', title: 't', color: 'c', points: [] })).toBe('');
  });
});

describe('weeklyBarChart', () => {
  const weeks = [
    { monday: '2026-09-28', value: 3, target: null, deload: false },
    { monday: '2026-10-05', value: 14.2, target: 15, deload: false },
    { monday: '2026-10-12', value: 12.9, target: 12.5, deload: true },
  ];
  const svg = weeklyBarChart({ id: 'km', width: 343, title: 'km', color: 'var(--easy)', unit: 'km', weeks });
  it('draws a bar and a target per active week, an empty mark before runs started, and shades deload weeks', () => {
    expect(count(svg, /class="ch-bar"/g)).toBe(2);
    expect(count(svg, /class="ch-target"/g)).toBe(2);
    expect(count(svg, /class="ch-empty"/g)).toBe(1);
    expect(count(svg, /class="ch-deload"/g)).toBe(1);
    expect(svg).toContain('Week of 28 Sep: before running started; Week of 5 Oct: 14.2 of 15 km; Week of 12 Oct: 12.9 of 12.5 km (deload).');
  });
  it('is empty before any week has a target', () => {
    expect(weeklyBarChart({ id: 'km', width: 343, title: 'km', color: 'c', unit: 'km', weeks: [weeks[0]!] })).toBe('');
  });
});

describe('adherenceRows', () => {
  const k = (expected: number, done: number, skipped = 0) => ({ expected, done, skipped });
  const weeks = [
    { monday: '2026-10-05', expected: 7, done: 6, skipped: 1, byKind: { lift: k(3, 3), run: k(3, 2, 1), climb: k(1, 1) } },
    { monday: '2026-10-12', expected: 4, done: 2, skipped: 0, byKind: { lift: k(2, 1), run: k(2, 1), climb: k(0, 0) } },
    { monday: '2026-10-19', expected: 0, done: 0, skipped: 0, byKind: { lift: k(0, 0), run: k(0, 0), climb: k(0, 0) } },
  ];
  const html = adherenceRows({ weeks });
  it('shows done of expected with the %, and the breakdown by kind', () => {
    expect(html).toContain('6/7 · 86%');
    expect(html).toContain('2/4 · 50%');
    expect(html).toContain('Week of 5 Oct: 6 of 7 done, 1 skipped, 0 missed, 86%');
    expect(html).toContain('Lift 3/3 · Run 2/3 (1 skipped) · Climb 1/1');
    expect(html).toContain('Lift 1/2 · Run 1/2');
    expect(html).toContain('Week of 19 Oct: nothing expected');
  });
  it('scales each bar to the busiest week', () => {
    expect(html).toContain('class="adh-bar" style="width:100%"');
    expect(html).toContain('class="adh-bar" style="width:57.1%"');
  });
  it('is empty when nothing was expected', () => {
    expect(adherenceRows({ weeks: [weeks[2]!] })).toBe('');
  });
});

describe('dataTable', () => {
  it('folds an escaped table with row headers', () => {
    const t = dataTable('Cap', ['A', 'B'], [['<x>', '1']]);
    expect(t).toContain('<summary>Show table</summary>');
    expect(t).toContain('<th scope="row">&lt;x&gt;</th><td>1</td>');
    expect(t).toContain('<caption class="sr-only">Cap</caption>');
  });
});
