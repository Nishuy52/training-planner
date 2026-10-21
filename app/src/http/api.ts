// HTTP API (docs/api-contract.md). Mounted under /api behind requireAccess.
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { Env } from '../index';
import { requireAccess } from './auth';
import type {
  ClubEvent, Constraint, DayPlan, DefaultSlotKind, DefaultWeek, GymProfile, ISODate, Lift, PlanComment, PlannerState, RunKind, SessionRef, Slot,
} from '../domain/types';
import { LIFT_ORDER } from '../domain/types';
import { applyAction, emptyAmrapLog, type Action, type AmrapLog, type SetLog } from '../domain/actions';
import { isPlanned, planDays } from '../domain/planner';
import { dayContext } from '../domain/constraints';
import { addDays, isRealIsoDate, localNow } from '../domain/dates';
import { buildDetails, type SessionDetail } from '../domain/details';
import { assignmentKey, type Route, type RouteAssignment, type RouteBook } from '../domain/routes';
import { EVENT_ID_RE } from '../telegram/format';
import {
  appendActionLog, deleteClubEvent, deleteComment, deleteConstraint, deleteRoute, getComment, getKV, isActivityUncredited, lastFslWeight,
  liftLogsFor, listComments, listRouteAssignments, listRoutes, loadPlannerState, logLift, markActivityCreditedIfCommitted, markMobility, mobilityStreak,
  putRouteAssignments, setKV, setKVIfCommitted, updateLiftLog, updateStateWithRetry, upsertClubEvent, upsertComment, upsertConstraint, upsertRoute,
} from '../store/db';
import { ALIGNMENT_RULE, DAILY_ROUTINE, MORNING_DRILLS, MORNING_DRILLS_NOTE, SELF_CHECKS } from '../content/mobility';
import { WARMUPS } from '../content/warmups';
import { FINISHERS, FSL } from '../content/liftExtras';
import { TRAVEL_STRENGTH } from '../content/travelStrength';
import { runIntervalsSync } from '../sync';
import { REST_KV, liveStub, loadRestSeconds, type LiveResult } from '../live/durable';
import type { LogInput, RestSeconds } from '../domain/live';
import { listActivities } from '../store/db';
import {
  activityBenchmarkTime, benchmarkKind, isTimeKind, parseGrade, resultFits, MAX_MINUTES, MAX_TIME_S, MIN_TIME_S, type BenchmarkInput,
} from '../domain/benchmark';
import { activityData, insertBenchmark, insertTmSnapshots, type TmReason, type TmSnapshot } from '../store/progress';
import { progressRoutes } from './progress';

// ───────────────────────── shared helpers (also used by the webhook and the cron) ─────────────────────────

/** Today's local date in the timezone that applies today (the active Constraint's, else the default). */
export function todayFor(state: Pick<PlannerState, 'defaultTimezone' | 'defaultGymProfileId' | 'constraints'>, now: Date = new Date()): ISODate {
  const tz = dayContext(state, localNow(now, state.defaultTimezone).date).timezone;
  return localNow(now, tz).date;
}

export async function loadAmrapLog(db: D1Database): Promise<AmrapLog> {
  const raw = await getKV(db, 'amrapLog');
  return { ...emptyAmrapLog(), ...(raw ? (JSON.parse(raw) as Partial<AmrapLog>) : {}) };
}

export class NotPlanned extends Error {
  constructor() { super('session is not planned for that date (already handled?)'); }
}

/**
 * `benchmarkId`: the Benchmark Results row a Benchmark Session this action completed got. `benchmarkAuto`: the time
 * an Activity that completed a run Benchmark gave it.
 */
export type ActionOutcome = {
  before: PlannerState; state: PlannerState; amrapLog: AmrapLog; events: string[];
  benchmarkId?: number; benchmarkAuto?: { kind: '2k4' | 'hill'; timeS: number };
};

/**
 * Load → applyAction → save state + amrapLog (one optimistic-concurrency write, retried on conflict) → append the
 * action log (+ lift_log for a done lift with AMRAP reps or sets). `marker`: a kv key written in the same batch as the
 * state, so a retry can tell the action already counted. `liftLogId`: a Live Session's lift_log row,
 * rewritten with the final entry instead of inserting another row.
 */
export async function performAction(db: D1Database, action: Action, opts: { liftLogId?: number; marker?: string } = {}): Promise<ActionOutcome> {
  return (await perform(db, action, undefined, opts))!;
}

/**
 * Credit a synced Activity row that was claimed with `credited: false`: the state change and `credited: true` are
 * written atomically, so a crash can neither lose the credit nor apply it twice. Returns null when the row was
 * already credited (e.g. by a concurrent sync).
 */
export async function creditActivity(db: D1Database, activityId: string, action: Extract<Action, { type: 'activity' }>): Promise<ActionOutcome | null> {
  return perform(db, action, activityId);
}

async function perform(db: D1Database, action: Action, creditActivityId?: string, opts: { liftLogId?: number; marker?: string } = {}): Promise<ActionOutcome | null> {
  const { liftLogId, marker } = opts;
  // A done lift with sets but no amrapReps: the AMRAP main set's reps feed the TM progression (API callers, Telegram).
  if (action.type === 'done' && action.ref.kind === 'lift' && action.amrapReps === undefined && action.sets) {
    const derived = amrapRepsFromSets(action.sets);
    if (derived !== undefined && derived <= MAX_AMRAP_REPS) action = { ...action, amrapReps: derived };
  }
  await loadPlannerState(db); // self-heals Test Week Training Maxes (healStoredTestWeekTms) before `before` is read
  const done = await updateStateWithRetry(db, async (before, version) => {
    if ((action.type === 'done' || action.type === 'skip' || action.type === 'tomorrow') && !isPlanned(before, action.date, action.ref)) throw new NotPlanned();
    // A TM Test result is accepted on any day while its lift is still pending (it may be logged late); a correction
    // only while the Test Week runs and the lift has a result.
    if (action.type === 'test-result') checkTestResult(before, action);
    if (action.type === 'done' && action.benchmark) checkBenchmark(before, action.ref, action.benchmark);
    // Read after the state (and its version): if another writer credits the row after this, our write conflicts and we re-check.
    if (creditActivityId !== undefined && !(await isActivityUncredited(db, creditActivityId))) return { result: null };
    // An Activity dated before today is late (spec §5); callers with their own clock (the sync) pass `today`.
    const a: Action = action.type === 'activity' && action.today === undefined ? { ...action, today: todayFor(before) } : action;
    const r = applyAction(before, a, await loadAmrapLog(db));
    const also = [setKVIfCommitted(db, 'amrapLog', JSON.stringify(r.amrapLog), version)];
    if (marker !== undefined) also.push(setKVIfCommitted(db, marker, version, version));
    if (creditActivityId !== undefined) also.push(markActivityCreditedIfCommitted(db, creditActivityId, version));
    return { state: r.state, also, result: { outcome: { before, state: r.state, amrapLog: r.amrapLog, events: r.events }, applied: a } };
  });
  if (!done) return null;
  const { applied } = done;
  const outcome: ActionOutcome = done.outcome;
  await appendActionLog(db, applied);
  // Side-writes from the committed before/after states, once (never inside the retry callback).
  Object.assign(outcome, await recordProgress(db, applied, outcome.before, outcome.state, creditActivityId));
  if (applied.type === 'done' && applied.ref.kind === 'lift' && (applied.amrapReps !== undefined || applied.sets)) {
    const entry: Record<string, unknown> = { date: applied.date, lift: applied.ref.lift, week: applied.ref.week };
    if (applied.amrapReps !== undefined) entry.amrapReps = applied.amrapReps;
    if (applied.sets) {
      entry.sets = applied.sets;
      const w = fslWeightFromSets(applied.ref.lift, applied.sets);
      if (w !== undefined) entry.fslWeightKg = w;
    }
    if (applied.type === 'done' && applied.autoFinished) entry.autoFinished = true;
    if (liftLogId !== undefined) await updateLiftLog(db, liftLogId, entry);
    else await logLift(db, applied.date, applied.ref.lift, entry);
  }
  return outcome;
}

