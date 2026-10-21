import { SELF } from 'cloudflare:test';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../../src/index';
import { __setTelegramFetchForTesting } from '../../src/telegram/webhook';
import { __setIntervalsFetchForTesting } from '../../src/integrations/intervals';
import { runIntervalsSync } from '../../src/sync';
import { performAction, todayFor } from '../../src/http/api';
import { loadPlannerState, updateStateWithRetry } from '../../src/store/db';
import { mondayOf } from '../../src/domain/dates';
import type { IcuActivity } from '../../src/domain/activityMap';
import { db, fakeTelegram, migrate, resetDb, tgEnv } from './helpers';

// D3: every state writer is a read-modify-write of the single state row; concurrent writers must not lose updates.

const NOW = new Date('2026-10-08T18:00:00Z'); // Thu 8 Oct, 20:00 in Berlin
const icuEnv = (): Env => ({ ...tgEnv(), ROLE: 'app', INTERVALS_API_KEY: 'icu-key-never-real-789' });
const BIG: IcuActivity = { id: 301, type: 'Hike', name: 'Big', start_date_local: '2026-10-08T09:00:00', distance: 8000, moving_time: 12600, total_elevation_gain: 600, icu_training_load: 80 };
const MEDIUM: IcuActivity = { id: 302, type: 'Hike', name: 'Medium', start_date_local: '2026-10-08T14:00:00', distance: 4000, moving_time: 4000, total_elevation_gain: 200, icu_training_load: 30 };

beforeAll(migrate);
beforeEach(async () => {
  await resetDb();
  await loadPlannerState(db);
  __setTelegramFetchForTesting(fakeTelegram().fetch);
});
afterEach(() => {
  __setTelegramFetchForTesting(null);
  __setIntervalsFetchForTesting(null);
});

describe('concurrent state writers', () => {
  it('two concurrent syncs crediting different hikes keep both credits', async () => {
    let call = 0;
    __setIntervalsFetchForTesting((async () => Response.json(call++ === 0 ? [BIG] : [MEDIUM])) as typeof fetch);
    const [a, b] = await Promise.all([runIntervalsSync(icuEnv(), NOW, { force: true }), runIntervalsSync(icuEnv(), NOW, { force: true })]);
    expect(a.error).toBeUndefined();
    expect(b.error).toBeUndefined();
    const st = await loadPlannerState(db);
    expect(st.ruck.lastCredit).toBe('2026-10-08');
    expect([...(st.runsThisWeek['2026-10-05'] ?? [])].sort()).toEqual(['easy', 'long']);
  });

  it('an action and a settings change at the same time both land', async () => {
    const today = todayFor(await loadPlannerState(db));
    const [, res] = await Promise.all([
      performAction(db, { type: 'activity', date: today, activity: { sport: 'climb' } }),
      SELF.fetch('http://localhost/api/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ rucksEnabled: true }) }),
    ]);
    expect(res.status).toBe(200);
    const st = await loadPlannerState(db);
    expect(st.lastClimbDate).toBe(today);
    expect(st.rucksEnabled).toBe(true);
  });

  it('many concurrent activity credits are all kept', async () => {
    const today = todayFor(await loadPlannerState(db));
    const mon = mondayOf(today);
    await Promise.all([
      performAction(db, { type: 'activity', date: today, activity: { sport: 'hike', load: 30, hours: 1 } }),
      performAction(db, { type: 'activity', date: today, activity: { sport: 'hike', load: 70, hours: 1 } }),
      performAction(db, { type: 'activity', date: today, activity: { sport: 'climb' } }),
    ]);
    const st = await loadPlannerState(db);
    expect([...(st.runsThisWeek[mon] ?? [])].sort()).toEqual(['easy', 'long']);
    expect(st.lastClimbDate).toBe(today);
  });

  it('gives up after 5 conflicting attempts', async () => {
    let attempts = 0;
    await expect(updateStateWithRetry(db, async (st) => {
      attempts++;
      // Another writer commits between our read and our write, every time.
      await db.prepare("UPDATE state SET updated_at = ? WHERE id = 1").bind(`other-${attempts}`).run();
      return { state: st, result: null };
    })).rejects.toThrow(/conflict/i);
    expect(attempts).toBe(5);
  });
});
