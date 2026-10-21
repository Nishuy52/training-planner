import { SELF, createExecutionContext, runDurableObjectAlarm, runInDurableObject, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import worker from '../../src/index';
import { __setTelegramFetchForTesting } from '../../src/telegram/webhook';
import { loadAmrapLog, performAction, todayFor } from '../../src/http/api';
import { planDays } from '../../src/domain/planner';
import { loadPlannerState, savePlannerState } from '../../src/store/db';
import { tmFromTest } from '../../src/domain/fivethreeone';
import { addDays } from '../../src/domain/dates';
import type { LiveState } from '../../src/domain/live';
import type { SessionRef } from '../../src/domain/types';
import { CHAT_ID, SECRET, db, fakeTelegram, liveStub, migrate, resetDb, resetLive, tgEnv } from './helpers';
import { DUPLICATE_MS, doneMarker } from '../../src/live/durable';
import { lastFslWeight, logLift } from '../../src/store/db';
import { getKV, setKV } from '../../src/store/db';
import { insertBenchmark, listBenchmarks, listTmHistory } from '../../src/store/progress';
import wranglerJsonc from '../../wrangler.jsonc?raw';

let tg: ReturnType<typeof fakeTelegram>;

beforeAll(migrate);
beforeEach(async () => {
  await resetDb();
  await resetLive();
  tg = fakeTelegram();
  __setTelegramFetchForTesting(tg.fetch);
});
afterEach(() => __setTelegramFetchForTesting(null));

async function call(method: string, path: string, body?: unknown) {
  const r = await SELF.fetch('http://localhost' + path, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, json: (await r.json()) as any };
}
const post = (p: string, b: unknown = {}) => call('POST', p, b);
const getLive = async () => (await call('GET', '/api/live')).json.live;

/** A lift planned every day (so one is planned today), TM squat 100. Returns today and today's lift. */
async function liftToday(): Promise<{ date: string; ref: Extract<SessionRef, { kind: 'lift' }> }> {
  const st = await loadPlannerState(db);
  st.tms = { squat: 100, bench: 70, deadlift: 140, ohp: 50 };
  st.defaultWeek = { 0: { am: 'lift' }, 1: { am: 'lift' }, 2: { am: 'lift' }, 3: { am: 'lift' }, 4: { am: 'lift' }, 5: { am: 'lift' }, 6: { am: 'lift' } };
  await savePlannerState(db, st);
  const date = todayFor(st);
  const s = planDays(st, date, 1)[0]!.sessions.find((x) => x.kind === 'lift');
  if (!s || s.kind !== 'lift') throw new Error('no lift today');
  expect(s).toMatchObject({ lift: 'squat', week: 1 });
  return { date, ref: { kind: 'lift', lift: s.lift, week: s.week } };
}

const liftLogRows = async () =>
  (await db.prepare('SELECT id, date, lift, json FROM lift_log ORDER BY id').all<{ id: number; date: string; lift: string; json: string }>()).results
    .map((r) => ({ id: r.id, ...JSON.parse(r.json) }));

const methods = () => tg.calls.map((c) => c.method);

/** Rewrites the stored Live Session (e.g. to put a timer in the past). */
async function patchLive(fn: (s: LiveState) => void) {
  await runInDurableObject(liveStub(), async (_o, state) => {
    const s = (await state.storage.get<LiveState>('live'))!;
    fn(s);
    await state.storage.put('live', s);
  });
}

async function start() {
  const { date, ref } = await liftToday();
  const r = await post('/api/live/start', { date, ref });
  expect(r.status).toBe(200);
  return { date, ref, live: r.json.live };
}

describe('API: start', () => {
  it('no Live Session: GET /api/live is null', async () => {
    expect(await call('GET', '/api/live')).toEqual({ status: 200, json: { live: null } });
  });

  it("start expands today's lift into Warm-up, main, FSL and Finisher steps and opens it in Telegram", async () => {
    const { date, live } = await start();
    expect(live.date).toBe(date);
    expect(live.title).toBe('Squat — Week 1 (5s)');
    expect(live.current).toBe(0);
    expect(live.steps[0]).toMatchObject({ kind: 'warmup', done: false });
    expect(live.steps[0].items.length).toBeGreaterThan(0);
    const sets = live.steps.slice(1);
    expect(sets.filter((s: any) => s.group === 'main').map((s: any) => [s.rxLoad, s.rxReps, !!s.amrap, s.restSeconds])).toEqual([
      [65, 5, false, 180], [75, 5, false, 180], [85, 5, true, 180],
    ]);
    const fsl = sets.filter((s: any) => s.group === 'fsl');
    expect(fsl).toHaveLength(4); // 4 x 8 per side
    expect(fsl[0]).toMatchObject({ exercise: 'DB Bulgarian split squat', n: 1, of: 4, rxReps: 8, restSeconds: 90 });
    const fin = sets.filter((s: any) => s.group === 'finisher');
    expect(fin.map((s: any) => s.exercise)).toEqual(['Cossack squat', 'Cossack squat', 'Nordic / hamstring curl', 'Nordic / hamstring curl', 'Side plank with top-leg raise']);
    expect(fin[0]).toMatchObject({ rxReps: 12, rxRepsMax: 15, restSeconds: 60 });
    expect(fin[4]).toMatchObject({ dose: '2 x 30 s/side' });
    expect(live.next).toEqual({ load: 65, reps: 5, unit: 'kg', loadStep: 2.5 });
    expect(live.restEndsAt).toBeNull();

    // The reply keyboard first, then the Live Session message with its buttons.
    expect(methods()).toEqual(['sendMessage', 'sendMessage']);
    expect(tg.calls[0]!.body.reply_markup).toMatchObject({ keyboard: [[{ text: '✓ Set done' }, { text: '+30 s rest' }], [{ text: 'Pause' }, { text: 'Finish' }]] });
    expect(String(tg.calls[1]!.body.text)).toContain('Warm-up');
    const kb = (tg.calls[1]!.body.reply_markup as any).inline_keyboard;
    expect(kb[0][0].text).toBe('✓ Warm-up done');
    expect(await getLive()).toMatchObject({ id: live.id });
  });

  it('refuses a second Live Session, other days, non-lift Sessions and bad bodies', async () => {
    const { date, ref } = await start();
    expect((await post('/api/live/start', { date, ref })).status).toBe(409);
    await post('/api/live/abandon');
    const tomorrow = new Date(Date.parse(date + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10);
    expect((await post('/api/live/start', { date: tomorrow, ref })).status).toBe(409);
    expect((await post('/api/live/start', { date, ref: { kind: 'lift', lift: 'bench', week: 2 } })).status).toBe(409);
    expect((await post('/api/live/start', { date, ref: { kind: 'run', run: 'easy' } })).status).toBe(400);
    expect((await post('/api/live/start', { date: 'today', ref })).status).toBe(400);
    expect((await post('/api/live/start', { date })).status).toBe(400);
  });

  it('CSRF guard applies', async () => {
    const r = await SELF.fetch('http://localhost/api/live/finish', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' });
    expect(r.status).toBe(415);
  });
});

describe('API: logging and finishing', () => {
  it('logs per set to one lift_log row, then finish goes through Done: Sequence, amrapLog, summary', async () => {
    const { date } = await start();
    tg.calls.length = 0;

    let r = await post('/api/live/warmup-done');
    expect(r.json.live.current).toBe(1);
    expect(r.json.live.steps[0].done).toBe(true);

    const t0 = Date.now();
    r = await post('/api/live/log', { step: 1 });
    expect(r.json.live.steps[1]).toMatchObject({ load: 65, reps: 5, status: 'met' });
    expect(Date.parse(r.json.live.restEndsAt) - t0).toBeGreaterThanOrEqual(179_000);
    let rows = await liftLogRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ date, lift: 'squat', week: 1, live: true, sets: [{ group: 'main', exercise: 'Squat', n: 1, load: 65, reps: 5, rxLoad: 65, rxReps: 5 }] });

    r = await post('/api/live/log', { step: 2, reps: 4, rpe: 9 });
    expect(r.json.live.steps[2]).toMatchObject({ load: 75, reps: 4, rpe: 9, status: 'under' });
    r = await post('/api/live/log', { step: 3, reps: 8 });
    expect(r.json.live.steps[3]).toMatchObject({ load: 85, reps: 8, status: 'amrap' });
    r = await post('/api/live/log', { step: 4, load: 22.5 }); // FSL 1: load given, reps at the Prescription
    expect(r.json.live.steps[4]).toMatchObject({ load: 22.5, reps: 8, status: 'met' });
    expect(r.json.live.next).toMatchObject({ load: 22.5, reps: 8 }); // the next FSL set carries the load
    r = await post('/api/live/log', { step: 5, skip: true });
    expect(r.json.live.steps[5]).toMatchObject({ skipped: true, status: 'skipped' });
    expect(r.json.live.current).toBe(6);

    rows = await liftLogRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].sets).toHaveLength(5);
    expect(rows[0].fslWeightKg).toBe(22.5);
    const rowId = rows[0].id;
    expect(methods().every((m) => m === 'editMessageText')).toBe(true);

    tg.calls.length = 0;
    r = await post('/api/live/finish');
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ live: null, outcome: 'finished' });

    const st = await loadPlannerState(db);
    expect(st.doneByDate[date]).toEqual([{ kind: 'lift', lift: 'squat', week: 1 }]);
    expect(st.lift.index).toBe(1);
    expect((await loadAmrapLog(db)).squat[1]).toBe(8);
    rows = await liftLogRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(rowId);
    expect(rows[0].live).toBeUndefined();
    expect(rows[0]).toMatchObject({ amrapReps: 8, fslWeightKg: 22.5 });
    expect(rows[0].sets.map((s: any) => s.skipped ?? false)).toEqual([false, false, false, false, true]);

    // The message becomes the summary; the reply keyboard goes.
    expect(methods()).toEqual(['editMessageText', 'sendMessage']);
    const summary = String(tg.calls[0]!.body.text);
    expect(summary).toContain('✓ Squat 1: 65 kg × 5');
    expect(summary).toContain('↓ Squat 2: 75 kg × 4 (rx 75 kg × 5) · RPE 9');
    expect(summary).toContain('Squat 3: 85 kg × 8 — AMRAP 8 reps');
    expect(summary).toContain('– DB Bulgarian split squat 2: skipped');
    expect((tg.calls[0]!.body.reply_markup as any).inline_keyboard).toEqual([]);
    expect(tg.calls[1]!.body.reply_markup).toEqual({ remove_keyboard: true });
    expect(await getLive()).toBeNull();
  });

  it('rejects bad log bodies and steps', async () => {
    await start();
    for (const b of [{}, { step: 0 }, { step: 1.5 }, { step: 1, reps: -1 }, { step: 1, rpe: 11 }, { step: 1, load: 'x' }, { step: 1, skip: true, reps: 3 }]) {
      expect((await post('/api/live/log', b)).status, JSON.stringify(b)).toBe(400);
    }
    expect((await post('/api/live/log', { step: 99 })).status).toBe(400);
    expect((await post('/api/live/log', { step: 1, top: true })).status).toBe(400);
  });

  it('finish with nothing logged is refused; abandon leaves the Sequence alone and marks the row', async () => {
    await start();
    expect((await post('/api/live/finish')).status).toBe(409);
    await post('/api/live/log', { step: 1 });
    tg.calls.length = 0;
    const r = await post('/api/live/abandon');
    expect(r.json).toEqual({ live: null, outcome: 'abandoned' });
    expect((await loadPlannerState(db)).lift.index).toBe(0);
    expect((await liftLogRows())[0]).toMatchObject({ abandoned: true });
    expect((await liftLogRows())[0].live).toBeUndefined();
    expect(methods()).toEqual(['editMessageText', 'sendMessage']);
    expect(tg.calls[1]!.body.reply_markup).toEqual({ remove_keyboard: true });
    expect((await post('/api/live/abandon')).status).toBe(404);
    expect((await post('/api/live/log', { step: 1 })).status).toBe(404);
  });

  it('a Session checked in elsewhere (plain Done, no row): finish keeps the sets as its row, Sequence moves once', async () => {
    const { date, ref } = await start();
    await post('/api/live/log', { step: 1 });
    await performAction(db, { type: 'done', date, ref });
    const r = await post('/api/live/finish');
    expect(r.json.outcome).toBe('not-counted');
    expect((await loadPlannerState(db)).lift.index).toBe(1);
    const rows = await liftLogRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ sets: [{ n: 1 }] });
    expect(rows[0].notCounted).toBeUndefined();
    expect(rows[0].live).toBeUndefined();
  });

  it('done elsewhere with AMRAP reps (a row without sets): the Logged Sets merge into that row', async () => {
    const { date, ref } = await start();
    await post('/api/live/log', { step: 1 });
    await post('/api/live/log', { step: 4, load: 25 });
    await performAction(db, { type: 'done', date, ref, amrapReps: 7 });
    expect(await liftLogRows()).toHaveLength(2);
    expect((await post('/api/live/finish')).json.outcome).toBe('not-counted');
    const rows = await liftLogRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ amrapReps: 7, fslWeightKg: 25, sets: [{ n: 1, load: 65 }, { group: 'fsl', load: 25 }] });
    expect((await loadPlannerState(db)).lift.index).toBe(1);
  });

  it('done elsewhere with its own sets: this row is linked (duplicateOf) and not counted', async () => {
    const { date, ref } = await start();
    await post('/api/live/log', { step: 1 });
    await performAction(db, { type: 'done', date, ref, sets: [{ group: 'main', exercise: 'Squat', n: 1, unit: 'kg', load: 60, reps: 5 }] });
    await post('/api/live/finish');
    const rows = await liftLogRows();
    const other = rows.find((x) => !x.notCounted)!;
    expect(rows.find((x) => x.notCounted)).toMatchObject({ duplicateOf: other.id, sets: [{ load: 65 }] });
  });

  it('a finish whose state committed but whose follow-up writes failed counts once on retry', async () => {
    const { date, ref, live } = await start();
    await post('/api/live/log', { step: 1 });
    await post('/api/live/log', { step: 2 });
    await post('/api/live/log', { step: 3, reps: 9 });
    // The state write (with its marker) commits; the lift_log rewrite and the rest never happen.
    await performAction(db, { type: 'done', date, ref }, { marker: doneMarker(live.id) });
    expect((await loadPlannerState(db)).lift.index).toBe(1);
    const r = await post('/api/live/finish');
    expect(r.json.outcome).toBe('finished');
    expect((await loadPlannerState(db)).lift.index).toBe(1);
    const rows = await liftLogRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ week: 1, amrapReps: 9, sets: [{ n: 1 }, { n: 2 }, { n: 3, reps: 9 }] });
    expect(rows[0].notCounted).toBeUndefined();
    expect(rows[0].live).toBeUndefined();
  });
});