/**
 * Record AMRAP reps for a lift's Cycle week 1 or 2 unless that week already has some (idempotent). amrapLog is written
 * with the state row's optimistic concurrency (it re-stamps the unchanged state). Resolves to the reps already
 * recorded, or undefined when these were written. Week 3 closes the Cycle at Done, so it is never back-filled.
 */
export async function recordAmrapIfMissing(db: D1Database, lift: Lift, week: 1 | 2, reps: number): Promise<number | undefined> {
  return updateStateWithRetry(db, async (current, version) => {
    const log = await loadAmrapLog(db);
    if (log[lift][week] !== undefined) return { result: log[lift][week] };
    log[lift][week] = reps;
    return { state: current, also: [setKVIfCommitted(db, 'amrapLog', JSON.stringify(log), version)], result: undefined };
  });
}

export const TEST_WEEK_OVER_HINT = 'the Test Week is over: change the Training Max in More › Training Max';

/** 409 for a duplicate result (no `correct`: the double-tap guard), or a correction with nothing to correct. */
function checkTestResult(state: PlannerState, action: Extract<Action, { type: 'test-result' }>) {
  const tw = state.testWeek;
  if (!action.correct) {
    if (!tw || tw.results[action.lift]) throw new NotPlanned();
    return;
  }
  if (!tw) throw new Conflict(TEST_WEEK_OVER_HINT);
  if (!tw.results[action.lift]) throw new Conflict(`${action.lift} has no TM Test result to correct yet`);
}

/** The date a lift's TM Test result was logged in the active Test Week (its Done entry), if still known. */
function testDateOf(state: PlannerState, lift: Lift): ISODate | undefined {
  return Object.keys(state.doneByDate).sort().reverse()
    .find((d) => state.doneByDate[d]!.some((r) => r.kind === 'lift-test' && r.lift === lift));
}

/**
 * A committed correction's side-writes, idempotent: the lift's 'test' Training Max snapshot on the original test
 * date is replaced by the corrected one (so the chart has no bogus point), and that day's TM Test lift_log row gets
 * the corrected `result` with `corrected: { from, at }` (its work-up `testSets` stay as logged).
 */
async function recordCorrection(db: D1Database, action: Extract<Action, { type: 'test-result' }>, before: PlannerState, after: PlannerState): Promise<void> {
  const { lift } = action;
  // doneByDate is pruned after 14 days; the Test Week's planned date is the next-best anchor for the original row.
  const date = testDateOf(before, lift) ?? before.testWeek?.dates[lift] ?? action.date;
  await db.batch([
    db.prepare("DELETE FROM tm_history WHERE lift = ? AND reason = 'test' AND date = ?").bind(lift, date),
    db.prepare("INSERT INTO tm_history (date, lift, tm, reason) VALUES (?, ?, ?, 'test')").bind(date, lift, after.tms[lift]),
  ]);
  const from = before.testWeek?.results[lift];
  const row = (await liftLogsFor(db, date, lift)).filter((r) => r.test === true && !r.live && !r.abandoned && !r.notCounted).at(-1);
  if (!row || !from) return;
  const { id, ...rest } = row;
  // Keep the originally logged result across repeated corrections.
  const original = (rest.corrected as { from?: unknown } | undefined)?.from ?? from;
  await updateLiftLog(db, id, { ...rest, result: { weight: action.weight, reps: action.reps }, corrected: { from: original, at: new Date().toISOString() } });
}

/** 400 unless `result` fits the Session: a time for the run Benchmarks, grade + minutes for the auto-belay. */
function checkBenchmark(state: PlannerState, ref: SessionRef, result: BenchmarkInput) {
  const kind = benchmarkKind(ref, state.clubEvents);
  if (!kind) bad('benchmark only applies to a Benchmark Session (2.4 km, hill loop, or an endurance_benchmark Club Event)');
  else if (!resultFits(kind, result)) bad(kind === 'autobelay' ? 'the auto-belay Benchmark takes grade and minutes' : 'a run Benchmark takes timeS');
}

/**
 * Progress records for a committed action: a TM snapshot per changed Training Max; for the Sessions it completed, an
 * `activity-credit` log entry (when an Activity did it, for Adherence) and a Benchmark Results row per Benchmark
 * Session. Returns the last Benchmark row's id.
 */
async function recordProgress(
  db: D1Database, action: Action, before: PlannerState, after: PlannerState, creditActivityId?: string,
): Promise<Pick<ActionOutcome, 'benchmarkId' | 'benchmarkAuto'>> {
  if (action.type === 'test-result' && action.correct) {
    await recordCorrection(db, action, before, after);
    return {};
  }
  await insertTmSnapshots(db, tmSnapshots(before, after, action));
  if (!('date' in action)) return {};
  const newlyDone = (after.doneByDate[action.date] ?? []).slice((before.doneByDate[action.date] ?? []).length);
  if (action.type === 'activity' && newlyDone.length) await appendActionLog(db, { type: 'activity-credit', date: action.date, refs: newlyDone });
  const out: Pick<ActionOutcome, 'benchmarkId' | 'benchmarkAuto'> = {};
  for (const ref of newlyDone) {
    const kind = benchmarkKind(ref, before.clubEvents);
    if (!kind) continue;
    let result: BenchmarkInput | undefined = action.type === 'done' ? action.benchmark : undefined;
    let auto = false;
    // An Activity that completes a run Benchmark gives it its time, when it looks like the Benchmark (spec: no Done follows).
    if (action.type === 'activity' && isTimeKind(kind)) {
      const recorded = creditActivityId !== undefined ? await activityData(db, creditActivityId) : null;
      const t = activityBenchmarkTime(kind, { ...action.activity, ...(recorded ?? {}) });
      if (t !== null) {
        result = { timeS: t };
        auto = true;
        out.benchmarkAuto = { kind, timeS: t };
      }
    }
    out.benchmarkId = await insertBenchmark(db, action.date, kind, ref.kind === 'climb' ? ref.eventId : undefined, result, auto);
  }
  return out;
}

