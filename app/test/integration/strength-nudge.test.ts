import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../../src/index';
import { __setTelegramFetchForTesting } from '../../src/telegram/webhook';
import { __setIntervalsFetchForTesting } from '../../src/integrations/intervals';
import { runIntervalsSync } from '../../src/sync';
import { loadPlannerState, savePlannerState, upsertConstraint } from '../../src/store/db';
import { planDays } from '../../src/domain/planner';
import { performAction } from '../../src/http/api';
import { mapIcuActivity, type IcuActivity } from '../../src/domain/activityMap';
import type { SessionRef } from '../../src/domain/types';
import { db, fakeTelegram, migrate, resetDb, tgEnv } from './helpers';

const NOW = new Date('2026-10-08T18:00:00Z'); // Thu 8 Oct, 20:00 in Berlin
const TODAY = '2026-10-08';
const env = (): Env => ({ ...tgEnv(), ROLE: 'app', INTERVALS_API_KEY: 'icu-key-never-real-456' });
const STRENGTH = (over: Partial<IcuActivity> = {}): IcuActivity => ({ id: 201, type: 'WeightTraining', name: 'Gym', start_date_local: `${TODAY}T07:00:00`, moving_time: 3600, ...over });

let tg: ReturnType<typeof fakeTelegram>;
let acts: IcuActivity[];

beforeAll(migrate);
beforeEach(async () => {
  await resetDb();
  await loadPlannerState(db);
  tg = fakeTelegram();
  __setTelegramFetchForTesting(tg.fetch);
  acts = [];
  __setIntervalsFetchForTesting((async () => Response.json(acts)) as typeof fetch);
});
afterEach(() => {
  __setTelegramFetchForTesting(null);
  __setIntervalsFetchForTesting(null);
});

async function plannedLift(): Promise<Extract<SessionRef, { kind: 'lift' | 'lift-test' }>> {
  const s = planDays(await loadPlannerState(db), TODAY, 1)[0]!.sessions.find((x) => x.status === 'planned' && (x.kind === 'lift' || x.kind === 'lift-test'));
  if (!s) throw new Error('no lift planned in the default state on the test day');
  return s as Extract<SessionRef, { kind: 'lift' | 'lift-test' }>;
}
const nudges = () => tg.calls.filter((c) => String(c.body.text).startsWith('⌚ Strength session synced'));
const keyboardData = (c: { body: Record<string, unknown> }) =>
  ((c.body.reply_markup as { inline_keyboard: Array<Array<{ callback_data: string }>> }).inline_keyboard).flat().map((b) => b.callback_data);

describe('strength Activities', () => {
  it('map to sport strength', () => {
    expect(mapIcuActivity(STRENGTH())?.activity.sport).toBe('strength');
    expect(mapIcuActivity(STRENGTH({ type: 'Strength Training' }))?.activity.sport).toBe('strength');
  });

  it('are stored as credited, listed, and never change PlannerState', async () => {
    const before = await loadPlannerState(db);
    acts = [STRENGTH()];
    const r = await runIntervalsSync(env(), NOW);
    expect(r.synced).toBe(0);
    expect(await loadPlannerState(db)).toEqual(before);
    const row = await db.prepare('SELECT json FROM activities WHERE id = ?').bind('icu:201').first<{ json: string }>();
    expect(JSON.parse(row!.json)).toMatchObject({ sport: 'strength', credited: true });
  });

  it('nudge once, with the planned lift\'s usual buttons, when the lift is still pending today', async () => {
    const ref = await plannedLift();
    acts = [STRENGTH()];
    await runIntervalsSync(env(), NOW);
    expect(nudges()).toHaveLength(1);
    const n = nudges()[0]!;
    if (ref.kind === 'lift') {
      expect(String(n.body.text)).toContain(`log your ${ref.lift[0]!.toUpperCase()}${ref.lift.slice(1)}`);
      expect(keyboardData(n).some((d) => d.startsWith('a|q|') || d.startsWith('a|d|'))).toBe(true);
    }
    await runIntervalsSync(env(), new Date(NOW.getTime() + 2 * 3600_000));
    expect(nudges()).toHaveLength(1); // same Activity: never again
  });

  it('no nudge when the lift was already done (Telegram first)', async () => {
    const ref = await plannedLift();
    await performAction(db, ref.kind === 'lift'
      ? { type: 'done', date: TODAY, ref, ...(ref.week !== 'reentry' && ref.week !== 4 ? { amrapReps: 5 } : {}) }
      : { type: 'skip', date: TODAY, ref });
    acts = [STRENGTH()];
    await runIntervalsSync(env(), NOW);
    expect(nudges()).toHaveLength(0);
  });

  it('no nudge for a late Activity', async () => {
    await plannedLift();
    acts = [STRENGTH({ start_date_local: '2026-10-07T07:00:00' })];
    await runIntervalsSync(env(), NOW);
    expect(nudges()).toHaveLength(0);
  });

  it('no nudge when no lift is planned', async () => {
    await upsertConstraint(db, { id: 'mtn', start: TODAY, end: TODAY, mountain: true });
    expect(planDays(await loadPlannerState(db), TODAY, 1)[0]!.sessions.some((s) => s.kind === 'lift' && s.status === 'planned')).toBe(false);
    acts = [STRENGTH()];
    await runIntervalsSync(env(), NOW);
    expect(nudges()).toHaveLength(0);
  });

  it('TM Test gets the /test hint', async () => {
    const st = await loadPlannerState(db);
    await savePlannerState(db, { ...st, testWeek: { dates: { squat: TODAY, bench: TODAY, deadlift: TODAY, ohp: TODAY }, results: {} } } as typeof st);
    const day = planDays(await loadPlannerState(db), TODAY, 1)[0]!;
    expect(day.sessions.some((s) => s.kind === 'lift-test' && s.status === 'planned')).toBe(true);
    acts = [STRENGTH()];
    await runIntervalsSync(env(), NOW);
    expect(nudges()).toHaveLength(1);
    expect(String(nudges()[0]!.body.text)).toContain('/test squat');
  });
});
