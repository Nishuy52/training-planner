import { describe, it, expect } from 'vitest';
import { buildDetails } from '../../src/domain/details';
import type { DayPlan } from '../../src/domain/types';
import { baseState } from './fixtures';

const day = (sessions: DayPlan['sessions'], over: Partial<DayPlan> = {}): DayPlan => ({
  date: '2026-10-12', timezone: 'Europe/Berlin', gymProfileId: 'home-gym', mountain: false, noGym: false, sessions, ...over,
});
const none = () => null;

describe('buildDetails', () => {
  it('done sessions are null and output is index-aligned', () => {
    const d = day([
      { kind: 'lift', lift: 'squat', week: 1, slot: 'am', status: 'done' },
      { kind: 'run', run: 'easy', slot: 'pm', status: 'planned' },
    ]);
    const out = buildDetails(baseState(), d, none);
    expect(out).toHaveLength(2);
    expect(out[0]).toBeNull();
    expect(out[1]?.kind).toBe('run');
  });

  it('lift: main sets, content, finisher by lift, last FSL weight', () => {
    const d = day([
      { kind: 'lift', lift: 'squat', week: 1, slot: 'am', status: 'planned' },
      { kind: 'lift', lift: 'deadlift', week: 2, slot: 'pm', status: 'planned' },
      { kind: 'lift', lift: 'bench', week: 3, slot: 'pm', status: 'planned' },
    ]);
    const [sq, dl, bp] = buildDetails(baseState(), d, (l) => (l === 'squat' ? 22.5 : null)) as any[];
    expect(sq.tm).toBe(100);
    expect(sq.gymProfileId).toBe('home-gym');
    expect(sq.mainSets.map((s: any) => s.load)).toEqual([65, 75, 85]);
    expect(sq.lastFslWeightKg).toBe(22.5);
    expect(sq.finisher[2].name).toBe('Side plank with top-leg raise');
    expect(dl.finisher[2].name).toBe('Copenhagen plank');
    expect(bp.finisher[0].name).toBe('Bicep curl');
    expect(bp.lastFslWeightKg).toBeNull();
    expect(sq.warmup.length).toBeGreaterThan(0);
    expect(sq.fsl[0].name).toBe('DB Bulgarian split squat');
  });

  it('reentry uses week 4 percentages and keeps week "reentry"', () => {
    const d = day([{ kind: 'lift', lift: 'squat', week: 'reentry', slot: 'am', status: 'planned' }]);
    const [x] = buildDetails(baseState(), d, none) as any[];
    expect(x.week).toBe('reentry');
    expect(x.mainSets.map((s: any) => s.pct)).toEqual([40, 50, 60]);
  });

  it('Gym Profile: day profile wins, falls back to default', () => {
    const travelGym = { id: 'travel-gym', name: 'Travel gym', plateStepKg: 2.5, machineLifts: ['bench' as const], machineStepLb: 10, machineMaxLb: 200, hasBands: false };
    const st = baseState({ gymProfiles: [...baseState().gymProfiles, travelGym] });
    const s = [{ kind: 'lift', lift: 'bench', week: 1, slot: 'am', status: 'planned' }] as DayPlan['sessions'];
    const [a] = buildDetails(st, day(s, { gymProfileId: 'travel-gym' }), none) as any[];
    expect(a.gymProfileId).toBe('travel-gym');
    expect(a.mainSets[0].unit).toBe('lb');
    const [b] = buildDetails(st, day(s, { gymProfileId: null }), none) as any[];
    expect(b.gymProfileId).toBe('home-gym');
    expect(b.mainSets[0].unit).toBe('kg');
  });

  it('travel strength', () => {
    const [x] = buildDetails(baseState(), day([{ kind: 'travel-strength', slot: 'am', status: 'planned' }]), none) as any[];
    expect(x.kind).toBe('travel-strength');
    expect(x.exercises.length).toBeGreaterThan(0);
  });

  it('run: target from the run week index, clamped at 0; route null', () => {
    const s = [{ kind: 'run', run: 'quality-vert', slot: 'am', status: 'planned' }] as DayPlan['sessions'];
    const [w0] = buildDetails(baseState(), day(s, { date: '2026-10-07' }), none) as any[];
    expect(w0.target).toEqual({ km: 15, vertM: 300, deload: false });
    expect(w0.route).toBeNull();
    const [w1] = buildDetails(baseState(), day(s, { date: '2026-10-12' }), none) as any[];
    expect(w1.target).toEqual({ km: 16.5, vertM: 330, deload: false });
    const [before] = buildDetails(baseState(), day(s, { date: '2026-09-20' }), none) as any[];
    expect(before.target.km).toBe(15);
    expect(w0.rx.km).toBe(4);
  });

  it('long run is described as a trail long run', () => {
    const [x] = buildDetails(baseState(), day([{ kind: 'run', run: 'long', slot: 'am', status: 'planned' }]), none) as any[];
    expect(x.rx.detail).toBe('Trail long run — pick hilly trails');
  });
  it('ruck: load from ruck step, rx.vertM replaced', () => {
    const st = baseState({ ruck: { step: 2 } });
    const [x] = buildDetails(st, day([{ kind: 'run', run: 'ruck', slot: 'am', status: 'planned' }]), none) as any[];
    expect(x.ruckLoad).toEqual({ packKg: 12, vertM: 750 });
    expect(x.rx.vertM).toBe(750);
  });

  it('climb: partner event, benchmark, fallback', () => {
    const st = baseState({
      clubEvents: [
        { id: 'e1', date: '2026-10-12', time: '18:00', title: 'Wall A', venue: 'Wall A', type: 'partner' },
        { id: 'e2', date: '2026-10-12', time: '18:00', title: 'Bench', venue: 'X', type: 'endurance_benchmark' },
      ],
    });
    const d = day([
      { kind: 'climb', eventId: 'e1', slot: 'pm', status: 'planned' },
      { kind: 'climb', eventId: 'e2', slot: 'pm', status: 'planned' },
      { kind: 'climb', fallback: true, slot: 'pm', status: 'planned' },
    ]);
    const [p, b, f] = buildDetails(st, d, none) as any[];
    expect(p.event.id).toBe('e1');
    expect(p.fallback).toBe(false);
    expect(p.finisher).toBe('Last 30 min: endurance laps (climb, lower, straight back on)');
    expect(b.finisher).toBe('Benchmark: continuous minutes on auto-belay at a fixed grade — log grade + minutes');
    expect(f.event).toBeNull();
    expect(f.fallback).toBe(true);
    expect(f.finisher).toBe('Boulder session @ the bouldering gym');
  });

  describe('route (Plan 3 A4)', () => {
    const hillRep = { id: 'hill-rep', name: 'Hill repeats', area: 'Hometown', km: 6, vertM: 450, kind: 'repeat' as const, repeats: 3, url: 'https://x.test/a', suits: ['long' as const] };
    const hill = { id: 'hill', name: 'Hill loop', area: 'Hometown', km: 5, vertM: 250, kind: 'loop' as const, suits: ['benchmark-hill' as const], benchmark: 'hill' as const };
    const book = { routes: [hillRep, hill], assignments: [{ date: '2026-10-12', runKind: 'long' as const, routeId: 'hill-rep' }] };
    it('is null without a book or an assignment', () => {
      const [x] = buildDetails(baseState(), day([{ kind: 'run', run: 'easy', slot: 'am', status: 'planned' }]), none) as any[];
      expect(x.route).toBeNull();
      const [y] = buildDetails(baseState(), day([{ kind: 'run', run: 'easy', slot: 'am', status: 'planned' }]), none, book) as any[];
      expect(y.route).toBeNull();
    });
    it('long and ruck take the long assignment', () => {
      const [l] = buildDetails(baseState(), day([{ kind: 'run', run: 'long', slot: 'am', status: 'planned' }]), none, book) as any[];
      expect(l.route).toEqual({ id: 'hill-rep', name: 'Hill repeats', km: 6, vertM: 450, kind: 'repeat', repeats: 3, url: 'https://x.test/a' });
      const [r] = buildDetails(baseState(), day([{ kind: 'run', run: 'ruck', slot: 'am', status: 'planned' }]), none, book) as any[];
      expect(r.route.id).toBe('hill-rep');
      expect(r.ruckLoad).toBeDefined();
    });
    it('a Benchmark hill run uses the Benchmark Route', () => {
      const [b] = buildDetails(baseState(), day([{ kind: 'run', run: 'benchmark-hill', slot: 'am', status: 'planned' }], { date: '2026-10-20' }), none, book) as any[];
      expect(b.route).toMatchObject({ id: 'hill', name: 'Hill loop', kind: 'loop' });
    });
  });
});