/** A Training Max snapshot per lift whose TM the action changed: a Cycle completion, a TM Test or a manual set. */
function tmSnapshots(before: PlannerState, after: PlannerState, action: Action): TmSnapshot[] {
  const reason: TmReason = action.type === 'set-tm' ? 'manual' : action.type === 'test-result' || action.type === 'test-results' ? 'test' : 'cycle';
  const date = 'date' in action ? action.date : todayFor(before);
  return LIFT_ORDER.filter((l) => after.tms[l] !== before.tms[l]).map((lift) => ({ date, lift, tm: after.tms[lift], reason }));
}

const MAX_AMRAP_REPS = 30;
const MAX_FSL_WEIGHT_KG = 500;

/** Reps of the AMRAP main set (the first main set flagged `amrap` with whole-number reps), if logged. */
export function amrapRepsFromSets(sets: SetLog[]): number | undefined {
  const s = sets.find((x) => x.group === 'main' && x.amrap === true && x.reps !== undefined && Number.isInteger(x.reps));
  return s?.reps;
}

/**
 * The next Session's FSL Prescription (lastFslWeight): the heaviest kg load logged on the lift's first FSL exercise
 * (the DB variation; bench/OHP's chin-up / row never count). Max, not first, so a warm-up-light first set does not
 * lower the prescription. Undefined when none was logged or it exceeds the POST /api/lift-log cap.
 */
export function fslWeightFromSets(lift: Lift, sets: SetLog[]): number | undefined {
  const name = FSL[lift][0]!.name;
  const loads = sets.filter((x) => x.group === 'fsl' && x.exercise === name && x.unit === 'kg' && x.load !== undefined).map((x) => x.load!);
  if (loads.length === 0) return undefined;
  const w = Math.max(...loads);
  return w <= MAX_FSL_WEIGHT_KG ? w : undefined;
}

/** Plan `n` days from `from`, with SessionDetails (including each run's Route) index-aligned with each day's sessions. */
export async function planWithDetails(db: D1Database, state: PlannerState, from: ISODate, n: number): Promise<{ days: DayPlan[]; details: Record<ISODate, Array<SessionDetail | null>>; routes: RouteBook }> {
  const [fsl, routes, assignments] = await Promise.all([
    Promise.all(LIFT_ORDER.map(async (l) => [l, await lastFslWeight(db, l)] as const)).then((e) => Object.fromEntries(e) as Record<Lift, number | null>),
    listRoutes(db),
    listRouteAssignments(db, from, addDays(from, n - 1)),
  ]);
  const book: RouteBook = { routes, assignments };
  const days = planDays(state, from, n);
  const details: Record<ISODate, Array<SessionDetail | null>> = {};
  for (const d of days) details[d.date] = buildDetails(state, d, (l) => fsl[l], book);
  return { days, details, routes: book };
}

// ───────────────────────── validation ─────────────────────────

export class BadRequest extends Error {}
export class Conflict extends Error {}
export const bad = (msg: string): never => { throw new BadRequest(msg); };

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
export const obj = (v: unknown, what: string): Obj => (isObj(v) ? v : bad(`${what} must be an object`));

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const RUN_KINDS: RunKind[] = ['easy', 'quality-vert', 'quality-speed', 'long', 'ruck', 'benchmark-2k4', 'benchmark-hill'];
const SLOT_KINDS: DefaultSlotKind[] = ['lift', 'run', 'run-long'];
const MAX_GYM_PROFILES = 20;

export function isoDate(v: unknown, what: string): ISODate {
  return isRealIsoDate(v) ? v : bad(`${what} must be a valid date YYYY-MM-DD`);
}

export function num(v: unknown, what: string, min: number, max: number, opts: { int?: boolean; exclusiveMin?: boolean } = {}): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return bad(`${what} must be a number`);
  if (opts.int && !Number.isInteger(v)) bad(`${what} must be a whole number`);
  if (v < min || v > max || (opts.exclusiveMin && v === min)) bad(`${what} must be between ${min} and ${max}`);
  return v;
}
const optNum = (v: unknown, what: string, min: number, max: number, opts?: { int?: boolean; exclusiveMin?: boolean }) =>
  v === undefined ? undefined : num(v, what, min, max, opts);

function str(v: unknown, what: string, maxLen: number): string {
  if (typeof v !== 'string' || v.trim() === '') return bad(`${what} must be a non-empty string`);
  if (v.length > maxLen) bad(`${what} is too long (max ${maxLen})`);
  return v;
}
const optStr = (v: unknown, what: string, maxLen: number) => (v === undefined ? undefined : str(v, what, maxLen));

function bool(v: unknown, what: string): boolean | undefined {
  if (v === undefined) return undefined;
  return typeof v === 'boolean' ? v : bad(`${what} must be true or false`);
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[], what: string): T {
  return allowed.includes(v as T) ? (v as T) : bad(`${what} must be one of ${allowed.join(', ')}`);
}

function timezone(v: unknown, what: string): string {
  const tz = str(v, what, 64);
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
  } catch {
    bad(`${what} is not a known IANA timezone`);
  }
  return tz;
}

function sessionRef(v: unknown): SessionRef {
  const r = obj(v, 'ref');
  switch (r.kind) {
    case 'lift': {
      const week = r.week === 'reentry' ? 'reentry' : (num(r.week, 'ref.week', 1, 4, { int: true }) as 1 | 2 | 3 | 4);
      return { kind: 'lift', lift: oneOf(r.lift, LIFT_ORDER, 'ref.lift'), week };
    }
    case 'lift-test': return { kind: 'lift-test', lift: oneOf(r.lift, LIFT_ORDER, 'ref.lift') };
    case 'travel-strength': return { kind: 'travel-strength' };
    case 'run': return { kind: 'run', run: oneOf(r.run, RUN_KINDS, 'ref.run') };
    case 'climb': {
      const ref: SessionRef = { kind: 'climb' };
      if (r.eventId !== undefined) {
        if (typeof r.eventId !== 'string' || !EVENT_ID_RE.test(r.eventId)) bad('ref.eventId is invalid');
        ref.eventId = r.eventId as string;
      }
      const fb = bool(r.fallback, 'ref.fallback');
      if (fb !== undefined) ref.fallback = fb;
      return ref;
    }
    default: return bad('ref.kind must be lift, lift-test, travel-strength, run or climb');
  }
}

const SET_GROUPS = ['main', 'fsl', 'finisher'] as const;
const MAX_SETS = 60;

