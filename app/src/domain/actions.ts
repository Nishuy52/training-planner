import type { ISODate, Lift, PlannerState, RunKind, SessionRef } from './types';
import { LIFT_ORDER } from './types';
import { addDays, daysBetween, mondayOf } from './dates';
import { nextTm, tmFromTest } from './fivethreeone';
import type { BenchmarkInput } from './benchmark';
import { advanceLift, enterReentryIfDue, planDays } from './planner';
import { LIFT_LABEL } from './live';

/**
 * State transitions (spec §1–§5). `applyAction` is pure: it returns a new state and AMRAP log and
 * never changes its inputs. The planner reads the result, so the two must agree: a done Session goes
 * into `doneByDate` (keeping today's plan stable) and the pointers move exactly as `planDays` assumes.
 */

/**
 * One logged set of a lift Session: what was prescribed (rx*) next to what was done. `n` is the set number
 * within its exercise (1-based). Main sets use `exercise` = the lift; FSL and finisher sets use the exercise name.
 */
export type SetLog = {
  group: 'main' | 'fsl' | 'finisher';
  exercise: string;
  n: number;
  rxLoad?: number; rxReps?: number; rxRepsMax?: number;
  load?: number; reps?: number;
  unit: 'kg' | 'lb';
  amrap?: boolean;
  /** Rate of perceived exertion for the set, integer 1–10 (Live Session: `rpe 8`). */
  rpe?: number;
  /** Skipped in a Live Session: no load or reps. */
  skipped?: boolean;
  /** TM Test (Live Session): the top set whose load and reps are the result. */
  top?: boolean;
};

export type Action =
  | {
      type: 'done'; date: ISODate; ref: SessionRef; amrapReps?: number; sets?: SetLog[]; note?: string; benchmark?: BenchmarkInput;
      /** Live Session finished at local midnight (never from the API). */ autoFinished?: true;
    }
  | { type: 'skip'; date: ISODate; ref: SessionRef }
  | { type: 'tomorrow'; date: ISODate; ref: SessionRef }
  | { type: 'test-results'; date: ISODate; results: Partial<Record<Lift, { weight: number; reps: number }>>; plateStepKg: number }
  | { type: 'start-test-week'; dates: Record<Lift, ISODate> }
  /**
   * `correct`: replace that lift's result in the active Test Week (and its Training Max) without counting a new one;
   * it never ends the Test Week. Without it, a lift that already has a result is refused (the double-tap guard).
   */
  | { type: 'test-result'; date: ISODate; lift: Lift; weight: number; reps: number; correct?: true }
  | { type: 'set-tm'; lift: Lift; tm: number }
  | { type: 'set-history'; lastClimbDate?: ISODate | null; ruckLastCredit?: ISODate | null; lastLiftDate?: ISODate | null; ruckStep?: number }
  /** `today` (local, active timezone): an Activity dated before it is late (spec §5) and only moves the clocks. */
  | { type: 'activity'; date: ISODate; today?: ISODate; activity: { sport: 'climb' | 'run' | 'hike'; km?: number; vertM?: number; hours?: number; load?: number; packKg?: number } };

/** AMRAP reps logged per lift and Cycle week, for the current Cycle. */
export type AmrapLog = Record<Lift, Partial<Record<1 | 2 | 3, number>>>;

export const emptyAmrapLog = (): AmrapLog => ({ squat: {}, bench: {}, deadlift: {}, ohp: {} });

type RunCategory = 'easy' | 'quality' | 'long';
type Result = { state: PlannerState; amrapLog: AmrapLog; events: string[] };

/** Spec §5 Activity thresholds. */
const HIKE_RUCK_VERT_M = 600;
const HIKE_LONG_LOAD = 60;
const HIKE_LONG_HOURS = 2;
const HIKE_EASY_LOAD = 25;
const DONE_KEEP_DAYS = 14;

const runCategory = (run: RunKind): RunCategory =>
  run === 'easy' ? 'easy' : run === 'long' || run === 'ruck' ? 'long' : 'quality';

const tmEvent = (lift: Lift, from: number, to: number) => (from === to ? `TM ${lift} held at ${from}` : `TM ${lift} ${from}→${to}`);

function addDone(st: PlannerState, date: ISODate, ref: SessionRef) {
  (st.doneByDate[date] ??= []).push(ref);
}

function addRun(st: PlannerState, date: ISODate, cat: RunCategory) {
  (st.runsThisWeek[mondayOf(date)] ??= []).push(cat);
}

