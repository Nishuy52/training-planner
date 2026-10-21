import { createExecutionContext, createScheduledController, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import worker, { type Env } from '../../src/index';
import { __setTelegramFetchForTesting } from '../../src/telegram/webhook';
import { __setIntervalsFetchForTesting } from '../../src/integrations/intervals';
import { runIntervalsSync } from '../../src/sync';
import { getKV, loadPlannerState, savePlannerState, setKV, upsertClubEvent } from '../../src/store/db';
import { listBenchmarks } from '../../src/store/progress';
import { cmdBench } from '../../src/telegram/benchmark';
import type { IcuActivity } from '../../src/domain/activityMap';
import { db, fakeTelegram, migrate, resetDb, tgEnv } from './helpers';

const KEY = 'icu-key-never-real-456';
const NOW = new Date('2026-10-08T18:00:00Z'); // Thu 8 Oct, 20:00 in Berlin
const icuEnv = (over: Partial<Env> = {}): Env => ({ ...tgEnv(), ROLE: 'app', INTERVALS_API_KEY: KEY, ...over });

const HIKE: IcuActivity = { id: 101, type: 'Hike', name: 'Ridge hike', start_date_local: '2026-10-08T09:00:00', distance: 8000, moving_time: 12600, total_elevation_gain: 600, icu_training_load: 80 };
const LIFT: IcuActivity = { id: 102, type: 'WeightTraining', name: 'Gym', start_date_local: '2026-10-08T07:00:00', moving_time: 3600 };

let tg: ReturnType<typeof fakeTelegram>;
let icu: { activities: IcuActivity[]; urls: URL[]; status: number };

beforeAll(migrate);
beforeEach(async () => {
  await resetDb();
  await loadPlannerState(db);
  tg = fakeTelegram();
  __setTelegramFetchForTesting(tg.fetch);
  icu = { activities: [], urls: [], status: 200 };
  __setIntervalsFetchForTesting((async (input: RequestInfo | URL) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    icu.urls.push(url);
    return icu.status === 200 ? Response.json(icu.activities) : new Response('no', { status: icu.status });
  }) as typeof fetch);
});
afterEach(() => {
  __setTelegramFetchForTesting(null);
  __setIntervalsFetchForTesting(null);
  vi.restoreAllMocks();
});

