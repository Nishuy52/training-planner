import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import worker from '../../src/index';
import { __setTelegramFetchForTesting } from '../../src/telegram/webhook';
import { performAction, todayFor } from '../../src/http/api';
import { encodeCallback } from '../../src/telegram/format';
import { planDays } from '../../src/domain/planner';
import { addDays, mondayOf } from '../../src/domain/dates';
import { insertActivity, loadPlannerState, savePlannerState, setKV } from '../../src/store/db';
import type { SessionRef } from '../../src/domain/types';
import { CHAT_ID, SECRET, db, fakeTelegram, migrate, resetDb, tgEnv } from './helpers';

let tg: ReturnType<typeof fakeTelegram>;

beforeAll(migrate);
beforeEach(async () => {
  await resetDb();
  tg = fakeTelegram();
  __setTelegramFetchForTesting(tg.fetch);
});
afterEach(() => __setTelegramFetchForTesting(null));

async function send(update: unknown, secret: string | null = SECRET) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (secret !== null) headers['X-Telegram-Bot-Api-Secret-Token'] = secret;
  const ctx = createExecutionContext();
  const r = await worker.fetch(new Request('https://training.example.com/telegram/webhook', { method: 'POST', headers, body: JSON.stringify(update) }), tgEnv(), ctx);
  await waitOnExecutionContext(ctx);
  return r;
}

const message = (text: string, chatId: number | string = Number(CHAT_ID)) => ({ update_id: 1, message: { message_id: 7, chat: { id: chatId }, text } });
const callback = (data: string, keyboard: unknown = [], chatId: number | string = Number(CHAT_ID)) => ({
  update_id: 2,
  callback_query: { id: 'cq1', data, message: { message_id: 9, chat: { id: chatId }, reply_markup: { inline_keyboard: keyboard } } },
});

/** First planned lift from Monday 5 Oct, as the morning message would offer it. */
async function firstLift() {
  const st = await loadPlannerState(db);
  for (const d of planDays(st, '2026-10-05', 7)) {
    const s = d.sessions.find((x) => x.kind === 'lift');
    if (s && s.kind === 'lift') return { date: d.date, ref: { kind: 'lift', lift: s.lift, week: s.week } as SessionRef };
  }
  throw new Error('no lift planned');
}