/**
 * Done or skip of a lift: advance the pointer (the head moves on; a swapped-in lift ahead of it is recorded in
 * `lift.ahead`); on done also log the date and AMRAP. Week 3 ends the lift's Cycle.
 */
function completeLift(r: Result, date: ISODate, ref: Extract<SessionRef, { kind: 'lift' }>, amrapReps: number | undefined, done: boolean) {
  const { state: st, amrapLog } = r;
  const { lift, week } = ref;
  enterReentryIfDue(st, date);
  advanceLift(st, lift);
  delete st.lift.notBefore;
  if (done) {
    st.lastLiftDate = date;
    addDone(st, date, ref);
    if (amrapReps !== undefined && (week === 1 || week === 2 || week === 3)) amrapLog[lift][week] = amrapReps;
  }
  // A skipped week 3 still closes the lift's Cycle; with no week-3 AMRAP logged the TM holds.
  if (week === 3) {
    const from = st.tms[lift];
    st.tms[lift] = nextTm(lift, from, amrapLog[lift]);
    amrapLog[lift] = {};
    r.events.push(tmEvent(lift, from, st.tms[lift]));
  }
}

/** Done or skip of a run: record its base kind for the week; on done also flip / credit and log the date. */
function completeRun(st: PlannerState, date: ISODate, ref: Extract<SessionRef, { kind: 'run' }>, done: boolean) {
  addRun(st, date, runCategory(ref.run));
  delete st.runNotBefore;
  if (!done) return;
  addDone(st, date, ref);
  if (ref.run === 'quality-vert' || ref.run === 'quality-speed') st.run.nextQuality = st.run.nextQuality === 'vert' ? 'speed' : 'vert';
  if (ref.run === 'benchmark-2k4' || ref.run === 'benchmark-hill') st.run.nextBenchmark = st.run.nextBenchmark === '2k4' ? 'hill' : '2k4';
  if (ref.run === 'ruck') st.ruck = { lastCredit: date, step: st.ruck.step + 1 };
}

function completeClimb(st: PlannerState, date: ISODate, ref: SessionRef) {
  if (!st.lastClimbDate || st.lastClimbDate < date) st.lastClimbDate = date;
  addDone(st, date, ref);
}

function done(r: Result, a: Extract<Action, { type: 'done' }>) {
  const st = r.state;
  switch (a.ref.kind) {
    case 'lift': return completeLift(r, a.date, a.ref, a.amrapReps, true);
    case 'run': return completeRun(st, a.date, a.ref, true);
    case 'climb': return completeClimb(st, a.date, a.ref);
    case 'travel-strength':
      st.lastLiftDate = a.date;
      delete st.lift.notBefore;
      return addDone(st, a.date, a.ref);
    case 'lift-test':
      return; // a TM Test is done by logging its result (`test-result`)
  }
}

/** Spec §2: a skipped (or deferred) TM Test moves to the next day; it is rolling. */
function moveTest(st: PlannerState, date: ISODate, lift: Lift) {
  if (st.testWeek && !st.testWeek.results[lift]) st.testWeek.dates[lift] = addDays(date, 1);
}

function skip(r: Result, a: Extract<Action, { type: 'skip' }>) {
  // Climbs and Travel Strength have no queue to advance, so skipping them changes nothing.
  if (a.ref.kind === 'lift') completeLift(r, a.date, a.ref, undefined, false);
  if (a.ref.kind === 'run') completeRun(r.state, a.date, a.ref, false);
  if (a.ref.kind === 'lift-test') moveTest(r.state, a.date, a.ref.lift);
}

function tomorrow(st: PlannerState, a: Extract<Action, { type: 'tomorrow' }>) {
  const next = addDays(a.date, 1);
  if (a.ref.kind === 'lift-test') moveTest(st, a.date, a.ref.lift);
  if (a.ref.kind === 'lift' || a.ref.kind === 'travel-strength') st.lift.notBefore = next;
  if (a.ref.kind === 'run') st.runNotBefore = next;
  // Climbs are event-driven: there is no queue to hold.
}

