import type { CycleWeek, DayPlan, DefaultSlotKind, ISODate, Lift, LiftPhase, PlannedSession, PlannerState, RunKind, SessionRef, Slot } from './types';
import { LIFT_ORDER, LOWER } from './types';
import { addDays, daysBetween, mondayOf, weekday } from './dates';
import { dayContext, type DayContext } from './constraints';
import { ruckDue, weeklyTarget } from './running';

/**
 * Rolling Sequence planner (spec §1–§4).
 *
 * `planDays` is a pure simulation: it walks day by day from `from`, placing Sessions into the
 * Default Week's Slots. It keeps a working copy of the queue pointers and advances it as if every
 * placed Session gets done, so later days show what follows. `state` itself is never changed.
 */

type RunCategory = 'easy' | 'quality' | 'long';
/** The week's run categories, in placement order: at most one of each per ISO week. */
export const RUN_ORDER: RunCategory[] = ['easy', 'quality', 'long'];
const SLOTS: Slot[] = ['am', 'pm'];

/** The simulation's working copy of everything placement advances. */
type Work = {
  lift: { week: CycleWeek; index: number; phase: LiftPhase; ahead?: Lift[] };
  lastLiftDate?: ISODate;
  nextQuality: 'vert' | 'speed';
  nextBenchmark: '2k4' | 'hill';
  ruckLastCredit?: ISODate;
  lastClimbDate?: ISODate;
  /** Run categories placed by the simulation, keyed by ISO Monday */
  placedRuns: Record<ISODate, RunCategory[]>;
  /** Test Week: TM Tests not yet placed, in placement order (planned date, then lift order). */
  tests: Array<{ lift: Lift; date: ISODate }>;
};

/** A day under construction. */
type Day = { date: ISODate; ctx: DayContext; sessions: PlannedSession[]; notes: string[] };

const isFree = (day: Day, slot: Slot) => !day.sessions.some((s) => s.slot === slot);
const otherSlot = (slot: Slot): Slot => (slot === 'am' ? 'pm' : 'am');

const runCategory = (run: RunKind): RunCategory =>
  run === 'easy' ? 'easy' : run === 'long' || run === 'ruck' ? 'long' : 'quality';

const defaultSlots = (state: PlannerState, d: ISODate) => state.defaultWeek[weekday(d)] ?? {};
const liftSlot = (state: PlannerState, d: ISODate) => SLOTS.find((s) => defaultSlots(state, d)[s] === 'lift');

/** Spec §1: a done Session keeps the Default Week Slot of its kind (climbs: pm), else am if free, else pm; a taken Slot yields to the other. */
function doneSlot(state: PlannerState, day: Day, ref: SessionRef): Slot {
  if (ref.kind === 'climb') return 'pm';
  if (ref.kind === 'lift-test') return isFree(day, 'am') ? 'am' : 'pm';
  const kinds: DefaultSlotKind[] =
    ref.kind === 'run' ? (runCategory(ref.run) === 'long' ? ['run-long', 'run'] : ['run', 'run-long']) : ['lift'];
  const slots = defaultSlots(state, day.date);
  for (const k of kinds) {
    const s = SLOTS.find((slot) => slots[slot] === k);
    if (s) return isFree(day, s) || !isFree(day, otherSlot(s)) ? s : otherSlot(s);
  }
  return isFree(day, 'am') ? 'am' : 'pm';
}

function placeDone(state: PlannerState, day: Day) {
  for (const ref of state.doneByDate[day.date] ?? []) {
    day.sessions.push({ ...ref, slot: doneSlot(state, day, ref), status: 'done' });
  }
}

/** Spec §4 Boulder Fallback is only placed at home. */
const atHome = (state: PlannerState, ctx: DayContext) =>
  !ctx.noGym && !ctx.mountain && !ctx.travel && ctx.timezone === state.defaultTimezone;

/**
 * Spec §4: Club Events always in pm; when pm is taken, the event becomes a note. A Boulder Fallback
 * after 7 climb-free days with no (plannable) Club Event in the next 2 days, at home only. Mountain days
 * plan no climbs at all (a Club Event there becomes a "Skipped" note) and reset the clock.
 */