describe('auth and chat filter', () => {
  it('wrong or missing secret -> 401, nothing processed', async () => {
    expect((await send(message('/help'), 'wrong')).status).toBe(401);
    expect((await send(message('/help'), null)).status).toBe(401);
    expect(tg.calls).toEqual([]);
  });
  it('is not behind Cloudflare Access (no JWT needed)', async () => {
    expect((await send(message('/help'))).status).toBe(200);
    expect(tg.calls.map((c) => c.method)).toEqual(['sendMessage']);
  });
  it('a foreign chat is ignored with 200', async () => {
    const { date, ref } = await firstLift();
    const r = await send(callback(encodeCallback({ type: 'action', act: 'done', date, ref }), [], 999));
    expect(r.status).toBe(200);
    expect(tg.calls).toEqual([]);
    expect((await loadPlannerState(db)).lift.index).toBe(0);
  });
  it('a malformed body still gets 200 (no Telegram retry loop)', async () => {
    const ctx = createExecutionContext();
    const r = await worker.fetch(new Request('https://x/telegram/webhook', { method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': SECRET }, body: '{nope' }), tgEnv(), ctx);
    expect(r.status).toBe(200);
  });
});

describe('callbacks', () => {
  it('confirmed Done advances the plan, answers, and marks the row; a second tap is a no-op', async () => {
    const { date, ref } = await firstLift();
    const data = encodeCallback({ type: 'action', act: 'done', date, ref });
    const keyboard = [
      [{ text: '🏋️ Squat: Done', callback_data: encodeCallback({ type: 'ask', act: 'done', date, ref }) }, { text: '🏋️ Skip', callback_data: encodeCallback({ type: 'ask', act: 'skip', date, ref }) }],
      [{ text: '🏃 Easy run: Done', callback_data: `a|d|${date}|R.easy` }],
    ];
    expect((await send(callback(data, keyboard))).status).toBe(200);

    const st = await loadPlannerState(db);
    expect(st.lift.index).toBe(1);
    expect(st.doneByDate[date]).toEqual([ref]);
    expect(tg.calls.map((c) => c.method)).toEqual(['answerCallbackQuery', 'editMessageReplyMarkup']);
    const edited = tg.calls[1]!.body.reply_markup as { inline_keyboard: { text: string; callback_data: string }[][] };
    // The status button still says which Session it was.
    expect(ref).toEqual({ kind: 'lift', lift: 'squat', week: 1 });
    expect(edited.inline_keyboard[0]).toEqual([{ text: '🏋️ Squat: ✅ Done', callback_data: 'noop' }]);
    expect(edited.inline_keyboard[1]).toEqual(keyboard[1]);

    tg.calls.length = 0;
    await send(callback(data, keyboard));
    expect((await loadPlannerState(db)).lift.index).toBe(1);
    expect(tg.calls[0]!.body.text).toBe('Already handled.');
    expect((tg.calls[1]!.body.reply_markup as { inline_keyboard: unknown[][] }).inline_keyboard[0]).toEqual([{ text: expect.stringMatching(/^🏋️ \w+: ✔ Already handled$/), callback_data: 'noop' }]);
  });

  describe('Done / Skip / Tomorrow confirmation', () => {
    type Kb = { text: string; callback_data: string }[][];
    const sent = (i: number) => (tg.calls[i]!.body.reply_markup as { inline_keyboard: Kb }).inline_keyboard;

    /** The morning rows for the first lift (Squat week 1), plus another Session's row. */
    async function squatRows() {
      const { date, ref } = await firstLift();
      expect(ref).toEqual({ kind: 'lift', lift: 'squat', week: 1 });
      const keyboard: Kb = [
        [{ text: '▶ Start Squat', callback_data: `a|g|${date}|L.squat.1` }],
        [
          { text: '🏋️ Squat: Done', callback_data: `a|q|${date}|L.squat.1` },
          { text: '🏋️ Skip', callback_data: `a|s|${date}|L.squat.1` },
          { text: '🏋️ Tomorrow', callback_data: `a|t|${date}|L.squat.1` },
        ],
        [{ text: '🏃 Easy run: Done', callback_data: `a|d|${date}|R.easy` }],
      ];
      return { date, ref, keyboard };
    }

    it('Skip asks: its rows become one confirmation row and nothing changes', async () => {
      const { date, keyboard } = await squatRows();
      const before = await loadPlannerState(db);
      await send(callback(`a|s|${date}|L.squat.1`, keyboard));
      expect(tg.calls.map((c) => c.method)).toEqual(['answerCallbackQuery', 'editMessageReplyMarkup']);
      expect(tg.calls[0]!.body.text).toBe('Tap ✓ to confirm');
      expect(sent(1)).toEqual([
        [{ text: '✓ Skip Squat 5s', callback_data: `a|S|${date}|L.squat.1` }, { text: '↩︎ Cancel', callback_data: `a|x|${date}|L.squat.1` }],
        keyboard[2],
      ]);
      expect(await loadPlannerState(db)).toEqual(before);
    });

    it('✓ Skip performs the Skip: the lift queue moves on and the row shows the status', async () => {
      const { date, keyboard } = await squatRows();
      await send(callback(`a|s|${date}|L.squat.1`, keyboard));
      const confirmKb = sent(1);
      tg.calls.length = 0;
      await send(callback(`a|S|${date}|L.squat.1`, confirmKb));
      expect((await loadPlannerState(db)).lift.index).toBe(1);
      expect(tg.calls[0]!.body.text).toMatch(/^⏭ Skipped/);
      expect(sent(1)).toEqual([[{ text: '🏋️ Squat: ⏭ Skipped', callback_data: 'noop' }], keyboard[2]]);
    });

    it('Tomorrow asks, ✓ moves the lift to tomorrow', async () => {
      const { date, ref, keyboard } = await squatRows();
      await send(callback(`a|t|${date}|L.squat.1`, keyboard));
      expect(sent(1)[0]![0]).toEqual({ text: '✓ Move Squat 5s to tomorrow', callback_data: `a|T|${date}|L.squat.1` });
      expect((await loadPlannerState(db)).lift.index).toBe(0);
      const confirmKb = sent(1);
      tg.calls.length = 0;
      await send(callback(`a|T|${date}|L.squat.1`, confirmKb));
      expect(tg.calls[0]!.body.text).toMatch(/^➡️ Moved to tomorrow/);
      const st = await loadPlannerState(db);
      expect(st.lift.index).toBe(0);
      expect(planDays(st, date, 1)[0]!.sessions.some((s) => s.kind === 'lift' && s.lift === 'squat')).toBe(false);
      expect(st.doneByDate[date] ?? []).not.toContainEqual(ref);
    });

    it('Done on a run asks too, and ✓ marks it done', async () => {
      const st = await loadPlannerState(db);
      const day = planDays(st, '2026-10-05', 7).find((d) => d.sessions.some((x) => x.kind === 'run'))!;
      const ref = day.sessions.find((x) => x.kind === 'run')! as Extract<SessionRef, { kind: 'run' }>;
      const tag = `${day.date}|R.${ref.run}`;
      const kb: Kb = [[{ text: '🏃 Done', callback_data: `a|d|${tag}` }, { text: '🏃 Skip', callback_data: `a|s|${tag}` }]];
      await send(callback(`a|d|${tag}`, kb));
      expect(sent(1)).toEqual([[{ text: expect.stringMatching(/^✓ Mark .+ done$/), callback_data: `a|D|${tag}` }, { text: '↩︎ Cancel', callback_data: `a|x|${tag}` }]]);
      expect((await loadPlannerState(db)).doneByDate[day.date]).toBeUndefined();
      await send(callback(`a|D|${tag}`, sent(1)));
      expect((await loadPlannerState(db)).doneByDate[day.date]).toEqual([{ kind: 'run', run: ref.run }]);
      expect(sent(3)[0]![0]!.text).toMatch(/: ✅ Done$/);
    });

    it('Cancel restores the original rows and changes nothing', async () => {
      const { date, keyboard } = await squatRows();
      await send(callback(`a|s|${date}|L.squat.1`, keyboard));
      await send(callback(`a|x|${date}|L.squat.1`, sent(1)));
      expect(sent(3)).toEqual(keyboard);
      expect((await loadPlannerState(db)).lift.index).toBe(0);
    });

    it('an ask tap on a Session already handled says so', async () => {
      const { date, keyboard } = await squatRows();
      await send(callback(`a|s|${date}|L.squat.1`, keyboard));
      await send(callback(`a|S|${date}|L.squat.1`, sent(1)));
      tg.calls.length = 0;
      await send(callback(`a|t|${date}|L.squat.1`, keyboard));
      expect(tg.calls[0]!.body.text).toBe('Already handled.');
      expect(sent(1)[0]).toEqual([{ text: '🏋️ Squat: ✔ Already handled', callback_data: 'noop' }]);
      expect((await loadPlannerState(db)).lift.index).toBe(1);
    });
  });

  describe('AMRAP reps picker', () => {
    type Kb = { text: string; callback_data: string }[][];
    const sent = (i: number) => (tg.calls[i]!.body.reply_markup as { inline_keyboard: Kb }).inline_keyboard;

    /** Squat week 3 is next, TM 100, and weeks 1 and 2 hit their AMRAP targets. */
    async function week3Squat() {
      const st = await loadPlannerState(db);
      st.tms.squat = 100;
      st.lift = { week: 3, index: 0, phase: { kind: 'normal' } };
      await savePlannerState(db, st);
      await setKV(db, 'amrapLog', JSON.stringify({ squat: { 1: 5, 2: 3 }, bench: {}, deadlift: {}, ohp: {} }));
      const { date, ref } = await firstLift();
      expect(ref).toEqual({ kind: 'lift', lift: 'squat', week: 3 });
      const row = [
        { text: '🏋️ Squat: Done', callback_data: `a|q|${date}|L.squat.3` },
        { text: '🏋️ Skip', callback_data: `a|s|${date}|L.squat.3` },
      ];
      return { date, keyboard: [row, [{ text: '🏃 Easy run: Done', callback_data: `a|d|${date}|R.easy` }]] as Kb };
    }

    it('q shows the rep buttons in place of the row and changes nothing', async () => {
      const { date, keyboard } = await week3Squat();
      await send(callback(`a|q|${date}|L.squat.3`, keyboard));
      expect(tg.calls.map((c) => c.method)).toEqual(['answerCallbackQuery', 'editMessageReplyMarkup']);
      const kb = sent(1);
      expect(kb.slice(0, 2).map((r) => r.map((b) => b.text))).toEqual([['0', '1', '2', '3', '4', '5', '6'], ['7', '8', '9', '10', '11', '12', '13+']]);
      expect(kb[1]![6]!.callback_data).toBe(`a|r|${date}|L.squat.3|13`);
      expect(kb[2]).toEqual([{ text: '↩︎ Cancel', callback_data: `a|x|${date}|L.squat.3` }]);
      expect(kb[3]).toEqual(keyboard[1]);
      const st = await loadPlannerState(db);
      expect(st.lift.index).toBe(0);
      expect(st.tms.squat).toBe(100);
    });

    it('Cancel restores the original row', async () => {
      const { date, keyboard } = await week3Squat();
      await send(callback(`a|q|${date}|L.squat.3`, keyboard));
      await send(callback(`a|x|${date}|L.squat.3`, sent(1)));
      const kb = sent(3);
      expect(kb).toHaveLength(3);
      expect(kb[0]).toEqual([{ text: '▶ Start Squat', callback_data: `a|g|${date}|L.squat.3` }]);
      expect(kb[1]!.map((b) => b.callback_data)).toEqual([`a|q|${date}|L.squat.3`, `a|s|${date}|L.squat.3`, `a|t|${date}|L.squat.3`]);
      expect(kb[1]!.map((b) => b.text)).toEqual(['🏋️ Squat: Done', '🏋️ Skip', '🏋️ Tomorrow']);
      expect(kb[2]).toEqual(keyboard[1]);
      expect((await loadPlannerState(db)).lift.index).toBe(0);
    });

    it('r with 6 on week-3 squat applies done with reps: TM 100 -> 105, lift_log written', async () => {
      const { date, keyboard } = await week3Squat();
      await send(callback(`a|q|${date}|L.squat.3`, keyboard));
      tg.calls.length = 0;
      await send(callback(`a|r|${date}|L.squat.3|6`, keyboard));
      const st = await loadPlannerState(db);
      expect(st.tms.squat).toBe(105);
      expect(st.doneByDate[date]).toEqual([{ kind: 'lift', lift: 'squat', week: 3 }]);
      const text = tg.calls[0]!.body.text as string;
      expect(text).toContain('Squat 5/3/1 done — 6 reps on the + set');
      expect(text).toContain('TM squat 100→105');
      expect(sent(1)[0]).toEqual([{ text: '🏋️ Squat: ✅ Done', callback_data: 'noop' }]);
      const log = await db.prepare("SELECT json FROM lift_log WHERE lift = 'squat'").first<{ json: string }>();
      expect(JSON.parse(log!.json)).toMatchObject({ amrapReps: 6, week: 3 });
    });

    it('r after the lift was already handled is a no-op', async () => {
      const { date, keyboard } = await week3Squat();
      await send(callback(`a|r|${date}|L.squat.3|6`, keyboard));
      tg.calls.length = 0;
      await send(callback(`a|r|${date}|L.squat.3|2`, keyboard));
      expect(tg.calls[0]!.body.text).toBe('Already handled.');
      expect((await loadPlannerState(db)).tms.squat).toBe(105);
    });
  });

  it('mobility button logs the routine', async () => {
    await send(callback('m|d|2026-10-05'));
    const row = await db.prepare('SELECT status FROM mobility_log WHERE date = ?').bind('2026-10-05').first<{ status: string }>();
    expect(row?.status).toBe('done');
    expect(tg.calls.map((c) => c.method)).toEqual(['answerCallbackQuery', 'editMessageReplyMarkup']);
  });

  it('garbage callback data is answered, nothing changes', async () => {
    await send(callback('a|d|2026-10-05|L.curl.1'));
    expect(tg.calls.map((c) => c.method)).toEqual(['answerCallbackQuery']);
    expect((await loadPlannerState(db)).lift.index).toBe(0);
  });
});

describe('commands', () => {
  it('/log credits a hike and replies with what it counted as', async () => {
    await send(message('/log 3h 700m 7'));
    const st = await loadPlannerState(db);
    const today = todayFor(st);
    expect(st.ruck.lastCredit).toBe(today);
    expect(st.runsThisWeek[mondayOf(today)]).toContain('long');
    expect(tg.calls).toHaveLength(1);
    const text = tg.calls[0]!.body.text as string;
    expect(text).toContain('3 h · 700 m');
    expect(text).toContain('Counted as: Hill Ruck credit + Long run');
    expect(tg.calls[0]!.body.chat_id).toBe(CHAT_ID);
  });

  it('/log records an Activity row per log (source telegram) for the weekly totals', async () => {
    await send(message('/log 3h 700m 7'));
    await send(message('/log 1h 100m 1'));
    const today = todayFor(await loadPlannerState(db));
    const { results } = await db.prepare('SELECT id, date, source, json FROM activities ORDER BY rowid').all<{ id: string; date: string; source: string; json: string }>();
    expect(results.map((r) => [r.date, r.source])).toEqual([[today, 'telegram'], [today, 'telegram']]);
    for (const r of results) expect(r.id).toMatch(new RegExp(`^log:${today}:[0-9a-f]{8,}$`));
    expect(results[0]!.id).not.toBe(results[1]!.id);
    expect(JSON.parse(results[0]!.json)).toEqual({ name: 'Hike (/log)', sport: 'hike', hours: 3, vertM: 700, load: 70 });
  });

  it('/log never collides with an existing row id (no count-based ids)', async () => {
    const today = todayFor(await loadPlannerState(db));
    await insertActivity(db, `log:${today}:2`, today, 'telegram', { name: 'Hike (/log)', sport: 'hike', hours: 1, vertM: 50, load: 10 });
    await send(message('/log 1h 100m 1'));
    expect((await db.prepare('SELECT COUNT(*) AS n FROM activities').first<{ n: number }>())!.n).toBe(2);
  });

  it('/log with a small hike counts as nothing; bad syntax gets usage', async () => {
    await send(message('/log 1h 100m 1'));
    expect(tg.calls[0]!.body.text).toContain('Counted as: nothing');
    await send(message('/log lots'));
    expect(tg.calls[1]!.body.text).toContain('Usage: /log');
  });

  it('/amrap attaches reps to today\'s done lift', async () => {
    const st = await loadPlannerState(db);
    const today = todayFor(st);
    // seed the done lift directly: whether squat is *planned* today depends on the weekday
    st.doneByDate[today] = [...(st.doneByDate[today] ?? []), { kind: 'lift', lift: 'squat', week: 1 }];
    await savePlannerState(db, st);
    await send(message('/amrap squat 9'));
    expect(tg.calls[0]!.body.text).toContain('Logged squat AMRAP: 9 reps (week 1)');
    const log = await db.prepare("SELECT json FROM lift_log WHERE lift = 'squat'").first<{ json: string }>();
    expect(JSON.parse(log!.json)).toMatchObject({ amrapReps: 9, week: 1 });
    await send(message('/amrap bench 5'));
    expect(tg.calls[1]!.body.text).toContain('No bench marked done today');
  });

  describe('Test Week', () => {
    async function startTestWeek() {
      const st = await loadPlannerState(db);
      const t = todayFor(st);
      st.testWeek = { dates: { squat: t, bench: addDays(t, 1), deadlift: addDays(t, 2), ohp: addDays(t, 3) }, results: {} };
      await savePlannerState(db, st);
      return t;
    }

    /** /test, then ✓ Save on its confirmation; resolves to the saved message's text. */
    async function testAndSave(cmd: string) {
      tg.calls.length = 0;
      await send(message(cmd));
      const data = (tg.calls[0]!.body as any).reply_markup.inline_keyboard[0][0].callback_data as string;
      tg.calls.length = 0;
      await send(callback(data));
      return tg.calls.find((c) => c.method === 'editMessageText')!.body.text as string;
    }

    it('/test asks first with the Training Max it sets; ✓ Save logs it; the fourth ends the Test Week', async () => {
      const t = await startTestWeek();
      await send(message('/test squat 110 5'));
      const ask = tg.calls[0]!.body as any;
      expect(ask.text).toBe('Squat 110 kg × 5 → Training Max 115 kg. Save?');
      expect(ask.reply_markup.inline_keyboard).toEqual([[
        { text: '✓ Save', callback_data: `a|ts|${t}|squat|110|5` }, { text: '✕ Cancel', callback_data: `a|tx|${t}|squat|110|5` },
      ]]);
      expect((await loadPlannerState(db)).testWeek?.results).toEqual({}); // nothing saved yet
      tg.calls.length = 0;
      await send(callback(`a|ts|${t}|squat|110|5`));
      let st = await loadPlannerState(db);
      expect(st.testWeek?.results.squat).toEqual({ weight: 110, reps: 5 });
      expect(st.tms.squat).toBe(115);
      expect(st.doneByDate[t]).toContainEqual({ kind: 'lift-test', lift: 'squat' });
      expect(tg.calls.find((c) => c.method === 'editMessageText')!.body).toMatchObject({
        message_id: 9, text: '🏋️ Squat 110 × 5 → Training Max 115 kg (1 of 4 tested)\nStill to test: bench, deadlift, ohp', reply_markup: { inline_keyboard: [] },
      });
      // a second tap on ✓ Save is not a second result
      tg.calls.length = 0;
      await send(callback(`a|ts|${t}|squat|110|5`));
      expect(tg.calls.find((c) => c.method === 'editMessageText')!.body.text).toBe('Squat already has 110 × 5: send /test again to replace it.');
      expect((await loadPlannerState(db)).tms.squat).toBe(115);
      tg.calls.length = 0;
      await send(message('/test squat 120 5'));
      expect(tg.calls[0]!.body.text).toContain('already has 110 × 5');
      expect((await loadPlannerState(db)).tms.squat).toBe(115);
      expect(await testAndSave('/test bench 72,5 6')).toContain('Bench 72.5 × 6 → Training Max 77.5 kg (2 of 4 tested)');
      await testAndSave('/test deadlift 140 5');
      const last = await testAndSave('/test OHP 50 5');
      st = await loadPlannerState(db);
      expect(st.testWeek).toBeUndefined();
      expect(st.tms).toEqual({ squat: 115, bench: 77.5, deadlift: 145, ohp: 52.5 });
      expect(st.lift).toMatchObject({ week: 1, index: 0, notBefore: addDays(t, 1) });
      expect(last).toBe('🏋️ OHP 50 × 5 → Training Max 52.5 kg (4 of 4 tested)\nAll four tested: Cycle 1 starts at the next lift Slot');
    });

    it('/test ✕ Cancel saves nothing; the confirmation warns when the TM is much lower than the other lifts', async () => {
      const t = await startTestWeek();
      await testAndSave('/test squat 110 5'); // TM 115
      tg.calls.length = 0;
      await send(message('/test deadlift 20 5'));
      expect(tg.calls[0]!.body.text).toBe("Deadlift 20 kg × 5 → Training Max 20 kg. Save?\n⚠️ That's much lower than your other lifts — check the weight");
      tg.calls.length = 0;
      await send(callback(`a|tx|${t}|deadlift|20|5`));
      expect(tg.calls.find((c) => c.method === 'editMessageText')!.body.text).toBe('Cancelled: Deadlift 20 kg × 5 not saved');
      const st = await loadPlannerState(db);
      expect(st.testWeek?.results.deadlift).toBeUndefined();
      expect(st.tms.deadlift).not.toBe(20);
      tg.calls.length = 0;
      await send(message('/test deadlift 120 5'));
      expect(tg.calls[0]!.body.text).toBe('Deadlift 120 kg × 5 → Training Max 125 kg. Save?');
    });

    it('/test rejects garbage and works only during a Test Week', async () => {
      await send(message('/test squat 100 5'));
      expect(tg.calls[0]!.body.text).toContain('No Test Week is active');
      await startTestWeek();
      for (const bad of ['/test', '/test curl 100 5', '/test squat heavy 5', '/test squat 0 5', '/test squat 501 5', '/test squat 100 0', '/test squat 100 16', '/test squat 100 5.5', '/test squat 100']) {
        await send(message(bad));
      }
      expect(tg.calls.slice(1).every((c) => String(c.body.text).startsWith('Usage: /test'))).toBe(true);
      expect((await loadPlannerState(db)).testWeek?.results).toEqual({});
    });

    it('How to log answers with the command; Skip moves the test to tomorrow', async () => {
      const t = await startTestWeek();
      await send(callback(`a|h|${t}|X.squat`));
      expect(tg.calls.map((c) => c.method)).toEqual(['answerCallbackQuery', 'sendMessage']);
      expect(tg.calls[0]!.body.text).toContain('/test squat <kg> <reps>');
      expect(tg.calls[1]!.body.text).toBe('Send /test squat &lt;kg&gt; &lt;reps&gt; with the top set, e.g. /test squat 100 5');
      await send(callback(`a|s|${t}|X.squat`));
      expect(tg.calls.filter((c) => c.method === 'answerCallbackQuery').at(-1)!.body.text).toBe('Tap ✓ to confirm');
      expect((await loadPlannerState(db)).testWeek?.dates.squat).toBe(t);
      await send(callback(`a|S|${t}|X.squat`));
      expect((await loadPlannerState(db)).testWeek?.dates.squat).toBe(addDays(t, 1));
    });
  });

  it('/today and /week send messages; unknown command gets help', async () => {
    await send(message('/today'));
    await send(message('/week@MyBot'));
    await send(message('/whatever'));
    expect(tg.calls.map((c) => c.method)).toEqual(['sendMessage', 'sendMessage', 'sendMessage']);
    expect(tg.calls[0]!.body.text).toContain('☀️');
    expect(String(tg.calls[1]!.body.text).split('\n').length).toBeGreaterThanOrEqual(7);
    expect(tg.calls[2]!.body.text).toContain('/log');
  });

  it('a Telegram API failure still returns 200', async () => {
    tg.status = 500;
    expect((await send(message('/help'))).status).toBe(200);
  });
});

describe('worker roles (ADR 0003)', () => {
  const call = async (role: string | undefined, method: string, path: string, secret = SECRET) => {
    const ctx = createExecutionContext();
    const init: RequestInit = { method, headers: { 'X-Telegram-Bot-Api-Secret-Token': secret, 'content-type': 'application/json' } };
    if (method === 'POST') init.body = JSON.stringify({ update_id: 1 });
    const r = await worker.fetch(new Request(`http://localhost${path}`, init), { ...tgEnv(), ROLE: role }, ctx);
    await waitOnExecutionContext(ctx);
    return r;
  };

  it('bot: only POST /telegram/webhook is served', async () => {
    expect((await call('bot', 'POST', '/telegram/webhook')).status).toBe(200);
    expect((await call('bot', 'GET', '/telegram/webhook')).status).toBe(404);
    expect((await call('bot', 'GET', '/')).status).toBe(404);
    expect((await call('bot', 'GET', '/api/health')).status).toBe(404);
  });

  it('app (or unset): webhook is 404, API still served', async () => {
    expect((await call('app', 'POST', '/telegram/webhook')).status).toBe(404);
    expect((await call(undefined, 'POST', '/telegram/webhook')).status).toBe(404);
    expect((await call('app', 'GET', '/api/health')).status).toBe(200);
  });
});
