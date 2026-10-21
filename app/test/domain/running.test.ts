import { describe, it, expect } from 'vitest';
import { weeklyTarget, runRx, ruckLoad, ruckDue } from '../../src/domain/running';

describe('weeklyTarget', () => {
  it('week 0 is 15 km / 300 m', () => expect(weeklyTarget(0)).toEqual({ km: 15, vertM: 300, deload: false }));
  it('grows ~10% per week', () => expect(weeklyTarget(1)).toEqual({ km: 16.5, vertM: 330, deload: false }));
  it('every 4th week (index 3, 7, ...) is a 70% deload of the previous week', () => {
    const w2 = weeklyTarget(2);
    expect(weeklyTarget(3)).toEqual({ km: Math.round(w2.km * 0.7 * 2) / 2, vertM: Math.round((w2.vertM * 0.7) / 10) * 10, deload: true });
  });
  it('week after deload resumes growth from the last loading week', () => expect(weeklyTarget(4).km).toBeCloseTo(weeklyTarget(2).km * 1.1, 0));
  it('caps at 35 km / 1000 m', () => expect(weeklyTarget(40)).toEqual({ km: 35, vertM: 1000, deload: false }));
});

describe('runRx', () => {
  const t = { km: 20, vertM: 400, deload: false };
  it('splits km 30/25/45', () => {
    expect(runRx('easy', t).km).toBe(6);
    expect(runRx('quality-vert', t).km).toBe(5);
    expect(runRx('long', t).km).toBe(9);
  });
  it('vert goes to quality-vert (40%) and long (60%); easy and speed get none', () => {
    expect(runRx('quality-vert', t).vertM).toBe(160);
    expect(runRx('long', t).vertM).toBe(240);
    expect(runRx('quality-speed', t).vertM).toBe(0);
  });
  it('speed carries an interval description', () => expect(runRx('quality-speed', t).detail).toMatch(/400 m/));
});

describe('ruck', () => {
  it('step 0 = 10 kg / 600 m; steps alternate +2 kg then +150 m; capped at 20 kg / 1200 m', () => {
    expect(ruckLoad(0)).toEqual({ packKg: 10, vertM: 600 });
    expect(ruckLoad(1)).toEqual({ packKg: 12, vertM: 600 });
    expect(ruckLoad(2)).toEqual({ packKg: 12, vertM: 750 });
    expect(ruckLoad(99)).toEqual({ packKg: 20, vertM: 1200 });
  });
  it('due after 21 days or when never done', () => {
    expect(ruckDue(undefined, '2026-10-10')).toBe(true);
    expect(ruckDue('2026-10-01', '2026-10-21')).toBe(false);
    expect(ruckDue('2026-10-01', '2026-10-22')).toBe(true);
  });
});