describe('rest timer', () => {
  it('+30 s extends, stop clears, bodies are validated', async () => {
    await start();
    let r = await post('/api/live/log', { step: 1 });
    const end = Date.parse(r.json.live.restEndsAt);
    r = await post('/api/live/rest', { addSeconds: 30 });
    expect(Date.parse(r.json.live.restEndsAt)).toBe(end + 30_000);
    r = await post('/api/live/rest', { stop: true });
    expect(r.json.live.restEndsAt).toBeNull();
    r = await post('/api/live/rest', { addSeconds: 30 }); // no rest running: 30 s from now
    expect(Date.parse(r.json.live.restEndsAt) - Date.now()).toBeLessThanOrEqual(30_000);
    for (const b of [{}, { addSeconds: 0 }, { addSeconds: 901 }, { addSeconds: 2.5 }, { addSeconds: 30, stop: true }]) {
      expect((await post('/api/live/rest', b)).status, JSON.stringify(b)).toBe(400);
    }
  });

  it('the alarm sends "Rest over" as a new message; logging the set deletes it', async () => {
    await start();
    await post('/api/live/log', { step: 1 });
    await patchLive((s) => { s.restEndsAt = Date.now() - 1000; });
    tg.calls.length = 0;
    expect(await runDurableObjectAlarm(liveStub())).toBe(true);
    const ping = tg.calls.find((c) => c.method === 'sendMessage')!;
    expect(ping.body.text).toBe('⏰ Rest over — Set 2: 75 kg × 5');
    expect(ping.body.reply_markup).toBeUndefined();
    const pingId = 1000 + tg.calls.indexOf(ping) + 1;

    // A second alarm (e.g. the midnight one rescheduled) does not ping again.
    tg.calls.length = 0;
    await runDurableObjectAlarm(liveStub());
    expect(methods()).not.toContain('sendMessage');

    await post('/api/live/log', { step: 2 });
    expect(tg.calls.find((c) => c.method === 'deleteMessage')?.body).toEqual({ chat_id: CHAT_ID, message_id: pingId });
  });

  it('a too-early alarm does nothing', async () => {
    await start();
    await post('/api/live/log', { step: 1 });
    tg.calls.length = 0;
    await runDurableObjectAlarm(liveStub());
    expect(methods()).toEqual([]);
    expect((await getLive()).steps[1].load).toBe(65);
  });

  it('restSeconds from Settings set the rest of each group', async () => {
    const r = await call('PUT', '/api/settings', { restSeconds: { main: 120, finisher: 45 } });
    expect(r.status).toBe(200);
    expect(r.json.restSeconds).toEqual({ main: 120, fsl: 90, finisher: 45 });
    expect((await call('GET', '/api/state')).json.restSeconds).toEqual({ main: 120, fsl: 90, finisher: 45 });
    const { live } = await start();
    expect(live.steps[1].restSeconds).toBe(120);
    expect(live.steps.at(-1).restSeconds).toBe(45);
    for (const b of [{ restSeconds: { main: 10 } }, { restSeconds: { main: 'x' } }, { restSeconds: { warmup: 60 } }, { restSeconds: 60 }]) {
      expect((await call('PUT', '/api/settings', b)).status, JSON.stringify(b)).toBe(400);
    }
  });
});