function placeClimbs(state: PlannerState, work: Work, day: Day) {
  const d = day.date;
  const doneEventIds = new Set(day.sessions.flatMap((s) => (s.kind === 'climb' && s.eventId ? [s.eventId] : [])));
  const events = state.clubEvents.filter((ev) => ev.date === d && !doneEventIds.has(ev.id)).sort((a, b) => a.time.localeCompare(b.time));
  if (day.ctx.mountain) {
    for (const ev of events) day.notes.push(`Skipped: ${ev.venue} ${ev.time} (mountain day)`);
    if (!work.lastClimbDate || work.lastClimbDate < d) work.lastClimbDate = d;
    return;
  }
  for (const ev of events) {
    if (isFree(day, 'pm')) day.sessions.push({ kind: 'climb', eventId: ev.id, slot: 'pm', status: 'planned' });
    else day.notes.push(`Also: ${ev.venue} ${ev.time}`);
    work.lastClimbDate = d;
  }
  const hasClimb = day.sessions.some((s) => s.kind === 'climb');
  const climbDue = !work.lastClimbDate || daysBetween(work.lastClimbDate, d) >= 7;
  const eventSoon = [addDays(d, 1), addDays(d, 2)].some((e) => state.clubEvents.some((ev) => ev.date === e) && !dayContext(state, e).mountain);
  if (!hasClimb && climbDue && !eventSoon && isFree(day, 'pm') && atHome(state, day.ctx)) {
    day.sessions.push({ kind: 'climb', fallback: true, slot: 'pm', status: 'planned' });
    work.lastClimbDate = d;
  }
}

/** Runs are placed unless it is a mountain day or an Arrival Day. */
export const runsAllowed = (ctx: DayContext) => !ctx.mountain && ctx.travel !== 'arrival';

/** A lift (or Travel Strength on a no-gym day) can be placed: runs allowed and not a Travel Day (planDays + placeLift). */
export const liftAllowed = (ctx: DayContext) => runsAllowed(ctx) && !ctx.travel;

/** Is there a run-long Slot on a day that allows runs from `d` to the end of its ISO week? */
function runLongSlotRemains(state: PlannerState, d: ISODate): boolean {
  for (let e = d; mondayOf(e) === mondayOf(d); e = addDays(e, 1)) {
    const slots = defaultSlots(state, e);
    if (SLOTS.some((s) => slots[s] === 'run-long') && runsAllowed(dayContext(state, e))) return true;
  }
  return false;
}

function resolveRun(state: PlannerState, work: Work, cat: RunCategory, day: Day): RunKind {
  const d = day.date;
  if (cat === 'easy') return 'easy';
  if (cat === 'long') {
    // Departure Day: no Hill Ruck; a plain Long instead, and the ruck stays due.
    if (!state.rucksEnabled || !ruckDue(work.ruckLastCredit, d) || day.ctx.travel === 'departure') return 'long';
    work.ruckLastCredit = d;
    return 'ruck';
  }
  const runWeek = Math.max(0, Math.floor(daysBetween(state.run.runStartMonday, mondayOf(d)) / 7));
  if (weeklyTarget(runWeek).deload) {
    const b = work.nextBenchmark;
    work.nextBenchmark = b === '2k4' ? 'hill' : '2k4';
    return `benchmark-${b}`;
  }
  const q = work.nextQuality;
  work.nextQuality = q === 'vert' ? 'speed' : 'vert';
  return `quality-${q}`;
}

/**
 * Spec §1/§3: runs roll within the ISO week; Long only in a run-long Slot unless none remains.
 * A run goes in its Default Slot; if another Session already holds it, the day's other Slot if free.
 */