function parseSets(v: unknown): SetLog[] {
  if (!Array.isArray(v)) return bad('sets must be an array');
  if (v.length === 0) bad('sets must not be empty');
  if (v.length > MAX_SETS) bad(`sets: at most ${MAX_SETS} entries`);
  return v.map((raw, i) => {
    const what = (k: string) => `sets[${i}].${k}`;
    const x = obj(raw, `sets[${i}]`);
    const out: SetLog = {
      group: oneOf(x.group, SET_GROUPS, what('group')),
      exercise: str(x.exercise, what('exercise'), 80),
      n: num(x.n, what('n'), 1, 20, { int: true }),
      unit: oneOf(x.unit, ['kg', 'lb'] as const, what('unit')),
    };
    const rxLoad = optNum(x.rxLoad, what('rxLoad'), 0, 1000);
    if (rxLoad !== undefined) out.rxLoad = rxLoad;
    const rxReps = optNum(x.rxReps, what('rxReps'), 0, 100, { int: true });
    if (rxReps !== undefined) out.rxReps = rxReps;
    const rxRepsMax = optNum(x.rxRepsMax, what('rxRepsMax'), 0, 100, { int: true });
    if (rxRepsMax !== undefined) out.rxRepsMax = rxRepsMax;
    const load = optNum(x.load, what('load'), 0, 1000);
    if (load !== undefined) out.load = load;
    const reps = optNum(x.reps, what('reps'), 0, 100, { int: true });
    if (reps !== undefined) out.reps = reps;
    const amrap = bool(x.amrap, what('amrap'));
    if (amrap !== undefined) out.amrap = amrap;
    const rpe = optNum(x.rpe, what('rpe'), 1, 10, { int: true });
    if (rpe !== undefined) out.rpe = rpe;
    const skipped = bool(x.skipped, what('skipped'));
    if (skipped !== undefined) out.skipped = skipped;
    return out;
  });
}

export function parseAction(v: unknown): Action {
  const a = obj(v, 'action');
  switch (a.type) {
    case 'done': {
      const out: Action = { type: 'done', date: isoDate(a.date, 'date'), ref: sessionRef(a.ref) };
      if (out.ref.kind === 'lift-test') bad('a TM Test is done with a test-result action (weight and reps)');
      const reps = optNum(a.amrapReps, 'amrapReps', 0, 30, { int: true });
      if (reps !== undefined) {
        if (out.ref.kind !== 'lift') bad('amrapReps only applies to a lift');
        out.amrapReps = reps;
      }
      if (a.sets !== undefined) {
        if (out.ref.kind !== 'lift') bad('sets only applies to a lift');
        out.sets = parseSets(a.sets);
        const derived = amrapRepsFromSets(out.sets);
        if (derived !== undefined) {
          if (out.amrapReps === undefined) num(derived, "the AMRAP set's reps", 0, MAX_AMRAP_REPS, { int: true });
          else if (derived !== out.amrapReps) bad("amrapReps does not match the AMRAP set's reps");
        }
      }
      const note = optStr(a.note, 'note', 1000);
      if (note !== undefined) out.note = note;
      if (a.benchmark !== undefined) {
        const r = out.ref;
        if (!(r.kind === 'climb' || (r.kind === 'run' && r.run.startsWith('benchmark-')))) bad('benchmark only applies to a Benchmark Session');
        out.benchmark = parseBenchmarkInput(a.benchmark, 'benchmark');
      }
      return out;
    }
    case 'skip':
    case 'tomorrow':
      return { type: a.type, date: isoDate(a.date, 'date'), ref: sessionRef(a.ref) };
    case 'test-results': {
      const res = obj(a.results, 'results');
      const results: Partial<Record<Lift, { weight: number; reps: number }>> = {};
      for (const [k, val] of Object.entries(res)) {
        const lift = oneOf(k, LIFT_ORDER, 'results key');
        const r = obj(val, `results.${lift}`);
        results[lift] = {
          weight: num(r.weight, `results.${lift}.weight`, 0, 500, { exclusiveMin: true }),
          reps: num(r.reps, `results.${lift}.reps`, 1, 30, { int: true }),
        };
      }
      if (Object.keys(results).length === 0) bad('results must contain at least one lift');
      return { type: 'test-results', date: isoDate(a.date, 'date'), results, plateStepKg: num(a.plateStepKg, 'plateStepKg', 0, 50, { exclusiveMin: true }) };
    }
    case 'start-test-week': {
      const d = obj(a.dates, 'dates');
      for (const k of Object.keys(d)) oneOf(k, LIFT_ORDER, 'dates key');
      const dates = Object.fromEntries(LIFT_ORDER.map((l) => [l, isoDate(d[l], `dates.${l}`)])) as Record<Lift, ISODate>;
      return { type: 'start-test-week', dates };
    }
    case 'test-result':
      return {
        type: 'test-result', date: isoDate(a.date, 'date'), lift: oneOf(a.lift, LIFT_ORDER, 'lift'),
        weight: num(a.weight, 'weight', 0, 500, { exclusiveMin: true }),
        reps: num(a.reps, 'reps', 1, 15, { int: true }),
        ...(a.correct === undefined || a.correct === false ? {} : a.correct === true ? { correct: true as const } : bad('correct must be true or false')),
      };
    case 'set-tm':
      return { type: 'set-tm', lift: oneOf(a.lift, LIFT_ORDER, 'lift'), tm: num(a.tm, 'tm', 0, 500) };
    case 'set-history': {
      const out: Extract<Action, { type: 'set-history' }> = { type: 'set-history' };
      for (const k of ['lastClimbDate', 'ruckLastCredit', 'lastLiftDate'] as const) {
        if (a[k] === undefined) continue;
        out[k] = a[k] === null ? null : isoDate(a[k], k);
      }
      const step = optNum(a.ruckStep, 'ruckStep', 0, 20, { int: true });
      if (step !== undefined) out.ruckStep = step;
      return out;
    }
    case 'activity': {
      const act = obj(a.activity, 'activity');
      const activity: Extract<Action, { type: 'activity' }>['activity'] = { sport: oneOf(act.sport, ['climb', 'run', 'hike'] as const, 'activity.sport') };
      const fields: Array<[keyof typeof activity, number]> = [['km', 1000], ['vertM', 20000], ['hours', 48], ['load', 1000], ['packKg', 100]];
      for (const [k, max] of fields) {
        const n = optNum(act[k], `activity.${k}`, 0, max);
        if (n !== undefined) (activity as Record<string, unknown>)[k] = n;
      }
      return { type: 'activity', date: isoDate(a.date, 'date'), activity };
    }
    default: return bad('type must be done, skip, tomorrow, test-results, start-test-week, test-result, set-tm, set-history or activity');
  }
}

