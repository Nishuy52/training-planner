import { SELF } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { performAction, todayFor } from '../../src/http/api';
import { planDays } from '../../src/domain/planner';
import { addDays, mondayOf, weekday } from '../../src/domain/dates';
import { insertActivity, loadPlannerState, savePlannerState, setKV, upsertClubEvent, upsertConstraint } from '../../src/store/db';
import { insertBenchmark, insertTmSnapshots, listTmHistory } from '../../src/store/progress';
import type { ISODate, SessionRef } from '../../src/domain/types';
import { db, migrate, resetDb } from './helpers';

async function call(method: string, path: string, body?: unknown) {
  const r = await SELF.fetch('http://localhost' + path, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, json: (await r.json()) as any };
}
const get = (p: string) => call('GET', p);
const post = (p: string, b: unknown) => call('POST', p, b);

beforeAll(migrate);
beforeEach(resetDb);

/**
 * Today is a 2.4 km Benchmark day: this week is a run deload week (run week 3), today has the only run Slot and the
 * week's Easy is done, so today's run is the Quality run, which a deload week turns into the Benchmark. Today (not a
 * future date) so the rows fall inside every window, and an Activity today is not late.
 */
async function benchmarkRunToday(): Promise<{ date: ISODate; ref: SessionRef }> {
  const st = await loadPlannerState(db);
  const date = todayFor(st);
  const mon = mondayOf(date);
  st.run.runStartMonday = addDays(mon, -21);
  st.defaultWeek = { 0: {}, 1: {}, 2: {}, 3: {}, 4: {}, 5: {}, 6: {} };
  st.defaultWeek[weekday(date)] = { am: 'run' };
  st.runsThisWeek[mon] = ['easy'];
  await savePlannerState(db, st);
  if (!planDays(st, date, 1)[0]!.sessions.some((x) => x.kind === 'run' && x.run === 'benchmark-2k4')) throw new Error('no Benchmark run planned');
  return { date, ref: { kind: 'run', run: 'benchmark-2k4' } };
}
const benchmarkRunDay = benchmarkRunToday;

const AUTOBELAY_EVENT = { id: 'wall-c-bm', time: '18:00', title: 'Wall C', venue: 'Wall C', type: 'endurance_benchmark' as const };
let AUTOBELAY: typeof AUTOBELAY_EVENT & { date: ISODate };
beforeEach(async () => {
  AUTOBELAY = { ...AUTOBELAY_EVENT, date: todayFor(await loadPlannerState(db)) };
});

