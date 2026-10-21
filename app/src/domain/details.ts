// Session details for the plan API and Telegram messages (docs/api-contract.md, SessionDetail).
import type { CycleWeek, ClubEvent, DayPlan, GymProfile, Lift, PlannerState, RunKind } from './types';
import type { Exercise } from '../content/mobility';
import { FINISHERS, FSL } from '../content/liftExtras';
import { TRAVEL_STRENGTH } from '../content/travelStrength';
import { WARMUPS } from '../content/warmups';
import { daysBetween, mondayOf } from './dates';
import { mainSets, type SetRx } from './fivethreeone';
import { ruckLoad, runRx, weeklyTarget, type RuckLoad, type RunRx, type WeeklyTarget } from './running';
import { routeFor, routeSummary, type RouteBook, type RouteSummary } from './routes';

export type SessionDetail =
  | {
      kind: 'lift'; lift: Lift; week: CycleWeek | 'reentry'; tm: number; gymProfileId: string;
      mainSets: SetRx[]; warmup: Exercise[]; fsl: Exercise[]; lastFslWeightKg: number | null; finisher: Exercise[];
    }
  | { kind: 'lift-test'; lift: Lift; warmup: Exercise[]; protocol: string }
  | { kind: 'travel-strength'; exercises: Exercise[] }
  | {
      kind: 'run'; run: RunKind; rx: RunRx; target: WeeklyTarget;
      route: RouteSummary | null; ruckLoad?: RuckLoad;
    }
  | { kind: 'climb'; event: ClubEvent | null; fallback: boolean; finisher: string };

/** Spec §2 TM Test protocol (after the lift's warm-up). */
export const TEST_PROTOCOL =
  'Ramp: bar × 10, ~40% × 5, ~60% × 3, ~75% × 2. Then sets of 5 in 2.5–5 kg jumps to a hard 5-rep max ' +
  '(1 rep in reserve, at most 3 heavy sets). 4–8 reps on the top set is fine: log its weight and reps.';

const CLIMB_PARTNER = 'Last 30 min: endurance laps (climb, lower, straight back on)';
const CLIMB_BENCHMARK = 'Benchmark: continuous minutes on auto-belay at a fixed grade — log grade + minutes';
const CLIMB_FALLBACK = 'Boulder session @ the bouldering gym';

function resolveGym(state: PlannerState, day: DayPlan): GymProfile {
  const byId = (id: string | null) => (id ? state.gymProfiles.find((g) => g.id === id) : undefined);
  const gym = byId(day.gymProfileId) ?? byId(state.defaultGymProfileId) ?? state.gymProfiles[0];
  if (!gym) throw new Error('No Gym Profile configured');
  return gym;
}

const NO_ROUTES: RouteBook = { routes: [], assignments: [] };

/** Details index-aligned with day.sessions; Done sessions are null. Run Sessions get their Route from `routes`. */
export function buildDetails(
  state: PlannerState,
  day: DayPlan,
  lastFslWeightKg: (lift: Lift) => number | null,
  routes: RouteBook = NO_ROUTES,
): Array<SessionDetail | null> {
  return day.sessions.map((s): SessionDetail | null => {
    if (s.status === 'done') return null;
    switch (s.kind) {
      case 'lift': {
        const gym = resolveGym(state, day);
        const tm = state.tms[s.lift];
        const finisher = s.lift === 'squat' ? FINISHERS.lower[0]! : s.lift === 'deadlift' ? FINISHERS.lower[1]! : FINISHERS.upper[0]!;
        return {
          kind: 'lift', lift: s.lift, week: s.week, tm, gymProfileId: gym.id,
          mainSets: mainSets(s.lift, tm, s.week === 'reentry' ? 4 : s.week, gym),
          warmup: WARMUPS[s.lift], fsl: FSL[s.lift], lastFslWeightKg: lastFslWeightKg(s.lift), finisher,
        };
      }
      case 'lift-test':
        return { kind: 'lift-test', lift: s.lift, warmup: WARMUPS[s.lift], protocol: TEST_PROTOCOL };
      case 'travel-strength':
        return { kind: 'travel-strength', exercises: TRAVEL_STRENGTH };
      case 'run': {
        const weekIndex = Math.max(0, Math.floor(daysBetween(state.run.runStartMonday, mondayOf(day.date)) / 7));
        const target = weeklyTarget(weekIndex);
        const rx = runRx(s.run, target);
        const r = routeFor(routes, day.date, s.run);
        const route = r ? routeSummary(r) : null;
        if (s.run === 'ruck') {
          const load = ruckLoad(state.ruck.step);
          return { kind: 'run', run: s.run, rx: { ...rx, vertM: load.vertM }, target, route, ruckLoad: load };
        }
        return { kind: 'run', run: s.run, rx, target, route };
      }
      case 'climb': {
        const event = (s.eventId && state.clubEvents.find((e) => e.id === s.eventId)) || null;
        const finisher = !event ? CLIMB_FALLBACK : event.type === 'endurance_benchmark' ? CLIMB_BENCHMARK : CLIMB_PARTNER;
        return { kind: 'climb', event, fallback: !!s.fallback, finisher };
      }
    }
  });
}
