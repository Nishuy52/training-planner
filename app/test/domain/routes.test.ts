import { describe, it, expect } from 'vitest';
import { assignmentKey, routeFor, routeSummary, type Route, type RouteBook } from '../../src/domain/routes';

const lakeLoop: Route = { id: 'lake-loop', name: 'Lake loop', area: 'Hometown', km: 3.3, vertM: 20, kind: 'loop', suits: ['easy', 'quality-speed'] };
const hillRep: Route = {
  id: 'hill-repeats-x3', name: 'Hill repeats', area: 'Hometown', km: 6, vertM: 450, kind: 'repeat', repeats: 3,
  url: 'https://example.com/routes/x', suits: ['quality-vert', 'long', 'ruck'],
};
const hill: Route = { id: 'hill-bm', name: 'Hill loop', area: 'Hometown', km: 5, vertM: 250, kind: 'loop', suits: ['benchmark-hill'], benchmark: 'hill' };
const track: Route = { id: 'track', name: 'Track', area: 'Hometown', km: 2.4, vertM: 0, kind: 'loop', suits: ['benchmark-2k4'], benchmark: '2k4' };

describe('assignmentKey', () => {
  it('ruck shares the long-run key; others are their own', () => {
    expect(assignmentKey('ruck')).toBe('long');
    expect(assignmentKey('long')).toBe('long');
    expect(assignmentKey('easy')).toBe('easy');
  });
});

describe('routeFor', () => {
  const book: RouteBook = {
    routes: [lakeLoop, hillRep, hill, track],
    assignments: [
      { date: '2026-10-06', runKind: 'easy', routeId: 'lake-loop' },
      { date: '2026-10-10', runKind: 'long', routeId: 'hill-repeats-x3' },
      { date: '2026-10-08', runKind: 'benchmark-hill', routeId: 'lake-loop' },
      { date: '2026-10-09', runKind: 'easy', routeId: 'gone' },
    ],
  };
  it('uses the assignment for (date, run kind)', () => {
    expect(routeFor(book, '2026-10-06', 'easy')?.id).toBe('lake-loop');
    expect(routeFor(book, '2026-10-06', 'quality-vert')).toBeNull();
    expect(routeFor(book, '2026-10-07', 'easy')).toBeNull();
  });
  it('long and ruck share the long assignment', () => {
    expect(routeFor(book, '2026-10-10', 'long')?.id).toBe('hill-repeats-x3');
    expect(routeFor(book, '2026-10-10', 'ruck')?.id).toBe('hill-repeats-x3');
  });
  it('Benchmark runs use the flagged Route whatever the assignments say', () => {
    expect(routeFor(book, '2026-10-08', 'benchmark-hill')?.id).toBe('hill-bm');
    expect(routeFor(book, '2026-11-01', 'benchmark-2k4')?.id).toBe('track');
  });
  it('a Benchmark run without a flagged Route falls back to its assignment', () => {
    expect(routeFor({ ...book, routes: [lakeLoop] }, '2026-10-08', 'benchmark-hill')?.id).toBe('lake-loop');
  });
  it('an assignment to a missing Route is no Route', () => {
    expect(routeFor(book, '2026-10-09', 'easy')).toBeNull();
  });
});

describe('routeSummary', () => {
  it('keeps what a Session needs, with url and repeats only when set', () => {
    expect(routeSummary(hillRep)).toEqual({ id: 'hill-repeats-x3', name: 'Hill repeats', km: 6, vertM: 450, kind: 'repeat', repeats: 3, url: 'https://example.com/routes/x' });
    expect(routeSummary(lakeLoop)).toEqual({ id: 'lake-loop', name: 'Lake loop', km: 3.3, vertM: 20, kind: 'loop' });
  });
});
