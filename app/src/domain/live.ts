// Live Session (CONTEXT.md): a lift Session or TM Test logged set by set. Pure state and transitions; the
// Durable Object (src/live/durable.ts, ADR 0004) persists it, runs the alarms and does the I/O.
import type { GymProfile, ISODate, Lift, SessionRef } from './types';
import type { SessionDetail } from './details';
import type { Exercise } from '../content/mobility';
import type { SetLog } from './actions';
import { parseDose } from './dose';

export type RestSeconds = { main: number; fsl: number; finisher: number };
/** Rest after a Logged Set, by group (editable in Settings: PUT /api/settings `restSeconds`). */
export const DEFAULT_REST: RestSeconds = { main: 180, fsl: 90, finisher: 60 };
export const REST_EXTEND_S = 30;

export type LiveRef = Extract<SessionRef, { kind: 'lift' | 'lift-test' }>;
export type LiveGroup = 'main' | 'fsl' | 'finisher' | 'test';

/** One set step: its Prescription (rx*), plus what was logged once `loggedAt` is set. */
export type LiveSet = {
  group: LiveGroup;
  exercise: string;
  n: number;
  /** Sets of this exercise in the Session (lift only; a TM Test has open-ended work-up sets). */
  of?: number;
  unit: 'kg' | 'lb';
  rxLoad?: number; rxReps?: number; rxRepsMax?: number;
  amrap?: boolean;
  /** The dose text when it is not "N x M" (e.g. "2 x 30 s/side"): the set is just ticked off. */
  dose?: string;
  loadStep: number;
  restS: number;
  load?: number; reps?: number; rpe?: number;
  skipped?: boolean;
  /** TM Test: the top set, whose load and reps are the TM Test result. */
  top?: boolean;
  loggedAt?: number;
};

export type LiveState = {
  id: string;
  date: ISODate;
  ref: LiveRef;
  tz: string;
  /** e.g. "Squat — Week 1 (5s)" or "Squat — 5-rep max test" */
  title: string;
  warmup: string[];
  warmupDone: boolean;
  /** A lift: every prescribed set. A TM Test: the work-up sets logged so far. */
  sets: LiveSet[];
  /** Reps/Load −/+ adjustments to the current set, until it is logged. */
  draft: { load?: number; reps?: number } | null;
  restEndsAt: number | null;
  restPinged: boolean;
  /** Local midnight after `date`: an open Live Session is auto-finished (or discarded) then. */
  autoFinishAt: number;
  startedAt: number;
  liftLogId: number | null;
  /** Telegram: the Live Session message (edited in place) and the "Rest over" ping. */
  messageId: number | null;
  pingMessageId: number | null;
  /** Telegram: the "▶ … started" message that carries the reply keyboard (deleted on Cancel). */
  keyboardMessageId?: number | null;
  /** The whole Live Session is paused: no rest timer, set input refused until resumed. */
  paused?: boolean;
  /** TM Test: load step and rest of each work-up set. */
  testRx?: { loadStep: number; restS: number };
  /**
   * Telegram, TM Test: the top set waiting for its confirmation (Save / Back on the Live Session message), with the
   * Training Max it will set and `low` (much lower than the other tested lifts'). Any other change clears it.
   */
  pendingTop?: { load: number; reps: number; rpe?: number; tm: number; low: boolean };
};

/** How a TM Test set is typed in Telegram (also the hint when no weight is known yet). */
export const TEST_INPUT_EXAMPLE = '100x5';

export const LIFT_LABEL: Record<Lift, string> = { squat: 'Squat', bench: 'Bench', deadlift: 'Deadlift', ohp: 'OHP' };
const WEEK_LABEL: Record<string, string> = { 1: '5s', 2: '3s', 3: '5/3/1', 4: 'deload' };

