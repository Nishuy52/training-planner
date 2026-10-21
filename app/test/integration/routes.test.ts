import { SELF } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { addDays } from '../../src/domain/dates';
import { loadPlannerState } from '../../src/store/db';
import { todayFor } from '../../src/http/api';
import { db, migrate, resetDb } from './helpers';

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const r = await SELF.fetch(`http://localhost${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, json: (await r.json()) as any };
}
const get = (p: string) => call('GET', p);
const post = (p: string, b: unknown) => call('POST', p, b);
const put = (p: string, b: unknown) => call('PUT', p, b);
async function expect400(p: Promise<{ status: number; json: any }>) {
  const r = await p;
  expect(r.status).toBe(400);
  expect(typeof r.json.error).toBe('string');
}

const hillRep = {
  id: 'hill-repeats-x3', name: 'Hill repeats', area: 'Hometown', km: 6, vertM: 450, kind: 'repeat', repeats: 3,
  url: 'https://example.com/routes/hill-repeats-x3', suits: ['quality-vert', 'long', 'ruck'],
};
const lakeLoop = { id: 'lake-loop', name: 'Lake loop', area: 'Hometown', km: 3.3, vertM: 20, kind: 'loop', suits: ['easy', 'quality-speed'] };

beforeAll(migrate);
beforeEach(resetDb);

/** Runs planned in the next `n` days, from GET /api/plan (which plans from today). */
async function plannedRuns(n: number) {
  const { json } = await get(`/api/plan?days=${n}`);
  return (json.days as any[]).flatMap((d) => d.sessions.map((s: any, i: number) => ({ date: d.date, s, det: json.details[d.date][i] })))
    .filter((x) => x.s.kind === 'run' && x.s.status === 'planned');
}

describe('routes library', () => {
  it('starts empty; POST upserts a validated Route (unknown keys dropped); GET lists it', async () => {
    expect(await get('/api/routes')).toEqual({ status: 200, json: { routes: [] } });
    const r = await post('/api/routes', { ...lakeLoop, extra: 'x' });
    expect(r).toEqual({ status: 200, json: lakeLoop });
    await post('/api/routes', hillRep);
    expect((await get('/api/routes')).json.routes.map((x: any) => x.id)).toEqual(['hill-repeats-x3', 'lake-loop']); // by name, not insertion
    await post('/api/routes', { ...hillRep, km: 6.5 });
    expect((await get('/api/routes')).json.routes.find((x: any) => x.id === 'hill-repeats-x3').km).toBe(6.5);
  });

  it('400 on invalid Routes', async () => {
    await expect400(post('/api/routes', { ...hillRep, id: 'has space' }));
    await expect400(post('/api/routes', { ...hillRep, id: 'x'.repeat(41) }));
    await expect400(post('/api/routes', { ...hillRep, url: 'http://example.com' }));
    await expect400(post('/api/routes', { ...hillRep, url: 'javascript:alert(1)' }));
    await expect400(post('/api/routes', { ...hillRep, url: 'not a url' }));
    await expect400(post('/api/routes', { ...hillRep, km: 101 }));
    await expect400(post('/api/routes', { ...hillRep, km: -1 }));
    await expect400(post('/api/routes', { ...hillRep, vertM: 5001 }));
    await expect400(post('/api/routes', { ...hillRep, repeats: 0 }));
    await expect400(post('/api/routes', { ...hillRep, repeats: 51 }));
    await expect400(post('/api/routes', { ...hillRep, repeats: 2.5 }));
    await expect400(post('/api/routes', { ...hillRep, suits: ['swim'] }));
    await expect400(post('/api/routes', { ...hillRep, suits: 'long' }));
    await expect400(post('/api/routes', { ...hillRep, kind: 'out-and-back' }));
    await expect400(post('/api/routes', { ...hillRep, benchmark: 'flat' }));
    await expect400(post('/api/routes', { ...hillRep, name: '' }));
    await expect400(post('/api/routes', { ...hillRep, area: undefined }));
    expect((await get('/api/routes')).json.routes).toEqual([]);
  });

  it('only one Route per Benchmark: a second one is 409, re-saving the same one is fine', async () => {
    const hill = { ...lakeLoop, id: 'hill', benchmark: 'hill', suits: ['benchmark-hill'] };
    expect((await post('/api/routes', hill)).status).toBe(200);
    expect((await post('/api/routes', { ...hill, km: 5 })).status).toBe(200);
    const r = await post('/api/routes', { ...hillRep, benchmark: 'hill' });
    expect(r.status).toBe(409);
    expect(r.json.error).toMatch(/Benchmark/);
    expect((await post('/api/routes', { ...hillRep, benchmark: '2k4' })).status).toBe(200);
  });

  it('writes pass the CSRF guard', async () => {
    expect((await call('POST', '/api/routes', hillRep, { 'sec-fetch-site': 'cross-site' })).status).toBe(403);
    expect((await call('DELETE', '/api/routes/x', undefined, { 'sec-fetch-site': 'cross-site' })).status).toBe(403);
    expect((await call('PUT', '/api/route-assignments', { assignments: [] }, { 'sec-fetch-site': 'cross-site' })).status).toBe(403);
  });

  it('DELETE removes the Route and its assignments', async () => {
    await post('/api/routes', hillRep);
    await post('/api/routes', lakeLoop);
    expect((await put('/api/route-assignments', { assignments: [
      { date: '2026-10-10', runKind: 'long', routeId: 'hill-repeats-x3' },
      { date: '2026-10-06', runKind: 'easy', routeId: 'lake-loop' },
    ] })).status).toBe(200);
    expect(await call('DELETE', '/api/routes/hill-repeats-x3')).toEqual({ status: 200, json: { ok: true } });
    expect((await get('/api/routes')).json.routes.map((x: any) => x.id)).toEqual(['lake-loop']);
    const { results } = await db.prepare('SELECT route_id FROM route_assignments').all<{ route_id: string }>();
    expect(results.map((r) => r.route_id)).toEqual(['lake-loop']);
    await expect400(call('DELETE', '/api/routes/bad%20id'));
  });
});

describe('PUT /api/route-assignments', () => {
  beforeEach(async () => { await post('/api/routes', hillRep); await post('/api/routes', lakeLoop); });
  const rows = async () => (await db.prepare('SELECT date, run_kind, route_id FROM route_assignments ORDER BY date, run_kind').all()).results;

  it('sets, maps ruck to long, and null clears', async () => {
    const r = await put('/api/route-assignments', { assignments: [
      { date: '2026-10-10', runKind: 'ruck', routeId: 'hill-repeats-x3' },
      { date: '2026-10-06', runKind: 'easy', routeId: 'lake-loop' },
    ] });
    expect(r.status).toBe(200);
    expect(r.json.assignments).toEqual([
      { date: '2026-10-10', runKind: 'long', routeId: 'hill-repeats-x3' },
      { date: '2026-10-06', runKind: 'easy', routeId: 'lake-loop' },
    ]);
    expect(await rows()).toEqual([
      { date: '2026-10-06', run_kind: 'easy', route_id: 'lake-loop' },
      { date: '2026-10-10', run_kind: 'long', route_id: 'hill-repeats-x3' },
    ]);
    await put('/api/route-assignments', { assignments: [{ date: '2026-10-10', runKind: 'long', routeId: 'lake-loop' }, { date: '2026-10-06', runKind: 'easy', routeId: null }] });
    expect(await rows()).toEqual([{ date: '2026-10-10', run_kind: 'long', route_id: 'lake-loop' }]);
  });

  it('400 on bad bodies, and nothing is written', async () => {
    const ok = { date: '2026-10-06', runKind: 'easy', routeId: 'lake-loop' };
    await expect400(put('/api/route-assignments', { assignments: Array.from({ length: 31 }, (_, i) => ({ ...ok, date: addDays('2026-10-01', i) })) }));
    await expect400(put('/api/route-assignments', { assignments: [ok, { ...ok, routeId: 'nope' }] }));
    await expect400(put('/api/route-assignments', { assignments: [{ ...ok, date: '2026-02-30' }] }));
    await expect400(put('/api/route-assignments', { assignments: [{ ...ok, runKind: 'swim' }] }));
    await expect400(put('/api/route-assignments', { assignments: [{ ...ok, routeId: 5 }] }));
    await expect400(put('/api/route-assignments', { assignments: 'x' }));
    await expect400(put('/api/route-assignments', {}));
    expect(await rows()).toEqual([]);
    expect((await put('/api/route-assignments', { assignments: Array.from({ length: 30 }, (_, i) => ({ ...ok, date: addDays('2026-10-01', i) })) })).status).toBe(200);
  });

  it('an assigned Route shows on the run in GET /api/plan', async () => {
    const run = (await plannedRuns(14))[0]!;
    await put('/api/route-assignments', { assignments: [{ date: run.date, runKind: run.s.run, routeId: 'hill-repeats-x3' }] });
    const again = (await plannedRuns(14)).find((x) => x.date === run.date && x.s.run === run.s.run)!;
    expect(again.det.route).toEqual({ id: 'hill-repeats-x3', name: 'Hill repeats', km: 6, vertM: 450, kind: 'repeat', repeats: 3, url: hillRep.url });
  });
});

describe('GET /api/routing-context', () => {
  it('8 days from today with location, timezone, mountain, travel and the planned runs; plus the library', async () => {
    await post('/api/routes', hillRep);
    const today = todayFor(await loadPlannerState(db));
    const { status, json } = await get('/api/routing-context?days=8');
    expect(status).toBe(200);
    expect(json.days).toHaveLength(8);
    expect(json.days[0].date).toBe(today);
    expect(json.library).toEqual([hillRep]);
    for (const d of json.days) {
      expect(d).toMatchObject({ location: 'Hometown', timezone: 'Europe/Berlin', mountain: false, travel: null });
      expect(Array.isArray(d.runs)).toBe(true);
    }
    // The same Sessions as the plan (both plan from today), with the run Rx.
    const runs = await plannedRuns(8);
    const ctxRuns = json.days.flatMap((d: any) => d.runs.map((r: any) => ({ date: d.date, ...r })));
    expect(ctxRuns).toEqual(runs.map((x) => ({ date: x.date, runKind: x.s.run, km: x.det.rx.km, vertM: x.det.rx.vertM, detail: x.det.rx.detail, routeId: null })));
    expect(ctxRuns.length).toBeGreaterThan(0);
  });

  it('shows assignments as routeId and Constraint locations per day', async () => {
    await post('/api/routes', hillRep);
    const today = todayFor(await loadPlannerState(db));
    const run = (await plannedRuns(8))[0]!;
    await put('/api/route-assignments', { assignments: [{ date: run.date, runKind: run.s.run, routeId: 'hill-repeats-x3' }] });
    await post('/api/constraints', { id: 'riverton', start: addDays(today, 6), end: addDays(today, 9), location: 'Riverton, Northshire', note: 'Riverton' });
    const { json } = await get('/api/routing-context?days=8');
    const day = json.days.find((d: any) => d.date === run.date);
    expect(day.runs.find((r: any) => r.runKind === run.s.run).routeId).toBe('hill-repeats-x3');
    expect(json.days[6].location).toBe('Riverton, Northshire');
    expect(json.days[5].location).toBe('Hometown');
  });

  it('days defaults to 8 and is 1-14', async () => {
    expect((await get('/api/routing-context')).json.days).toHaveLength(8);
    expect((await get('/api/routing-context?days=14')).json.days).toHaveLength(14);
    await expect400(get('/api/routing-context?days=15'));
    await expect400(get('/api/routing-context?days=0'));
  });
});

describe('location', () => {
  it('Constraint location round-trips and is validated', async () => {
    const c = { id: 'trip', start: '2026-11-25', end: '2026-12-09', timezone: 'Asia/Tokyo', location: 'Lakeside, Westland' };
    expect((await post('/api/constraints', c)).json).toEqual(c);
    await expect400(post('/api/constraints', { ...c, location: 5 }));
    await expect400(post('/api/constraints', { ...c, location: 'x'.repeat(101) }));
  });

  it('homeLocation defaults to Hometown and is a setting', async () => {
    expect((await get('/api/state')).json.homeLocation).toBe('Hometown');
    const r = await put('/api/settings', { homeLocation: 'Riverton, Northshire' });
    expect(r.status).toBe(200);
    expect(r.json.homeLocation).toBe('Riverton, Northshire');
    expect((await get('/api/routing-context?days=1')).json.days[0].location).toBe('Riverton, Northshire');
    await expect400(put('/api/settings', { homeLocation: '' }));
    await expect400(put('/api/settings', { homeLocation: 'x'.repeat(101) }));
  });
});