/** env.DB whose first `n` batches that write the state row throw (a transient D1 failure). */
function failingStateWrites(n: number): D1Database {
  const writes = new WeakSet<object>();
  return new Proxy(db, {
    get(target, prop) {
      if (prop === 'prepare') {
        return (sql: string) => {
          const stmt = target.prepare(sql);
          if (/^\s*(UPDATE|INSERT INTO) state /i.test(sql)) {
            // bind() returns a new statement: mark that one too.
            const bind = stmt.bind.bind(stmt);
            stmt.bind = (...v: unknown[]) => { const b = bind(...v); writes.add(b); return b; };
            writes.add(stmt);
          }
          return stmt;
        };
      }
      if (prop === 'batch') {
        return async (stmts: D1PreparedStatement[]) => {
          if (n > 0 && stmts.some((s) => writes.has(s))) { n--; throw new Error('D1_ERROR: transient'); }
          return target.batch(stmts);
        };
      }
      const v = Reflect.get(target, prop, target);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
}

const hour = (h: number) => new Date(NOW.getTime() + h * 3600_000);

describe('intervals.icu sync', () => {
  it('first sync credits a 600 m Hike as Hill Ruck + Long run and sends one notice', async () => {
    icu.activities = [HIKE];
    const r = await runIntervalsSync(icuEnv(), NOW);
    expect(r).toMatchObject({ synced: 1 });
    expect(icu.urls).toHaveLength(1);
    expect(icu.urls[0]!.searchParams.get('oldest')).toBe('2026-09-24');
    expect(icu.urls[0]!.searchParams.get('newest')).toBe('2026-10-08');

    const st = await loadPlannerState(db);
    expect(st.ruck.lastCredit).toBe('2026-10-08');
    expect(st.runsThisWeek['2026-10-05']).toContain('long');

    expect(tg.calls).toHaveLength(1);
    expect(tg.calls[0]!.body.text).toBe('⌚ Synced: "Ridge hike" (8 km · 600 m ↑) → Hill Ruck credit + Long run');
    expect(r.notices).toEqual([tg.calls[0]!.body.text]);

    const row = await db.prepare('SELECT id, date, source, json FROM activities').first<{ id: string; date: string; source: string; json: string }>();
    expect(row).toMatchObject({ id: 'icu:101', date: '2026-10-08', source: 'intervals' });
    expect(JSON.parse(row!.json)).toMatchObject({ name: 'Ridge hike', sport: 'hike', km: 8, vertM: 600 });
    expect(await getKV(db, 'intervalsLastSyncAt')).toBe(NOW.toISOString());
  });

  it('a second sync with the same activities credits nothing and sends nothing', async () => {
    icu.activities = [HIKE];
    await runIntervalsSync(icuEnv(), NOW);
    const before = await loadPlannerState(db);
    const r = await runIntervalsSync(icuEnv(), hour(2));
    expect(r).toMatchObject({ synced: 0, notices: [] });
    expect(icu.urls[1]!.searchParams.get('oldest')).toBe('2026-09-24'); // always today − 14 days
    expect(await loadPlannerState(db)).toEqual(before);
    expect(tg.calls).toHaveLength(1);
  });

it('WeightTraining is stored as a strength Activity but never credited or put in the batch notice', async () => {    icu.activities = [LIFT];    expect(await runIntervalsSync(icuEnv(), NOW)).toMatchObject({ synced: 0, notices: [] });    expect((await db.prepare('SELECT COUNT(*) AS n FROM activities').first<{ n: number }>())!.n).toBe(1);  });

  it('a climb credits that day\'s planned Club Event climb as done', async () => {
    await upsertClubEvent(db, { id: 'v1', date: '2026-10-08', time: '18:00', title: 'Friday climbing', venue: 'Wall A', type: 'partner' });
    icu.activities = [{ id: 'c1', type: 'RockClimbing', name: 'Wall A <laps>', start_date_local: '2026-10-08T18:05:00', moving_time: 7200 }];
    await runIntervalsSync(icuEnv(), NOW);
    const st = await loadPlannerState(db);
    expect(st.doneByDate['2026-10-08']).toEqual([{ kind: 'climb', eventId: 'v1' }]);
    expect(tg.calls[0]!.body.text).toBe('⌚ Synced: "Wall A &lt;laps&gt;" (2 h) → Climb');
  });

  describe('a run Activity that completes a planned run Benchmark', () => {
    /** Thu 8 Oct is a Benchmark day: run week 3 (deload) from 14 Sep, Thursday the only run Slot, Easy already done. */
    async function benchmarkThursday(next: '2k4' | 'hill') {
      const st = await loadPlannerState(db);
      st.run = { ...st.run, runStartMonday: '2026-09-14', nextBenchmark: next };
      st.defaultWeek = { 0: {}, 1: {}, 2: {}, 3: { am: 'run' }, 4: {}, 5: {}, 6: {} };
      st.runsThisWeek['2026-10-05'] = ['easy'];
      await savePlannerState(db, st);
    }
    const RUN = (over: Partial<IcuActivity>): IcuActivity => ({ id: 'tt', type: 'Run', name: 'TT', start_date_local: '2026-10-08T07:00:00', ...over });

    it('2.4 km: the result is filled from the watch (elapsed time) and named in the notice; /bench corrects it', async () => {
      await benchmarkThursday('2k4');
      icu.activities = [RUN({ distance: 2410, moving_time: 640, elapsed_time: 655 })];
      await runIntervalsSync(icuEnv(), NOW);
      expect((await loadPlannerState(db)).doneByDate['2026-10-08']).toEqual([{ kind: 'run', run: 'benchmark-2k4' }]);
      expect(await listBenchmarks(db, '2026-10-01', '2026-10-31')).toEqual([{ id: expect.any(Number), date: '2026-10-08', kind: '2k4', timeS: 655, auto: true }]);
      expect(tg.calls).toHaveLength(1);
      expect(tg.calls[0]!.body.text).toContain(' · 2.4 km Benchmark: 10:55 (from watch) · /bench mm:ss to correct');

      expect(await cmdBench(db, ['10:50'])).toBe('✅ 2.4 km 10:50 saved for 2026-10-08.');
      expect(await listBenchmarks(db, '2026-10-01', '2026-10-31')).toEqual([{ id: expect.any(Number), date: '2026-10-08', kind: '2k4', timeS: 650 }]);
      // a manual result is not overwritten by the next /bench
      expect(await cmdBench(db, ['10:40'])).toContain('No run Benchmark');
    });

    it('2.4 km: a run that is not 2.2–2.8 km completes the Session but leaves the result waiting', async () => {
      await benchmarkThursday('2k4');
      icu.activities = [RUN({ distance: 6000, moving_time: 1800 })];
      await runIntervalsSync(icuEnv(), NOW);
      expect(await listBenchmarks(db, '2026-10-01', '2026-10-31')).toEqual([{ id: expect.any(Number), date: '2026-10-08', kind: '2k4' }]);
      expect(tg.calls[0]!.body.text).not.toContain('Benchmark:');
    });

    it('hill loop: any run that day, moving time when there is no elapsed time', async () => {
      await benchmarkThursday('hill');
      icu.activities = [RUN({ distance: 6100, moving_time: 2290, total_elevation_gain: 380 })];
      await runIntervalsSync(icuEnv(), NOW);
      expect(await listBenchmarks(db, '2026-10-01', '2026-10-31')).toEqual([{ id: expect.any(Number), date: '2026-10-08', kind: 'hill', timeS: 2290, auto: true }]);
      expect(tg.calls[0]!.body.text).toContain('Hill loop Benchmark: 38:10 (from watch)');
    });
  });

  it('an activity that counts as nothing is listed as logged; several go in one message, oldest first', async () => {
    icu.activities = [HIKE, { id: 103, type: 'Walk', name: 'Stroll', start_date_local: '2026-10-07T12:00:00', distance: 3000, moving_time: 6000, total_elevation_gain: 40 }];
    const r = await runIntervalsSync(icuEnv(), NOW);
    expect(r.synced).toBe(2);
    expect(tg.calls).toHaveLength(1);
    expect(String(tg.calls[0]!.body.text).split('\n')).toEqual([
      '⌚ Synced: "Stroll" (3 km · 40 m ↑) → logged (late)',
      '⌚ Synced: "Ridge hike" (8 km · 600 m ↑) → Hill Ruck credit + Long run',
    ]);
  });

  it('a late run (dated yesterday) only feeds the weekly totals: no run credit, no Done', async () => {
    icu.activities = [{ id: 201, type: 'Run', name: 'Yesterday', start_date_local: '2026-10-07T07:00:00', distance: 8000, moving_time: 2700, total_elevation_gain: 120 }];
    const before = await loadPlannerState(db);
    expect(await runIntervalsSync(icuEnv(), NOW)).toMatchObject({ synced: 1 });
    const st = await loadPlannerState(db);
    expect(st.runsThisWeek).toEqual(before.runsThisWeek);
    expect(st.doneByDate).toEqual(before.doneByDate);
    expect(tg.calls[0]!.body.text).toBe('⌚ Synced: "Yesterday" (8 km · 120 m ↑) → logged (late)');
  });

  it('a late 600 m hike moves the Hill Ruck clock forward only, with no Long run', async () => {
    icu.activities = [{ ...HIKE, start_date_local: '2026-10-06T09:00:00' }];
    expect(await runIntervalsSync(icuEnv(), NOW)).toMatchObject({ synced: 1 });
    const st = await loadPlannerState(db);
    expect(st.ruck.lastCredit).toBe('2026-10-06');
    expect(st.runsThisWeek['2026-10-05'] ?? []).not.toContain('long');
    expect(tg.calls[0]!.body.text).toBe('⌚ Synced: "Ridge hike" (8 km · 600 m ↑) → Hill Ruck clock (late)');
  });

  it('an Activity uploaded late (dated 3 days ago, after a sync already ran) is still fetched and counted', async () => {
    await runIntervalsSync(icuEnv(), NOW);
    icu.activities = [{ ...HIKE, id: 401, name: 'Trip hike', start_date_local: '2026-10-05T09:00:00' }];
    const r = await runIntervalsSync(icuEnv(), hour(2));
    expect(icu.urls[1]!.searchParams.get('oldest')).toBe('2026-09-24');
    expect(r).toMatchObject({ synced: 1 });
    expect((await loadPlannerState(db)).ruck.lastCredit).toBe('2026-10-05');
    expect(r.notices).toEqual(['⌚ Synced: "Trip hike" (8 km · 600 m ↑) → Hill Ruck clock (late)']);
  });

  it('a failure between claiming and crediting an Activity is retried by the next sync, exactly once', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    icu.activities = [HIKE];
    const r1 = await runIntervalsSync(icuEnv({ DB: failingStateWrites(1) }), NOW);
    expect(r1.error).toBeDefined();
    expect(r1.synced).toBe(0);
    expect((await loadPlannerState(db)).runsThisWeek).toEqual({});
    const claimed = await db.prepare("SELECT json FROM activities WHERE id = 'icu:101'").first<{ json: string }>();
    expect(JSON.parse(claimed!.json)).toMatchObject({ credited: false });

    icu.activities = []; // even when intervals.icu no longer returns it
    const r2 = await runIntervalsSync(icuEnv(), hour(2));
    expect(r2).toMatchObject({ synced: 1, notices: ['⌚ Synced: "Ridge hike" (8 km · 600 m ↑) → Hill Ruck credit + Long run'] });
    const st = await loadPlannerState(db);
    expect(st.runsThisWeek['2026-10-05']).toEqual(['long']);
    expect(st.ruck.lastCredit).toBe('2026-10-08');
    const credited = await db.prepare("SELECT json FROM activities WHERE id = 'icu:101'").first<{ json: string }>();
    expect(JSON.parse(credited!.json)).toMatchObject({ credited: true });

    icu.activities = [HIKE];
    expect(await runIntervalsSync(icuEnv(), hour(4))).toMatchObject({ synced: 0, notices: [] });
    expect((await loadPlannerState(db)).runsThisWeek['2026-10-05']).toEqual(['long']);
  });

  it('two syncs retrying the same claimed Activity credit it once', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    icu.activities = [{ ...HIKE, total_elevation_gain: 200, icu_training_load: 30, moving_time: 3600 }]; // an Easy run
    await runIntervalsSync(icuEnv({ DB: failingStateWrites(1) }), NOW);
    icu.activities = [];
    const [a, b] = await Promise.all([runIntervalsSync(icuEnv(), hour(2), { force: true }), runIntervalsSync(icuEnv(), hour(2), { force: true })]);
    expect(a.synced + b.synced).toBe(1);
    expect((await loadPlannerState(db)).runsThisWeek['2026-10-05']).toEqual(['easy']);
  });

  it('the Telegram notice truncates long names and stays under 3500 characters, summarising the rest', async () => {
    const long = 'x'.repeat(200);
    icu.activities = Array.from({ length: 60 }, (_, i) => ({
      id: 500 + i, type: 'Run', name: `${long}${i}`, start_date_local: `2026-10-08T${String(6 + Math.floor(i / 6)).padStart(2, '0')}:${String((i % 6) * 10).padStart(2, '0')}:00`, distance: 5000,
    }));
    const r = await runIntervalsSync(icuEnv(), NOW);
    expect(r.synced).toBe(60);
    expect(tg.calls).toHaveLength(1);
    const text = String(tg.calls[0]!.body.text);
    expect(text.length).toBeLessThan(3500);
    const lines = text.split('\n');
    expect(lines[0]).toContain(`"${'x'.repeat(59)}…"`);
    expect(lines.at(-1)).toMatch(/^\+\d+ more$/);
    expect(lines.length - 1 + Number(/\d+/.exec(lines.at(-1)!)![0])).toBe(60);
  });

  it('the 55-minute gate holds; force (POST /api/sync) bypasses it', async () => {
    await setKV(db, 'intervalsLastSyncAt', hour(-0.5).toISOString());
    icu.activities = [HIKE];
    expect(await runIntervalsSync(icuEnv(), NOW)).toMatchObject({ synced: 0, skipped: 'recent' });
    expect(icu.urls).toEqual([]);

    const ctx = createExecutionContext();
    const res = await worker.fetch(new Request('http://localhost/api/sync', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }), icuEnv(), ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { synced: number; notices: string[] };
    expect(json.synced).toBe(1);
    expect(json.notices[0]).toContain('Ridge hike');
  });

  it('after 55 minutes the gate opens', async () => {
    await setKV(db, 'intervalsLastSyncAt', hour(-1).toISOString());
    await runIntervalsSync(icuEnv(), NOW);
    expect(icu.urls).toHaveLength(1);
  });

  it('an empty key means no fetch at all, from the cron or /api/sync', async () => {
    expect(await runIntervalsSync(icuEnv({ INTERVALS_API_KEY: '' }), NOW, { force: true })).toMatchObject({ synced: 0, skipped: 'off' });
    const ctx = createExecutionContext();
    const res = await worker.fetch(new Request('http://localhost/api/sync', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }), icuEnv({ INTERVALS_API_KEY: undefined }), ctx);
    await waitOnExecutionContext(ctx);
    expect(await res.json()).toMatchObject({ synced: 0, skipped: 'off' });
    expect(icu.urls).toEqual([]);
  });

  it('an intervals.icu error is logged without the key and does not throw; the gate stays open', async () => {
    const errors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errors.push(a.map(String).join(' ')); });
    icu.status = 401;
    const r = await runIntervalsSync(icuEnv(), NOW);
    expect(r.synced).toBe(0);
    expect(r.error).toContain('401');
    expect(errors.join('\n')).toContain('401');
    expect(errors.join('\n')).not.toContain(KEY);
    expect(await getKV(db, 'intervalsLastSyncAt')).toBeNull();

    const ctx = createExecutionContext();
    const res = await worker.fetch(new Request('http://localhost/api/sync', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }), icuEnv(), ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(502);
    expect(await res.text()).not.toContain(KEY);
  });

  it('the cron runs the sync after the reminders (app role only)', async () => {
    icu.activities = [HIKE];
    const tick = async (role: string) => {
      const ctx = createExecutionContext();
      await worker.scheduled(createScheduledController({ scheduledTime: NOW.getTime(), cron: '*/5 * * * *' }), icuEnv({ ROLE: role }), ctx);
      await waitOnExecutionContext(ctx);
    };
    await tick('bot');
    expect(icu.urls).toEqual([]);
    await tick('app');
    expect(icu.urls).toHaveLength(1);
    const texts = tg.calls.map((c) => String(c.body.text));
    expect(texts.at(-1)).toContain('⌚ Synced');
    expect(texts.length).toBeGreaterThan(1); // the morning/mobility reminders went first
  });
});