export const liveTitle = (ref: LiveRef): string =>
  ref.kind === 'lift-test'
    ? `${LIFT_LABEL[ref.lift]} — 5-rep max test`
    : `${LIFT_LABEL[ref.lift]} — ${ref.week === 'reentry' ? 'Re-entry (deload)' : `Week ${ref.week} (${WEEK_LABEL[ref.week]})`}`;

function doseText(dose: Exercise['dose']): string {
  if (typeof dose === 'string') return dose;
  const side = dose.perSide ? '/side' : '';
  return dose.type === 'hold' ? `${dose.times ? dose.times + ' x ' : ''}${dose.seconds} s${side}` : `${dose.sets ? dose.sets + ' x ' : ''}${dose.reps}${side}`;
}
const warmupItems = (list: Exercise[]) => list.map((e) => `${e.name} ${doseText(e.dose)}`);

const round2 = (x: number) => Math.round(x * 100) / 100;

/** The set steps of a lift Session: main sets, then FSL, then Finisher (each "N x M" dose expands to N sets). */
export function liftSets(det: Extract<SessionDetail, { kind: 'lift' }>, gym: GymProfile | undefined, rest: RestSeconds): LiveSet[] {
  const kgStep = gym?.plateStepKg ?? 2.5;
  const main: LiveSet[] = det.mainSets.map((x, i) => ({
    group: 'main', exercise: LIFT_LABEL[det.lift], n: i + 1, of: det.mainSets.length, unit: x.unit,
    rxLoad: x.load, rxReps: x.reps, amrap: x.amrap,
    loadStep: x.unit === 'lb' ? (gym?.machineStepLb ?? 10) : kgStep, restS: rest.main,
  }));
  const extra = (group: 'fsl' | 'finisher', list: Exercise[]): LiveSet[] =>
    list.flatMap((e, ei): LiveSet[] => {
      const d = parseDose(e.dose);
      const base = { group, exercise: e.name, unit: 'kg' as const, loadStep: kgStep, restS: rest[group] };
      const rxLoad = group === 'fsl' && ei === 0 && det.lastFslWeightKg != null ? { rxLoad: det.lastFslWeightKg } : {};
      if (!d) return [{ ...base, n: 1, of: 1, dose: doseText(e.dose) }];
      return Array.from({ length: d.sets }, (_, k) => ({
        ...base, ...rxLoad, n: k + 1, of: d.sets, rxReps: d.reps, ...(d.repsMax !== undefined ? { rxRepsMax: d.repsMax } : {}),
      }));
    });
  return [...main, ...extra('fsl', det.fsl), ...extra('finisher', det.finisher)];
}

export function newLiveState(args: {
  id: string; date: ISODate; ref: LiveRef; tz: string; detail: SessionDetail; gym: GymProfile | undefined; rest: RestSeconds; now: number; autoFinishAt: number;
}): LiveState {
  const { detail: det } = args;
  const sets = det.kind === 'lift' ? liftSets(det, args.gym, args.rest) : [];
  const warmup = det.kind === 'lift' || det.kind === 'lift-test' ? warmupItems(det.warmup) : [];
  return {
    id: args.id, date: args.date, ref: args.ref, tz: args.tz, title: liveTitle(args.ref),
    warmup, warmupDone: false, sets, draft: null, restEndsAt: null, restPinged: false,
    autoFinishAt: args.autoFinishAt, startedAt: args.now, liftLogId: null, messageId: null, pingMessageId: null,
    ...(det.kind === 'lift-test' ? { testRx: { loadStep: args.gym?.plateStepKg ?? 2.5, restS: args.rest.main } } : {}),
  };
}

const isTest = (s: LiveState) => s.ref.kind === 'lift-test';
const logged = (x: LiveSet) => x.loggedAt !== undefined;
const done = (x: LiveSet) => logged(x) && !x.skipped;

/** Index into `sets` of the set to log next; `sets.length` when a lift has every set logged, or for a TM Test's next work-up set. */
export function currentSetIndex(s: LiveState): number {
  if (isTest(s)) return s.sets.length;
  const i = s.sets.findIndex((x) => !logged(x));
  return i < 0 ? s.sets.length : i;
}