describe('auto-finish at local midnight', () => {
  it('with Logged Sets: finishes as Done (auto-finished), no message sent', async () => {
    const { date } = await start();
    await post('/api/live/log', { step: 1 });
    await post('/api/live/log', { step: 2 });
    await patchLive((s) => { s.autoFinishAt = Date.now() - 1000; });
    tg.calls.length = 0;
    await runDurableObjectAlarm(liveStub());
    expect(methods()).not.toContain('sendMessage');
    expect(methods()).toContain('editMessageText');
    expect(await getLive()).toBeNull();
    const st = await loadPlannerState(db);
    expect(st.doneByDate[date]).toEqual([{ kind: 'lift', lift: 'squat', week: 1 }]);
    expect((await liftLogRows())[0]).toMatchObject({ autoFinished: true, sets: [{ n: 1 }, { n: 2 }] });
    const log = await db.prepare("SELECT json FROM action_log WHERE json_extract(json, '$.type') = 'done'").first<{ json: string }>();
    expect(JSON.parse(log!.json)).toMatchObject({ autoFinished: true });
  });

  it('with none: discarded, Sequence untouched', async () => {
    await start();
    await post('/api/live/warmup-done');
    await patchLive((s) => { s.autoFinishAt = Date.now() - 1000; });
    await runDurableObjectAlarm(liveStub());
    expect(await getLive()).toBeNull();
    expect((await loadPlannerState(db)).lift.index).toBe(0);
    expect(await liftLogRows()).toEqual([]);
  });

  it('a lost alarm is caught on the next request', async () => {
    const { date } = await start();
    await post('/api/live/log', { step: 1 });
    await patchLive((s) => { s.autoFinishAt = Date.now() - 1000; });
    expect(await getLive()).toBeNull();
    expect((await loadPlannerState(db)).doneByDate[date]).toHaveLength(1);
  });
});