describe('Benchmark Results', () => {
  it('done with a result stores it', async () => {
    const { date, ref } = await benchmarkRunDay();
    const r = await post('/api/action', { type: 'done', date, ref, benchmark: { timeS: 642 } });
    expect(r.status).toBe(200);
    const { json } = await get('/api/benchmark-results?days=1000');
    expect(json.entries).toEqual([{ id: expect.any(Number), date, kind: '2k4', timeS: 642 }]);
  });

  it('an auto-belay Club Event takes grade and minutes', async () => {
    await upsertClubEvent(db, AUTOBELAY);
    const ref = { kind: 'climb', eventId: AUTOBELAY.id };
    expect((await post('/api/action', { type: 'done', date: AUTOBELAY.date, ref, benchmark: { timeS: 600 } })).status).toBe(400);
    const r = await post('/api/action', { type: 'done', date: AUTOBELAY.date, ref, benchmark: { grade: '6B+', minutes: 18 } });
    expect(r.status).toBe(200);
    const { json } = await get('/api/benchmark-results?days=1000');
    expect(json.entries[0]).toMatchObject({ date: AUTOBELAY.date, kind: 'autobelay', eventId: AUTOBELAY.id, grade: '6b+', minutes: 18 });
  });

  it('validates the result per kind and Session', async () => {
    const { date, ref } = await benchmarkRunDay();
    const bad = async (benchmark: unknown, r: unknown = ref) => {
      const res = await post('/api/action', { type: 'done', date, ref: r, benchmark });
      expect(res.status).toBe(400);
      expect(typeof res.json.error).toBe('string');
    };
    await bad({ grade: '6a', minutes: 10 }); // a run Benchmark takes a time
    await bad({ timeS: 30 });
    await bad({ timeS: 642.5 });
    await bad({ timeS: 642, grade: '6a', minutes: 5 });
    await bad({ grade: '6z', minutes: 10 });
    await bad('10:42');
    await bad({ timeS: 642 }, { kind: 'run', run: 'easy' });
    await bad({ timeS: 642 }, { kind: 'lift', lift: 'squat', week: 1 });
    // a climb that is not an endurance_benchmark Club Event
    await upsertClubEvent(db, { ...AUTOBELAY, id: 'wall-a', type: 'partner' });
    const res = await post('/api/action', { type: 'done', date: AUTOBELAY.date, ref: { kind: 'climb', eventId: 'wall-a' }, benchmark: { grade: '6a', minutes: 10 } });
    expect(res.status).toBe(400);
    // nothing was recorded by the rejected requests
    expect((await get('/api/benchmark-results?days=1000')).json.entries).toEqual([]);
  });

  it('done without a result waits for one; POST adds it to the most recent; 409 when none waits', async () => {
    const { date, ref } = await benchmarkRunDay();
    expect((await post('/api/action', { type: 'done', date, ref })).status).toBe(200);
    let { json } = await get('/api/benchmark-results?days=1000');
    expect(json.entries).toEqual([{ id: expect.any(Number), date, kind: '2k4' }]);
    expect((await get('/api/progress')).json.benchmarks).toEqual([]); // only results count as progress

    expect((await post('/api/benchmark-results', { grade: '6a', minutes: 10 })).status).toBe(409); // no auto-belay waiting
    const r = await post('/api/benchmark-results', { timeS: 655 });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ date, kind: '2k4', timeS: 655 });
    expect((await post('/api/benchmark-results', { timeS: 650 })).status).toBe(409);

    // correcting an entry by id; the result must fit its kind
    expect((await post('/api/benchmark-results', { id: r.json.id, timeS: 649 })).json.timeS).toBe(649);
    expect((await post('/api/benchmark-results', { id: r.json.id, grade: '6a', minutes: 3 })).status).toBe(400);
    expect((await post('/api/benchmark-results', { id: 9999, timeS: 649 })).status).toBe(404);
    ({ json } = await get('/api/benchmark-results?days=1000'));
    expect(json.entries).toHaveLength(1);
  });

  it('an Activity that completes a Benchmark run gives it its time (auto); a manual result replaces it', async () => {
    const { date } = await benchmarkRunDay();
    const out = await performAction(db, { type: 'activity', date, activity: { sport: 'run', km: 2.4, hours: 0.18 } });
    expect(out.benchmarkAuto).toEqual({ kind: '2k4', timeS: 648 });
    let { json } = await get('/api/benchmark-results?days=1000');
    expect(json.entries).toEqual([{ id: expect.any(Number), date, kind: '2k4', timeS: 648, auto: true }]);
    // POST without id corrects the most recent auto-filled result
    const r = await post('/api/benchmark-results', { timeS: 640 });
    expect(r.json).toEqual({ id: json.entries[0].id, date, kind: '2k4', timeS: 640 });
    // now a manual result: nothing waits any more
    expect((await post('/api/benchmark-results', { timeS: 630 })).status).toBe(409);
  });

  it('an Activity that does not look like the 2.4 km leaves the Benchmark waiting', async () => {
    const { date } = await benchmarkRunDay();
    const out = await performAction(db, { type: 'activity', date, activity: { sport: 'run', km: 6, hours: 0.6 } });
    expect(out.benchmarkAuto).toBeUndefined();
    const { json } = await get('/api/benchmark-results?days=1000');
    expect(json.entries).toEqual([{ id: expect.any(Number), date, kind: '2k4' }]);
  });

  it('rows dated after today are outside GET /api/benchmark-results and /api/progress', async () => {
    const today = todayFor(await loadPlannerState(db));
    await insertBenchmark(db, today, 'hill', undefined, { timeS: 1500 });
    await insertBenchmark(db, addDays(today, 1), '2k4', undefined, { timeS: 600 });
    await insertTmSnapshots(db, [{ date: today, lift: 'squat', tm: 100, reason: 'manual' }, { date: addDays(today, 3), lift: 'squat', tm: 105, reason: 'manual' }]);
    expect((await get('/api/benchmark-results')).json.entries.map((e: any) => e.date)).toEqual([today]);
    const { json } = await get('/api/progress');
    expect(json.benchmarks.map((e: any) => e.date)).toEqual([today]);
    expect(json.tmHistory.map((e: any) => e.date)).toEqual([today]);
  });
});