/** API step index: 0 = Warm-up, 1 + i = sets[i]. */
export const currentStep = (s: LiveState): number => (s.warmupDone ? 1 + currentSetIndex(s) : 0);

/** The step to log next (a TM Test's next work-up set is built from the lift's template), or null when a lift is complete. */
export function setAt(s: LiveState, i: number): LiveSet | null {
  if (i < 0) return null;
  if (i < s.sets.length) return s.sets[i]!;
  if (!isTest(s) || i !== s.sets.length) return null;
  return {
    group: 'test', exercise: LIFT_LABEL[s.ref.lift], n: s.sets.length + 1, unit: 'kg',
    loadStep: s.testRx?.loadStep ?? 2.5, restS: s.testRx?.restS ?? DEFAULT_REST.main,
  };
}

/** What the set's Prescription means when logged as is: rx, else the load used on the previous set of the exercise. */
function defaultsFor(s: LiveState, i: number, set: LiveSet): { load?: number; reps?: number } {
  if (isTest(s)) {
    const prev = s.sets.slice(0, i).reverse().find(done);
    // No Prescription to fall back on: the first work-up set's weight is typed (never the bar by default).
    return prev ? { load: prev.load, reps: prev.reps } : { reps: 5 };
  }
  const prevLoad = s.sets.slice(0, i).reverse().find((x) => done(x) && x.exercise === set.exercise && x.load !== undefined)?.load;
  return { load: set.rxLoad ?? prevLoad, reps: set.rxReps };
}

/** What "✓ As prescribed" / "✓ Set done" logs for the current set: the Prescription with any Reps/Load −/+ applied. */
export function pendingValues(s: LiveState): { load?: number; reps?: number } | null {
  const i = currentSetIndex(s);
  const set = setAt(s, i);
  if (!set) return null;
  return { ...defaultsFor(s, i, set), ...(s.draft ?? {}) };
}

export type LiveError = { status: 400 | 404 | 409; error: string };
const err = (status: LiveError['status'], error: string): LiveError => ({ status, error });

/** Reps −/+ or Load −/+ on the current set. */
export function adjust(s: LiveState, field: 'load' | 'reps', dir: 1 | -1): LiveError | null {
  const i = currentSetIndex(s);
  const set = setAt(s, i);
  const base = pendingValues(s);
  if (!set || !base) return err(409, 'every set is logged: finish the Live Session');
  if (set.dose !== undefined) return err(400, 'this set has no load or reps to change');
  const draft = { ...base };
  if (field === 'reps') draft.reps = Math.min(100, Math.max(0, (base.reps ?? 0) + dir));
  else draft.load = Math.min(1000, Math.max(0, round2((base.load ?? 0) + dir * set.loadStep)));
  s.draft = draft;
  s.warmupDone = true;
  return null;
}

export type LogInput = { step: number; load?: number; reps?: number; rpe?: number; skip?: boolean; top?: boolean };

/**
 * Log (or correct) one set step. Logging the current set uses its pending values for whatever the input
 * leaves out; a newly logged set (not a skip) starts the rest timer. Returns the set index logged.
 */
