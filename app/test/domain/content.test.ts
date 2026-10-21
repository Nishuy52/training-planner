import { it, expect } from 'vitest';
import { DAILY_ROUTINE, MORNING_DRILLS, SELF_CHECKS, ALIGNMENT_RULE } from '../../src/content/mobility';
import { WARMUPS } from '../../src/content/warmups';
import { FSL, FINISHERS } from '../../src/content/liftExtras';
import { TRAVEL_STRENGTH } from '../../src/content/travelStrength';

const all = JSON.stringify([DAILY_ROUTINE, WARMUPS, MORNING_DRILLS, FSL, FINISHERS, TRAVEL_STRENGTH]).toLowerCase();
it('daily routine has 15 items', () => expect(DAILY_ROUTINE).toHaveLength(15));
it('never contains removed exercises', () => { for (const w of ['figure-4', 'figure 4', 'pigeon', 'piriformis']) expect(all).not.toContain(w); });
it('knee-to-wall cue uses 2nd toe', () => {
  expect(JSON.stringify(WARMUPS.squat)).toMatch(/2nd toe/);
  expect(JSON.stringify(WARMUPS.squat)).not.toMatch(/over little toe/);
});
it('daily routine only uses 45 s holds or 10-rep doses', () => {
  for (const e of DAILY_ROUTINE) { const d = e.dose as any; expect(d.type === 'hold' ? d.seconds === 45 : d.reps === 10).toBe(true); }
});
it('daily routine groups and alignment rule', () => {
  expect(new Set(DAILY_ROUTINE.map((e) => e.group))).toEqual(new Set(['Standing at wall', 'Kneeling at bed', 'Floor']));
  expect(ALIGNMENT_RULE).toMatch(/kneecap forward/i);
});
it('morning drills and self-checks', () => { expect(MORNING_DRILLS).toHaveLength(3); expect(SELF_CHECKS).toHaveLength(2); });
it('warm-ups cover every lift with the spec additions', () => {
  expect(Object.keys(WARMUPS).sort()).toEqual(['bench', 'deadlift', 'ohp', 'squat']);
  expect(WARMUPS.squat).toHaveLength(6); expect(WARMUPS.deadlift).toHaveLength(6);
  expect(WARMUPS.bench).toHaveLength(5); expect(WARMUPS.ohp).toHaveLength(6);
});
it('FSL, finishers, travel strength', () => {
  expect(FSL.bench).toHaveLength(2); expect(FSL.ohp).toHaveLength(2);
  expect(FSL.squat).toHaveLength(1); expect(FSL.deadlift).toHaveLength(1);
  expect(FINISHERS.lower.length).toBeGreaterThanOrEqual(2); expect(FINISHERS.upper.length).toBeGreaterThanOrEqual(1);
  expect(TRAVEL_STRENGTH).toHaveLength(6);
});

it('every lower finisher variant has Cossack + Nordic and exactly one of side plank / Copenhagen', () => {
  expect(FINISHERS.lower).toHaveLength(2);
  for (const v of FINISHERS.lower) {
    const names = v.map((e) => e.name.toLowerCase());
    expect(names.some((n) => n.includes('cossack'))).toBe(true);
    expect(names.some((n) => n.includes('nordic'))).toBe(true);
    expect(names.filter((n) => n.includes('side plank') || n.includes('copenhagen'))).toHaveLength(1);
  }
});
it('every hip 90/90 and clamshell warm-up cue says knees track', () => {
  const items = Object.values(WARMUPS).flat().filter((e) => /90\/90|clamshell/i.test(e.name) && !/external rotation/i.test(e.name));
  expect(items.length).toBeGreaterThan(0);
  for (const e of items) expect((e.cue ?? '').toLowerCase()).toContain('knees track');
});
