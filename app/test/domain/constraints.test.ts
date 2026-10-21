import { describe, it, expect } from 'vitest';
import { dayContext } from '../../src/domain/constraints';
import type { Constraint } from '../../src/domain/types';
const base = { defaultTimezone: 'Europe/Berlin', defaultGymProfileId: 'home-gym' };
const cragTrip = { id: 'c1', start: '2026-10-31', end: '2026-11-05', timezone: 'Europe/Rome', gymProfileId: null, noGym: true, note: 'Crag trip' };
const crag = { id: 'c2', start: '2026-11-01', end: '2026-11-03', mountain: true };
it('defaults outside constraints', () => expect(dayContext({ ...base, constraints: [cragTrip] }, '2026-10-30')).toEqual({ timezone: 'Europe/Berlin', gymProfileId: 'home-gym', noGym: false, mountain: false, note: undefined, location: 'Hometown' }));
it('applies constraint fields', () => expect(dayContext({ ...base, constraints: [cragTrip] }, '2026-10-31')).toMatchObject({ timezone: 'Europe/Rome', gymProfileId: null, noGym: true }));
it('overlapping constraints merge; later-starting wins per field, booleans OR', () => {
  const c = dayContext({ ...base, constraints: [cragTrip, crag] }, '2026-11-03');
  expect(c).toMatchObject({ timezone: 'Europe/Rome', noGym: true, mountain: true });
});

describe('Travel Days (spec §1)', () => {
  const ctx = (constraints: Constraint[], d: string) => dayContext({ ...base, constraints }, d);

  it('a trip Constraint (timezone or noGym) has a Departure Day first and an Arrival Day last', () => {
    expect(ctx([cragTrip], '2026-10-31').travel).toBe('departure');
    expect(ctx([cragTrip], '2026-11-01').travel).toBeUndefined();
    expect(ctx([cragTrip], '2026-11-05').travel).toBe('arrival');
    const tzOnly = { id: 't', start: '2026-11-22', end: '2026-11-26', timezone: 'Asia/Shanghai' };
    expect(ctx([tzOnly], '2026-11-22').travel).toBe('departure');
    expect(ctx([tzOnly], '2026-11-26').travel).toBe('arrival');
  });

  it('travelDays: false turns them off; a non-trip Constraint has none unless travelDays: true', () => {
    expect(ctx([{ ...cragTrip, travelDays: false }], '2026-10-31').travel).toBeUndefined();
    expect(ctx([{ ...cragTrip, travelDays: false }], '2026-11-05').travel).toBeUndefined();
    const note = { id: 'n', start: '2026-11-22', end: '2026-11-24', note: 'Work trip by car' };
    expect(ctx([note], '2026-11-22').travel).toBeUndefined();
    expect(ctx([{ ...note, travelDays: true }], '2026-11-22').travel).toBe('departure');
    expect(ctx([{ ...note, travelDays: true }], '2026-11-24').travel).toBe('arrival');
  });

  it('a mountain-only Constraint inside a trip has no Travel Days; mountain days take precedence', () => {
    expect(ctx([cragTrip, crag], '2026-11-02').travel).toBeUndefined();
    const both = ctx([cragTrip, { ...crag, start: '2026-10-31' }], '2026-10-31');
    expect(both.mountain).toBe(true);
    expect(both.travel).toBeUndefined();
  });

  it('back-to-back trips: a day that is both an Arrival and a Departure Day is an Arrival Day', () => {
    const next = { id: 'c3', start: '2026-11-05', end: '2026-11-10', timezone: 'Europe/Paris' };
    expect(ctx([cragTrip, next], '2026-11-05').travel).toBe('arrival');
    expect(ctx([cragTrip, { ...next, start: '2026-11-06' }], '2026-11-06').travel).toBe('departure');
  });

  it('a one-day trip is an Arrival Day (nothing but Club Events)', () => {
    expect(ctx([{ id: 'd', start: '2026-11-22', end: '2026-11-22', noGym: true }], '2026-11-22').travel).toBe('arrival');
  });
});

describe('location (Plan 3 A2)', () => {
  const trip = { id: 't', start: '2026-10-31', end: '2026-11-05', timezone: 'Europe/Rome', location: 'Sunny Crag, Southland' };
  const course = { id: 'm', start: '2026-11-01', end: '2026-11-03', mountain: true, location: 'Rocky Gorge, Southland' };
  it('is homeLocation outside Constraints, defaulting to Hometown', () => {
    expect(dayContext({ ...base, constraints: [] }, '2026-10-30').location).toBe('Hometown');
    expect(dayContext({ ...base, homeLocation: 'Riverton', constraints: [trip] }, '2026-10-30').location).toBe('Riverton');
  });
  it('is the latest-starting matching Constraint location', () => {
    expect(dayContext({ ...base, constraints: [course, trip] }, '2026-11-04').location).toBe('Sunny Crag, Southland');
    expect(dayContext({ ...base, constraints: [course, trip] }, '2026-11-03').location).toBe('Rocky Gorge, Southland');
  });
  it('a Constraint without a location keeps the earlier one', () => {
    expect(dayContext({ ...base, constraints: [trip, { ...course, location: undefined }] }, '2026-11-03').location).toBe('Sunny Crag, Southland');
  });
});
