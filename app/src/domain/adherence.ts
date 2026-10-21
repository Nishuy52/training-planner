// Adherence (CONTEXT.md): Sessions done in an ISO week against what the Default Week and Club Events expected, after Constraints.
import type { ISODate, PlannerState, SessionRef } from './types';
import { addDays, mondayOf, weekday } from './dates';
import { dayContext } from './constraints';
import { RUN_ORDER, liftAllowed, runsAllowed } from './planner';

export type AdherenceKind = 'lift' | 'run' | 'climb';
export type KindCount = { expected: number; done: number; skipped: number };
export type WeekAdherence = { monday: ISODate; expected: number; done: number; skipped: number; byKind: Record<AdherenceKind, KindCount> };

/** A Check-in as read from the action log (or `doneByDate`). */
export type CheckIn = { date: ISODate; ref: SessionRef; status: 'done' | 'skipped' };

const KINDS: AdherenceKind[] = ['lift', 'run', 'climb'];
const SLOTS_PER_DAY = 2;

/** Travel Strength and TM Tests count as the week's lifting. */
export const adherenceKind = (ref: SessionRef): AdherenceKind =>
  ref.kind === 'run' ? 'run' : ref.kind === 'climb' ? 'climb' : 'lift';

/**
 * What one day expects, with the planner's own rules: a Club Event is a climb (one per day; later ones are notes; none on a mountain day),
 * a run Slot is a run unless a mountain or Arrival Day, a lift Slot is a lift (Travel Strength when no gym) unless a
 * mountain or Travel Day. A Club Event day with no lift Slot expects a lift too (the planner's am lift before a climb), and
 * so does the week's Easy-run day (the lift after the Easy run). Two Slots a day: climbs take theirs first, then runs,
 * and the lift gives way.
 */
export function expectedForDay(state: PlannerState, date: ISODate): AdherenceKind[] {
  const ctx = dayContext(state, date);
  const slots = Object.values(state.defaultWeek[weekday(date)] ?? {});
  const out: AdherenceKind[] = [];
  const climb = !ctx.mountain && state.clubEvents.some((e) => e.date === date);
  if (climb) out.push('climb');
  if (runsAllowed(ctx)) for (const k of slots) if (k === 'run' || k === 'run-long') out.push('run');
  if (liftAllowed(ctx) && (slots.includes('lift') || climb || easyRunDay(state, date) === date)) out.push('lift');
  return out.slice(0, SLOTS_PER_DAY);
}

const hasRunSlot = (state: PlannerState, d: ISODate) => Object.values(state.defaultWeek[weekday(d)] ?? {}).includes('run');

/**
 * Where the Default Week puts the Easy run in `date`'s ISO week: the first day with a `run` Slot that allows runs (the
 * planner places Easy first). It ignores runs done or credited elsewhere; Adherence counts per kind and week, so only
 * the one extra lift matters, not the day it falls on.
 */
function easyRunDay(state: PlannerState, date: ISODate): ISODate | undefined {
  const monday = mondayOf(date);
  for (let d = monday; d <= addDays(monday, 6); d = addDays(d, 1)) {
    if (hasRunSlot(state, d) && runsAllowed(dayContext(state, d))) return d;
  }
  return undefined;
}

/**
 * Adherence for the ISO week starting `monday`, counting only days up to `upTo` (later days are not missed yet).
 * Runs are capped at the planner's three a week. Done and skipped are counted per kind against what was expected,
 * so an extra Session never lifts a kind above 100 %; a day with no Check-in is simply not done (a miss).
 */
export function weekAdherence(state: PlannerState, monday: ISODate, upTo: ISODate, checkIns: CheckIn[]): WeekAdherence {
  const byKind = Object.fromEntries(KINDS.map((k) => [k, { expected: 0, done: 0, skipped: 0 }])) as Record<AdherenceKind, KindCount>;
  const end = addDays(monday, 6);
  for (let d = monday; d <= end && d <= upTo; d = addDays(d, 1)) {
    for (const k of expectedForDay(state, d)) byKind[k].expected++;
  }
  byKind.run.expected = Math.min(byKind.run.expected, RUN_ORDER.length);

  const inWeek = checkIns.filter((c) => c.date >= monday && c.date <= end && c.date <= upTo);
  for (const k of KINDS) {
    const kc = byKind[k];
    const mine = inWeek.filter((c) => adherenceKind(c.ref) === k);
    kc.done = Math.min(kc.expected, mine.filter((c) => c.status === 'done').length);
    kc.skipped = Math.min(kc.expected - kc.done, mine.filter((c) => c.status === 'skipped').length);
  }
  const sum = (f: keyof KindCount) => KINDS.reduce((n, k) => n + byKind[k][f], 0);
  return { monday, expected: sum('expected'), done: sum('done'), skipped: sum('skipped'), byKind };
}