/** `{ timeS }` (whole seconds, 1 min–4 h) or `{ grade, minutes }` (French grade, whole minutes 1–240). */
export function parseBenchmarkInput(v: unknown, what: string): BenchmarkInput {
  const b = obj(v, what);
  if (b.timeS !== undefined) {
    if (b.grade !== undefined || b.minutes !== undefined) bad(`${what}: give timeS, or grade and minutes, not both`);
    return { timeS: num(b.timeS, `${what}.timeS`, MIN_TIME_S, MAX_TIME_S, { int: true }) };
  }
  const grade = typeof b.grade === 'string' ? parseGrade(b.grade) : null;
  if (!grade) return bad(`${what}.grade must be a French grade such as 6a+ (or give timeS)`);
  return { grade, minutes: num(b.minutes, `${what}.minutes`, 1, MAX_MINUTES, { int: true }) };
}

function parseConstraint(v: unknown, state: PlannerState): Constraint {
  const c = obj(v, 'constraint');
  const out: Record<string, unknown> = {
    id: ID_RE.test(String(c.id ?? '')) && typeof c.id === 'string' ? c.id : bad('id must be 1-64 letters, digits, _ or -'),
    start: isoDate(c.start, 'start'),
    end: isoDate(c.end, 'end'),
  };
  if ((out.end as string) < (out.start as string)) bad('end must be on or after start');
  if (c.timezone !== undefined) out.timezone = timezone(c.timezone, 'timezone');
  if (c.gymProfileId === null) out.gymProfileId = null;
  else if (c.gymProfileId !== undefined) {
    if (!state.gymProfiles.some((g) => g.id === c.gymProfileId)) bad('gymProfileId does not match a Gym Profile');
    out.gymProfileId = c.gymProfileId;
  }
  for (const k of ['noGym', 'mountain', 'travelDays'] as const) {
    const b = bool(c[k], k);
    if (b !== undefined) out[k] = b;
  }
  const note = optStr(c.note, 'note', 500);
  if (note !== undefined) out.note = note;
  const location = optStr(c.location, 'location', MAX_LOCATION);
  if (location !== undefined) out.location = location;
  return out as Constraint;
}

const MAX_LOCATION = 100;
const ROUTE_ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const routeId = (v: unknown, what = 'id'): string => (typeof v === 'string' && ROUTE_ID_RE.test(v) ? v : bad(`${what} must be 1-40 letters, digits, _ or -`));

function httpsUrl(v: unknown, what: string): string {
  const s = str(v, what, 500);
  let u: URL | undefined;
  try { u = new URL(s); } catch { /* reported below */ }
  if (!u || u.protocol !== 'https:') bad(`${what} must be an https:// URL`);
  return s;
}

/** Validates a Route (Plan 3 A1); unknown keys are dropped. */
function parseRoute(v: unknown): Route {
  const r = obj(v, 'route');
  if (!Array.isArray(r.suits)) bad('suits must be an array of run kinds');
  const out: Route = {
    id: routeId(r.id),
    name: str(r.name, 'name', 100),
    area: str(r.area, 'area', MAX_LOCATION),
    km: num(r.km, 'km', 0, 100),
    vertM: num(r.vertM, 'vertM', 0, 5000),
    kind: oneOf(r.kind, ['loop', 'repeat'] as const, 'kind'),
    suits: [...new Set((r.suits as unknown[]).map((k) => oneOf(k, RUN_KINDS, 'suits[]')))],
  };
  const repeats = optNum(r.repeats, 'repeats', 1, 50, { int: true });
  if (repeats !== undefined) out.repeats = repeats;
  if (r.url !== undefined) out.url = httpsUrl(r.url, 'url');
  if (r.benchmark !== undefined) out.benchmark = oneOf(r.benchmark, ['hill', '2k4'] as const, 'benchmark');
  const notes = optStr(r.notes, 'notes', 500);
  if (notes !== undefined) out.notes = notes;
  return out;
}

const MAX_ASSIGNMENTS = 30;

/** `{ assignments: [{ date, runKind, routeId | null }] }`, at most 30; `ruck` is stored as `long`. */
function parseAssignments(v: unknown): Array<Omit<RouteAssignment, 'routeId'> & { routeId: string | null }> {
  const b = obj(v, 'body');
  if (!Array.isArray(b.assignments)) return bad('assignments must be an array');
  if (b.assignments.length > MAX_ASSIGNMENTS) bad(`assignments: at most ${MAX_ASSIGNMENTS} entries`);
  return (b.assignments as unknown[]).map((raw, i) => {
    const a = obj(raw, `assignments[${i}]`);
    return {
      date: isoDate(a.date, `assignments[${i}].date`),
      runKind: assignmentKey(oneOf(a.runKind, RUN_KINDS, `assignments[${i}].runKind`)),
      routeId: a.routeId === null ? null : routeId(a.routeId, `assignments[${i}].routeId`),
    };
  });
}

function parseClubEvent(v: unknown): ClubEvent {
  const e = obj(v, 'club event');
  if (typeof e.id !== 'string' || !EVENT_ID_RE.test(e.id) || e.id === 'fb') bad('id must be 1-36 letters, digits, _ or - (not "fb")');
  if (typeof e.time !== 'string' || !TIME_RE.test(e.time)) bad('time must be HH:MM');
  return {
    id: e.id as string,
    date: isoDate(e.date, 'date'),
    time: e.time as string,
    title: str(e.title, 'title', 200),
    venue: str(e.venue, 'venue', 200),
    type: oneOf(e.type, ['partner', 'endurance_benchmark'] as const, 'type'),
  };
}

const COMMENT_STATUSES = ['open', 'addressed'] as const;
const SESSION_KEY_RE = /^[a-z0-9:-]{1,40}$/;
const commentId = (v: unknown): string => (typeof v === 'string' && ID_RE.test(v) ? v : bad('id must be 1-64 letters, digits, _ or -'));

/** Validates a comment body; server-set fields (status default, timestamps) are filled in by the route. */
function parseComment(v: unknown): Omit<PlanComment, 'status' | 'createdAt' | 'updatedAt'> & { status?: PlanComment['status'] } {
  const c = obj(v, 'comment');
  const out: ReturnType<typeof parseComment> = {
    id: commentId(c.id),
    date: isoDate(c.date, 'date'),
    text: str(typeof c.text === 'string' ? c.text.trim() : c.text, 'text', 1000),
  };
  if (c.session !== undefined) {
    const s = obj(c.session, 'session');
    if (typeof s.key !== 'string' || !SESSION_KEY_RE.test(s.key)) bad('session.key must be 1-40 lowercase letters, digits, : or -');
    out.session = { key: s.key as string, label: str(s.label, 'session.label', 80) };
  }
  if (c.status !== undefined) out.status = oneOf(c.status, COMMENT_STATUSES, 'status');
  const resolution = optStr(c.resolution, 'resolution', 1000);
  if (resolution !== undefined) out.resolution = resolution;
  return out;
}