describe('Training Max history', () => {
  it('manual: set-tm records a snapshot, an unchanged TM does not', async () => {
    await post('/api/action', { type: 'set-tm', lift: 'bench', tm: 72.5 });
    await post('/api/action', { type: 'set-tm', lift: 'bench', tm: 72.5 });
    const today = todayFor(await loadPlannerState(db));
    expect(await listTmHistory(db, '2000-01-01', '2999-12-31')).toEqual([{ date: today, lift: 'bench', tm: 72.5, reason: 'manual' }]);
  });

  it('test: each TM Test result records its own snapshot', async () => {
    const dates = { squat: '2026-10-05', bench: '2026-10-06', deadlift: '2026-10-07', ohp: '2026-10-08' };
    await performAction(db, { type: 'start-test-week', dates });
    await performAction(db, { type: 'test-result', date: '2026-10-05', lift: 'squat', weight: 100, reps: 5 });
    expect(await listTmHistory(db, '2000-01-01', '2999-12-31')).toEqual([{ date: '2026-10-05', lift: 'squat', tm: 105, reason: 'test' }]);
    await performAction(db, { type: 'test-result', date: '2026-10-06', lift: 'bench', weight: 70, reps: 5 });
    await performAction(db, { type: 'test-result', date: '2026-10-07', lift: 'deadlift', weight: 140, reps: 5 });
    await performAction(db, { type: 'test-result', date: '2026-10-08', lift: 'ohp', weight: 45, reps: 5 });
    const h = await listTmHistory(db, '2000-01-01', '2999-12-31');
    expect(h.map((s) => [s.date, s.lift, s.tm, s.reason])).toEqual([
      ['2026-10-05', 'squat', 105, 'test'], ['2026-10-06', 'bench', 72.5, 'test'], ['2026-10-07', 'deadlift', 145, 'test'], ['2026-10-08', 'ohp', 45, 'test'],
    ]);
  });

  it('self-heal: a Test Week result logged with its TM still 0 gets the TM on the next load, exactly once', async () => {
    const st = await loadPlannerState(db);
    // legacy state: squat tested (110 × 5) before results set TMs
    st.tms = { squat: 0, bench: 0, deadlift: 0, ohp: 0 };
    st.testWeek = { dates: { squat: '2026-10-24', bench: '2026-10-25', deadlift: '2026-10-26', ohp: '2026-10-27' }, results: { squat: { weight: 110, reps: 5 } } };
    st.doneByDate['2026-10-24'] = [{ kind: 'lift-test', lift: 'squat' }];
    await savePlannerState(db, st);
    const raw = async () => JSON.parse((await db.prepare('SELECT json FROM state WHERE id = 1').first<{ json: string }>())!.json);
    expect((await raw()).tms.squat).toBe(0);

    const healed = await loadPlannerState(db);
    expect(healed.tms).toEqual({ squat: 115, bench: 0, deadlift: 0, ohp: 0 });
    expect(healed.testWeek?.results).toEqual({ squat: { weight: 110, reps: 5 } });
    expect((await raw()).tms).toEqual({ squat: 115, bench: 0, deadlift: 0, ohp: 0 }); // persisted
    const once = [{ date: '2026-10-24', lift: 'squat', tm: 115, reason: 'test' }];
    expect(await listTmHistory(db, '2000-01-22', '2999-12-31')).toEqual(once);

    // a second load and an action change nothing more
    const version = async () => (await db.prepare('SELECT updated_at FROM state WHERE id = 1').first<{ updated_at: string }>())!.updated_at;
    const v = await version();
    expect((await loadPlannerState(db)).tms.squat).toBe(115);
    expect(await version()).toBe(v);
    await performAction(db, { type: 'set-history', ruckStep: 1 });
    expect((await loadPlannerState(db)).tms).toEqual({ squat: 115, bench: 0, deadlift: 0, ohp: 0 });
    expect(await listTmHistory(db, '2000-01-22', '2999-12-31')).toEqual(once);
    // GET /api/state shows it
    expect((await get('/api/state')).json.tms.squat).toBe(115);
  });

  it('self-heal on the action path: the next action heals before it applies', async () => {
    const st = await loadPlannerState(db);
    st.tms = { squat: 0, bench: 60, deadlift: 0, ohp: 0 };
    st.testWeek = { dates: { squat: '2026-10-24', bench: '2026-10-25', deadlift: '2026-10-26', ohp: '2026-10-27' }, results: { squat: { weight: 110, reps: 5 } } };
    await savePlannerState(db, st);
    const r = await performAction(db, { type: 'test-result', date: '2026-10-25', lift: 'bench', weight: 70, reps: 5 });
    expect(r.state.tms).toEqual({ squat: 115, bench: 72.5, deadlift: 0, ohp: 0 });
    expect((await listTmHistory(db, '2000-01-22', '2999-12-31')).map((s) => [s.date, s.lift, s.tm, s.reason])).toEqual([
      ['2026-10-24', 'squat', 115, 'test'], ['2026-10-25', 'bench', 72.5, 'test'],
    ]);
  });

  it('test: test-results sets the TMs directly', async () => {
    await post('/api/action', { type: 'test-results', date: '2026-10-05', results: { squat: { weight: 100, reps: 5 } }, plateStepKg: 2.5 });
    expect(await listTmHistory(db, '2000-01-01', '2999-12-31')).toEqual([{ date: '2026-10-05', lift: 'squat', tm: 105, reason: 'test' }]);
  });

  it('cycle: week 3 done with every AMRAP target met', async () => {
    const st = await loadPlannerState(db);
    st.tms.squat = 100;
    st.lift = { week: 3, index: 0, phase: { kind: 'normal' } };
    await savePlannerState(db, st);
    await setKV(db, 'amrapLog', JSON.stringify({ squat: { 1: 5, 2: 3 }, bench: {}, deadlift: {}, ohp: {} }));
    const day = planDays(st, '2026-10-05', 7).find((d) => d.sessions.some((s) => s.kind === 'lift'))!;
    await performAction(db, { type: 'done', date: day.date, ref: { kind: 'lift', lift: 'squat', week: 3 }, amrapReps: 3 });
    expect(await listTmHistory(db, '2000-01-01', '2999-12-31')).toEqual([{ date: day.date, lift: 'squat', tm: 105, reason: 'cycle' }]);
  });
});