export function logSet(s: LiveState, input: LogInput, now: number): { index: number; newly: boolean } | LiveError {
  const i = input.step - 1;
  const cur = currentSetIndex(s);
  if (input.step === 0) return err(400, 'step 0 is the Warm-up: use warmup-done');
  const set = setAt(s, i);
  if (!set) return err(400, `step ${input.step} is not a set of this Live Session`);
  if (input.top && !isTest(s)) return err(400, 'top only applies to a TM Test');
  if (input.skip && (input.top || input.load !== undefined || input.reps !== undefined || input.rpe !== undefined)) return err(400, 'skip takes no load, reps, rpe or top');
  const newly = !logged(set);
  if (input.skip) {
    if (isTest(s)) return err(400, 'a TM Test has no sets to skip');
    delete set.load; delete set.reps; delete set.rpe;
    set.skipped = true;
  } else {
    const base = i === cur ? pendingValues(s)! : logged(set) && !set.skipped ? { load: set.load, reps: set.reps } : defaultsFor(s, i, set);
    const load = input.load ?? base.load;
    const reps = set.dose !== undefined && input.reps === undefined ? undefined : (input.reps ?? base.reps);
    if (isTest(s) && load === undefined) return err(400, `type the weight, e.g. ${TEST_INPUT_EXAMPLE}`);
    if (isTest(s) && reps === undefined) return err(400, 'a TM Test set needs load and reps');
    if (input.top && (!(load! > 0 && load! <= 500) || !(reps! >= 1 && reps! <= 15))) return err(400, 'the top set needs a load of 0–500 kg and 1–15 reps');
    delete set.skipped; delete set.load; delete set.reps;
    if (load !== undefined) set.load = load;
    if (reps !== undefined) set.reps = reps;
    if (input.rpe !== undefined) set.rpe = input.rpe;
    if (input.top) set.top = true;
  }
  if (newly) set.loggedAt = now; // a correction keeps its place in the order sets were logged
  if (i === s.sets.length) s.sets.push(set);
  if (i === cur) s.draft = null;
  s.warmupDone = true;
  if (newly && !input.skip) {
    s.restEndsAt = now + set.restS * 1000;
    s.restPinged = false;
  }
  return { index: i, newly };
}

/** `rpe 8` on its own: the RPE of the most recently logged set. */
export function setLastRpe(s: LiveState, rpe: number): LiveError | null {
  const last = s.sets.filter(done).sort((a, b) => a.loggedAt! - b.loggedAt!).at(-1);
  if (!last) return err(409, 'no Logged Set yet to put the RPE on');
  last.rpe = rpe;
  return null;
}

/** +30 s: extends a running rest, or starts a 30 s rest when none is running. */
export function extendRest(s: LiveState, seconds: number, now: number): void {
  s.restEndsAt = (s.restEndsAt !== null && s.restEndsAt > now ? s.restEndsAt : now) + seconds * 1000;
  s.restPinged = false;
}

export const loggedSetCount = (s: LiveState): number => s.sets.filter(done).length;

export type Verdict = 'met' | 'over' | 'under' | 'amrap' | 'skipped' | 'done';
const EPS = 0.01;

/**
 * Logged Set vs Prescription: under if the load or the reps fall short; met if equal; over if both are at
 * least the Prescription and one is above it (a rep range counts as met up to its top). The AMRAP set reports
 * its reps instead (unless its load fell short). A set without a Prescription is just done.
 */
export function verdict(x: LiveSet): Verdict | null {
  if (!logged(x)) return null;
  if (x.skipped) return 'skipped';
  const loadUnder = x.rxLoad !== undefined && x.load !== undefined && x.load < x.rxLoad - EPS;
  const repsUnder = x.rxReps !== undefined && x.reps !== undefined && x.reps < x.rxReps;
  if (loadUnder || (repsUnder && !x.amrap)) return 'under';
  if (x.amrap) return 'amrap';
  if (x.rxLoad === undefined && x.rxReps === undefined) return 'done';
  const loadOver = x.rxLoad !== undefined && x.load !== undefined && x.load > x.rxLoad + EPS;
  const repsOver = x.rxReps !== undefined && x.reps !== undefined && x.reps > (x.rxRepsMax ?? x.rxReps);
  return loadOver || repsOver ? 'over' : 'met';
}