function parseGymProfile(v: unknown, i: number): GymProfile {
  const g = obj(v, `gymProfiles[${i}]`);
  const what = (k: string) => `gymProfiles[${i}].${k}`;
  if (typeof g.id !== 'string' || !ID_RE.test(g.id)) bad(`${what('id')} must be 1-64 letters, digits, _ or -`);
  if (!Array.isArray(g.machineLifts)) bad(`${what('machineLifts')} must be an array`);
  const p: GymProfile = {
    id: g.id as string,
    name: str(g.name, what('name'), 100),
    plateStepKg: num(g.plateStepKg, what('plateStepKg'), 0, 50, { exclusiveMin: true }),
    machineLifts: [...new Set((g.machineLifts as unknown[]).map((l) => oneOf(l, LIFT_ORDER, what('machineLifts[]'))))],
    hasBands: bool(g.hasBands, what('hasBands')) ?? bad(`${what('hasBands')} is required`),
  };
  const step = optNum(g.machineStepLb, what('machineStepLb'), 0, 100, { exclusiveMin: true });
  const max = optNum(g.machineMaxLb, what('machineMaxLb'), 0, 1000, { exclusiveMin: true });
  if (step !== undefined) p.machineStepLb = step;
  if (max !== undefined) p.machineMaxLb = max;
  return p;
}

function parseDefaultWeek(v: unknown): DefaultWeek {
  const w = obj(v, 'defaultWeek');
  for (const k of Object.keys(w)) if (!/^[0-6]$/.test(k)) bad('defaultWeek keys must be "0"-"6"');
  const out = {} as DefaultWeek;
  for (const d of [0, 1, 2, 3, 4, 5, 6] as const) {
    const day = w[String(d)] === undefined ? {} : obj(w[String(d)], `defaultWeek.${d}`);
    const slots: Partial<Record<Slot, DefaultSlotKind>> = {};
    for (const k of Object.keys(day)) {
      const slot = oneOf(k, ['am', 'pm'] as const, `defaultWeek.${d} slot`);
      if (day[k] === undefined || day[k] === null || day[k] === '') continue;
      slots[slot] = oneOf(day[k], SLOT_KINDS, `defaultWeek.${d}.${slot}`);
    }
    out[d] = slots;
  }
  return out;
}

async function body(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return bad('body must be JSON');
  }
}

export function daysParam(raw: string | undefined, dflt: number, max: number, what = 'days'): number {
  if (raw === undefined) return dflt;
  if (!/^\d+$/.test(raw)) return bad(`${what} must be a whole number`);
  return num(Number(raw), what, 1, max, { int: true });
}

// ───────────────────────── routes ─────────────────────────

type MobilityEntry = { date: ISODate; status: 'done' | 'skipped' };

async function mobilityView(db: D1Database, today: ISODate, days: number) {
  const { results } = await db.prepare('SELECT date, status FROM mobility_log WHERE date > ? AND date <= ? ORDER BY date')
    .bind(addDays(today, -days), today).all<MobilityEntry>();
  return { log: results, streak: await mobilityStreak(db, today) };
}

async function readSelfChecks(db: D1Database): Promise<Record<string, ISODate>> {
  const raw = await getKV(db, 'selfChecks');
  return raw ? (JSON.parse(raw) as Record<string, ISODate>) : {};
}

export const api = new Hono<{ Bindings: Env }>();

/**
 * CSRF guard for state-changing requests. The Access cookie (CF_Authorization) is SameSite=None, so a
 * cross-site page could otherwise make the browser send an authenticated write. Two independent checks:
 *  - Fetch Metadata: a browser-sent Sec-Fetch-Site other than same-origin/none (user-initiated) is refused.
 *    Absent header (older browsers, non-browser clients) falls through to the next check.
 *  - Bodied writes must be Content-Type application/json: HTML forms can only send urlencoded, multipart
 *    or text/plain, and a cross-origin fetch with application/json needs a CORS preflight we never grant.
 * DELETE carries no body; it is not a CORS-safelisted method, so cross-origin it always needs a preflight.
 */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const ALLOWED_FETCH_SITES = new Set(['same-origin', 'none']);
export const csrfGuard: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const method = c.req.method.toUpperCase();
  if (SAFE_METHODS.has(method)) return next();
  const site = c.req.header('Sec-Fetch-Site');
  if (site !== undefined && !ALLOWED_FETCH_SITES.has(site.trim().toLowerCase())) return c.json({ error: 'forbidden' }, 403);
  if (method !== 'DELETE') {
    const mediaType = (c.req.header('Content-Type') ?? '').split(';', 1)[0]!.trim().toLowerCase();
    if (mediaType !== 'application/json') return c.json({ error: 'Content-Type must be application/json' }, 415);
  }
  return next();
};

export const MAX_BODY_BYTES = 64 * 1024;

// Must be registered before every /api route (health included): Access first, then CSRF, then size.
api.use('/api/*', requireAccess);
api.use('/api/*', csrfGuard);
api.use('/api/*', bodyLimit({ maxSize: MAX_BODY_BYTES, onError: (c) => c.json({ error: 'body too large (max 64 KB)' }, 413) }));

api.onError((err, c) => {
  if (err instanceof BadRequest) return c.json({ error: err.message }, 400);
  if (err instanceof NotPlanned || err instanceof Conflict) return c.json({ error: err.message }, 409);
  console.error('api error:', err instanceof Error ? err.message : String(err));
  return c.json({ error: 'internal error' }, 500);
});

api.get('/api/health', (c) => c.json({ ok: true }));

api.get('/api/plan', async (c) => {
  const db = c.env.DB;
  const n = daysParam(c.req.query('days'), 14, 100);
  const fromQ = c.req.query('from');
  const state = await loadPlannerState(db);
  const from = fromQ === undefined ? todayFor(state) : isoDate(fromQ, 'from');
  return c.json(await planWithDetails(db, state, from, n));
});

api.get('/api/state', async (c) => {
  const db = c.env.DB;
  const state = await loadPlannerState(db);
  return c.json({ ...state, amrapLog: await loadAmrapLog(db), restSeconds: await loadRestSeconds(db) });
});

api.post('/api/action', async (c) => {
  const action = parseAction(await body(c.req.raw));
  const { state, events } = await performAction(c.env.DB, action);
  return c.json({ state, events });
});

// Manual intervals.icu sync: runs now, ignoring the hourly gate.
api.post('/api/sync', async (c) => {
  const r = await runIntervalsSync(c.env, new Date(), { force: true });
  if (r.error) return c.json({ error: 'intervals.icu sync failed' }, 502);
  return c.json(r);
});

// Activities (intervals.icu sync and Telegram /log) for the weekly km / metres-climbed totals.
api.get('/api/activities', async (c) => {
  const db = c.env.DB;
  const days = daysParam(c.req.query('days'), 60, 400);
  const today = todayFor(await loadPlannerState(db));
  return c.json({ entries: await listActivities(db, addDays(today, 1 - days)) });
});

progressRoutes(api);

api.get('/api/lift-log', async (c) => {
  const { results } = await c.env.DB.prepare('SELECT date, lift, json FROM lift_log ORDER BY date DESC, id DESC LIMIT 200')
    .all<{ date: ISODate; lift: Lift; json: string }>();
  return c.json({ entries: results.map((r) => ({ ...(JSON.parse(r.json) as object), date: r.date, lift: r.lift })) });
});