describe('GET /api/progress', () => {
  it('returns the four series, one entry per week, oldest first', async () => {
    const { status, json } = await get('/api/progress');
    expect(status).toBe(200);
    expect(Object.keys(json).sort()).toEqual(['adherence', 'benchmarks', 'tmHistory', 'weeklyRuns']);
    expect(json.weeklyRuns).toHaveLength(12);
    expect(json.adherence).toHaveLength(1); // fresh DB: Adherence starts this week (weeks before first use are left out)
    const today = todayFor(await loadPlannerState(db));
    expect(json.weeklyRuns[11].monday).toBe(mondayOf(today));
    expect(json.weeklyRuns[0].monday).toBe(addDays(mondayOf(today), -77));
    expect(json.adherence[0].monday).toBe(mondayOf(today));
    expect(json.adherence[0]).toMatchObject({ expected: expect.any(Number), done: 0, skipped: 0, byKind: { lift: expect.any(Object), run: expect.any(Object), climb: expect.any(Object) } });
  });

  it('weeks is 1–104', async () => {
    expect((await get('/api/progress?weeks=1')).json.weeklyRuns).toHaveLength(1);
    expect((await get('/api/progress?weeks=104')).json.weeklyRuns).toHaveLength(104);
    for (const w of ['0', '105', 'abc', '2.5', '-1']) expect((await get(`/api/progress?weeks=${w}`)).status).toBe(400);
  });

  it('weekly run + hike totals from Activities next to the week target', async () => {
    // the run plan starts the week of today, so this week is run week 0 (15 km / 300 m)
    const st = await loadPlannerState(db);
    const today = todayFor(st);
    st.run.runStartMonday = mondayOf(today);
    await savePlannerState(db, st);
    await insertActivity(db, 'icu:1', today, 'intervals', { name: 'Run', sport: 'run', km: 8.25, vertM: 120 });
    await insertActivity(db, 'icu:2', today, 'intervals', { name: 'Hike', sport: 'hike', km: 6, vertM: 600.4 });
    await insertActivity(db, 'icu:3', today, 'intervals', { name: 'Climb', sport: 'climb', hours: 2 });
    await insertActivity(db, 'icu:4', addDays(mondayOf(today), -7), 'intervals', { name: 'Old', sport: 'run', km: 5 });
    const { json } = await get('/api/progress?weeks=2');
    expect(json.weeklyRuns).toEqual([
      { monday: addDays(mondayOf(today), -7), km: 5, vertM: 0, targetKm: null, targetVertM: null, deload: false },
      { monday: mondayOf(today), km: 14.3, vertM: 720, targetKm: 15, targetVertM: 300, deload: false },
    ]);
  });

  it('adherence counts this week\'s Check-ins against a mountain Constraint and a Club Event', async () => {
    const st = await loadPlannerState(db);
    const today = todayFor(st);
    const mon = mondayOf(today);
    // A whole-week view: put the week in the past so every day is expected.
    const pastMon = addDays(mon, -7);
    await upsertConstraint(db, { id: 'mtn', start: addDays(pastMon, 5), end: addDays(pastMon, 6), mountain: true }); // Sat + Sun
    await upsertClubEvent(db, { id: 'fri', date: addDays(pastMon, 4), time: '18:00', title: 'Wall A', venue: 'Wall A', type: 'partner' });
    const { appendActionLog } = await import('../../src/store/db');
    await appendActionLog(db, { type: 'done', date: pastMon, ref: { kind: 'lift', lift: 'squat', week: 1 } });
    await appendActionLog(db, { type: 'skip', date: addDays(pastMon, 1), ref: { kind: 'run', run: 'easy' } });
    await appendActionLog(db, { type: 'activity-credit', date: addDays(pastMon, 2), refs: [{ kind: 'run', run: 'quality-vert' }] });
    await appendActionLog(db, { type: 'done', date: addDays(pastMon, 4), ref: { kind: 'climb', eventId: 'fri' } });
    const { json } = await get('/api/progress?weeks=2');
    expect(json.adherence[0]).toEqual({
      // lifts: Mon, Tue (after the week's Easy run), Thu, and Friday's am lift before the Club Event
      monday: pastMon, expected: 7, done: 3, skipped: 1,
      byKind: { lift: { expected: 4, done: 1, skipped: 0 }, run: { expected: 2, done: 1, skipped: 1 }, climb: { expected: 1, done: 1, skipped: 0 } },
    });
  });
});