/** Logged sets as SetLogs (lift_log `sets`, and the Done action's sets). */
export function toSetLogs(s: LiveState): SetLog[] {
  return s.sets.filter(logged).map((x) => {
    const out: SetLog = { group: x.group === 'test' ? 'main' : x.group, exercise: x.exercise, n: x.n, unit: x.unit };
    if (x.rxLoad !== undefined) out.rxLoad = x.rxLoad;
    if (x.rxReps !== undefined) out.rxReps = x.rxReps;
    if (x.rxRepsMax !== undefined) out.rxRepsMax = x.rxRepsMax;
    if (x.load !== undefined) out.load = x.load;
    if (x.reps !== undefined) out.reps = x.reps;
    if (x.amrap) out.amrap = true;
    if (x.rpe !== undefined) out.rpe = x.rpe;
    if (x.skipped) out.skipped = true;
    if (x.top) out.top = true;
    return out;
  });
}

/** The TM Test's top set, once logged. */
export const topSet = (s: LiveState): LiveSet | undefined => s.sets.find((x) => x.top && done(x));

// ───────────────────────── API view (docs/api-contract.md, LiveSession) ─────────────────────────

export type LiveStepView =
  | { kind: 'warmup'; items: string[]; done: boolean }
  | ({ kind: 'set'; status: Verdict | null } & Omit<LiveSet, 'loggedAt' | 'loadStep' | 'restS'> & { restSeconds: number; loadStep: number; loggedAt?: string });

export type LiveView = {
  id: string; date: ISODate; ref: LiveRef; title: string;
  steps: LiveStepView[];
  /** Step to log next. For a lift, steps.length once every set is logged; for a TM Test, steps.length is the next work-up set. */
  current: number;
  /** What ✓ logs on the current set (its Prescription with Reps/Load −/+ applied); null when nothing is left. */
  next: { load?: number; reps?: number; unit: 'kg' | 'lb'; loadStep: number } | null;
  restEndsAt: string | null;
  startedAt: string;
  autoFinishAt: string;
  loggedSets: number;
  paused: boolean;
};

export function liveView(s: LiveState): LiveView {
  const iso = (t: number) => new Date(t).toISOString();
  const steps: LiveStepView[] = [{ kind: 'warmup', items: s.warmup, done: s.warmupDone }];
  for (const x of s.sets) {
    const { loggedAt, restS, ...rest } = x;
    steps.push({ kind: 'set', ...rest, restSeconds: restS, status: verdict(x), ...(loggedAt !== undefined ? { loggedAt: iso(loggedAt) } : {}) });
  }
  const set = setAt(s, currentSetIndex(s));
  const pend = pendingValues(s);
  return {
    id: s.id, date: s.date, ref: s.ref, title: s.title, steps, current: currentStep(s),
    next: set && pend ? { ...pend, unit: set.unit, loadStep: set.loadStep } : null,
    restEndsAt: s.restEndsAt === null ? null : iso(s.restEndsAt),
    startedAt: iso(s.startedAt), autoFinishAt: iso(s.autoFinishAt), loggedSets: loggedSetCount(s), paused: !!s.paused,
  };
}

/**
 * Resume an abandoned attempt: put its Logged Sets (lift_log `sets`, or a TM Test's `testSets`) back on the steps.
 * A lift matches sets by group, exercise and set number; a TM Test takes its work-up sets in order.
 */
export function restoreSets(s: LiveState, logs: SetLog[], now: number): void {
  if (s.ref.kind === 'lift-test') {
    logs.forEach((x, i) => {
      const set = setAt(s, s.sets.length)!;
      s.sets.push({ ...set, ...(x.load !== undefined ? { load: x.load } : {}), ...(x.reps !== undefined ? { reps: x.reps } : {}), ...(x.rpe !== undefined ? { rpe: x.rpe } : {}), loggedAt: now - (logs.length - i) });
    });
  } else {
    logs.forEach((x, i) => {
      const set = s.sets.find((y) => y.group === x.group && y.exercise === x.exercise && y.n === x.n);
      if (!set) return;
      if (x.skipped) set.skipped = true;
      if (x.load !== undefined) set.load = x.load;
      if (x.reps !== undefined) set.reps = x.reps;
      if (x.rpe !== undefined) set.rpe = x.rpe;
      set.loggedAt = now - (logs.length - i);
    });
  }
  s.warmupDone = true;
}
