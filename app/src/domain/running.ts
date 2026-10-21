import type { ISODate, RunKind } from './types';
import { daysBetween } from './dates';

export type WeeklyTarget = { km: number; vertM: number; deload: boolean };
export type RunRx = { km: number; vertM: number; detail: string };
export type RuckLoad = { packKg: number; vertM: number };

const START = { km: 15, vertM: 300 };
const CAP = { km: 35, vertM: 1000 };
const GROWTH = 1.1;
const DELOAD = 0.7;

const roundKm = (km: number) => Math.round(km * 2) / 2;
const roundM = (m: number) => Math.round(m / 10) * 10;

/** Run target for the run week `index` (0 = the week of runStartMonday). Every 4th week is a deload (spec §3). */
export function weeklyTarget(index: number): WeeklyTarget {
  let loading = { ...START };
  for (let i = 1; i <= index; i++) {
    if (i % 4 === 3) continue; // deload weeks don't move the loading baseline
    loading = {
      km: Math.min(CAP.km, roundKm(loading.km * GROWTH)),
      vertM: Math.min(CAP.vertM, roundM(loading.vertM * GROWTH)),
    };
  }
  if (index % 4 === 3) return { km: roundKm(loading.km * DELOAD), vertM: roundM(loading.vertM * DELOAD), deload: true };
  return { ...loading, deload: false };
}

/** Share of the weekly km and metres climbed per RunKind. Benchmarks take the Quality run's place. */
const SPLIT: Record<RunKind, { km: number; vert: number }> = {
  easy: { km: 0.3, vert: 0 },
  'quality-vert': { km: 0.25, vert: 0.4 },
  'quality-speed': { km: 0.25, vert: 0 },
  'benchmark-2k4': { km: 0.25, vert: 0 },
  'benchmark-hill': { km: 0.25, vert: 0.4 },
  long: { km: 0.45, vert: 0.6 },
  ruck: { km: 0.45, vert: 0.6 },
};

// The plan text says 6 × 400 m for weeks under 20 km, but the plan's test expects 400s at exactly
// 20 km, so that boundary is inclusive. Flagged for review.
function speedDetail(weekKm: number): string {
  const reps = weekKm <= 20 ? '6 × 400 m' : weekKm < 28 ? '5 × 600 m' : '4 × 800 m';
  return `${reps} @ 2.4 km pace, 90 s jog`;
}

const DETAIL: Partial<Record<RunKind, string>> = {
  'quality-vert': 'Hill repeats: climb hard 2–3 min, jog down',
  long: 'Trail long run — pick hilly trails',
  'benchmark-2k4': '2.4 km time trial (flat), warm up 15 min',
  'benchmark-hill': 'Hill loop Benchmark, timed',
};

/** Prescription for one run Session given the week's target. */
export function runRx(kind: RunKind, target: WeeklyTarget): RunRx {
  const split = SPLIT[kind];
  return {
    km: roundKm(target.km * split.km),
    vertM: roundM(target.vertM * split.vert),
    detail: kind === 'quality-speed' ? speedDetail(target.km) : DETAIL[kind] ?? '',
  };
}

/** Hill Ruck load at progression `step`: odd steps add 2 kg, even steps add 150 m, capped at 20 kg / 1200 m. */
export function ruckLoad(step: number): RuckLoad {
  return {
    packKg: Math.min(20, 10 + 2 * Math.ceil(step / 2)),
    vertM: Math.min(1200, 600 + 150 * Math.floor(step / 2)),
  };
}

/** A Hill Ruck is due when none has been credited, or the last credit is ≥ 21 days ago. */
export const ruckDue = (lastCredit: ISODate | undefined, date: ISODate): boolean =>
  !lastCredit || daysBetween(lastCredit, date) >= 21;
