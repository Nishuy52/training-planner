import type { PlannerState } from '../../src/domain/types';
export const HOME_WEEK = {
  0: { am: 'lift' }, 1: { am: 'run' }, 2: { am: 'run' }, 3: { am: 'lift' },
  4: {}, 5: { am: 'run-long' }, 6: { am: 'lift' },
} as const;
export function baseState(over: Partial<PlannerState> = {}): PlannerState {
  return {
    tms: { squat: 100, bench: 70, deadlift: 130, ohp: 45 },
    lift: { week: 1, index: 0, phase: { kind: 'normal' } },
    lastLiftDate: '2026-10-06',
    run: { nextQuality: 'vert', nextBenchmark: '2k4', runStartMonday: '2026-10-05' },
    ruck: { lastCredit: '2026-09-15', step: 0 }, // ruck due on Sat 10 Oct
    rucksEnabled: true, // explicit: the planner/ruck fixtures exercise Hill Rucks
    lastClimbDate: '2026-10-02',
    runsThisWeek: {}, doneByDate: {},
    defaultWeek: HOME_WEEK as any,
    gymProfiles: [{ id: 'home-gym', name: 'Home Gym', plateStepKg: 2.5, machineLifts: [], hasBands: true }],
    defaultGymProfileId: 'home-gym', defaultTimezone: 'Europe/Berlin', homeLocation: 'Hometown',
    constraints: [], clubEvents: [],
    ...over,
  };
}
