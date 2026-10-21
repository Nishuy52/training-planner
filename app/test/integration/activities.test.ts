import { SELF } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { insertActivity, loadPlannerState } from '../../src/store/db';
import { todayFor } from '../../src/http/api';
import { addDays } from '../../src/domain/dates';
import { db, migrate, resetDb } from './helpers';

const get = async (p: string) => {
  const r = await SELF.fetch(`http://localhost${p}`);
  return { status: r.status, json: (await r.json()) as any };
};

beforeAll(migrate);
beforeEach(resetDb);

describe('GET /api/activities', () => {
  it('lists Activities from both sources, newest first, within the window', async () => {
    const today = todayFor(await loadPlannerState(db));
    await insertActivity(db, 'icu:1', addDays(today, -1), 'intervals', { name: 'Ridge hike', sport: 'hike', km: 8, vertM: 600, hours: 3.5, load: 80 });
    await insertActivity(db, `log:${today}:1`, today, 'telegram', { name: 'Hike (/log)', sport: 'hike', hours: 2, vertM: 300, load: 50 });
    await insertActivity(db, 'icu:old', addDays(today, -61), 'intervals', { name: 'Old run', sport: 'run', km: 10 });

    const { status, json } = await get('/api/activities?days=60');
    expect(status).toBe(200);
    expect(json.entries).toEqual([
      { date: today, name: 'Hike (/log)', sport: 'hike', hours: 2, vertM: 300, load: 50, source: 'telegram' },
      { date: addDays(today, -1), name: 'Ridge hike', sport: 'hike', km: 8, vertM: 600, hours: 3.5, load: 80, source: 'intervals' },
    ]);
    expect((await get('/api/activities?days=90')).json.entries).toHaveLength(3);
  });

  it('a /log hike on a day with a synced intervals.icu hike is not listed (counted once in the weekly totals)', async () => {
    const today = todayFor(await loadPlannerState(db));
    const y = addDays(today, -1);
    await insertActivity(db, `log:${y}:a1`, y, 'telegram', { name: 'Hike (/log)', sport: 'hike', hours: 3, vertM: 700, load: 70 });
    await insertActivity(db, 'icu:9', y, 'intervals', { name: 'Ridge hike', sport: 'hike', km: 8, vertM: 600, credited: true });
    await insertActivity(db, `log:${today}:b2`, today, 'telegram', { name: 'Hike (/log)', sport: 'hike', hours: 2, vertM: 300, load: 50 });
    await insertActivity(db, 'icu:10', today, 'intervals', { name: 'Run', sport: 'run', km: 5 });
    const { json } = await get('/api/activities');
    expect(json.entries.map((e: any) => `${e.date === today ? 'today' : 'y'}:${e.source}:${e.sport}`)).toEqual([
      'today:intervals:run', 'today:telegram:hike', 'y:intervals:hike',
    ]);
    expect(json.entries.find((e: any) => e.name === 'Ridge hike')).not.toHaveProperty('credited');
  });

  it('defaults to 60 days; 400 on a bad days value', async () => {
    expect((await get('/api/activities')).json).toEqual({ entries: [] });
    expect((await get('/api/activities?days=0')).status).toBe(400);
    expect((await get('/api/activities?days=abc')).status).toBe(400);
  });
});
