import type { CycleWeek, GymProfile, Lift } from './types';
import { LOWER } from './types';

/** [percent of Training Max, reps, AMRAP] per set, by Cycle week (spec §2). */
const SCHEME: Record<CycleWeek, Array<[number, number, boolean]>> = {
  1: [[65, 5, false], [75, 5, false], [85, 5, true]],
  2: [[70, 3, false], [80, 3, false], [90, 3, true]],
  3: [[75, 5, false], [85, 3, false], [95, 1, true]],
  4: [[40, 5, false], [50, 5, false], [60, 5, false]],
};

export type SetRx = { pct: number; reps: number; amrap: boolean; load: number; unit: 'kg' | 'lb'; capped: boolean };

const roundTo = (x: number, step: number) => Math.round(x / step) * step;
const KG_TO_LB = 2.20462;

export function mainSets(lift: Lift, tm: number, week: CycleWeek, gym: GymProfile): SetRx[] {
  const machine = gym.machineLifts.includes(lift);
  return SCHEME[week].map(([pct, reps, amrap]) => {
    const kg = (tm * pct) / 100;
    if (!machine) return { pct, reps, amrap, load: roundTo(kg, gym.plateStepKg), unit: 'kg', capped: false };
    const lb = roundTo(kg * KG_TO_LB, gym.machineStepLb ?? 10);
    const max = gym.machineMaxLb ?? Infinity;
    return { pct, reps, amrap, load: Math.min(lb, max), unit: 'lb', capped: lb > max };
  });
}

/** Minimum AMRAP reps per Cycle week for the Training Max to rise. */
export const AMRAP_TARGET: Record<1 | 2 | 3, number> = { 1: 5, 2: 3, 3: 1 };

/** Training Max from a rep-max test: 90% of Epley e1RM, rounded down to the plate step. */
export function tmFromTest(weight: number, reps: number, step: number): number {
  const e1rm = weight * (1 + reps / 30);
  return Math.floor((0.9 * e1rm) / step + 1e-9) * step;
}

/** Training Max after a Cycle: +5 kg lower / +2.5 kg upper only if every week's AMRAP target was met. */
export function nextTm(lift: Lift, tm: number, amraps: Partial<Record<1 | 2 | 3, number>>): number {
  const hit = ([1, 2, 3] as const).every((w) => (amraps[w] ?? -1) >= AMRAP_TARGET[w]);
  return hit ? tm + (LOWER.includes(lift) ? 5 : 2.5) : tm;
}
