import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import worker from '../../src/index';
import { __setTelegramFetchForTesting } from '../../src/telegram/webhook';
import { onBenchmarkReply } from '../../src/telegram/benchmark';
import { planDays } from '../../src/domain/planner';
import { addDays } from '../../src/domain/dates';
import { getKV, insertActivity, loadPlannerState, savePlannerState, upsertClubEvent } from '../../src/store/db';
import { listBenchmarks } from '../../src/store/progress';
import type { ISODate } from '../../src/domain/types';
import { CHAT_ID, SECRET, db, fakeTelegram, migrate, resetDb, tgEnv } from './helpers';

type Kb = { text: string; callback_data: string }[][];
let tg: ReturnType<typeof fakeTelegram>;

beforeAll(migrate);
beforeEach(async () => {
  await resetDb();
  tg = fakeTelegram();
  __setTelegramFetchForTesting(tg.fetch);
});
afterEach(() => __setTelegramFetchForTesting(null));

async function send(update: unknown) {
  const ctx = createExecutionContext();
  const r = await worker.fetch(
    new Request('https://training.example.com/telegram/webhook', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': SECRET },
      body: JSON.stringify(update),
    }),
    tgEnv(), ctx,
  );
  await waitOnExecutionContext(ctx);
  expect(r.status).toBe(200);
}
const text = (t: string) => send({ update_id: 1, message: { message_id: 7, chat: { id: Number(CHAT_ID) }, text: t } });
const tap = (data: string, keyboard: Kb) =>
  send({ update_id: 2, callback_query: { id: 'cq', data, message: { message_id: 9, chat: { id: Number(CHAT_ID) }, reply_markup: { inline_keyboard: keyboard } } } });

/** The keyboard the last editMessageReplyMarkup set. */
const lastEdit = (): Kb => {
  const c = tg.calls.filter((x) => x.method === 'editMessageReplyMarkup').at(-1)!;
  return (c.body.reply_markup as { inline_keyboard: Kb }).inline_keyboard;
};
const toasts = () => tg.calls.filter((c) => c.method === 'answerCallbackQuery').map((c) => c.body.text);
const results = () => listBenchmarks(db, '2000-01-01', '2999-12-31');

const DELOAD_MON = '2026-10-26';
/** A day in a run deload week whose plan has the 2.4 km Benchmark, and the morning keyboard for it (plus another row). */
async function benchmarkRun(): Promise<{ date: ISODate; suffix: string; keyboard: Kb }> {
  const st = await loadPlannerState(db);
  st.run.runStartMonday = addDays(DELOAD_MON, -21); // run week 4 (index 3) is a deload
  st.runsThisWeek[DELOAD_MON] = ['easy'];
  await savePlannerState(db, st);
  for (let i = 0; i < 7; i++) {
    const date = addDays(DELOAD_MON, i);
    if (planDays(st, date, 1)[0]!.sessions.some((x) => x.kind === 'run' && x.run === 'benchmark-2k4')) {
      const suffix = `${date}|R.benchmark-2k4`;
      return {
        date, suffix,
        keyboard: [
          [{ text: '✅ Done', callback_data: `a|d|${suffix}` }, { text: '⏭ Skip', callback_data: `a|s|${suffix}` }],
          [{ text: '✅ Done', callback_data: `a|d|${date}|C.other` }],
        ],
      };
    }
  }
  throw new Error('no Benchmark run planned');
}

