// Correcting a TM Test result (test-result with `correct: true`): the API, its side-writes and Telegram's /test replace.
import { SELF, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import worker from '../../src/index';
import { __setTelegramFetchForTesting } from '../../src/telegram/webhook';
import { performAction, todayFor } from '../../src/http/api';
import { listCheckIns, listTmHistory } from '../../src/store/progress';
import { liftLogsFor, loadPlannerState, logLift } from '../../src/store/db';
import { addDays } from '../../src/domain/dates';
import { CHAT_ID, SECRET, db, fakeTelegram, migrate, resetDb, tgEnv } from './helpers';

async function post(path: string, body: unknown) {
  const r = await SELF.fetch(`http://localhost${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, json: (await r.json()) as any };
}

const DATES = { squat: '2026-10-24', bench: '2026-10-25', deadlift: '2026-10-26', ohp: '2026-10-27' };
const TEST_SETS = [1, 2, 3].map((n) => ({ group: 'main', exercise: 'Deadlift', n, unit: 'kg', load: 20, reps: 5, ...(n === 3 ? { top: true } : {}) }));

/** Mid Test Week: squat and bench tested, deadlift logged as the bar (20 × 5) through a Live Session, OHP to come. */
async function midTestWeek() {
  await performAction(db, { type: 'start-test-week', dates: DATES });
  await performAction(db, { type: 'test-result', date: '2026-10-24', lift: 'squat', weight: 110, reps: 5 }); // TM 115
  await performAction(db, { type: 'test-result', date: '2026-10-25', lift: 'bench', weight: 70, reps: 6 }); // TM 75
  await performAction(db, { type: 'test-result', date: '2026-10-26', lift: 'deadlift', weight: 20, reps: 5 }); // TM 20
  await logLift(db, '2026-10-26', 'deadlift', { date: '2026-10-26', lift: 'deadlift', test: true, testSets: TEST_SETS, result: { weight: 20, reps: 5 } });
}

const correction = (o: Record<string, unknown> = {}) => ({ type: 'test-result', date: '2026-10-26', lift: 'deadlift', weight: 120, reps: 5, correct: true, ...o });

beforeAll(migrate);
beforeEach(resetDb);

describe('test-result correct: true', () => {
  it('replaces the result and the Training Max without counting a new result', async () => {
    await midTestWeek();
    const before = await loadPlannerState(db);
    expect(before.tms.deadlift).toBe(20);
    const r = await post('/api/action', correction());
    expect(r.status).toBe(200);
    expect(r.json.events).toEqual(['Deadlift corrected: 20 × 5 → 120 × 5 · Training Max 20 → 125 kg']);
    const st = await loadPlannerState(db);
    expect(st.testWeek?.results.deadlift).toEqual({ weight: 120, reps: 5 });
    expect(st.tms.deadlift).toBe(125);
    // still 3 of 4: the Test Week runs on, no Cycle started, the other lifts untouched
    expect(Object.keys(st.testWeek!.results).sort()).toEqual(['bench', 'deadlift', 'squat']);
    expect(st.lift).toEqual(before.lift);
    expect(st.tms).toEqual({ ...before.tms, deadlift: 125 });
    // ...and OHP tomorrow is still the fourth result that ends it
    const last = await performAction(db, { type: 'test-result', date: '2026-10-27', lift: 'ohp', weight: 50, reps: 5 });
    expect(last.events).toEqual(['OHP 50 × 5 → Training Max 52.5 kg (4 of 4 tested)', 'All four tested: Cycle 1 starts at the next lift Slot']);
  });

  it("replaces the lift's tm_history snapshot (one row: the new TM on the original test date), idempotently", async () => {
    await midTestWeek();
    // corrected a day later: the snapshot keeps the test's own date
    await post('/api/action', correction({ date: '2026-10-27' }));
    const rows = async () => (await listTmHistory(db, '2000-01-22', '2999-12-31')).filter((s) => s.lift === 'deadlift');
    expect(await rows()).toEqual([{ date: '2026-10-26', lift: 'deadlift', tm: 125, reason: 'test' }]);
    // a second correction replaces it again, never adds one
    await post('/api/action', correction({ weight: 125 }));
    expect(await rows()).toEqual([{ date: '2026-10-26', lift: 'deadlift', tm: 130, reason: 'test' }]); // 0.9 × 125 × 7/6 = 131.25 → 130
  });

  it('updates the TM Test lift_log row: result corrected, corrected.from recorded, testSets left alone', async () => {
    await midTestWeek();
    await post('/api/action', correction());
    const [row] = await liftLogsFor(db, '2026-10-26', 'deadlift');
    expect(row).toMatchObject({ test: true, testSets: TEST_SETS, result: { weight: 120, reps: 5 }, corrected: { from: { weight: 20, reps: 5 } } });
    expect(typeof (row!.corrected as { at: string }).at).toBe('string');
    expect(await liftLogsFor(db, '2026-10-26', 'deadlift')).toHaveLength(1);
  });

  it('a repeated correction keeps the originally logged result in corrected.from', async () => {
    await midTestWeek();
    await post('/api/action', correction());
    await post('/api/action', { ...correction(), weight: 122.5 });
    const [row] = await liftLogsFor(db, '2026-10-26', 'deadlift');
    expect(row).toMatchObject({ result: { weight: 122.5, reps: 5 }, corrected: { from: { weight: 20, reps: 5 } } });
  });

  it('is not a Check-in (Adherence counts the test once)', async () => {
    await midTestWeek();
    await post('/api/action', correction({ date: '2026-10-27' }));
    const ins = await listCheckIns(db, '2026-10-22', '2026-10-31', {});
    expect(ins.filter((c) => c.ref.kind === 'lift-test' && c.ref.lift === 'deadlift')).toEqual([{ date: '2026-10-26', ref: { kind: 'lift-test', lift: 'deadlift' }, status: 'done' }]);
  });

  it('a duplicate without correct is still 409 (the double-tap guard)', async () => {
    await midTestWeek();
    const r = await post('/api/action', { type: 'test-result', date: '2026-10-26', lift: 'deadlift', weight: 120, reps: 5 });
    expect(r.status).toBe(409);
    expect((await loadPlannerState(db)).tms.deadlift).toBe(20);
    expect((await post('/api/action', correction({ correct: false }))).status).toBe(409);
  });

  it('409 for a lift with no result yet, and after the Test Week with a hint to More › Training Max', async () => {
    await midTestWeek();
    const none = await post('/api/action', correction({ lift: 'ohp' }));
    expect(none.status).toBe(409);
    expect(none.json.error).toContain('no TM Test result to correct');
    await performAction(db, { type: 'test-result', date: '2026-10-27', lift: 'ohp', weight: 50, reps: 5 }); // ends the Test Week
    const over = await post('/api/action', correction());
    expect(over.status).toBe(409);
    expect(over.json.error).toBe('the Test Week is over: change the Training Max in More › Training Max');
    expect((await loadPlannerState(db)).tms.deadlift).toBe(20);
  });

  it('validates like test-result', async () => {
    await midTestWeek();
    for (const bad of [{ weight: 0 }, { weight: 500.5 }, { weight: 'x' }, { reps: 0 }, { reps: 16 }, { reps: 5.5 }, { correct: 'yes' }, { correct: 1 }, { lift: 'curl' }, { date: '2026-02-30' }]) {
      const r = await post('/api/action', correction(bad));
      expect(r.status, JSON.stringify(bad)).toBe(400);
    }
    expect((await post('/api/action', correction({ weight: 500, reps: 15 }))).status).toBe(200);
  });
});

// ───────────────────────── Telegram ─────────────────────────

describe('Telegram /test for a tested lift', () => {
  let tg: ReturnType<typeof fakeTelegram>;
  beforeEach(() => {
    tg = fakeTelegram();
    __setTelegramFetchForTesting(tg.fetch);
  });
  afterEach(() => __setTelegramFetchForTesting(null));

  async function send(update: unknown) {
    const ctx = createExecutionContext();
    await worker.fetch(new Request('https://training.example.com/telegram/webhook', {
      method: 'POST', headers: { 'content-type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': SECRET }, body: JSON.stringify(update),
    }), tgEnv(), ctx);
    await waitOnExecutionContext(ctx);
  }
  const message = (text: string) => ({ update_id: 1, message: { message_id: 7, chat: { id: Number(CHAT_ID) }, text } });
  const callback = (data: string) => ({ update_id: 2, callback_query: { id: 'cq1', data, message: { message_id: 55, chat: { id: Number(CHAT_ID) } } } });

  it('asks to replace; ✓ Replace corrects it and edits the same message to the event', async () => {
    await midTestWeek();
    const t = todayFor(await loadPlannerState(db));
    await send(message('/test deadlift 120 5'));
    expect(tg.calls).toHaveLength(1);
    const ask = tg.calls[0]!.body as any;
    expect(ask.text).toBe('Deadlift already has 20 × 5 (TM 20 kg). Replace with 120 × 5 → TM 125 kg?');
    expect(ask.reply_markup.inline_keyboard).toEqual([[
      { text: '✓ Replace', callback_data: `a|tc|${t}|deadlift|120|5` }, { text: '✕ Keep', callback_data: `a|tk|${t}|deadlift|120|5` },
    ]]);
    for (const b of ask.reply_markup.inline_keyboard[0]) expect(new TextEncoder().encode(b.callback_data).length).toBeLessThanOrEqual(64);
    expect((await loadPlannerState(db)).tms.deadlift).toBe(20); // nothing changes until confirmed

    tg.calls.length = 0;
    await send(callback(`a|tc|${t}|deadlift|120|5`));
    const st = await loadPlannerState(db);
    expect(st.testWeek?.results.deadlift).toEqual({ weight: 120, reps: 5 });
    expect(st.tms.deadlift).toBe(125);
    expect(Object.keys(st.testWeek!.results)).toHaveLength(3);
    const edit = tg.calls.find((c) => c.method === 'editMessageText')!.body;
    expect(edit).toMatchObject({ message_id: 55, text: '🏋️ Deadlift corrected: 20 × 5 → 120 × 5 · Training Max 20 → 125 kg', reply_markup: { inline_keyboard: [] } });
    expect(tg.calls.find((c) => c.method === 'answerCallbackQuery')!.body.text).toBe('Corrected');
    expect((await listTmHistory(db, '2000-01-22', '2999-12-31')).filter((s) => s.lift === 'deadlift')).toEqual([{ date: '2026-10-26', lift: 'deadlift', tm: 125, reason: 'test' }]);
  });

  it('✕ Keep leaves the result and edits the message to "Kept 20 × 5"', async () => {
    await midTestWeek();
    const t = todayFor(await loadPlannerState(db));
    await send(callback(`a|tk|${t}|deadlift|120|5`));
    expect(tg.calls.find((c) => c.method === 'editMessageText')!.body).toMatchObject({ message_id: 55, text: 'Kept 20 × 5' });
    const st = await loadPlannerState(db);
    expect(st.testWeek?.results.deadlift).toEqual({ weight: 20, reps: 5 });
    expect(st.tms.deadlift).toBe(20);
  });

  it('the confirmation warns when the new TM is much lower than the other lifts', async () => {
    await midTestWeek();
    await send(message('/test squat 20 5'));
    expect(tg.calls[0]!.body.text).toBe("Squat already has 110 × 5 (TM 115 kg). Replace with 20 × 5 → TM 20 kg?\n⚠️ That's much lower than your other lifts — check the weight");
  });

  it('Replace after the Test Week ended says to use More › Training Max', async () => {
    await midTestWeek();
    const t = todayFor(await loadPlannerState(db));
    await performAction(db, { type: 'test-result', date: addDays(t, 1), lift: 'ohp', weight: 50, reps: 5 });
    await send(callback(`a|tc|${t}|deadlift|120|5`));
    expect(tg.calls.find((c) => c.method === 'editMessageText')!.body.text).toBe('The Test Week is over: change the Training Max in More › Training Max.');
    expect((await loadPlannerState(db)).tms.deadlift).toBe(20);
  });

  it('/help mentions replacing a result', async () => {
    await send(message('/help'));
    expect(tg.calls[0]!.body.text).toContain('asks to replace');
  });
});