function placeRuns(state: PlannerState, work: Work, day: Day) {
  const d = day.date;
  if (state.runNotBefore && state.runNotBefore > d) return;
  const monday = mondayOf(d);
  const slots = defaultSlots(state, d);
  for (const defaultSlot of SLOTS) {
    const kind = slots[defaultSlot];
    if (kind !== 'run' && kind !== 'run-long') continue;
    const occupant = day.sessions.find((s) => s.slot === defaultSlot);
    if (occupant?.kind === 'run') continue; // this Slot's run is already there (done)
    const slot = !occupant ? defaultSlot : isFree(day, otherSlot(defaultSlot)) ? otherSlot(defaultSlot) : undefined;
    if (!slot) continue;
    const used = new Set<RunCategory>([
      ...(state.runsThisWeek[monday] ?? []),
      ...(work.placedRuns[monday] ?? []),
      ...day.sessions.flatMap((s) => (s.kind === 'run' ? [runCategory(s.run)] : [])),
    ]);
    const remaining = RUN_ORDER.filter((c) => !used.has(c));
    const cat =
      kind === 'run-long'
        ? remaining.includes('long') ? 'long' : remaining[0]
        : remaining.find((c) => c !== 'long') ?? (remaining.includes('long') && !runLongSlotRemains(state, d) ? 'long' : undefined);
    if (!cat) continue;
    day.sessions.push({ kind: 'run', run: resolveRun(state, work, cat, day), slot, status: 'planned' });
    (work.placedRuns[monday] ??= []).push(cat);
  }
}

/**
 * Spec §2 Test Week: at most one TM Test a day, in the AM Slot (pm if am is taken). A test whose date
 * has passed is still pending and rolls to the next day it can go, one per day, in lift order.
 * Not on mountain, no-gym or Travel Days (it needs the gym).
 */
function placeTest(state: PlannerState, work: Work, day: Day) {
  if (!state.testWeek || work.tests.length === 0) return;
  if (day.ctx.mountain || day.ctx.noGym || day.ctx.travel) return;
  if (day.sessions.some((s) => s.kind === 'lift-test')) return; // one a day, done ones included
  const i = work.tests.findIndex((t) => t.date <= day.date);
  const slot = SLOTS.find((s) => isFree(day, s));
  if (i < 0 || !slot) return;
  day.sessions.push({ kind: 'lift-test', lift: work.tests[i]!.lift, slot, status: 'planned' });
  work.tests.splice(i, 1);
}

/** Pending TM Tests (no result yet) ordered by planned date, then lift order. */
function pendingTests(state: PlannerState): Work['tests'] {
  const tw = state.testWeek;
  if (!tw) return [];
  return LIFT_ORDER.filter((l) => !tw.results[l])
    .map((lift) => ({ lift, date: tw.dates[lift] }))
    .sort((a, b) => a.date.localeCompare(b.date) || LIFT_ORDER.indexOf(a.lift) - LIFT_ORDER.indexOf(b.lift));
}

/** Steps 2–5 of one day: done Sessions, TM Tests, climbs, and (unless a mountain or Arrival Day) runs. */
function planDayUpToRuns(state: PlannerState, work: Work, d: ISODate): Day {
  const day: Day = { date: d, ctx: dayContext(state, d), sessions: [], notes: [] };
  placeDone(state, day);
  placeTest(state, work, day);
  placeClimbs(state, work, day);
  if (runsAllowed(day.ctx)) placeRuns(state, work, day);
  return day;
}

/** A Quality, Long, Hill Ruck or Benchmark: anything but an Easy run. */
const hasHardRun = (sessions: SessionRef[]) => sessions.some((s) => s.kind === 'run' && s.run !== 'easy');

type LiftPointer = Work['lift'];

/** The head's position in the current round: Re-entry sessions done, else the lift index. */
const position = (l: LiftPointer) => (l.phase.kind === 'reentry' ? l.phase.done : l.index);

/**
 * The current round's lifts already done ahead of the head. A Re-entry Week keeps its own record in its phase, so the
 * normal round's `lift.ahead` survives it untouched and applies again when the Cycle resumes.
 */
const roundAhead = (l: LiftPointer): Lift[] => (l.phase.kind === 'reentry' ? l.phase.ahead : l.ahead) ?? [];

