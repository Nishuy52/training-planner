// Progress data API (docs/api-contract.md): Training Max history, Benchmark Results, weekly run totals and Adherence.
import type { Hono } from 'hono';
import type { Env } from '../index';
import type { ISODate, PlannerState } from '../domain/types';
import { addDays, daysBetween, mondayOf } from '../domain/dates';
import { weeklyTarget } from '../domain/running';
import { weekAdherence } from '../domain/adherence';
import { isTimeKind, resultFits, type BenchmarkInput, type BenchmarkKind } from '../domain/benchmark';
import { listActivities, loadPlannerState } from '../store/db';
import { getBenchmark, latestPendingBenchmark, listBenchmarks, listCheckIns, listTmHistory, setBenchmarkResult } from '../store/progress';
import { appendActionLog } from '../store/db';
import { bad, daysParam, num, obj, parseBenchmarkInput, todayFor } from './api';

export type WeeklyRun = { monday: ISODate; km: number; vertM: number; targetKm: number | null; targetVertM: number | null; deload: boolean };

const round1 = (n: number) => Math.round(n * 10) / 10;

/** Run + hike km and metres climbed per ISO week (as the Running tab totals), next to that week's run target. */
async function weeklyRuns(db: D1Database, state: PlannerState, mondays: ISODate[], to: ISODate): Promise<WeeklyRun[]> {
  const acts = (await listActivities(db, mondays[0]!, 100_000)).filter((a) => a.date <= to && (a.sport === 'run' || a.sport === 'hike'));
  return mondays.map((monday) => {
    const week = acts.filter((a) => mondayOf(a.date) === monday);
    const index = Math.floor(daysBetween(state.run.runStartMonday, monday) / 7);
    const target = index >= 0 ? weeklyTarget(index) : null; // weeks before the run plan started have no target
    return {
      monday,
      km: round1(week.reduce((n, a) => n + (a.km ?? 0), 0)),
      vertM: Math.round(week.reduce((n, a) => n + (a.vertM ?? 0), 0)),
      targetKm: target?.km ?? null,
      targetVertM: target?.vertM ?? null,
      deload: target?.deload ?? false,
    };
  });
}

export function progressRoutes(api: Hono<{ Bindings: Env }>): void {
  api.get('/api/progress', async (c) => {
    const db = c.env.DB;
    const weeks = daysParam(c.req.query('weeks'), 12, 104, 'weeks');
    const state = await loadPlannerState(db);
    const today = todayFor(state);
    const thisMonday = mondayOf(today);
    const mondays = Array.from({ length: weeks }, (_, i) => addDays(thisMonday, 7 * (i - weeks + 1)));
    const from = mondays[0]!;
    const checkIns = await listCheckIns(db, from, today, state.doneByDate);
    // Weeks before the app was first used have no Check-ins by definition; leave them out
    // rather than report them as all missed.
    // First use = the earliest of the first action-log entry and the earliest (possibly backdated) Check-in.
    const first = await db.prepare('SELECT MIN(at) AS at FROM action_log').first<{ at: string | null }>();
    const starts = [first?.at?.slice(0, 10), ...checkIns.map((ci) => ci.date)].filter((d): d is string => !!d).sort();
    const firstMonday = starts.length ? mondayOf(starts[0]!) : thisMonday;
    return c.json({
      tmHistory: await listTmHistory(db, from, today),
      benchmarks: (await listBenchmarks(db, from, today, { withResult: true })).reverse(),
      weeklyRuns: await weeklyRuns(db, state, mondays, today),
      adherence: mondays.filter((m) => m >= firstMonday).map((m) => weekAdherence(state, m, today, checkIns)),
    });
  });

  api.get('/api/benchmark-results', async (c) => {
    const db = c.env.DB;
    const days = daysParam(c.req.query('days'), 365, 1000);
    const today = todayFor(await loadPlannerState(db));
    return c.json({ entries: await listBenchmarks(db, addDays(today, 1 - days), today) });
  });

  // Add (or correct) a Benchmark Result: on entry `id`, else on the most recent Benchmark Session done without one.
  api.post('/api/benchmark-results', async (c) => {
    const db = c.env.DB;
    const b = obj(await c.req.json().catch(() => bad('body must be JSON')), 'body');
    const result: BenchmarkInput = parseBenchmarkInput(b, 'body');
    const kinds: BenchmarkKind[] = 'timeS' in result ? ['2k4', 'hill'] : ['autobelay'];
    const entry = b.id === undefined
      ? await latestPendingBenchmark(db, kinds, undefined, { orAuto: true })
      : await getBenchmark(db, num(b.id, 'id', 1, Number.MAX_SAFE_INTEGER, { int: true }));
    if (!entry) {
      return b.id === undefined
        ? c.json({ error: `no ${'timeS' in result ? 'run' : 'auto-belay'} Benchmark Session is waiting for a result` }, 409)
        : c.json({ error: 'not found' }, 404);
    }
    if (!resultFits(entry.kind, result)) bad(isTimeKind(entry.kind) ? 'a run Benchmark takes timeS' : 'the auto-belay Benchmark takes grade and minutes');
    await setBenchmarkResult(db, entry.id, result);
    await appendActionLog(db, { type: 'benchmark-result', id: entry.id, date: entry.date, kind: entry.kind, result });
    return c.json(await getBenchmark(db, entry.id));
  });
}