describe('TM Test Live Session', () => {
  it('work-up sets, then the top set logs the result and sets its Training Max; the fourth ends the Test Week', async () => {
    const st = await loadPlannerState(db);
    const today = todayFor(st);
    const later = (n: number) => addDays(today, n);
    await performAction(db, { type: 'start-test-week', dates: { squat: later(1), bench: later(2), deadlift: later(3), ohp: today } });
    for (const [lift, w, n] of [['squat', 100, 1], ['bench', 70, 2], ['deadlift', 140, 3]] as const) {
      await performAction(db, { type: 'test-result', date: later(n), lift, weight: w, reps: 5 });
    }
    const ref = { kind: 'lift-test', lift: 'ohp' } as const;
    let r = await post('/api/live/start', { date: today, ref });
    expect(r.status).toBe(200);
    expect(r.json.live.title).toBe('OHP — 5-rep max test');
    expect(r.json.live.steps).toHaveLength(1);
    // No Prescription for a TM Test: no weight to suggest (never the bar); it is typed.
    expect(r.json.live.next).toEqual({ reps: 5, unit: 'kg', loadStep: 2.5 });

    await post('/api/live/warmup-done');
    const empty = await post('/api/live/log', { step: 1 });
    expect(empty.status).toBe(400);
    expect(empty.json.error).toBe('type the weight, e.g. 100x5');
    r = await post('/api/live/log', { step: 1, load: 30, reps: 5 });
    expect(r.json.live.steps[1]).toMatchObject({ group: 'test', n: 1, load: 30, reps: 5 });
    expect(r.json.live.current).toBe(2);
    expect(r.json.live.restEndsAt).not.toBeNull();
    expect(r.json.live.next).toMatchObject({ load: 30, reps: 5 });
    expect((await post('/api/live/finish')).status).toBe(409); // a TM Test finishes with its top set
    expect((await post('/api/live/log', { step: 2, load: 45, reps: 20, top: true })).status).toBe(400);

    r = await post('/api/live/log', { step: 2, load: 45, reps: 5, top: true });
    expect(r.status).toBe(200);
    expect(r.json.live).toBeNull();
    expect(r.json.events).toEqual(['OHP 45 × 5 → Training Max 45 kg (4 of 4 tested)', 'All four tested: Cycle 1 starts at the next lift Slot']);
    const after = await loadPlannerState(db);
    expect(after.testWeek).toBeUndefined();
    expect(after.tms.ohp).toBe(tmFromTest(45, 5, 2.5));
    const rows = await liftLogRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ lift: 'ohp', test: true, result: { weight: 45, reps: 5 }, testSets: [{ n: 1, load: 30 }, { n: 2, load: 45, top: true }] });
    expect(rows[0].live).toBeUndefined();
  });
});

// ───────────────────────── Telegram ─────────────────────────

async function send(update: unknown) {
  const ctx = createExecutionContext();
  const r = await worker.fetch(new Request('https://bot.example.com/telegram/webhook', {
    method: 'POST', headers: { 'content-type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': SECRET }, body: JSON.stringify(update),
  }), tgEnv(), ctx);
  await waitOnExecutionContext(ctx);
  expect(r.status).toBe(200);
}
const text = (t: string) => send({ update_id: 1, message: { message_id: 7, chat: { id: Number(CHAT_ID) }, text: t } });
const tap = (data: string) => send({ update_id: 2, callback_query: { id: 'cq', data, message: { message_id: 1002, chat: { id: Number(CHAT_ID) }, reply_markup: { inline_keyboard: [] } } } });
const toast = () => tg.calls.find((c) => c.method === 'answerCallbackQuery')?.body.text;