function setRoundAhead(l: LiftPointer, ahead: Lift[]) {
  if (l.phase.kind === 'reentry') l.phase = ahead.length ? { kind: 'reentry', done: l.phase.done, ahead } : { kind: 'reentry', done: l.phase.done };
  else if (ahead.length) l.ahead = ahead;
  else delete l.ahead;
}

/** One step of the pointer. The end of a Re-entry Week drops its record; wrapping into the next Cycle week clears `ahead`. */
function step(l: LiftPointer) {
  if (l.phase.kind === 'reentry') {
    const done = l.phase.done + 1;
    l.phase = done >= LIFT_ORDER.length ? { kind: 'normal' } : { ...l.phase, done };
    return;
  }
  l.index += 1;
  if (l.index >= LIFT_ORDER.length) {
    l.index = 0;
    l.week = ((l.week % 4) + 1) as CycleWeek;
    delete l.ahead;
  }
}

/**
 * Advance the lift pointer for one done or skipped lift Session (spec §2). Shared with `applyAction` so planner and
 * actions agree. The head (or no `lift`) moves the position on, past any lifts already done ahead of it; a lift of the
 * current round after the head (a leg-block swap) is recorded as done ahead and the head stays.
 */
export function advanceLift(work: { lift: LiftPointer }, lift?: Lift) {
  const l = work.lift;
  const at = position(l);
  if (lift && lift !== LIFT_ORDER[at]) {
    const ahead = roundAhead(l);
    if (LIFT_ORDER.indexOf(lift) > at && !ahead.includes(lift)) setRoundAhead(l, [...ahead, lift]);
    return;
  }
  step(l);
  for (let next = LIFT_ORDER[position(l)]!; roundAhead(l).includes(next); next = LIFT_ORDER[position(l)]!) {
    setRoundAhead(l, roundAhead(l).filter((x) => x !== next));
    step(l);
  }
}

/**
 * Spec §2 Re-entry Week: a normal-phase head after >= 7 days without lifting starts one (a fresh round with its own
 * record; the normal round's `ahead` waits for the Cycle to resume). Shared with `applyAction`.
 */
export function enterReentryIfDue(w: { lift: LiftPointer; lastLiftDate?: ISODate }, date: ISODate) {
  if (w.lift.phase.kind === 'normal' && w.lastLiftDate && daysBetween(w.lastLiftDate, date) >= 7) {
    w.lift.phase = { kind: 'reentry', done: 0 };
  }
}

function head(work: Work): { lift: Lift; week: CycleWeek | 'reentry' } {
  const { phase, week } = work.lift;
  return { lift: LIFT_ORDER[position(work.lift)]!, week: phase.kind === 'reentry' ? 'reentry' : week };
}

/**
 * Spec §1: the Slot a lift goes in. The Default Week lift Slot if free; on a day with a climb (always pm) the am Slot
 * if free; on a day with an Easy run (planned or done) the day's other Slot if free. The last two apply whether or not
 * the day has a lift Slot. Runs are placed before lifts, so the week's Easy run is already on its day.
 */
function liftSlotFor(state: PlannerState, day: Day): Slot | undefined {
  const slot = liftSlot(state, day.date);
  if (slot && isFree(day, slot)) return slot;
  if (day.sessions.some((s) => s.kind === 'climb') && isFree(day, 'am')) return 'am';
  const easy = day.sessions.find((s) => s.kind === 'run' && s.run === 'easy');
  if (easy && isFree(day, otherSlot(easy.slot))) return otherSlot(easy.slot);
  return undefined;
}

/**
 * Spec §1/§2: the lift queue head in the day's lift Slot, Travel Strength on no_gym days, Re-entry Week. Legs
 * (squat / deadlift) are blocked in a Slot after a run that day and on the day after a hard run (`prevHard`); then the
 * next upper-body lift of the current round goes in instead and the leg lift stays the head. With none left (stuck),
 * a block by an Easy run that day alone yields and the leg lift goes in; otherwise the Slot stays empty.
 */
