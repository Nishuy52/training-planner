import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  loadPlannerState, savePlannerState, upsertConstraint, deleteConstraint, upsertClubEvent, deleteClubEvent,
  appendActionLog, logLift, lastFslWeight, markMobility, mobilityStreak, wasSent, markSent, getKV, setKV, defaultState,
} from '../../src/store/db';
import { mondayOf } from '../../src/domain/dates';
import { db, migrate, resetDb } from './helpers';

beforeAll(migrate);
beforeEach(resetDb);

describe('planner state', () => {
  it('stored state without rucksEnabled loads as disabled', async () => {
    const { rucksEnabled: _r, ...legacy } = await loadPlannerState(db);
    const { constraints: _c, clubEvents: _e, ...stored } = legacy as any;
    await db.prepare('UPDATE state SET json = ? WHERE id = 1').bind(JSON.stringify(stored)).run();
    expect((await loadPlannerState(db)).rucksEnabled).toBe(false);
  });
  it('defaultState: runStartMonday is the Monday of the given instant (UTC)', () => {
    expect(defaultState(new Date('2027-03-04T12:00:00Z')).run.runStartMonday).toBe('2027-03-01'); // Thu -> Mon
    expect(defaultState(new Date('2027-03-01T00:00:00Z')).run.runStartMonday).toBe('2027-03-01'); // a Monday stays
    expect(defaultState(new Date('2027-03-07T23:59:59Z')).run.runStartMonday).toBe('2027-03-01'); // Sun -> the Monday before
  });
  it('seeds defaults on first load', async () => {
    const s = await loadPlannerState(db);
    expect(s.defaultWeek[0]).toEqual({ am: 'lift' });
    expect(s.defaultWeek[4]).toEqual({});
    expect(s.defaultWeek[5]).toEqual({ am: 'run-long' });
    expect(s.gymProfiles.map((g) => g.id)).toEqual(['home-gym', 'travel-gym']);
    expect(s.gymProfiles[1]).toMatchObject({ machineLifts: ['bench', 'ohp'], machineStepLb: 10, machineMaxLb: 200, hasBands: false });
    expect(s.defaultGymProfileId).toBe('home-gym');
    expect(s.defaultTimezone).toBe('Europe/Berlin');
    expect(s.tms).toEqual({ squat: 0, bench: 0, deadlift: 0, ohp: 0 });
    expect(s.lift).toEqual({ week: 1, index: 0, phase: { kind: 'normal' } });
    // running starts the Monday of the week the state is first created (UTC), not a fixed date
    const thisMonday = mondayOf(new Date().toISOString().slice(0, 10));
    expect(s.run).toEqual({ nextQuality: 'vert', nextBenchmark: '2k4', runStartMonday: thisMonday });
    expect(s.ruck).toEqual({ step: 0 });
    expect(s.rucksEnabled).toBe(false);
    expect(s.runsThisWeek).toEqual({});
    expect(s.doneByDate).toEqual({});
    expect(s.constraints).toEqual([]);
    expect(s.clubEvents).toEqual([]);
    // seeding persisted: second load identical
    expect(await loadPlannerState(db)).toEqual(s);
  });

  it('save then load round-trips', async () => {
    const s = await loadPlannerState(db);
    s.tms = { squat: 100, bench: 70, deadlift: 120, ohp: 45 };
    s.lift = { week: 2, index: 3, phase: { kind: 'reentry', done: 1 }, notBefore: '2026-10-08' };
    s.lastLiftDate = '2026-10-06';
    s.doneByDate = { '2026-10-06': [{ kind: 'lift', lift: 'ohp', week: 1 }] };
    await savePlannerState(db, s);
    expect(await loadPlannerState(db)).toEqual(s);
  });

  it('merges constraints and club events into state, and stores them outside the state row', async () => {
    await loadPlannerState(db);
    await upsertConstraint(db, { id: 'east', start: '2026-10-10', end: '2026-10-20', timezone: 'Asia/Shanghai', gymProfileId: 'travel-gym' });
    await upsertClubEvent(db, { id: 'e1', date: '2026-10-08', time: '18:00', title: 'Wall A', venue: 'Wall A', type: 'partner' });
    const s = await loadPlannerState(db);
    expect(s.constraints).toHaveLength(1);
    expect(s.clubEvents[0].id).toBe('e1');

    await savePlannerState(db, s);
    const row = await db.prepare('SELECT json FROM state WHERE id = 1').first<{ json: string }>();
    expect(JSON.parse(row!.json)).not.toHaveProperty('constraints');
    expect(JSON.parse(row!.json)).not.toHaveProperty('clubEvents');

    await upsertConstraint(db, { id: 'east', start: '2026-10-10', end: '2026-10-25' });
    expect((await loadPlannerState(db)).constraints).toEqual([{ id: 'east', start: '2026-10-10', end: '2026-10-25' }]);
    await deleteConstraint(db, 'east');
    await deleteClubEvent(db, 'e1');
    const t = await loadPlannerState(db);
    expect(t.constraints).toEqual([]);
    expect(t.clubEvents).toEqual([]);
  });
});