describe('Telegram (bot Worker, ROLE=bot)', () => {
  it('the bot Worker binds the app Worker\'s Live Session object by script_name', () => {
    const cfg = JSON.parse(wranglerJsonc.replace(/^\s*\/\/.*$/gm, '').replace(/,(\s*[}\]])/g, '$1'));
    const appBinding = cfg.durable_objects.bindings[0];
    expect(appBinding).toEqual({ name: 'LIVE', class_name: 'LiveSessionObject' });
    expect(cfg.migrations).toEqual([{ tag: 'v1-live-session', new_sqlite_classes: ['LiveSessionObject'] }]);
    expect(cfg.env.bot.durable_objects.bindings).toEqual([{ name: 'LIVE', class_name: 'LiveSessionObject', script_name: cfg.name }]);
    expect(cfg.env.bot.migrations).toEqual([]);
    expect(tgEnv().ROLE).toBe('bot');
  });

  it('▶ Start from the morning message, then buttons and typed input log sets', async () => {
    const { date } = await liftToday();
    await tap(`a|g|${date}|L.squat.1`);
    expect(toast()).toBe('▶ Live Session started');
    const live = await getLive();
    const sid = live.id.slice(0, 8);
    const liveMsg = tg.calls.filter((c) => c.method === 'sendMessage')[1]!;
    for (const row of (liveMsg.body.reply_markup as any).inline_keyboard) {
      for (const b of row) expect(new TextEncoder().encode(b.callback_data).length).toBeLessThanOrEqual(64);
    }

    tg.calls.length = 0;
    await tap(`a|g|${date}|L.squat.1`);
    expect(toast()).toContain('already running');

    await tap(`l|wu|${sid}|0`);
    expect((await getLive()).current).toBe(1);
    const edit = tg.calls.find((c) => c.method === 'editMessageText')!;
    expect(edit.body.message_id).toBe(1002);
    expect(String(edit.body.text)).toContain('Squat · Set 1 of 3 — 65 kg × 5');
    expect((edit.body.reply_markup as any).inline_keyboard.flat().map((b: any) => b.text)).toEqual([
      '✓ As prescribed', 'Reps −', 'Reps +', 'Load −', 'Load +', '⏭ Skip set', '🏁 Finish', '✕ Cancel',
    ]);

    await tap(`l|ok|${sid}|1`);
    expect((await getLive()).steps[1]).toMatchObject({ load: 65, reps: 5 });
    tg.calls.length = 0;
    await tap(`l|ok|${sid}|1`); // a stale button
    expect(toast()).toContain('out of date');
    expect((await getLive()).current).toBe(2);

    await tap(`l|r-|${sid}|2`);
    await tap(`l|l+|${sid}|2`);
    tg.calls.length = 0;
    await tap(`l|r-|${sid}|2`);
    expect((await getLive()).next).toMatchObject({ load: 77.5, reps: 3 });
    const kb = (tg.calls.find((c) => c.method === 'editMessageText')!.body.reply_markup as any).inline_keyboard;
    expect(kb[0][0].text).toBe('✓ 77.5 kg × 3');
    await patchLive((x) => { x.sets[0]!.loggedAt = Date.now() - DUPLICATE_MS - 1; }); // not a double tap
    await text('✓ Set done');
    expect((await getLive()).steps[2]).toMatchObject({ load: 77.5, reps: 3, status: 'under' });

    tg.calls.length = 0;
    await text('x8 rpe 9'); // AMRAP set: reps at the Prescription's load
    expect((await getLive()).steps[3]).toMatchObject({ load: 85, reps: 8, rpe: 9 });
    expect(methods()).not.toContain('sendMessage'); // success is the edited message, no reply
    await text('22.5x8');
    await text('rpe 7');
    expect((await getLive()).steps[4]).toMatchObject({ load: 22.5, reps: 8, rpe: 7 });
    await text('skip');
    expect((await getLive()).steps[5].skipped).toBe(true);

    const before = Date.parse((await getLive()).restEndsAt);
    await text('+30 s rest');
    expect(Date.parse((await getLive()).restEndsAt)).toBe(before + 30_000);
    await text('Pause');
    expect((await getLive()).restEndsAt).toBeNull();
    await text('Resume');
    expect((await getLive()).paused).toBe(false);

    tg.calls.length = 0;
    await text('lots of reps');
    expect(tg.calls.map((c) => [c.method, c.body.text])).toEqual([['sendMessage', expect.stringContaining('67.5x4')]]);

    tg.calls.length = 0;
    await text('Finish');
    expect(await getLive()).toBeNull();
    expect(methods()).toEqual(['editMessageText', 'sendMessage']);
    expect(tg.calls[1]!.body.reply_markup).toEqual({ remove_keyboard: true });
    expect((await loadPlannerState(db)).doneByDate[date]).toHaveLength(1);
    expect((await loadAmrapLog(db)).squat[1]).toBe(8);

    tg.calls.length = 0;
    await tap(`l|ok|${sid}|6`);
    expect(toast()).toBe('This Live Session is over.');
    expect(methods()).toContain('editMessageReplyMarkup');
    tg.calls.length = 0;
    await text('Finish');
    expect(tg.calls.map((c) => [c.body.text, c.body.reply_markup])).toEqual([['No Live Session is running.', { remove_keyboard: true }]]);
    tg.calls.length = 0;
    await text('hello');
    expect(tg.calls).toEqual([]); // plain chat without a Live Session is ignored, as before
  });

  it('once a set is logged, Abandon asks first; Keep going restores the buttons', async () => {
    const { date } = await liftToday();
    await tap(`a|g|${date}|L.squat.1`);
    const sid = (await getLive()).id.slice(0, 8);
    await tap(`l|ok|${sid}|0`);
    tg.calls.length = 0;
    await tap(`l|ok|${sid}|2`);
    const kb = (tg.calls.find((c) => c.method === 'editMessageText')!.body.reply_markup as any).inline_keyboard;
    expect(kb.at(-1)).toEqual([{ text: '✖ Abandon', callback_data: `l|ab|${sid}|3` }]);
    tg.calls.length = 0;
    await tap(`l|ab|${sid}|3`);
    const confirm = (tg.calls.find((c) => c.method === 'editMessageText')!.body.reply_markup as any).inline_keyboard;
    expect(confirm[0].map((b: any) => b.callback_data)).toEqual([`l|aby|${sid}|3`, `l|rf|${sid}|3`]);
    expect(await getLive()).not.toBeNull();
    await tap(`l|rf|${sid}|3`);
    await tap(`l|aby|${sid}|3`);
    expect(await getLive()).toBeNull();
    expect((await loadPlannerState(db)).lift.index).toBe(0);
  });

  it('a TM Test: ▶ Start, work-up sets, 🏁 Top set', async () => {
    const st = await loadPlannerState(db);
    const today = todayFor(st);
    await performAction(db, { type: 'start-test-week', dates: { squat: today, bench: today, deadlift: today, ohp: today } });
    const planned = planDays(await loadPlannerState(db), today, 1)[0]!.sessions.find((s) => s.kind === 'lift-test')!;
    const lift = (planned as Extract<SessionRef, { kind: 'lift-test' }>).lift;
    await tap(`a|g|${today}|X.${lift}`);
    const sid = (await getLive()).id.slice(0, 8);
    await tap(`l|wu|${sid}|0`);
    await text('60x5');
    await tap(`l|l+|${sid}|2`);
    tg.calls.length = 0;
    await tap(`l|top|${sid}|2`);
    // 🏁 Top set asks first, on the same message, with the Training Max it will set
    expect(toast()).toBe('Save this top set?');
    const ask = tg.calls.find((c) => c.method === 'editMessageText')!.body as any;
    expect(ask.message_id).toBe(1002);
    expect(ask.text).toContain('Top set 62.5 kg × 5 → Training Max 65 kg. Save?');
    expect(ask.text).not.toContain('⚠️'); // nothing tested yet to compare with
    expect(ask.reply_markup.inline_keyboard).toEqual([[
      { text: '✓ Save top set', callback_data: `l|tpy|${sid}|2` }, { text: '↩︎ Back', callback_data: `l|tpn|${sid}|2` },
    ]]);
    expect((await loadPlannerState(db)).testWeek?.results).toEqual({});
    tg.calls.length = 0;
    await tap(`l|tpy|${sid}|2`);
    const name = { squat: 'Squat', bench: 'Bench', deadlift: 'Deadlift', ohp: 'OHP' }[lift];
    const line = `${name} 62.5 × 5 → Training Max 65 kg (1 of 4 tested)`; // 0.9 × 62.5 × 7/6 = 65.6 → 65
    expect(toast()).toBe(`Top set logged · ${line}`);
    expect(tg.calls.find((c) => c.method === 'editMessageText')!.body.text).toContain(line);
    expect(await getLive()).toBeNull();
    const after = await loadPlannerState(db);
    expect(after.testWeek?.results[lift]).toEqual({ weight: 62.5, reps: 5 });
    expect(after.tms[lift]).toBe(65);
  });

  it('a TM Test in Telegram: no bar default; ↩︎ Back, typed top and the low-result warning', async () => {
    const st = await loadPlannerState(db);
    const today = todayFor(st);
    // squat and bench already tested (TM 115 / 75); deadlift today
    await performAction(db, { type: 'start-test-week', dates: { squat: addDays(today, -2), bench: addDays(today, -1), deadlift: today, ohp: addDays(today, 1) } });
    await performAction(db, { type: 'test-result', date: addDays(today, -2), lift: 'squat', weight: 110, reps: 5 });
    await performAction(db, { type: 'test-result', date: addDays(today, -1), lift: 'bench', weight: 70, reps: 6 });
    await tap(`a|g|${today}|X.deadlift`);
    const sid = (await getLive()).id.slice(0, 8);
    tg.calls.length = 0;
    await tap(`l|wu|${sid}|0`);
    let msg = tg.calls.find((c) => c.method === 'editMessageText')!.body as any;
    expect(msg.text).toContain('Deadlift · Work-up set 1 — Type the weight, e.g. 100x5');
    expect(msg.text).not.toContain('20 kg');
    expect(JSON.stringify(msg.reply_markup)).not.toContain('Work-up');
    // the reply keyboard's ✓ Set done has no weight to log
    tg.calls.length = 0;
    await text('✓ Set done');
    expect(tg.calls.at(-1)!.body.text).toBe('type the weight, e.g. 100x5');
    expect((await getLive()).loggedSets).toBe(0);

    await text('20x5');
    tg.calls.length = 0;
    await tap(`l|top|${sid}|2`);
    msg = tg.calls.find((c) => c.method === 'editMessageText')!.body as any;
    expect(msg.text).toContain('Top set 20 kg × 5 → Training Max 20 kg. Save?');
    expect(msg.text).toContain("⚠️ That's much lower than your other lifts — check the weight");
    // ↩︎ Back: nothing saved, the set buttons return
    tg.calls.length = 0;
    await tap(`l|tpn|${sid}|2`);
    msg = tg.calls.find((c) => c.method === 'editMessageText')!.body as any;
    expect(msg.text).not.toContain('Save?');
    expect(msg.reply_markup.inline_keyboard[0].map((b: any) => b.text)).toEqual(['✓ Work-up 20 kg × 5', '🏁 Top set']);
    // a stale ✓ Save after Back does nothing
    tg.calls.length = 0;
    await tap(`l|tpy|${sid}|2`);
    expect(toast()).toBe('That confirmation is out of date.');
    expect((await loadPlannerState(db)).testWeek?.results.deadlift).toBeUndefined();

    await text('100x5');
    await text('120x3');
    // typed top asks too, with the typed values; any other change drops the pending confirmation
    tg.calls.length = 0;
    await text('top 120x5');
    expect(tg.calls.at(-1)!.body.text).toBe('Confirm the top set on the Live Session message above.');
    msg = tg.calls.find((c) => c.method === 'editMessageText')!.body as any;
    expect(msg.text).toContain('Top set 120 kg × 5 → Training Max 125 kg. Save?');
    expect(msg.text).not.toContain('⚠️');
    expect((await getLive()).loggedSets).toBe(3);
    tg.calls.length = 0;
    await tap(`l|tpy|${sid}|4`);
    expect(toast()).toBe('Top set logged · Deadlift 120 × 5 → Training Max 125 kg (3 of 4 tested)');
    expect(await getLive()).toBeNull();
    const after = await loadPlannerState(db);
    expect(after.testWeek?.results.deadlift).toEqual({ weight: 120, reps: 5 });
    expect(after.tms.deadlift).toBe(125);
  });

  it('a TM Test abandoned after work-up sets leaves the Training Maxes alone', async () => {
    const st = await loadPlannerState(db);
    const today = todayFor(st);
    await performAction(db, { type: 'start-test-week', dates: { squat: today, bench: today, deadlift: today, ohp: today } });
    const before = (await loadPlannerState(db)).tms;
    await post('/api/live/start', { date: today, ref: { kind: 'lift-test', lift: 'squat' } });
    await post('/api/live/warmup-done');
    await post('/api/live/log', { step: 1, load: 100, reps: 5 });
    expect((await post('/api/live/abandon')).status).toBe(200);
    const after = await loadPlannerState(db);
    expect(after.tms).toEqual(before);
    expect(after.testWeek?.results).toEqual({});
  });
});