/** Spec §5 Activity crediting. Strength is never credited by an Activity. */
function activity(st: PlannerState, a: Extract<Action, { type: 'activity' }>) {
  const { date, activity: act } = a;
  const moveClimbClock = () => { if (!st.lastClimbDate || st.lastClimbDate < date) st.lastClimbDate = date; };
  const moveRuckClock = () => { if (!st.ruck.lastCredit || st.ruck.lastCredit < date) st.ruck.lastCredit = date; };

  // A late Activity (e.g. synced after a trip) moves the climb and Hill Ruck clocks forward only. It never
  // credits a run Session or the run queue: the athlete may already have tapped Done for that run.
  if (a.today !== undefined && date < a.today) {
    if (act.sport === 'climb') moveClimbClock();
    if (act.sport === 'hike' && (act.vertM ?? 0) >= HIKE_RUCK_VERT_M) moveRuckClock();
    return;
  }

  const planned = planDays(st, date, 1)[0].sessions.filter((s) => s.status === 'planned');

  if (act.sport === 'climb') {
    const session = planned.find((s) => s.kind === 'climb');
    if (session?.kind === 'climb') {
      return completeClimb(st, date, session.eventId ? { kind: 'climb', eventId: session.eventId } : { kind: 'climb', fallback: session.fallback });
    }
    return moveClimbClock(); // standalone climb
  }

  if (act.sport === 'run') {
    const session = planned.find((s) => s.kind === 'run');
    if (session?.kind === 'run') return completeRun(st, date, { kind: 'run', run: session.run }, true);
    // The day's run was already checked in (tapped Done): this Activity is that run, not another one.
    if ((st.doneByDate[date] ?? []).some((r) => r.kind === 'run')) return;
    const used = new Set(st.runsThisWeek[mondayOf(date)] ?? []);
    const cat = (['easy', 'quality', 'long'] as const).find((c) => !used.has(c));
    if (cat) addRun(st, date, cat);
    return;
  }

  // Hike
  const credit = (cat: RunCategory) => {
    if (!(st.runsThisWeek[mondayOf(date)] ?? []).includes(cat)) addRun(st, date, cat);
  };
  if ((act.vertM ?? 0) >= HIKE_RUCK_VERT_M) {
    moveRuckClock();
    if (act.packKg !== undefined) st.ruck.step += 1;
    credit('long');
  } else if ((act.load ?? 0) >= HIKE_LONG_LOAD || (act.hours ?? 0) >= HIKE_LONG_HOURS) {
    credit('long');
  } else if ((act.load ?? 0) >= HIKE_EASY_LOAD) {
    credit('easy');
  }
}

/**
 * Set the TMs from rep-max results and start Cycle 1 at the first lift Slot after `date`; the test
 * counts as lifting (no Re-entry). Ends any Test Week.
 */
function setTmsFromTests(r: Result, date: ISODate, results: Partial<Record<Lift, { weight: number; reps: number }>>, plateStepKg: number) {
  const st = r.state;
  for (const lift of LIFT_ORDER) {
    const res = results[lift];
    if (!res) continue;
    const from = st.tms[lift];
    st.tms[lift] = tmFromTest(res.weight, res.reps, plateStepKg);
    r.events.push(tmEvent(lift, from, st.tms[lift]));
  }
  startCycle1(r, date);
}

/** Cycle 1 week 1 from the first lift Slot after `date` (the test counts as lifting: no Re-entry); ends any Test Week. */
function startCycle1(r: Result, date: ISODate) {
  const st = r.state;
  st.lift = { week: 1, index: 0, phase: { kind: 'normal' }, notBefore: addDays(date, 1) };
  st.lastLiftDate = date;
  delete st.testWeek;
  r.amrapLog = emptyAmrapLog();
}

/** Plate step of the default Gym Profile (TM rounding). */
export function plateStep(st: PlannerState): number {
  const gym = st.gymProfiles.find((g) => g.id === st.defaultGymProfileId) ?? st.gymProfiles[0];
  return gym?.plateStepKg ?? 2.5;
}

/**
 * Spec §2 Test Week: one TM Test result sets that lift's Training Max straight away (plate step of the default Gym
 * Profile); the fourth also ends the Test Week and starts Cycle 1.
 */
function testResult(r: Result, a: Extract<Action, { type: 'test-result' }>) {
  const st = r.state;
  const tw = st.testWeek;
  if (!tw) return;
  if (a.correct) return correctTestResult(r, tw, a);
  tw.results[a.lift] = { weight: a.weight, reps: a.reps };
  addDone(st, a.date, { kind: 'lift-test', lift: a.lift });
  st.tms[a.lift] = tmFromTest(a.weight, a.reps, plateStep(st));
  const tested = LIFT_ORDER.filter((l) => tw.results[l]).length;
  r.events.push(`${LIFT_LABEL[a.lift]} ${a.weight} × ${a.reps} → Training Max ${st.tms[a.lift]} kg (${tested} of 4 tested)`);
  if (tested < LIFT_ORDER.length) return;
  startCycle1(r, a.date);
  r.events.push('All four tested: Cycle 1 starts at the next lift Slot');
}