api.post('/api/lift-log', async (c) => {
  const b = obj(await body(c.req.raw), 'body');
  const date = isoDate(b.date, 'date');
  const lift = oneOf(b.lift, LIFT_ORDER, 'lift');
  const entry: Record<string, unknown> = { date, lift };
  const w = optNum(b.fslWeightKg, 'fslWeightKg', 0, 500);
  if (w !== undefined) entry.fslWeightKg = w;
  const notes = optStr(b.notes, 'notes', 1000);
  if (notes !== undefined) entry.notes = notes;
  await logLift(c.env.DB, date, lift, entry);
  return c.json({ ok: true });
});

api.get('/api/constraints', async (c) => c.json((await loadPlannerState(c.env.DB)).constraints));

api.post('/api/constraints', async (c) => {
  const db = c.env.DB;
  const con = parseConstraint(await body(c.req.raw), await loadPlannerState(db));
  await upsertConstraint(db, con);
  await appendActionLog(db, { type: 'constraint-upsert', constraint: con });
  return c.json(con);
});

api.delete('/api/constraints/:id', async (c) => {
  const id = c.req.param('id');
  await deleteConstraint(c.env.DB, id);
  await appendActionLog(c.env.DB, { type: 'constraint-delete', id });
  return c.json({ ok: true });
});

api.get('/api/club-events', async (c) => c.json((await loadPlannerState(c.env.DB)).clubEvents));

api.post('/api/club-events', async (c) => {
  const ev = parseClubEvent(await body(c.req.raw));
  await upsertClubEvent(c.env.DB, ev);
  await appendActionLog(c.env.DB, { type: 'club-event-upsert', event: ev });
  return c.json(ev);
});

api.delete('/api/club-events/:id', async (c) => {
  const id = c.req.param('id');
  await deleteClubEvent(c.env.DB, id);
  await appendActionLog(c.env.DB, { type: 'club-event-delete', id });
  return c.json({ ok: true });
});

api.get('/api/comments', async (c) => {
  const q = (k: string) => c.req.query(k);
  const from = q('from') === undefined ? undefined : isoDate(q('from'), 'from');
  const to = q('to') === undefined ? undefined : isoDate(q('to'), 'to');
  const status = q('status') === undefined ? undefined : oneOf(q('status'), COMMENT_STATUSES, 'status');
  return c.json({ comments: await listComments(c.env.DB, { from, to, status }) });
});

api.post('/api/comments', async (c) => {
  const db = c.env.DB;
  const { status, ...input } = parseComment(await body(c.req.raw));
  const prev = await getComment(db, input.id);
  const now = new Date().toISOString();
  const comment: PlanComment = {
    ...input,
    status: status ?? prev?.status ?? 'open',
    createdAt: prev?.createdAt ?? now,
    updatedAt: now,
  };
  await upsertComment(db, comment);
  await appendActionLog(db, { type: 'comment-upsert', comment });
  return c.json(comment);
});

api.delete('/api/comments/:id', async (c) => {
  const id = commentId(c.req.param('id'));
  await deleteComment(c.env.DB, id);
  await appendActionLog(c.env.DB, { type: 'comment-delete', id });
  return c.json({ ok: true });
});

// Routes (Plan 3): the library, Route Assignments, and the context the weekly routine picks Routes from.
api.get('/api/routes', async (c) => c.json({ routes: await listRoutes(c.env.DB) }));

api.post('/api/routes', async (c) => {
  const db = c.env.DB;
  const route = parseRoute(await body(c.req.raw));
  if (route.benchmark) {
    const holder = (await listRoutes(db)).find((r) => r.benchmark === route.benchmark && r.id !== route.id);
    if (holder) throw new Conflict(`"${holder.name}" is already the ${route.benchmark} Benchmark Route; a Benchmark stays fixed`);
  }
  await upsertRoute(db, route);
  await appendActionLog(db, { type: 'route-upsert', route });
  return c.json(route);
});

api.delete('/api/routes/:id', async (c) => {
  const id = routeId(c.req.param('id'));
  await deleteRoute(c.env.DB, id);
  await appendActionLog(c.env.DB, { type: 'route-delete', id });
  return c.json({ ok: true });
});

api.put('/api/route-assignments', async (c) => {
  const db = c.env.DB;
  const assignments = parseAssignments(await body(c.req.raw));
  const known = new Set((await listRoutes(db)).map((r) => r.id));
  assignments.forEach((a, i) => { if (a.routeId !== null && !known.has(a.routeId)) bad(`assignments[${i}].routeId does not match a Route`); });
  await putRouteAssignments(db, assignments);
  await appendActionLog(db, { type: 'route-assignments', assignments });
  return c.json({ assignments });
});

/**
 * The next `days` days for the weekly Route routine. Planned from today and sliced: planDays restarts the rotation at
 * `from`, so only a plan from today shows the real Sessions.
 */
api.get('/api/routing-context', async (c) => {
  const db = c.env.DB;
  const n = daysParam(c.req.query('days'), 8, 14);
  const state = await loadPlannerState(db);
  const { days, details, routes } = await planWithDetails(db, state, todayFor(state), n);
  return c.json({
    days: days.map((d) => ({
      date: d.date,
      location: dayContext(state, d.date).location,
      timezone: d.timezone,
      mountain: d.mountain,
      travel: d.travel ?? null,
      runs: d.sessions.flatMap((s, i) => {
        const det = details[d.date]![i];
        if (s.kind !== 'run' || s.status !== 'planned' || det?.kind !== 'run') return [];
        return [{ runKind: s.run, km: det.rx.km, vertM: det.rx.vertM, detail: det.rx.detail, routeId: det.route?.id ?? null }];
      }),
    })),
    library: routes.routes,
  });
});

api.get('/api/mobility', async (c) => {
  const db = c.env.DB;
  const days = daysParam(c.req.query('days'), 30, 400);
  return c.json(await mobilityView(db, todayFor(await loadPlannerState(db)), days));
});

api.post('/api/mobility', async (c) => {
  const db = c.env.DB;
  const b = obj(await body(c.req.raw), 'body');
  const date = isoDate(b.date, 'date');
  const status = oneOf(b.status, ['done', 'skipped'] as const, 'status');
  await markMobility(db, date, status);
  const today = todayFor(await loadPlannerState(db));
  return c.json(await mobilityView(db, date > today ? date : today, 30));
});

api.get('/api/self-checks', async (c) => c.json(await readSelfChecks(c.env.DB)));

api.post('/api/self-checks', async (c) => {
  const db = c.env.DB;
  const b = obj(await body(c.req.raw), 'body');
  const name = oneOf(b.name, SELF_CHECKS.map((s) => s.name), 'name');
  const date = isoDate(b.date, 'date');
  const checks = { ...(await readSelfChecks(db)), [name]: date };
  await setKV(db, 'selfChecks', JSON.stringify(checks));
  return c.json(checks);
});