// ───────────────────────── Cancel, Resume / Start fresh, Pause, and the check fixes ─────────────────────────

const actionLogCount = async () => (await db.prepare('SELECT COUNT(*) AS n FROM action_log').first<{ n: number }>())!.n;

describe('Cancel (accidental start)', () => {
  it('nothing logged: Cancel leaves no trace and removes the messages and reply keyboard', async () => {
    const { live } = await start();
    const actions = await actionLogCount();
    await post('/api/live/warmup-done');
    await post('/api/live/log', { step: 1, skip: true }); // a skip makes a row; Cancel removes it
    expect(await liftLogRows()).toHaveLength(1);
    tg.calls.length = 0;
    const r = await post('/api/live/cancel');
    expect(r.json).toEqual({ live: null, outcome: 'cancelled' });
    expect(await liftLogRows()).toEqual([]);
    expect(await actionLogCount()).toBe(actions);
    expect((await loadPlannerState(db)).lift.index).toBe(0);
    expect(tg.calls.filter((c) => c.method === 'deleteMessage').map((c) => c.body.message_id).sort()).toEqual([1001, 1002]);
    expect(tg.calls.at(-1)!.body).toMatchObject({ text: 'Live Session cancelled.', reply_markup: { remove_keyboard: true } });
    expect(await getLive()).toBeNull();
    // Start works again on the same Session, fresh (nothing to resume).
    const again = await post('/api/live/start', { date: live.date, ref: live.ref });
    expect(again.status).toBe(200);
    expect(again.json.live.loggedSets).toBe(0);
  });

  it('with a Logged Set Cancel is refused (abandon instead); the Telegram button switches to Abandon', async () => {
    await start();
    await post('/api/live/log', { step: 1 });
    expect((await post('/api/live/cancel')).status).toBe(409);
  });

  it('the ✕ Cancel button cancels', async () => {
    const { date } = await liftToday();
    await tap(`a|g|${date}|L.squat.1`);
    const sid = (await getLive()).id.slice(0, 8);
    tg.calls.length = 0;
    await tap(`l|cx|${sid}|0`);
    expect(toast()).toBe('Cancelled');
    expect(await getLive()).toBeNull();
  });
});