describe('time Benchmark prompt', () => {
  it('Done edits the same message: prompt + Later in place of the row; no watch button without an Activity', async () => {
    const { suffix, keyboard } = await benchmarkRun();
    await tap(`a|D|${suffix}`, keyboard);
    expect(tg.calls.map((c) => c.method)).toEqual(['answerCallbackQuery', 'editMessageReplyMarkup']);
    expect(lastEdit()).toEqual([
      [{ text: '⏱ Time? Reply e.g. 10:42', callback_data: `a|bn|${suffix}` }],
      [{ text: 'Later', callback_data: `a|bl|${suffix}` }],
      keyboard[1],
    ]);
    expect(await results()).toEqual([expect.objectContaining({ kind: '2k4' })]);
    expect((await results())[0]!.timeS).toBeUndefined();
  });

  it('offers the synced Activity\'s time as one tap', async () => {
    const { date, suffix, keyboard } = await benchmarkRun();
    await insertActivity(db, 'icu:long', date, 'intervals', { name: 'Warm-up + TT', sport: 'run', km: 6.1, movingS: 2400 }); // not 2.4 km
    await insertActivity(db, 'icu:tt', date, 'intervals', { name: '2.4 km TT', sport: 'run', km: 2.4, hours: 0.18, movingS: 650, elapsedS: 655 });
    await tap(`a|D|${suffix}`, keyboard);
    const prompt = lastEdit();
    expect(prompt[1]).toEqual([
      { text: '⌚ 10:55 (watch)', callback_data: `a|bt|${suffix}|655` },
      { text: 'Later', callback_data: `a|bl|${suffix}` },
    ]);
    await tap(`a|bt|${suffix}|655`, prompt);
    expect((await results())[0]).toMatchObject({ date, kind: '2k4', timeS: 655 });
    expect(lastEdit()).toEqual([[{ text: '✅ Done · 10:55', callback_data: 'noop' }], keyboard[1]]);
    expect(await getKV(db, 'benchPrompt')).toBeNull();
  });

  it('a plain-text reply like 10:42 is the result, shown on the prompt message; no new message', async () => {
    const { date, suffix, keyboard } = await benchmarkRun();
    await tap(`a|D|${suffix}`, keyboard);
    tg.calls.length = 0;
    await text('hello'); // not a time: ignored, prompt still pending
    expect(tg.calls).toEqual([]);
    await text('10:42');
    expect((await results())[0]).toMatchObject({ date, timeS: 642 });
    expect(tg.calls.map((c) => c.method)).toEqual(['editMessageReplyMarkup']);
    expect(tg.calls[0]!.body.message_id).toBe(9);
    expect(lastEdit()).toEqual([[{ text: '✅ Done · 10:42', callback_data: 'noop' }], keyboard[1]]);
    // answered: a second time reply is just a message
    tg.calls.length = 0;
    await text('10:30');
    expect(tg.calls).toEqual([]);
    expect((await results())[0]!.timeS).toBe(642);
  });

  it('the prompt expires after 2 h', async () => {
    const { suffix, keyboard } = await benchmarkRun();
    await tap(`a|D|${suffix}`, keyboard);
    tg.calls.length = 0;
    const later = new Date(Date.now() + 2 * 3600_000 + 1000);
    expect(await onBenchmarkReply(tgEnv(), '10:42', tg.fetch, later)).toBe(false);
    expect(tg.calls).toEqual([]);
    expect((await results())[0]!.timeS).toBeUndefined();
    expect(await getKV(db, 'benchPrompt')).toBeNull();
    expect(await onBenchmarkReply(tgEnv(), '10:42', tg.fetch)).toBe(false);
  });

  it('Later: Done with no result, never asked again; /bench adds it afterwards', async () => {
    const { date, suffix, keyboard } = await benchmarkRun();
    await tap(`a|D|${suffix}`, keyboard);
    await tap(`a|bl|${suffix}`, lastEdit());
    expect(toasts().at(-1)).toContain('/bench');
    expect(lastEdit()).toEqual([[{ text: '✅ Done', callback_data: 'noop' }], keyboard[1]]);
    expect(await getKV(db, 'benchPrompt')).toBeNull();
    tg.calls.length = 0;
    await text('10:42');
    expect(tg.calls).toEqual([]);
    expect((await results())[0]!.timeS).toBeUndefined();

    await text('/bench 6b 18'); // no auto-belay waiting
    expect(tg.calls.at(-1)!.body.text).toContain('No auto-belay Benchmark');
    await text('/bench 10:42');
    expect(tg.calls.at(-1)!.body.text).toBe(`✅ 2.4 km 10:42 saved for ${date}.`);
    expect((await results())[0]!.timeS).toBe(642);
    await text('/bench 10:40');
    expect(tg.calls.at(-1)!.body.text).toContain('No run Benchmark');
    await text('/bench soon');
    expect(tg.calls.at(-1)!.body.text).toContain('Usage: /bench');
  });

  it('a prompt button for a result already saved says so', async () => {
    const { suffix, keyboard } = await benchmarkRun();
    await tap(`a|D|${suffix}`, keyboard);
    const prompt = lastEdit();
    await text('10:42');
    await tap(`a|bl|${suffix}`, prompt);
    expect(toasts().at(-1)).toBe('Already saved.');
    expect((await results())[0]!.timeS).toBe(642);
  });
});

describe('auto-belay prompt', () => {
  it('grade buttons, then minute buttons, all in the same message', async () => {
    const date = '2026-10-29';
    await upsertClubEvent(db, { id: 'wall-c', date, time: '18:00', title: 'Wall C', venue: 'Wall C', type: 'endurance_benchmark' });
    const suffix = `${date}|C.wall-c`;
    await tap(`a|D|${suffix}`, [[{ text: '✅ Done', callback_data: `a|d|${suffix}` }]]);
    const grades = lastEdit();
    expect(grades[0]).toEqual([{ text: '🧗 Grade?', callback_data: `a|bn|${suffix}` }]);
    expect(grades.slice(1, 3).flat().map((b) => b.text)).toEqual(['5c', '6a', '6a+', '6b', '6b+', '6c', '6c+', '7a', '7a+', '7b', '7b+', '7c']);
    expect(grades[3]).toEqual([{ text: 'Later', callback_data: `a|bl|${suffix}` }]);
    for (const row of grades) for (const b of row) expect(new TextEncoder().encode(b.callback_data).length).toBeLessThanOrEqual(64);

    await tap(`a|bg|${suffix}|6b+`, grades);
    const mins = lastEdit();
    expect(mins[0]![0]!.text).toBe('🧗 6b+ — minutes?');
    expect(mins[1]!.map((b) => b.text)).toEqual(['5', '10', '15', '20', '25', '30+']);
    expect(await getKV(db, 'benchPrompt')).toBeNull(); // only time prompts take a text reply

    await tap(`a|bm|${suffix}|6b+|30`, mins);
    expect((await results())[0]).toMatchObject({ date, kind: 'autobelay', eventId: 'wall-c', grade: '6b+', minutes: 30 });
    expect(lastEdit()).toEqual([[{ text: '✅ Done · 6b+ · 30 min', callback_data: 'noop' }]]);
  });

  it('a forged grade is refused', async () => {
    const date = '2026-10-29';
    await upsertClubEvent(db, { id: 'wall-c', date, time: '18:00', title: 'Wall C', venue: 'Wall C', type: 'endurance_benchmark' });
    const suffix = `${date}|C.wall-c`;
    await tap(`a|D|${suffix}`, [[{ text: '✅ Done', callback_data: `a|d|${suffix}` }]]);
    await tap(`a|bm|${suffix}|6z|20`, lastEdit());
    expect(toasts().at(-1)).toBe('This button is no longer valid.');
    expect((await results())[0]!.grade).toBeUndefined();
  });
});
