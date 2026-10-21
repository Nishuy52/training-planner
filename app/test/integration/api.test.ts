import { SELF } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DayPlan, PlannedSession } from '../../src/domain/types';
import { db, migrate, resetDb } from './helpers';
import { lastFslWeight } from '../../src/store/db';
import { addDays } from '../../src/domain/dates';

const BASE = 'http://localhost';

async function call(method: string, path: string, body?: unknown) {
  const r = await SELF.fetch(BASE + path, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { status: r.status, json: (await r.json()) as any };
}
const get = (p: string) => call('GET', p);
const post = (p: string, b: unknown) => call('POST', p, b);

async function expect400(p: Promise<{ status: number; json: any }>) {
  const r = await p;
  expect(r.status).toBe(400);
  expect(typeof r.json.error).toBe('string');
}

beforeAll(migrate);
beforeEach(resetDb);

describe('access', () => {
  it('requireAccess covers /api/health: 403 without a JWT on a non-localhost host', async () => {
    const r = await SELF.fetch('https://training.example.com/api/health');
    expect(r.status).toBe(403);
  });
  it('localhost with empty Access vars is allowed', async () => {
    expect(await get('/api/health')).toEqual({ status: 200, json: { ok: true } });
  });
  it('unknown /api route is a JSON 404', async () => {
    expect((await get('/api/nope')).status).toBe(404);
  });
});

describe('plan', () => {
  it('returns days with index-aligned details', async () => {
    const { status, json } = await get('/api/plan?from=2026-10-05&days=7');
    expect(status).toBe(200);
    expect(json.days).toHaveLength(7);
    expect(json.days[0].date).toBe('2026-10-05');
    for (const d of json.days as DayPlan[]) expect(json.details[d.date]).toHaveLength(d.sessions.length);
    const lift = (json.days as DayPlan[]).flatMap((d) => d.sessions.map((s, i) => ({ s, det: json.details[d.date][i] }))).find((x) => x.s.kind === 'lift');
    expect(lift?.det.kind).toBe('lift');
    expect(Array.isArray(lift?.det.mainSets)).toBe(true);
  });
  it('defaults from to today', async () => {
    const { json } = await get('/api/plan?days=2');
    expect(json.days).toHaveLength(2);
    expect(json.days[0].date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
  it('400 on a malformed date or days', async () => {
    await expect400(get('/api/plan?from=2026-13-01'));
    await expect400(get('/api/plan?from=yesterday'));
    await expect400(get('/api/plan?days=abc'));
    await expect400(get('/api/plan?days=0'));
  });
  it('accepts up to 100 days', async () => {
    const { status, json } = await get('/api/plan?from=2026-10-05&days=100');
    expect(status).toBe(200);
    expect(json.days).toHaveLength(100);
    await expect400(get('/api/plan?from=2026-10-05&days=101'));
  });
});

describe('state and actions', () => {
  it('GET /api/state includes constraints, clubEvents and amrapLog', async () => {
    const { json } = await get('/api/state');
    expect(json.constraints).toEqual([]);
    expect(json.clubEvents).toEqual([]);
    expect(json.amrapLog).toEqual({ squat: {}, bench: {}, deadlift: {}, ohp: {} });
  });

  it('done lift advances the plan, writes amrapLog, lift_log and the action log', async () => {
    const plan = (await get('/api/plan?from=2026-10-05&days=7')).json;
    const day = (plan.days as DayPlan[]).find((d) => d.sessions.some((s) => s.kind === 'lift'))!;
    const s = day.sessions.find((x) => x.kind === 'lift') as Extract<PlannedSession, { kind: 'lift' }>;
    expect(s.week).toBe(1);

    const r = await post('/api/action', { type: 'done', date: day.date, ref: { kind: 'lift', lift: s.lift, week: 1 }, amrapReps: 8 });
    expect(r.status).toBe(200);
    expect(r.json.state.lift.index).toBe(1);
    expect(Array.isArray(r.json.events)).toBe(true);

    const after = (await get('/api/plan?from=2026-10-05&days=7')).json;
    const same = (after.days as DayPlan[]).find((d) => d.date === day.date)!;
    expect(same.sessions.find((x) => x.kind === 'lift')).toMatchObject({ lift: s.lift, status: 'done' });

    expect((await get('/api/state')).json.amrapLog[s.lift]).toEqual({ 1: 8 });
    const log = (await get('/api/lift-log')).json;
    expect(log.entries[0]).toMatchObject({ date: day.date, lift: s.lift, week: 1, amrapReps: 8 });
    const n = await db.prepare('SELECT COUNT(*) AS n FROM action_log').first<{ n: number }>();
    expect(n!.n).toBe(1);
  });

  it('rejects a repeated done with 409: pointer advances once, one lift_log row', async () => {
    const plan = (await get('/api/plan?from=2026-10-05&days=7')).json;
    const day = (plan.days as DayPlan[]).find((d) => d.sessions.some((s) => s.kind === 'lift'))!;
    const s = day.sessions.find((x) => x.kind === 'lift') as Extract<PlannedSession, { kind: 'lift' }>;
    const a = { type: 'done', date: day.date, ref: { kind: 'lift', lift: s.lift, week: 1 }, amrapReps: 8 };
    expect((await post('/api/action', a)).status).toBe(200);
    const second = await post('/api/action', a);
    expect(second.status).toBe(409);
    expect(second.json.error).toBe('session is not planned for that date (already handled?)');
    expect((await get('/api/state')).json.lift.index).toBe(1);
    const n = await db.prepare('SELECT COUNT(*) AS n FROM lift_log').first<{ n: number }>();
    expect(n!.n).toBe(1);
    const skip = await post('/api/action', { type: 'skip', date: day.date, ref: a.ref });
    expect(skip.status).toBe(409);
  });

  it('done lift with sets: stored in the lift_log row with amrapReps; FSL weight feeds the next prescription', async () => {
    const plan = (await get('/api/plan?from=2026-10-05&days=7')).json;
    const day = (plan.days as DayPlan[]).find((d) => d.sessions.some((s) => s.kind === 'lift'))!;
    const s = day.sessions.find((x) => x.kind === 'lift') as Extract<PlannedSession, { kind: 'lift' }>;
    const sets = [
      { group: 'main', exercise: 'Squat', n: 3, rxLoad: 85, rxReps: 5, load: 85, reps: 9, unit: 'kg', amrap: true, extra: 'dropped' },
      { group: 'fsl', exercise: 'DB Bulgarian split squat', n: 1, rxLoad: 20, rxReps: 8, load: 22.5, reps: 8, unit: 'kg' },
      { group: 'finisher', exercise: 'Cossack squat', n: 1, rxReps: 12, rxRepsMax: 15, reps: 14, unit: 'kg', rpe: 8 },
    ];
    const r = await post('/api/action', { type: 'done', date: day.date, ref: { kind: 'lift', lift: s.lift, week: 1 }, amrapReps: 9, sets });
    expect(r.status).toBe(200);
    expect((await get('/api/state')).json.amrapLog[s.lift]).toEqual({ 1: 9 });
    const n = await db.prepare('SELECT COUNT(*) AS n FROM lift_log').first<{ n: number }>();
    expect(n!.n).toBe(1);
    const e = (await get('/api/lift-log')).json.entries[0];
    expect(e).toMatchObject({ date: day.date, lift: s.lift, week: 1, amrapReps: 9, fslWeightKg: 22.5 });
    expect(e.sets).toHaveLength(3);
    expect(e.sets[0]).toEqual({ group: 'main', exercise: 'Squat', n: 3, rxLoad: 85, rxReps: 5, load: 85, reps: 9, unit: 'kg', amrap: true });
    expect(e.sets[2]).toEqual({ group: 'finisher', exercise: 'Cossack squat', n: 1, rxReps: 12, rxRepsMax: 15, reps: 14, unit: 'kg', rpe: 8 });
    // lastFslWeight reads the derived fslWeightKg: the next Session of this lift prescribes it.
    const later = (await get('/api/plan?from=2026-10-05&days=42')).json;
    const next = (later.days as DayPlan[]).findIndex((d) => d.date > day.date && d.sessions.some((x) => x.kind === 'lift' && x.lift === s.lift));
    const nd = (later.days as DayPlan[])[next]!;
    const i = nd.sessions.findIndex((x) => x.kind === 'lift' && x.lift === s.lift);
    expect(later.details[nd.date][i].lastFslWeightKg).toBe(22.5);
  });

  it('done lift with sets but no amrapReps still writes a lift_log row; amrapLog unchanged', async () => {
    const plan = (await get('/api/plan?from=2026-10-05&days=7')).json;
    const day = (plan.days as DayPlan[]).find((d) => d.sessions.some((s) => s.kind === 'lift'))!;
    const s = day.sessions.find((x) => x.kind === 'lift') as Extract<PlannedSession, { kind: 'lift' }>;
    const sets = [{ group: 'main', exercise: 'Squat', n: 1, rxLoad: 65, rxReps: 5, load: 65, reps: 5, unit: 'kg' }];
    expect((await post('/api/action', { type: 'done', date: day.date, ref: { kind: 'lift', lift: s.lift, week: 1 }, sets })).status).toBe(200);
    expect((await get('/api/state')).json.amrapLog[s.lift]).toEqual({});
    const e = (await get('/api/lift-log')).json.entries[0];
    expect(e).toEqual({ date: day.date, lift: s.lift, week: 1, sets });
  });

  it('400 on bad sets', async () => {
    const base = { type: 'done', date: '2026-10-05', ref: { kind: 'lift', lift: 'squat', week: 1 } };
    const ok = { group: 'main', exercise: 'Squat', n: 1, unit: 'kg' };
    const sets = (x: object) => post('/api/action', { ...base, sets: [{ ...ok, ...x }] });
    await expect400(post('/api/action', { ...base, sets: 'nope' }));
    await expect400(post('/api/action', { ...base, sets: Array.from({ length: 61 }, () => ok) }));
    await expect400(post('/api/action', { ...base, sets: [null] }));
    await expect400(sets({ group: 'cardio' }));
    await expect400(sets({ exercise: '' }));
    await expect400(sets({ exercise: 'x'.repeat(81) }));
    await expect400(sets({ n: 0 }));
    await expect400(sets({ n: 21 }));
    await expect400(sets({ n: 1.5 }));
    await expect400(sets({ unit: 'st' }));
    await expect400(sets({ load: 1001 }));
    await expect400(sets({ load: -1 }));
    await expect400(sets({ reps: 101 }));
    await expect400(sets({ reps: 2.5 }));
    await expect400(sets({ rxReps: 'five' }));
    await expect400(sets({ amrap: 'yes' }));
    await expect400(sets({ rpe: 0 }));
    await expect400(sets({ rpe: 11 }));
    await expect400(sets({ rpe: 7.5 }));
    await expect400(post('/api/action', { type: 'done', date: '2026-10-05', ref: { kind: 'run', run: 'easy' }, sets: [ok] }));
    await expect400(post('/api/action', { ...base, sets: [] }));
    // amrapReps given but disagrees with the AMRAP main set's reps; derived reps out of the amrapReps range
    await expect400(post('/api/action', { ...base, amrapReps: 7, sets: [{ ...ok, reps: 9, amrap: true }] }));
    await expect400(post('/api/action', { ...base, sets: [{ ...ok, reps: 31, amrap: true }] }));
    // nothing was written
    const n = await db.prepare('SELECT COUNT(*) AS n FROM lift_log').first<{ n: number }>();
    expect(n!.n).toBe(0);
  });

  it('sets without amrapReps: amrapReps derived from the AMRAP main set and fed to amrapLog', async () => {
    const plan = (await get('/api/plan?from=2026-10-05&days=7')).json;
    const day = (plan.days as DayPlan[]).find((d) => d.sessions.some((s) => s.kind === 'lift'))!;
    const s = day.sessions.find((x) => x.kind === 'lift') as Extract<PlannedSession, { kind: 'lift' }>;
    const sets = [
      { group: 'main', exercise: 'X', n: 3, rxLoad: 85, rxReps: 5, load: 85, reps: 10, unit: 'kg', amrap: true },
    ];
    expect((await post('/api/action', { type: 'done', date: day.date, ref: { kind: 'lift', lift: s.lift, week: 1 }, sets })).status).toBe(200);
    expect((await get('/api/state')).json.amrapLog[s.lift]).toEqual({ 1: 10 });
    expect((await get('/api/lift-log')).json.entries[0]).toMatchObject({ amrapReps: 10 });
  });

  it('AMRAP set with load only (reps unknown) does not touch amrapLog', async () => {
    const plan = (await get('/api/plan?from=2026-10-05&days=7')).json;
    const day = (plan.days as DayPlan[]).find((d) => d.sessions.some((s) => s.kind === 'lift'))!;
    const s = day.sessions.find((x) => x.kind === 'lift') as Extract<PlannedSession, { kind: 'lift' }>;
    const sets = [{ group: 'main', exercise: 'X', n: 3, rxLoad: 85, rxReps: 5, load: 85, unit: 'kg', amrap: true }];
    expect((await post('/api/action', { type: 'done', date: day.date, ref: { kind: 'lift', lift: s.lift, week: 1 }, sets })).status).toBe(200);
    expect((await get('/api/state')).json.amrapLog[s.lift]).toEqual({});
    expect((await get('/api/lift-log')).json.entries[0].amrapReps).toBeUndefined();
  });

  it("bench: fslWeightKg comes only from the first FSL exercise, never the weighted chin-up", async () => {
    // Day by day, as each day's own plan shows it (actions are only offered for today): complete planned lifts until bench.
    let day: DayPlan | undefined;
    let b: Extract<PlannedSession, { kind: 'lift' }> | undefined;
    for (let i = 0; i < 28 && !b; i++) {
      const date = addDays('2026-10-05', i);
      day = ((await get(`/api/plan?from=${date}&days=1`)).json.days as DayPlan[])[0]!;
      const x = day.sessions.find((y) => y.kind === 'lift' && y.status === 'planned') as Extract<PlannedSession, { kind: 'lift' }> | undefined;
      if (!x) continue;
      if (x.lift === 'bench') b = x;
      else expect((await post('/api/action', { type: 'done', date: day.date, ref: { kind: 'lift', lift: x.lift, week: x.week } })).status).toBe(200);
    }
    expect(b).toBeDefined();
    const ref = { kind: 'lift', lift: 'bench', week: b!.week };
    const sets = [
      { group: 'fsl', exercise: '1-arm DB bench press', n: 1, rxReps: 8, reps: 8, unit: 'kg' },
      { group: 'fsl', exercise: 'Weighted chin-up', n: 1, rxReps: 5, load: 15, reps: 5, unit: 'kg' },
    ];
    expect((await post('/api/action', { type: 'done', date: day!.date, ref, sets })).status).toBe(200);
    const e = (await get('/api/lift-log')).json.entries.find((x: { lift: string }) => x.lift === 'bench');
    expect(e.fslWeightKg).toBeUndefined();
    expect(await lastFslWeight(db, 'bench')).toBeNull();
  });

  it('409 for done on a date where that session is not planned', async () => {
    const r = await post('/api/action', { type: 'done', date: '2026-10-05', ref: { kind: 'run', run: 'benchmark-hill' } });
    expect(r.status).toBe(409);
    expect((await get('/api/state')).json.lift.index).toBe(0);
  });

  it('set-tm and test-results', async () => {
    expect((await post('/api/action', { type: 'set-tm', lift: 'bench', tm: 70 })).json.state.tms.bench).toBe(70);
    const r = await post('/api/action', { type: 'test-results', date: '2026-10-02', results: { squat: { weight: 100, reps: 5 } }, plateStepKg: 2.5 });
    expect(r.status).toBe(200);
    expect(r.json.state.tms.squat).toBeGreaterThan(0);
  });

  it('Test Week: start, plan details, results, then the TMs', async () => {
    const dates = { squat: '2026-10-24', bench: '2026-10-25', deadlift: '2026-10-26', ohp: '2026-10-27' };
    const s = await post('/api/action', { type: 'start-test-week', dates });
    expect(s.status).toBe(200);
    expect(s.json.state.testWeek).toEqual({ dates, results: {} });

    const plan = (await get('/api/plan?from=2026-10-24&days=4')).json;
    const first = (plan.days as DayPlan[])[0]!;
    const i = first.sessions.findIndex((x) => x.kind === 'lift-test');
    expect(first.sessions[i]).toMatchObject({ kind: 'lift-test', lift: 'squat', slot: 'am', status: 'planned' });
    expect(plan.details['2026-10-24'][i]).toMatchObject({ kind: 'lift-test', lift: 'squat' });
    expect((plan.days as DayPlan[]).flatMap((d) => d.sessions).some((x) => x.kind === 'lift')).toBe(false);

    // a bare done is refused; skip moves it
    await expect400(post('/api/action', { type: 'done', date: '2026-10-24', ref: { kind: 'lift-test', lift: 'squat' } }));
    const sk = await post('/api/action', { type: 'skip', date: '2026-10-24', ref: { kind: 'lift-test', lift: 'squat' } });
    expect(sk.status).toBe(200);
    expect(sk.json.state.testWeek.dates.squat).toBe('2026-10-25');

    for (const [lift, weight] of [['squat', 100], ['bench', 70], ['deadlift', 140]] as const) {
      expect((await post('/api/action', { type: 'test-result', date: '2026-10-25', lift, weight, reps: 5 })).status).toBe(200);
    }
    expect((await post('/api/action', { type: 'test-result', date: '2026-10-25', lift: 'squat', weight: 100, reps: 5 })).status).toBe(409);
    const last = await post('/api/action', { type: 'test-result', date: '2026-10-27', lift: 'ohp', weight: 50, reps: 5 });
    expect(last.status).toBe(200);
    expect(last.json.state.tms).toEqual({ squat: 105, bench: 72.5, deadlift: 145, ohp: 52.5 });
    expect(last.json.state.testWeek).toBeUndefined();
    expect(last.json.state.lift).toEqual({ week: 1, index: 0, phase: { kind: 'normal' }, notBefore: '2026-10-28' });
    // no Test Week any more: a further result is 409
    expect((await post('/api/action', { type: 'test-result', date: '2026-10-27', lift: 'ohp', weight: 50, reps: 5 })).status).toBe(409);
  });

  it('400 on bad Test Week actions', async () => {
    const dates = { squat: '2026-10-24', bench: '2026-10-25', deadlift: '2026-10-26', ohp: '2026-10-27' };
    await expect400(post('/api/action', { type: 'start-test-week' }));
    await expect400(post('/api/action', { type: 'start-test-week', dates: { squat: '2026-10-24' } }));
    await expect400(post('/api/action', { type: 'start-test-week', dates: { ...dates, ohp: '2026-02-30' } }));
    await expect400(post('/api/action', { type: 'start-test-week', dates: { ...dates, curl: '2026-10-28' } }));
    const ok = { type: 'test-result', date: '2026-10-24', lift: 'squat', weight: 100, reps: 5 };
    await expect400(post('/api/action', { ...ok, lift: 'curl' }));
    await expect400(post('/api/action', { ...ok, weight: 0 }));
    await expect400(post('/api/action', { ...ok, weight: 501 }));
    await expect400(post('/api/action', { ...ok, weight: '100' }));
    await expect400(post('/api/action', { ...ok, reps: 0 }));
    await expect400(post('/api/action', { ...ok, reps: 16 }));
    await expect400(post('/api/action', { ...ok, reps: 5.5 }));
    await expect400(post('/api/action', { ...ok, date: 'today' }));
    await expect400(post('/api/action', { type: 'skip', date: '2026-10-24', ref: { kind: 'lift-test', lift: 'curl' } }));
    expect((await get('/api/state')).json.testWeek).toBeUndefined();
  });

  it('set-history sets and clears history', async () => {
    const r = await post('/api/action', { type: 'set-history', lastClimbDate: '2026-10-02', ruckLastCredit: '2026-09-24', lastLiftDate: '2026-09-30', ruckStep: 4 });
    expect(r.status).toBe(200);
    expect(r.json.state).toMatchObject({ lastClimbDate: '2026-10-02', lastLiftDate: '2026-09-30', ruck: { lastCredit: '2026-09-24', step: 4 } });
    const c = await post('/api/action', { type: 'set-history', lastClimbDate: null });
    expect(c.json.state.lastClimbDate).toBeUndefined();
    expect(c.json.state.lastLiftDate).toBe('2026-09-30');
    await expect400(post('/api/action', { type: 'set-history', lastClimbDate: '2026-02-30' }));
    await expect400(post('/api/action', { type: 'set-history', ruckStep: 21 }));
    await expect400(post('/api/action', { type: 'set-history', ruckStep: 1.5 }));
  });

  it('400 on bad actions', async () => {
    await expect400(post('/api/action', { type: 'done', date: '2026-02-30', ref: { kind: 'run', run: 'easy' } }));
    await expect400(post('/api/action', { type: 'done', date: '2026-10-05', ref: { kind: 'lift', lift: 'curl', week: 1 } }));
    await expect400(post('/api/action', { type: 'done', date: '2026-10-05', ref: { kind: 'lift', lift: 'squat', week: 1 }, amrapReps: 31 }));
    await expect400(post('/api/action', { type: 'set-tm', lift: 'squat', tm: 9999 }));
    await expect400(post('/api/action', { type: 'set-tm', lift: 'squat', tm: 'NaN' }));
    await expect400(post('/api/action', { type: 'test-results', results: { squat: { weight: 100, reps: 5 } }, plateStepKg: 2.5 }));
    await expect400(post('/api/action', { type: 'activity', date: '2026-10-05', activity: { sport: 'swim' } }));
    await expect400(post('/api/action', '{not json'));
  });
});

describe('lift log', () => {
  it('posts and lists newest first', async () => {
    expect((await post('/api/lift-log', { date: '2026-10-05', lift: 'squat', fslWeightKg: 20 })).json).toEqual({ ok: true });
    await post('/api/lift-log', { date: '2026-10-08', lift: 'bench', fslWeightKg: 22.5, notes: 'felt good' });
    const { json } = await get('/api/lift-log');
    expect(json.entries.map((e: any) => e.date)).toEqual(['2026-10-08', '2026-10-05']);
    expect(json.entries[0]).toEqual({ date: '2026-10-08', lift: 'bench', fslWeightKg: 22.5, notes: 'felt good' });
  });
  it('400 on a bad lift or weight', async () => {
    await expect400(post('/api/lift-log', { date: '2026-10-05', lift: 'curl' }));
    await expect400(post('/api/lift-log', { date: '2026-10-05', lift: 'squat', fslWeightKg: 501 }));
  });
});

describe('constraints', () => {
  it('upsert changes the plan; delete restores it', async () => {
    const c = { id: 'trip1', start: '2026-10-05', end: '2026-10-11', noGym: true, timezone: 'Asia/Shanghai', note: 'Trip' };
    const r = await post('/api/constraints', c);
    expect(r).toEqual({ status: 200, json: c });
    expect((await get('/api/state')).json.constraints).toEqual([c]);
    expect((await get('/api/constraints')).json).toEqual([c]);
    const plan = (await get('/api/plan?from=2026-10-05&days=7')).json;
    const kinds = (plan.days as DayPlan[]).flatMap((d) => d.sessions.map((s) => s.kind));
    expect(kinds).not.toContain('lift');
    expect(plan.days[2].timezone).toBe('Asia/Shanghai');

    expect((await call('DELETE', '/api/constraints/trip1')).json).toEqual({ ok: true });
    expect((await get('/api/state')).json.constraints).toEqual([]);
  });
  it('accepts gymProfileId null and a known profile; strips unknown fields', async () => {
    expect((await post('/api/constraints', { id: 'a', start: '2026-10-05', end: '2026-10-05', gymProfileId: null, extra: 1 })).json)
      .toEqual({ id: 'a', start: '2026-10-05', end: '2026-10-05', gymProfileId: null });
    expect((await post('/api/constraints', { id: 'b', start: '2026-10-05', end: '2026-10-05', gymProfileId: 'travel-gym' })).status).toBe(200);
  });
  it('400 on bad constraints', async () => {
    await expect400(post('/api/constraints', { id: 'x', start: '2026-10-10', end: '2026-10-05' }));
    await expect400(post('/api/constraints', { id: 'x', start: '2026-10-05', end: '2026-10-06', timezone: 'Mars/Olympus' }));
    await expect400(post('/api/constraints', { id: 'x', start: '2026-10-05', end: '2026-10-06', gymProfileId: 'nope' }));
    await expect400(post('/api/constraints', { start: '2026-10-05', end: '2026-10-06' }));
  });
});

describe('club events', () => {
  const ev = { id: 'ev_1', date: '2026-10-09', time: '18:00', title: 'Wall A', venue: 'Wall A', type: 'partner' };
  it('upsert and delete', async () => {
    expect(await post('/api/club-events', ev)).toEqual({ status: 200, json: ev });
    expect((await get('/api/state')).json.clubEvents).toEqual([ev]);
    expect((await get('/api/club-events')).json).toEqual([ev]);
    expect((await call('DELETE', '/api/club-events/ev_1')).json).toEqual({ ok: true });
    expect((await get('/api/state')).json.clubEvents).toEqual([]);
  });
  it('400 on an id that cannot go in callback_data, or a bad time/type', async () => {
    await expect400(post('/api/club-events', { ...ev, id: 'has space' }));
    await expect400(post('/api/club-events', { ...ev, id: 'x'.repeat(37) }));
    await expect400(post('/api/club-events', { ...ev, id: 'fb' }));
    await expect400(post('/api/club-events', { ...ev, time: '25:00' }));
    await expect400(post('/api/club-events', { ...ev, type: 'party' }));
  });
});

describe('comments', () => {
  const del = (p: string) => call('DELETE', p);
  it('creates with server-set fields, trims text and ignores unknown fields', async () => {
    const r = await post('/api/comments', {
      id: 'c1', date: '2026-10-07', text: '  knee felt off, go easier  ', session: { key: 'run:quality-vert', label: 'Vert run' },
      createdAt: '2000-01-01T00:00:00.000Z', junk: 1,
    });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ id: 'c1', date: '2026-10-07', text: 'knee felt off, go easier', session: { key: 'run:quality-vert', label: 'Vert run' }, status: 'open' });
    expect(r.json.junk).toBeUndefined();
    expect(r.json.createdAt).not.toBe('2000-01-01T00:00:00.000Z');
    expect(r.json.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(r.json.updatedAt).toBe(r.json.createdAt);
    expect((await get('/api/comments')).json).toEqual({ comments: [r.json] });
    const log = await db.prepare('SELECT json FROM action_log ORDER BY id DESC LIMIT 1').first<{ json: string }>();
    expect(JSON.parse(log!.json)).toEqual({ type: 'comment-upsert', comment: r.json });
  });

  it('lists sorted by date then createdAt, filtered by from/to/status', async () => {
    await post('/api/comments', { id: 'b', date: '2026-10-09', text: 'Riverton' });
    await post('/api/comments', { id: 'a2', date: '2026-10-05', text: 'second', status: 'addressed', resolution: 'moved' });
    await post('/api/comments', { id: 'a1', date: '2026-10-05', text: 'third' });
    const ids = async (q: string) => ((await get(`/api/comments${q}`)).json.comments as any[]).map((c) => c.id);
    expect(await ids('')).toEqual(['a2', 'a1', 'b']);
    expect(await ids('?from=2026-10-06')).toEqual(['b']);
    expect(await ids('?to=2026-10-05')).toEqual(['a2', 'a1']);
    expect(await ids('?from=2026-10-05&to=2026-10-09&status=open')).toEqual(['a1', 'b']);
    expect(await ids('?status=addressed')).toEqual(['a2']);
  });

  it('update preserves createdAt and keeps status when omitted', async () => {
    const first = (await post('/api/comments', { id: 'c1', date: '2026-10-07', text: 'knee' })).json;
    const addressed = (await post('/api/comments', { id: 'c1', date: '2026-10-07', text: 'knee', status: 'addressed', resolution: 'swapped to easy run' })).json;
    expect(addressed).toMatchObject({ status: 'addressed', resolution: 'swapped to easy run', createdAt: first.createdAt });
    const edited = (await post('/api/comments', { id: 'c1', date: '2026-10-08', text: 'knee, still' })).json;
    expect(edited).toMatchObject({ date: '2026-10-08', text: 'knee, still', status: 'addressed', createdAt: first.createdAt });
    expect(edited.updatedAt >= first.updatedAt).toBe(true);
    expect((await get('/api/comments')).json.comments).toEqual([edited]);
  });

  it('delete removes it and logs it', async () => {
    await post('/api/comments', { id: 'c1', date: '2026-10-07', text: 'x' });
    expect((await del('/api/comments/c1')).json).toEqual({ ok: true });
    expect((await get('/api/comments')).json).toEqual({ comments: [] });
    const log = await db.prepare('SELECT json FROM action_log ORDER BY id DESC LIMIT 1').first<{ json: string }>();
    expect(JSON.parse(log!.json)).toEqual({ type: 'comment-delete', id: 'c1' });
  });

  it('400 on bad comments and filters', async () => {
    const ok = { id: 'c1', date: '2026-10-07', text: 'hi' };
    await expect400(post('/api/comments', { ...ok, id: 'has space' }));
    await expect400(post('/api/comments', { ...ok, id: 'x'.repeat(65) }));
    await expect400(post('/api/comments', { ...ok, id: undefined }));
    await expect400(post('/api/comments', { ...ok, text: '' }));
    await expect400(post('/api/comments', { ...ok, text: '   ' }));
    await expect400(post('/api/comments', { ...ok, text: 'x'.repeat(1001) }));
    expect((await post('/api/comments', { ...ok, text: 'x'.repeat(1000) })).status).toBe(200);
    await expect400(post('/api/comments', { ...ok, date: '2026-02-30' }));
    await expect400(post('/api/comments', { ...ok, session: { key: 'Lift:Squat', label: 'Squat' } }));
    await expect400(post('/api/comments', { ...ok, session: { key: 'x'.repeat(41), label: 'Squat' } }));
    await expect400(post('/api/comments', { ...ok, session: { key: 'lift:squat', label: 'x'.repeat(81) } }));
    await expect400(post('/api/comments', { ...ok, session: 'lift:squat' }));
    await expect400(post('/api/comments', { ...ok, status: 'done' }));
    await expect400(post('/api/comments', { ...ok, resolution: 'x'.repeat(1001) }));
    await expect400(get('/api/comments?from=yesterday'));
    await expect400(get('/api/comments?to=2026-13-01'));
    await expect400(get('/api/comments?status=closed'));
    await expect400(del('/api/comments/has%20space'));
  });
});

describe('mobility', () => {
  it('posts and reads the log with a streak', async () => {
    const today = (await get('/api/plan?days=1')).json.days[0].date as string;
    const r = await post('/api/mobility', { date: today, status: 'done' });
    expect(r.status).toBe(200);
    expect(r.json.log).toContainEqual({ date: today, status: 'done' });
    expect(r.json.streak).toBe(1);
    expect((await get('/api/mobility?days=30')).json).toEqual(r.json);
  });
  it('400 on a bad status', async () => {
    await expect400(post('/api/mobility', { date: '2026-10-05', status: 'meh' }));
  });
});

describe('self-checks', () => {
  it('records the date per check', async () => {
    expect((await get('/api/self-checks')).json).toEqual({});
    expect((await post('/api/self-checks', { name: 'Ober test', date: '2026-10-02' })).json).toEqual({ 'Ober test': '2026-10-02' });
    expect((await get('/api/self-checks')).json).toEqual({ 'Ober test': '2026-10-02' });
  });
  it('400 on an unknown check', async () => {
    await expect400(post('/api/self-checks', { name: 'Vibe check', date: '2026-10-02' }));
  });
});

describe('settings', () => {
  it('updates the default week, timezone and gym profiles', async () => {
    const state = (await get('/api/state')).json;
    const body = {
      defaultWeek: { 0: { am: 'lift' }, 1: { pm: 'run' }, 2: {}, 3: { am: 'lift' }, 4: {}, 5: { am: 'run-long' }, 6: { am: 'lift' } },
      defaultTimezone: 'Asia/Shanghai',
      defaultGymProfileId: 'travel-gym',
      gymProfiles: state.gymProfiles,
    };
    const r = await call('PUT', '/api/settings', body);
    expect(r.status).toBe(200);
    expect(r.json.defaultWeek[1]).toEqual({ pm: 'run' });
    expect(r.json.defaultTimezone).toBe('Asia/Shanghai');
    expect(r.json.defaultGymProfileId).toBe('travel-gym');
    expect((await get('/api/state')).json.defaultTimezone).toBe('Asia/Shanghai');
  });
  it('rucksEnabled round-trips and must be a boolean', async () => {
    expect((await get('/api/state')).json.rucksEnabled).toBe(false);
    const r = await call('PUT', '/api/settings', { rucksEnabled: true });
    expect(r.status).toBe(200);
    expect(r.json.rucksEnabled).toBe(true);
    expect((await get('/api/state')).json.rucksEnabled).toBe(true);
    await expect400(call('PUT', '/api/settings', { rucksEnabled: 'yes' }));
  });
  it('400 on a bad timezone, slot kind or unknown default gym', async () => {
    await expect400(call('PUT', '/api/settings', { defaultTimezone: 'Nowhere/Land' }));
    await expect400(call('PUT', '/api/settings', { defaultWeek: { 0: { am: 'swim' } } }));
    await expect400(call('PUT', '/api/settings', { defaultWeek: { 7: {} } }));
    await expect400(call('PUT', '/api/settings', { defaultGymProfileId: 'nope' }));
  });
});

describe('csrf guard', () => {
  const raw = (method: string, path: string, headers: Record<string, string>, body?: string) =>
    SELF.fetch(BASE + path, { method, headers, body });
  const setTm = JSON.stringify({ type: 'set-tm', lift: 'bench', tm: 77 });
  const benchTm = async () => (await get('/api/state')).json.tms.bench;

  it('415 on a text/plain POST (a cross-site form can send one); state unchanged', async () => {
    const before = await benchTm();
    const r = await raw('POST', '/api/action', { 'content-type': 'text/plain' }, setTm);
    expect(r.status).toBe(415);
    expect(typeof ((await r.json()) as any).error).toBe('string');
    expect(await benchTm()).toBe(before);
  });
  it('415 on form-encoded or missing content-type for bodied writes', async () => {
    expect((await raw('POST', '/api/action', { 'content-type': 'application/x-www-form-urlencoded' }, setTm)).status).toBe(415);
    expect((await raw('PUT', '/api/settings', {}, '{}')).status).toBe(415);
    expect((await raw('POST', '/api/action', { 'content-type': 'application/jsonx' }, setTm)).status).toBe(415);
  });
  it('403 on Sec-Fetch-Site cross-site or same-site; state unchanged', async () => {
    const before = await benchTm();
    for (const site of ['cross-site', 'same-site']) {
      const r = await raw('POST', '/api/action', { 'content-type': 'application/json', 'sec-fetch-site': site }, setTm);
      expect(r.status).toBe(403);
    }
    expect((await raw('DELETE', '/api/constraints/x', { 'sec-fetch-site': 'cross-site' })).status).toBe(403);
    expect(await benchTm()).toBe(before);
  });
  it('same-origin JSON POST (with charset) succeeds', async () => {
    const r = await raw('POST', '/api/action', { 'content-type': 'application/json; charset=utf-8', 'sec-fetch-site': 'same-origin' }, setTm);
    expect(r.status).toBe(200);
    expect(await benchTm()).toBe(77);
    expect((await raw('POST', '/api/action', { 'content-type': 'Application/JSON', 'sec-fetch-site': 'none' }, setTm)).status).toBe(200);
  });
  it('DELETE without a content-type succeeds', async () => {
    const r = await raw('DELETE', '/api/club-events/ev_1', { 'sec-fetch-site': 'same-origin' });
    expect(r.status).toBe(200);
  });
  it('GET is not affected by Sec-Fetch-Site', async () => {
    expect((await raw('GET', '/api/health', { 'sec-fetch-site': 'cross-site' })).status).toBe(200);
  });
});

describe('body limits', () => {
  it('413 on a body over 64 KB', async () => {
    const r = await call('PUT', '/api/settings', { defaultTimezone: 'Europe/Berlin', pad: 'x'.repeat(70 * 1024) });
    expect(r.status).toBe(413);
    expect(typeof r.json.error).toBe('string');
  });
  it('400 on more than 20 gym profiles', async () => {
    const state = (await get('/api/state')).json;
    const extra = Array.from({ length: 20 }, (_, i) => ({ ...state.gymProfiles[0], id: `g${i}` }));
    await expect400(call('PUT', '/api/settings', { gymProfiles: [...state.gymProfiles, ...extra] }));
  });
  it('the settings action log records only validated fields', async () => {
    const r = await call('PUT', '/api/settings', { defaultTimezone: 'Asia/Shanghai', junk: 'y'.repeat(10_000) });
    expect(r.status).toBe(200);
    const row = await db.prepare('SELECT json FROM action_log ORDER BY id DESC LIMIT 1').first<{ json: string }>();
    expect(row!.json.length).toBeLessThan(1000); // the 10 KB junk field is not persisted
    expect(JSON.parse(row!.json)).toEqual({ type: 'settings', settings: { defaultTimezone: 'Asia/Shanghai' } });
  });
});

describe('content', () => {
  it('returns every content module', async () => {
    const { json } = await get('/api/content');
    expect(Object.keys(json).sort()).toEqual(
      ['alignmentRule', 'dailyRoutine', 'finishers', 'fsl', 'morningDrills', 'morningDrillsNote', 'selfChecks', 'travelStrength', 'warmups'].sort(),
    );
  });
});
