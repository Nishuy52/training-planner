import { describe, expect, it } from 'vitest';
import { expectedForDay, weekAdherence, type CheckIn } from '../../src/domain/adherence';
import type { ClubEvent, Constraint } from '../../src/domain/types';
import { baseState } from './fixtures';

// Week of Mon 12 Oct 2026. Default Week: Mon/Thu/Sun lift, Tue/Wed run, Sat run-long.
const MON = '2026-10-12';
const SUN = '2026-10-18';
const mountain: Constraint = { id: 'm', start: '2026-10-17', end: '2026-10-18', mountain: true };
const friClimb: ClubEvent = { id: 'wall-a', date: '2026-10-16', time: '18:00', title: 'Wall A', venue: 'Wall A', type: 'partner' };

describe('expectedForDay', () => {
  it('follows the Default Week and Club Events', () => {
    const st = baseState({ clubEvents: [friClimb] });
    expect(expectedForDay(st, MON)).toEqual(['lift']);
    expect(expectedForDay(st, '2026-10-13')).toEqual(['run', 'lift']); // the week's Easy run, and a lift after it
    expect(expectedForDay(st, '2026-10-14')).toEqual(['run']);
    expect(expectedForDay(st, '2026-10-16')).toEqual(['climb', 'lift']); // a lift before the Club Event
    expect(expectedForDay(st, '2026-10-17')).toEqual(['run']);
  });
  it('a mountain day expects no run, lift or Club Event climb', () => {
    const st = baseState({ constraints: [mountain], clubEvents: [{ ...friClimb, date: '2026-10-17' }] });
    expect(expectedForDay(st, '2026-10-17')).toEqual([]);
    expect(expectedForDay(st, SUN)).toEqual([]);
  });
  it('Travel Days per the planner: Departure runs only, no-gym middle is Travel Strength (a lift), Arrival nothing', () => {
    const trip: Constraint = { id: 't', start: '2026-10-14', end: '2026-10-16', noGym: true }; // Wed–Fri, Travel Days on
    const st = baseState({ constraints: [trip] });
    expect(expectedForDay(st, '2026-10-14')).toEqual(['run']);
    expect(expectedForDay(st, '2026-10-15')).toEqual(['lift']);
    expect(expectedForDay(st, '2026-10-16')).toEqual([]);
  });
  it('two Slots a day: the lift gives way to a Club Event and a run', () => {
    const st = baseState({ defaultWeek: { ...baseState().defaultWeek, 0: { am: 'lift', pm: 'run' } }, clubEvents: [{ ...friClimb, date: MON }] });
    expect(expectedForDay(st, MON)).toEqual(['climb', 'run']);
  });
  it('a Club Event day without a lift Slot expects a lift, with the usual gates', () => {
    const st = baseState({ clubEvents: [friClimb] });
    expect(expectedForDay(st, '2026-10-16')).toEqual(['climb', 'lift']);
    const noGym = baseState({ clubEvents: [friClimb], constraints: [{ id: 'c', start: '2026-10-16', end: '2026-10-16', noGym: true, travelDays: false }] });
    expect(expectedForDay(noGym, '2026-10-16')).toEqual(['climb', 'lift']); // Travel Strength
    const arrival = baseState({ clubEvents: [friClimb], constraints: [{ id: 't', start: '2026-10-14', end: '2026-10-16', noGym: true }] });
    expect(expectedForDay(arrival, '2026-10-16')).toEqual(['climb']);
    const runDay = baseState({ clubEvents: [{ ...friClimb, date: '2026-10-13' }] }); // Tue: am run, so no room for a lift
    expect(expectedForDay(runDay, '2026-10-13')).toEqual(['climb', 'run']);
  });
  it("the Easy-run day (the week's first day with a run Slot that allows runs) expects a lift, with the usual gates", () => {
    const tueMtn = baseState({ constraints: [{ id: 'm', start: '2026-10-13', end: '2026-10-13', mountain: true }] });
    expect(expectedForDay(tueMtn, '2026-10-13')).toEqual([]);
    expect(expectedForDay(tueMtn, '2026-10-14')).toEqual(['run', 'lift']); // the Easy run rolls to Wed
    const departure = baseState({ constraints: [{ id: 't', start: '2026-10-13', end: '2026-10-15', timezone: 'Europe/Rome' }] });
    expect(expectedForDay(departure, '2026-10-13')).toEqual(['run']); // a run, but no lift on a Travel Day
    expect(expectedForDay(departure, '2026-10-14')).toEqual(['run']);
    const noGym = baseState({ constraints: [{ id: 'c', start: '2026-10-13', end: '2026-10-13', noGym: true, travelDays: false }] });
    expect(expectedForDay(noGym, '2026-10-13')).toEqual(['run', 'lift']); // Travel Strength
  });
});

describe('weekAdherence', () => {
  const st = baseState({ constraints: [mountain], clubEvents: [friClimb] });
  const checkIns: CheckIn[] = [
    { date: MON, ref: { kind: 'lift', lift: 'squat', week: 1 }, status: 'done' },
    { date: '2026-10-13', ref: { kind: 'run', run: 'easy' }, status: 'done' },
    { date: '2026-10-14', ref: { kind: 'run', run: 'quality-vert' }, status: 'skipped' },
    { date: '2026-10-16', ref: { kind: 'climb', eventId: 'wall-a' }, status: 'done' },
    { date: SUN, ref: { kind: 'climb', fallback: true }, status: 'done' }, // extra climb: never above expected
    { date: '2026-10-19', ref: { kind: 'lift', lift: 'bench', week: 1 }, status: 'done' }, // next week
  ];

  it('a week with a mountain Constraint and a Club Event; the Tuesday, Thursday and Friday lifts without a Check-in are misses', () => {
    expect(weekAdherence(st, MON, '2026-10-30', checkIns)).toEqual({
      monday: MON, expected: 7, done: 3, skipped: 1,
      byKind: {
        lift: { expected: 4, done: 1, skipped: 0 }, // Mon, Tue after the Easy run, Thu, and Friday's am lift before the Club Event
        run: { expected: 2, done: 1, skipped: 1 },
        climb: { expected: 1, done: 1, skipped: 0 },
      },
    });
  });

  it('days after upTo are not expected yet', () => {
    const r = weekAdherence(st, MON, '2026-10-13', checkIns);
    expect(r).toMatchObject({ expected: 3, done: 2, skipped: 0 }); // Mon lift, Tue run and the lift after it
  });

  it('runs are capped at the planner\'s three a week', () => {
    const allRuns = baseState({ defaultWeek: { 0: { am: 'run' }, 1: { am: 'run' }, 2: { am: 'run' }, 3: { am: 'run' }, 4: {}, 5: { am: 'run-long' }, 6: {} } });
    expect(weekAdherence(allRuns, MON, SUN, []).byKind.run.expected).toBe(3);
  });
});