function placeLift(state: PlannerState, work: Work, day: Day, prevHard: boolean) {
  const d = day.date;
  if (state.testWeek) return; // spec §2: no regular lift Sessions (nor Travel Strength) during a Test Week
  const slot = liftSlotFor(state, day);
  if (!slot) return;
  if (!liftAllowed(day.ctx)) return; // Travel Days: no lift, no Travel Strength; the lift waits
  if (day.sessions.some((s) => s.kind === 'lift' || s.kind === 'travel-strength')) return;
  if (state.lift.notBefore && state.lift.notBefore > d) return;

  if (day.ctx.noGym) {
    day.sessions.push({ kind: 'travel-strength', slot, status: 'planned' });
    work.lastLiftDate = d;
    return;
  }

  enterReentryIfDue(work, d);
  const h = head(work);
  let lift: Lift | undefined = h.lift;
  const amRun = slot === 'pm' ? day.sessions.find((s) => s.slot === 'am' && s.kind === 'run') : undefined;
  if (LOWER.includes(lift) && (amRun || prevHard)) {
    const swap = LIFT_ORDER.slice(position(work.lift) + 1).find((l) => !LOWER.includes(l) && !roundAhead(work.lift).includes(l));
    const easyOnly = !prevHard && amRun?.kind === 'run' && amRun.run === 'easy';
    if (swap) lift = swap;
    else if (!easyOnly) return;
  }

  day.sessions.push({ kind: 'lift', lift, week: h.week, slot, status: 'planned' });
  work.lastLiftDate = d;
  advanceLift(work, lift);
}

/** The simulation's starting point: the queue pointers as stored. */
function startWork(state: PlannerState): Work {
  const { phase, ahead } = state.lift;
  return {
    lift: {
      week: state.lift.week, index: state.lift.index,
      phase: phase.kind === 'reentry' && phase.ahead ? { ...phase, ahead: [...phase.ahead] } : { ...phase },
      ...(ahead?.length ? { ahead: [...ahead] } : {}),
    },
    lastLiftDate: state.lastLiftDate,
    nextQuality: state.run.nextQuality,
    nextBenchmark: state.run.nextBenchmark,
    ruckLastCredit: state.ruck.lastCredit,
    lastClimbDate: state.lastClimbDate,
    placedRuns: {},
    tests: pendingTests(state),
  };
}

export function planDays(state: PlannerState, from: ISODate, n: number): DayPlan[] {
  const work = startWork(state);
  // The day before `from` is past: only a done hard run there blocks legs.
  let prevHard = hasHardRun(state.doneByDate[addDays(from, -1)] ?? []);
  const plans: DayPlan[] = [];
  for (let i = 0; i < n; i++) {
    const d = addDays(from, i);
    const day = planDayUpToRuns(state, work, d);
    if (runsAllowed(day.ctx)) placeLift(state, work, day, prevHard);
    prevHard = hasHardRun(day.sessions);
    const sessions = [...day.sessions].sort((a, b) => SLOTS.indexOf(a.slot) - SLOTS.indexOf(b.slot));
    plans.push({
      date: d, timezone: day.ctx.timezone, gymProfileId: day.ctx.gymProfileId,
      mountain: day.ctx.mountain, noGym: day.ctx.noGym, note: day.ctx.note,
      ...(day.ctx.travel ? { travel: day.ctx.travel } : {}),
      ...(day.notes.length ? { notes: day.notes } : {}),
      sessions,
    });
  }
  return plans;
}

/** Stable identity of a session ref (ignores fields that do not identify the session). */
export const refKey = (r: SessionRef): string => {
  const x = r as Partial<{ kind: string; lift: string; week: unknown; run: string; eventId: string; fallback: boolean }>;
  return [x.kind, x.lift ?? '', x.week ?? '', x.run ?? '', x.eventId ?? '', x.fallback ? 1 : ''].join('|');
};

/** True when `ref` is a still-planned (not done/skipped/moved) session on `date`. */
export function isPlanned(state: PlannerState, date: ISODate, ref: SessionRef): boolean {
  return planDays(state, date, 1)[0]!.sessions.some((s) => s.status === 'planned' && refKey(s) === refKey(ref));
}