describe('side-writes run once when the state write is retried', () => {
  /** A D1 handle whose first `batch` (the state write) loses to another writer, so perform() retries once. */
  function conflictOnce() {
    let batches = 0;
    const handle = new Proxy(db, {
      get(target, prop) {
        if (prop === 'batch') {
          return async (stmts: D1PreparedStatement[]) => {
            if (batches++ === 0) await target.prepare("UPDATE state SET updated_at = 'another-writer' WHERE id = 1").run();
            return target.batch(stmts);
          };
        }
        const v = Reflect.get(target, prop);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
    return { handle, batches: () => batches };
  }

  it('one TM snapshot for a retried set-tm', async () => {
    await loadPlannerState(db);
    const c = conflictOnce();
    await performAction(c.handle, { type: 'set-tm', lift: 'ohp', tm: 47.5 });
    expect(c.batches()).toBeGreaterThanOrEqual(2); // the first write conflicted
    expect(await listTmHistory(db, '2000-01-01', '2999-12-31')).toEqual([expect.objectContaining({ lift: 'ohp', tm: 47.5, reason: 'manual' })]);
    expect((await loadPlannerState(db)).tms.ohp).toBe(47.5);
  });

  it('one Benchmark row (and one action-log entry) for a retried Done', async () => {
    const { date, ref } = await benchmarkRunDay();
    const c = conflictOnce();
    const out = await performAction(c.handle, { type: 'done', date, ref, benchmark: { timeS: 642 } });
    expect(c.batches()).toBeGreaterThanOrEqual(2);
    const { json } = await get('/api/benchmark-results?days=1000');
    expect(json.entries).toEqual([{ id: out.benchmarkId, date, kind: '2k4', timeS: 642 }]);
    const n = await db.prepare("SELECT COUNT(*) AS n FROM action_log WHERE json_extract(json, '$.type') = 'done'").first<{ n: number }>();
    expect(n!.n).toBe(1);
  });
});

describe('GET /api/progress: Adherence starts at first use', () => {
  it('leaves out weeks before the first action-log entry or Check-in', async () => {
    const today = todayFor(await loadPlannerState(db));
    const twoWeeksAgo = addDays(mondayOf(today), -14);
    await db.prepare('INSERT INTO action_log (at, json) VALUES (?, ?)').bind(`${twoWeeksAgo}T08:00:00.000Z`, JSON.stringify({ type: 'settings', settings: {} })).run();
    const { json } = await get('/api/progress');
    expect(json.weeklyRuns).toHaveLength(12);
    expect(json.adherence.map((a: any) => a.monday)).toEqual([twoWeeksAgo, addDays(twoWeeksAgo, 7), mondayOf(today)]);
  });
});