describe('Resume or start fresh after an abandon the same day', () => {
  async function abandonedWithTwoSets() {
    const { date, ref } = await start();
    await post('/api/live/log', { step: 1 });
    await post('/api/live/log', { step: 2, reps: 4 });
    await post('/api/live/abandon');
    return { date, ref, rowId: (await liftLogRows())[0].id };
  }

  it('Start asks (409 resumable); resume continues in the same row, un-abandoned', async () => {
    const { date, ref, rowId } = await abandonedWithTwoSets();
    const ask = await post('/api/live/start', { date, ref });
    expect(ask.status).toBe(409);
    expect(ask.json.resumable).toBe(true);
    expect(ask.json.error).toContain('2 Logged Sets');
    const r = await post('/api/live/start', { date, ref, mode: 'resume' });
    expect(r.status).toBe(200);
    expect(r.json.live.current).toBe(3);
    expect(r.json.live.steps[2]).toMatchObject({ reps: 4, status: 'under' });
    let rows = await liftLogRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: rowId, live: true });
    expect(rows[0].abandoned).toBeUndefined();
    await post('/api/live/log', { step: 3, reps: 6 });
    await post('/api/live/finish');
    rows = await liftLogRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: rowId, amrapReps: 6, sets: [{ n: 1 }, { n: 2 }, { n: 3 }] });
  });

  it('fresh leaves the old row abandoned; bad modes are 400; resume with nothing to resume is 409', async () => {
    const { date, ref, rowId } = await abandonedWithTwoSets();
    expect((await post('/api/live/start', { date, ref, mode: 'later' })).status).toBe(400);
    const r = await post('/api/live/start', { date, ref, mode: 'fresh' });
    expect(r.json.live.loggedSets).toBe(0);
    await post('/api/live/log', { step: 1 });
    const rows = await liftLogRows();
    expect(rows).toHaveLength(2);
    expect(rows.find((x) => x.id === rowId)).toMatchObject({ abandoned: true });
    await post('/api/live/abandon');
    await resetDb();
    await liftToday();
    expect((await post('/api/live/start', { date, ref, mode: 'resume' })).status).toBe(409);
  });

  it('Telegram: ▶ Start offers ▶ Resume / Start fresh; ▶ Resume resumes', async () => {
    const { date } = await abandonedWithTwoSets();
    tg.calls.length = 0;
    await tap(`a|g|${date}|L.squat.1`);
    expect(toast()).toBe('Resume or start fresh?');
    const ask = tg.calls.find((c) => c.method === 'sendMessage')!;
    expect(String(ask.body.text)).toContain('abandoned earlier today with 2 Logged Sets');
    expect((ask.body.reply_markup as any).inline_keyboard.flat().map((b: any) => b.callback_data)).toEqual([`a|gr|${date}|L.squat.1`, `a|gf|${date}|L.squat.1`]);
    tg.calls.length = 0;
    await tap(`a|gr|${date}|L.squat.1`);
    expect(toast()).toBe('▶ Live Session resumed');
    expect(methods()).toContain('editMessageReplyMarkup'); // the question's buttons go
    expect((await getLive()).loggedSets).toBe(2);
  });
});

describe('Pause', () => {
  it('pauses the whole Live Session: rest stops, set input is refused, resume carries on', async () => {
    await start();
    await post('/api/live/log', { step: 1 });
    tg.calls.length = 0;
    let r = await post('/api/live/pause');
    expect(r.json.live).toMatchObject({ paused: true, restEndsAt: null });
    const msg = tg.calls.find((c) => c.method === 'editMessageText')!;
    expect(String(msg.body.text)).toContain('⏸ Paused');
    expect((msg.body.reply_markup as any).inline_keyboard[0][0].text).toBe('▶ Resume');
    r = await post('/api/live/log', { step: 2 });
    expect(r.status).toBe(409);
    expect(r.json.error).toContain('Paused');
    expect((await post('/api/live/rest', { addSeconds: 30 })).status).toBe(409);
    r = await post('/api/live/resume');
    expect(r.json.live.paused).toBe(false);
    expect((await post('/api/live/log', { step: 2 })).status).toBe(200);
  });

  it('Telegram: Pause toggles, typed sets get the hint while paused; midnight still auto-finishes', async () => {
    const { date } = await liftToday();
    await tap(`a|g|${date}|L.squat.1`);
    await text('65x5');
    await text('Pause');
    expect((await getLive()).paused).toBe(true);
    tg.calls.length = 0;
    await text('70x5');
    expect(tg.calls.map((c) => c.body.text)).toEqual([expect.stringContaining('Paused')]);
    expect((await getLive()).loggedSets).toBe(1);
    await text('Pause');
    expect((await getLive()).paused).toBe(false);
    await text('Pause');
    await patchLive((s) => { s.autoFinishAt = Date.now() - 1000; });
    await runDurableObjectAlarm(liveStub());
    expect(await getLive()).toBeNull();
    expect((await loadPlannerState(db)).doneByDate[date]).toHaveLength(1);
  });

  it('the ▶ Resume button resumes', async () => {
    const { date } = await liftToday();
    await tap(`a|g|${date}|L.squat.1`);
    const sid = (await getLive()).id.slice(0, 8);
    await post('/api/live/pause');
    await tap(`l|rs|${sid}|0`);
    expect((await getLive()).paused).toBe(false);
  });
});