/** A correction: the lift's result and Training Max are replaced; the tested count and the Test Week stay as they are. */
function correctTestResult(r: Result, tw: NonNullable<PlannerState['testWeek']>, a: Extract<Action, { type: 'test-result' }>) {
  const st = r.state;
  const prev = tw.results[a.lift];
  if (!prev) return;
  const from = st.tms[a.lift];
  tw.results[a.lift] = { weight: a.weight, reps: a.reps };
  st.tms[a.lift] = tmFromTest(a.weight, a.reps, plateStep(st));
  r.events.push(`${LIFT_LABEL[a.lift]} corrected: ${prev.weight} × ${prev.reps} → ${a.weight} × ${a.reps} · Training Max ${from} → ${st.tms[a.lift]} kg`);
}

/** A result whose Training Max is under this share of the median of the other tested lifts' is likely a mis-entry. */
export const LOW_TM_RATIO = 0.5;
export const LOW_TM_WARNING = "That's much lower than your other lifts — check the weight";

/**
 * What a TM Test result would do before it is saved: the Training Max it sets, and `low` when that is under
 * LOW_TM_RATIO of the median Training Max of the other lifts tested in the active Test Week (none tested: never low).
 */
export function testResultPreview(st: PlannerState, lift: Lift, weight: number, reps: number): { tm: number; low: boolean } {
  const tm = tmFromTest(weight, reps, plateStep(st));
  const others = LIFT_ORDER.filter((l) => l !== lift && st.testWeek?.results[l] && st.tms[l] > 0).map((l) => st.tms[l]).sort((x, y) => x - y);
  if (!others.length) return { tm, low: false };
  const mid = others.length >> 1;
  const median = others.length % 2 ? others[mid]! : (others[mid - 1]! + others[mid]!) / 2;
  return { tm, low: tm < LOW_TM_RATIO * median };
}

/**
 * Self-heal for Test Week results logged before each result set its TM: a lift with a result in the active Test Week
 * whose Training Max is still unset (0) gets the TM its result gives. Mutates `st`; returns the lifts it set (none on
 * a second call). Never touches a lift without a result, or one whose TM is already set (e.g. by hand).
 */
export function healTestWeekTms(st: PlannerState): Lift[] {
  const tw = st.testWeek;
  if (!tw) return [];
  const healed: Lift[] = [];
  for (const lift of LIFT_ORDER) {
    const res = tw.results[lift];
    if (!res || st.tms[lift] !== 0) continue;
    st.tms[lift] = tmFromTest(res.weight, res.reps, plateStep(st));
    if (st.tms[lift] !== 0) healed.push(lift);
  }
  return healed;
}

/** Keep only `doneByDate` entries from the last 14 days before `ref` (future dates are kept). */
function prune(st: PlannerState, ref: ISODate | undefined) {
  const today = ref ?? Object.keys(st.doneByDate).sort().at(-1);
  if (!today) return;
  for (const d of Object.keys(st.doneByDate)) {
    if (daysBetween(d, today) > DONE_KEEP_DAYS) delete st.doneByDate[d];
  }
}

export function applyAction(state: PlannerState, action: Action, amrapLog: AmrapLog): Result {
  const r: Result = { state: structuredClone(state), amrapLog: { ...emptyAmrapLog(), ...structuredClone(amrapLog) }, events: [] };
  const st = r.state;
  switch (action.type) {
    case 'done': done(r, action); break;
    case 'skip': skip(r, action); break;
    case 'tomorrow': tomorrow(st, action); break;
    case 'test-results': setTmsFromTests(r, action.date, action.results, action.plateStepKg); break;
    case 'start-test-week': st.testWeek = { dates: { ...action.dates }, results: {} }; break;
    case 'test-result': testResult(r, action); break;
    case 'set-tm':
      r.events.push(tmEvent(action.lift, st.tms[action.lift], action.tm));
      st.tms[action.lift] = action.tm;
      break;
    case 'set-history':
      if (action.lastClimbDate !== undefined) { if (action.lastClimbDate === null) delete st.lastClimbDate; else st.lastClimbDate = action.lastClimbDate; }
      if (action.lastLiftDate !== undefined) { if (action.lastLiftDate === null) delete st.lastLiftDate; else st.lastLiftDate = action.lastLiftDate; }
      if (action.ruckLastCredit !== undefined) {
        if (action.ruckLastCredit === null) delete st.ruck.lastCredit; else st.ruck.lastCredit = action.ruckLastCredit;
      }
      if (action.ruckStep !== undefined) st.ruck.step = action.ruckStep;
      break;
    case 'activity': activity(st, action); break;
  }
  prune(st, 'date' in action ? action.date : undefined);
  return r;
}