describe('sent reminders', () => {
  it('markSent is idempotent', async () => {
    expect(await wasSent(db, 'morning', '2026-10-05')).toBe(false);
    expect(await markSent(db, 'morning', '2026-10-05')).toBe(true);
    expect(await markSent(db, 'morning', '2026-10-05')).toBe(false);
    expect(await wasSent(db, 'morning', '2026-10-05')).toBe(true);
    expect(await wasSent(db, 'morning', '2026-10-06')).toBe(false);
    expect(await markSent(db, 'mobility', '2026-10-05')).toBe(true);
  });
});

describe('logs', () => {
  it('lastFslWeight returns the most recent logged weight for the lift', async () => {
    expect(await lastFslWeight(db, 'squat')).toBeNull();
    await logLift(db, '2026-10-05', 'squat', { fslWeightKg: 20 });
    await logLift(db, '2026-10-12', 'squat', { fslWeightKg: 22.5 });
    await logLift(db, '2026-10-13', 'squat', { notes: 'no weight recorded' });
    await logLift(db, '2026-10-06', 'bench', { fslWeightKg: 40 });
    expect(await lastFslWeight(db, 'squat')).toBe(22.5);
    expect(await lastFslWeight(db, 'bench')).toBe(40);
    expect(await lastFslWeight(db, 'ohp')).toBeNull();
  });

  it('mobilityStreak counts consecutive done days ending at upToDate (or the day before if not yet logged)', async () => {
    expect(await mobilityStreak(db, '2026-10-05')).toBe(0);
    await markMobility(db, '2026-10-02', 'done');
    await markMobility(db, '2026-10-03', 'done');
    await markMobility(db, '2026-10-04', 'done');
    expect(await mobilityStreak(db, '2026-10-04')).toBe(3);
    expect(await mobilityStreak(db, '2026-10-05')).toBe(3); // tonight not yet logged
    await markMobility(db, '2026-10-05', 'skipped');
    expect(await mobilityStreak(db, '2026-10-05')).toBe(0);
    await markMobility(db, '2026-10-03', 'skipped');
    expect(await mobilityStreak(db, '2026-10-04')).toBe(1);
    await markMobility(db, '2026-10-03', 'done'); // upsert overwrites
    expect(await mobilityStreak(db, '2026-10-04')).toBe(3);
  });

  it('appendActionLog and kv', async () => {
    await appendActionLog(db, { type: 'done', date: '2026-10-05' });
    const n = await db.prepare('SELECT COUNT(*) AS n FROM action_log').first<{ n: number }>();
    expect(n!.n).toBe(1);
    expect(await getKV(db, 'amrapLog')).toBeNull();
    await setKV(db, 'amrapLog', '{"squat":[8]}');
    await setKV(db, 'amrapLog', '{"squat":[8,6]}');
    expect(await getKV(db, 'amrapLog')).toBe('{"squat":[8,6]}');
  });
});
