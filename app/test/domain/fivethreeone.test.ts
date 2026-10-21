import { describe, it, expect } from 'vitest';
import { mainSets, tmFromTest, nextTm } from '../../src/domain/fivethreeone';
import type { GymProfile } from '../../src/domain/types';

const homeGym: GymProfile = { id: 'home-gym', name: 'Home Gym', plateStepKg: 2.5, machineLifts: [], hasBands: true };
const travelGym: GymProfile = { id: 'travel-gym', name: 'Travel gym', plateStepKg: 2.5, machineLifts: ['bench', 'ohp'], machineStepLb: 10, machineMaxLb: 200, hasBands: false };

describe('mainSets', () => {
  it('week 1 percentages, AMRAP last, rounded to 2.5 kg', () => {
    expect(mainSets('squat', 100, 1, homeGym)).toEqual([
      { pct: 65, reps: 5, amrap: false, load: 65, unit: 'kg', capped: false },
      { pct: 75, reps: 5, amrap: false, load: 75, unit: 'kg', capped: false },
      { pct: 85, reps: 5, amrap: true, load: 85, unit: 'kg', capped: false },
    ]);
  });
  it('rounds to nearest plate step', () => {
    expect(mainSets('bench', 72.5, 3, homeGym).map((s) => s.load)).toEqual([55, 62.5, 70]); // 54.375, 61.6, 68.9
  });
  it('week 3 is 5/3/1+', () => expect(mainSets('ohp', 50, 3, homeGym).map((s) => [s.reps, s.amrap])).toEqual([[5, false], [3, false], [1, true]]));
  it('deload has no AMRAP', () => expect(mainSets('deadlift', 140, 4, homeGym).every((s) => !s.amrap)).toBe(true));
  it('travel-gym machine lifts convert to lb, round to 10, cap at 200', () => {
    const s = mainSets('bench', 100, 3, travelGym); // 75kg=165.3lb->170, 85kg=187.4->190, 95kg=209.4->200 capped
    expect(s.map((x) => [x.load, x.unit, x.capped])).toEqual([[170, 'lb', false], [190, 'lb', false], [200, 'lb', true]]);
  });
});

describe('tmFromTest', () => {
  it('90% of Epley e1RM, rounded down to plate step', () => {
    // 100 x 5 -> e1RM 116.67 -> 0.9 = 105 -> 105
    expect(tmFromTest(100, 5, 2.5)).toBe(105);
    // 62.5 x 6 -> 75 -> 67.5
    expect(tmFromTest(62.5, 6, 2.5)).toBe(67.5);
  });
});

describe('nextTm', () => {
  it('adds 5 kg lower / 2.5 kg upper when all AMRAP targets were hit', () => {
    expect(nextTm('squat', 100, { 1: 7, 2: 4, 3: 2 })).toBe(105);
    expect(nextTm('bench', 70, { 1: 5, 2: 3, 3: 1 })).toBe(72.5);
  });
  it('holds when any week fell short', () => expect(nextTm('deadlift', 140, { 1: 6, 2: 2, 3: 3 })).toBe(140));
  it('holds when a week is missing (skipped)', () => expect(nextTm('ohp', 50, { 1: 6, 3: 2 })).toBe(50));
});