const REST_GROUPS = ['main', 'fsl', 'finisher'] as const;

/** `restSeconds`: partial { main, fsl, finisher }, whole seconds 15–900. */
function parseRestSeconds(v: unknown, current: RestSeconds): RestSeconds {
  const r = obj(v, 'restSeconds');
  for (const k of Object.keys(r)) oneOf(k, REST_GROUPS, 'restSeconds key');
  const out = { ...current };
  for (const k of REST_GROUPS) {
    const n = optNum(r[k], `restSeconds.${k}`, 15, 900, { int: true });
    if (n !== undefined) out[k] = n;
  }
  return out;
}

api.put('/api/settings', async (c) => {
  const db = c.env.DB;
  const b = obj(await body(c.req.raw), 'body');
  // Rest timer defaults live in kv, not the PlannerState: validated before any write, saved after the state.
  const rest = b.restSeconds === undefined ? undefined : parseRestSeconds(b.restSeconds, await loadRestSeconds(db));
  const { next, applied } = await updateStateWithRetry(db, (state) => {
    const next: PlannerState = { ...state };
    // Only validated fields are applied and logged; unknown keys in the body are dropped.
    const applied: Partial<Pick<PlannerState, 'defaultWeek' | 'defaultTimezone' | 'gymProfiles' | 'defaultGymProfileId' | 'rucksEnabled' | 'homeLocation'>> = {};
    if (b.defaultWeek !== undefined) next.defaultWeek = applied.defaultWeek = parseDefaultWeek(b.defaultWeek);
    if (b.defaultTimezone !== undefined) next.defaultTimezone = applied.defaultTimezone = timezone(b.defaultTimezone, 'defaultTimezone');
    if (b.gymProfiles !== undefined) {
      if (!Array.isArray(b.gymProfiles) || b.gymProfiles.length === 0) bad('gymProfiles must be a non-empty array');
      if ((b.gymProfiles as unknown[]).length > MAX_GYM_PROFILES) bad(`gymProfiles may have at most ${MAX_GYM_PROFILES} entries`);
      const profiles = (b.gymProfiles as unknown[]).map(parseGymProfile);
      if (new Set(profiles.map((p) => p.id)).size !== profiles.length) bad('gymProfiles ids must be unique');
      next.gymProfiles = applied.gymProfiles = profiles;
    }
    if (b.defaultGymProfileId !== undefined) next.defaultGymProfileId = applied.defaultGymProfileId = str(b.defaultGymProfileId, 'defaultGymProfileId', 64);
    if (b.rucksEnabled !== undefined) {
      if (typeof b.rucksEnabled !== 'boolean') return bad('rucksEnabled must be a boolean');
      next.rucksEnabled = applied.rucksEnabled = b.rucksEnabled;
    }
    if (b.homeLocation !== undefined) next.homeLocation = applied.homeLocation = str(b.homeLocation, 'homeLocation', MAX_LOCATION).trim();
    if (!next.gymProfiles.some((g) => g.id === next.defaultGymProfileId)) bad('defaultGymProfileId does not match a Gym Profile');
    return { state: next, result: { next, applied } };
  });
  if (rest) await setKV(db, REST_KV, JSON.stringify(rest));
  await appendActionLog(db, { type: 'settings', settings: rest ? { ...applied, restSeconds: rest } : applied });
  return c.json({ ...next, restSeconds: rest ?? (await loadRestSeconds(db)) });
});

// ───────────────────────── Live Session (ADR 0004): one at a time, held by the LIVE Durable Object ─────────────────────────

async function liveReply(c: Context<{ Bindings: Env }>, r: Promise<LiveResult>) {
  const res = await r;
  if (!res.ok) return c.json({ error: res.error, ...(res.resumable ? { resumable: true } : {}) }, res.status);
  const { ok: _ok, ...out } = res;
  return c.json(out);
}

const MAX_STEP = 200;

api.get('/api/live', (c) => liveReply(c, liveStub(c.env).view()));

api.post('/api/live/start', async (c) => {
  const b = obj(await body(c.req.raw), 'body');
  const date = isoDate(b.date, 'date');
  const ref = sessionRef(b.ref);
  if (ref.kind !== 'lift' && ref.kind !== 'lift-test') bad('ref must be a lift Session or a TM Test');
  const mode = b.mode === undefined ? undefined : oneOf(b.mode, ['resume', 'fresh'] as const, 'mode');
  return liveReply(c, liveStub(c.env).start(date, ref, mode));
});

api.post('/api/live/log', async (c) => {
  const b = obj(await body(c.req.raw), 'body');
  const input: LogInput = { step: num(b.step, 'step', 1, MAX_STEP, { int: true }) };
  const load = optNum(b.load, 'load', 0, 1000);
  if (load !== undefined) input.load = load;
  const reps = optNum(b.reps, 'reps', 0, 100, { int: true });
  if (reps !== undefined) input.reps = reps;
  const rpe = optNum(b.rpe, 'rpe', 1, 10, { int: true });
  if (rpe !== undefined) input.rpe = rpe;
  if (bool(b.skip, 'skip')) input.skip = true;
  if (bool(b.top, 'top')) input.top = true;
  if (input.skip && (load !== undefined || reps !== undefined || rpe !== undefined || input.top)) bad('skip takes no load, reps, rpe or top');
  return liveReply(c, liveStub(c.env).log(input));
});

api.post('/api/live/rest', async (c) => {
  const b = obj(await body(c.req.raw), 'body');
  if (b.stop === true) {
    if (b.addSeconds !== undefined) bad('send addSeconds or stop, not both');
    return liveReply(c, liveStub(c.env).stopRest());
  }
  return liveReply(c, liveStub(c.env).rest(num(b.addSeconds, 'addSeconds', 1, 900, { int: true })));
});

api.post('/api/live/warmup-done', (c) => liveReply(c, liveStub(c.env).warmupDone()));
api.post('/api/live/finish', (c) => liveReply(c, liveStub(c.env).finish()));
api.post('/api/live/abandon', (c) => liveReply(c, liveStub(c.env).abandon()));
api.post('/api/live/cancel', (c) => liveReply(c, liveStub(c.env).cancel()));
api.post('/api/live/pause', (c) => liveReply(c, liveStub(c.env).pause()));
api.post('/api/live/resume', (c) => liveReply(c, liveStub(c.env).resume()));

api.get('/api/content', (c) =>
  c.json({
    alignmentRule: ALIGNMENT_RULE,
    dailyRoutine: DAILY_ROUTINE,
    morningDrills: MORNING_DRILLS,
    morningDrillsNote: MORNING_DRILLS_NOTE,
    selfChecks: SELF_CHECKS,
    warmups: WARMUPS,
    fsl: FSL,
    finishers: FINISHERS,
    travelStrength: TRAVEL_STRENGTH,
  }),
);

api.all('/api/*', (c) => c.json({ error: 'not found' }, 404));