describe('check fixes', () => {
  it('#2 after a midnight auto-finish the next keyboard press gets the outcome line and the keyboard removal, once', async () => {
    const { date } = await liftToday();
    await tap(`a|g|${date}|L.squat.1`);
    await text('65x5');
    await patchLive((s) => { s.autoFinishAt = Date.now() - 1000; });
    await runDurableObjectAlarm(liveStub());
    tg.calls.length = 0;
    await text('✓ Set done');
    expect(tg.calls).toHaveLength(1);
    expect(tg.calls[0]!.body).toMatchObject({ reply_markup: { remove_keyboard: true } });
    expect(String(tg.calls[0]!.body.text)).toContain('auto-finished at midnight');
    tg.calls.length = 0;
    await text('Finish');
    expect(tg.calls[0]!.body.text).toBe('No Live Session is running.');
  });

  it('#3 the Rest over ping is deleted only when the next set is logged (not by rpe or a correction)', async () => {
    const { date } = await liftToday();
    await tap(`a|g|${date}|L.squat.1`);
    await text('65x5');
    await patchLive((s) => { s.restEndsAt = Date.now() - 1000; });
    await runDurableObjectAlarm(liveStub());
    tg.calls.length = 0;
    await text('rpe 7');
    await post('/api/live/log', { step: 1, reps: 6 });
    expect(methods()).not.toContain('deleteMessage');
    await post('/api/live/log', { step: 2 });
    expect(methods()).toContain('deleteMessage');
  });

  it('#4 a second ✓ Set done right after a log is ignored', async () => {
    const { date } = await liftToday();
    await tap(`a|g|${date}|L.squat.1`);
    await text('✓ Set done');
    await text('✓ Set done');
    expect((await getLive()).loggedSets).toBe(1);
    await patchLive((s) => { s.sets[0]!.loggedAt = Date.now() - DUPLICATE_MS - 1; });
    await text('✓ Set done');
    expect((await getLive()).loggedSets).toBe(2);
  });

  it('#7 lastFslWeight ignores live, abandoned and not-counted rows', async () => {
    await logLift(db, '2026-10-01', 'squat', { fslWeightKg: 20 });
    await logLift(db, '2026-10-02', 'squat', { fslWeightKg: 30, abandoned: true });
    await logLift(db, '2026-10-02', 'squat', { fslWeightKg: 31, notCounted: true });
    await logLift(db, '2026-10-03', 'squat', { fslWeightKg: 32, live: true });
    expect(await lastFslWeight(db, 'squat')).toBe(20);
  });
});

describe('with stream C (Benchmark prompt, TM snapshots, AMRAP back-fill)', () => {
  /** A pending Benchmark time prompt, as ✅ Done on a 2.4 km Benchmark leaves it. */
  async function pendingPrompt(date: string) {
    const id = await insertBenchmark(db, date, '2k4', undefined);
    await setKV(db, 'benchPrompt', JSON.stringify({ id, suffix: `${date}|R.benchmark-2k4`, messageId: 9, keyboard: [], expiresAt: new Date(Date.now() + 3600_000).toISOString() }));
    return id;
  }

  it('"10:42" during a Live Session with a pending prompt is the Benchmark result, not a set', async () => {
    const { date } = await liftToday();
    await tap(`a|g|${date}|L.squat.1`);
    const id = await pendingPrompt(date);
    await text('10:42');
    expect((await listBenchmarks(db, date, date)).find((b) => b.id === id)).toMatchObject({ timeS: 642 });
    expect((await getLive()).loggedSets).toBe(0);
  });

  it('"67.5x4" with a pending prompt goes to the Live Session, and the prompt stays pending', async () => {
    const { date } = await liftToday();
    await tap(`a|g|${date}|L.squat.1`);
    const id = await pendingPrompt(date);
    await text('67.5x4');
    expect((await getLive()).steps[1]).toMatchObject({ load: 67.5, reps: 4 });
    expect((await listBenchmarks(db, date, date)).find((b) => b.id === id)?.timeS).toBeUndefined();
    expect(await getKV(db, 'benchPrompt')).not.toBeNull();
  });

  it('a TM Test top set through the Live Session sets that TM and records its snapshot', async () => {
    const st = await loadPlannerState(db);
    const today = todayFor(st);
    const later = (n: number) => addDays(today, n);
    await performAction(db, { type: 'start-test-week', dates: { squat: later(1), bench: later(2), deadlift: later(3), ohp: today } });
    for (const [lift, w, n] of [['squat', 100, 1], ['bench', 70, 2], ['deadlift', 140, 3]] as const) {
      await performAction(db, { type: 'test-result', date: later(n), lift, weight: w, reps: 5 });
    }
    expect((await listTmHistory(db, '2000-01-01', '2999-12-31')).map((x) => x.lift)).toEqual(['squat', 'bench', 'deadlift']);
    await post('/api/live/start', { date: today, ref: { kind: 'lift-test', lift: 'ohp' } });
    await post('/api/live/log', { step: 1, load: 40, reps: 5, top: true });
    const snaps = await listTmHistory(db, '2000-01-01', '2999-12-31');
    expect(snaps.map((x) => [x.lift, x.reason])).toEqual([['ohp', 'test'], ['squat', 'test'], ['bench', 'test'], ['deadlift', 'test']]); // by date: ohp is today
    expect(snaps.find((x) => x.lift === 'ohp')!.tm).toBe(tmFromTest(40, 5, 2.5));
  });

  it('done elsewhere without AMRAP reps: the Logged AMRAP set back-fills amrapLog once', async () => {
    const { date, ref } = await start();
    await post('/api/live/log', { step: 1 });
    await post('/api/live/log', { step: 2 });
    await post('/api/live/log', { step: 3, reps: 7 });
    await performAction(db, { type: 'done', date, ref }); // a plain Done: no row, no AMRAP reps
    expect((await loadAmrapLog(db)).squat[1]).toBeUndefined();
    expect((await post('/api/live/finish')).json.outcome).toBe('not-counted');
    expect((await loadAmrapLog(db)).squat[1]).toBe(7);
    expect((await liftLogRows())[0]).toMatchObject({ amrapReps: 7 });
    expect((await loadPlannerState(db)).lift.index).toBe(1);
  });

  it('merging into a Done row that has AMRAP reps keeps them (no second write)', async () => {
    const { date, ref } = await start();
    await post('/api/live/log', { step: 3, reps: 9 });
    await performAction(db, { type: 'done', date, ref, amrapReps: 6 });
    await post('/api/live/finish');
    expect((await loadAmrapLog(db)).squat[1]).toBe(6);
    const rows = await liftLogRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ amrapReps: 6, sets: [{ n: 3, reps: 9 }] });
  });
});
