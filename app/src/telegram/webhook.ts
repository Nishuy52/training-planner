// POST /telegram/webhook: Check-ins (button callbacks) and commands from the one allowed chat.
// Not behind Cloudflare Access (Telegram can't authenticate to it); protected by the webhook secret instead.
import { Hono } from 'hono';
import type { Env } from '../index';
import type { Lift, PlannerState, SessionRef } from '../domain/types';
import { LIFT_ORDER } from '../domain/types';
import { countedAs } from '../domain/credit';
import { isPlanned } from '../domain/planner';
import { appendActionLog, insertActivity, loadPlannerState, logLift, markMobility, newLogActivityId } from '../store/db';
import { BadRequest, Conflict, NotPlanned, performAction, planWithDetails, recordAmrapIfMissing, todayFor } from '../http/api';
import { LOW_TM_WARNING, testResultPreview } from '../domain/actions';
import { LIFT_LABEL } from '../domain/live';
import { answerCallbackQuery, editMessageReplyMarkup, editMessageText, sendMessage, sendMessageWithMarkup, type InlineKeyboard } from './client';
import { REMOVE_KEYBOARD, decodeLive } from './live';
import { liveStub } from '../live/durable';
import { MAX_AMRAP_BUTTON, confirmRow, decodeCallback, encodeCallback, esc, morningMessage, previewMessage, repsKeyboard, sessionRows, sessionTag, testHint } from './format';
import { benchmarkPrompt, cmdBench, isBenchmarkCallback, onBenchmarkCallback, onBenchmarkReply } from './benchmark';

// ───────────────────────── Telegram transport (overridable in tests) ─────────────────────────

let fetchOverride: typeof fetch | null = null;

/** TEST ONLY: route Telegram API calls to a fake. Pass `null` to restore the real fetch. */
export function __setTelegramFetchForTesting(f: typeof fetch | null): void {
  fetchOverride = f;
}

/** The fetch every Telegram API call goes through (webhook replies and cron reminders). */
export const telegramFetch: typeof fetch = (input, init) => (fetchOverride ?? fetch)(input, init);

/** Error text safe to log: never includes the bot token. */
export function safeError(env: Env, err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return env.TELEGRAM_BOT_TOKEN ? msg.split(env.TELEGRAM_BOT_TOKEN).join('***') : msg;
}

// ───────────────────────── update shapes ─────────────────────────

type TgChat = { id: number | string };
type TgMessage = { message_id: number; chat: TgChat; text?: string; reply_markup?: { inline_keyboard?: InlineKeyboard } };
type TgUpdate = {
  message?: TgMessage;
  callback_query?: { id: string; data?: string; message?: TgMessage };
};

const NOOP = 'noop';

async function secretMatches(got: string | undefined, want: string | undefined): Promise<boolean> {
  if (!want || got === undefined) return false;
  // Hash both sides so the comparison is fixed-length and constant-time.
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(got)),
    crypto.subtle.digest('SHA-256', enc.encode(want)),
  ]);
  return crypto.subtle.timingSafeEqual(a, b);
}

// ───────────────────────── callbacks ─────────────────────────

const ACT_DONE_TEXT = { done: '✅ Done', skip: '⏭ Skipped', tomorrow: '➡️ Moved to tomorrow' } as const;

/** The keyboard rows whose buttons target `suffix` (`<date>|<ref>`): Done/Skip/Tomorrow, rep buttons or Cancel. */
const targets = (row: InlineKeyboard[number], suffix: string): boolean =>
  row.some((b) => b.callback_data.startsWith('a|') && b.callback_data.split('|').slice(2, 4).join('|') === suffix);

/** Replace the first row targeting `suffix` with `replacement` and drop any further rows for it (the rep picker spans several). */
function swapRows(keyboard: InlineKeyboard, suffix: string, replacement: InlineKeyboard): InlineKeyboard {
  let done = false;
  return keyboard.flatMap((row) => {
    if (!targets(row, suffix)) return [row];
    if (done) return [];
    done = true;
    return replacement;
  });
}

/** Replace the rows for `suffix` with a single status button. */
const markRows = (keyboard: InlineKeyboard, suffix: string, status: string): InlineKeyboard =>
  swapRows(keyboard, suffix, [[{ text: status, callback_data: NOOP }]]);

const WEEK_NAME = { 1: '5s', 2: '3s', 3: '5/3/1' } as const;

async function onCallback(env: Env, cq: NonNullable<TgUpdate['callback_query']>): Promise<void> {
  const db = env.DB;
  const data = cq.data ?? '';
  const msg = cq.message;
  const keyboard = msg?.reply_markup?.inline_keyboard ?? [];
  const answer = (text?: string) => answerCallbackQuery(env, cq.id, text, telegramFetch);
  const edit = (kb: InlineKeyboard) => (msg ? editMessageReplyMarkup(env, msg.message_id, kb, telegramFetch) : Promise.resolve());

  if (data === NOOP) return answer();
  if (isBenchmarkCallback(data)) return onBenchmarkCallback(db, data, keyboard, answer, edit);
  if (data.startsWith('l|')) {
    const lc = decodeLive(data);
    if (!lc) return answer('This button is no longer valid.');
    const r = await liveStub(env).callback(lc);
    await answer(r.toast);
    if (r.clearKeyboard) await edit([]);
    return;
  }
  const cb = decodeCallback(data);
  if (!cb) return answer('This button is no longer valid.');

  if (cb.type === 'mobility') {
    await markMobility(db, cb.date, cb.status);
    const status = cb.status === 'done' ? '✅ Routine done' : 'Routine skipped';
    await answer(status);
    await edit([[{ text: status, callback_data: NOOP }]]);
    return;
  }

  if (cb.type === 'test-hint') {
    // A toast is gone in a second: send the command as a message too, so it stays to copy.
    const hint = `Send ${testHint(cb.lift)} with the top set, e.g. /test ${cb.lift} 100 5`;
    await answer(hint);
    await sendMessage(env, esc(hint), undefined, telegramFetch);
    return;
  }

  if (cb.type === 'start') {
    const r = await liveStub(env).start(cb.date, cb.ref, cb.mode);
    if (cb.mode && msg) await edit([]); // the Resume / Start fresh question is answered
    if (r.ok) return answer(cb.mode === 'resume' ? '▶ Live Session resumed' : '▶ Live Session started');
    if (!r.resumable) return answer(r.error);
    // An attempt abandoned earlier today has Logged Sets: ask which way.
    await answer('Resume or start fresh?');
    await sendMessage(env, esc(`${r.error[0]!.toUpperCase()}${r.error.slice(1)}.`), [
      [{ text: '▶ Resume', callback_data: encodeCallback({ type: 'start', date: cb.date, ref: cb.ref, mode: 'resume' }) }],
      [{ text: 'Start fresh', callback_data: encodeCallback({ type: 'start', date: cb.date, ref: cb.ref, mode: 'fresh' }) }],
    ], telegramFetch);
    return;
  }

  if (cb.type === 'test-correct' || cb.type === 'test-keep') return onTestReplace(env, cb, answer, msg?.message_id);
  if (cb.type === 'test-save' || cb.type === 'test-cancel') return onTestSave(env, cb, answer, msg?.message_id);

  const suffix = data.split('|').slice(2, 4).join('|');
  // Status buttons keep the Session's name, so a two-Session message still says which one was handled.
  const status = (text: string) => `${sessionTag(cb.ref)}: ${text}`;
  const state = await loadPlannerState(db);
  const stillPlanned = isPlanned(state, cb.date, cb.ref);
  if (!stillPlanned) {
    await answer('Already handled.');
    await edit(markRows(keyboard, suffix, status('✔ Already handled')));
    return;
  }
  if (cb.type === 'reps-ask') {
    await answer('How many reps on the + set?');
    await edit(swapRows(keyboard, suffix, repsKeyboard(cb.date, cb.ref)));
    return;
  }
  if (cb.type === 'ask') {
    // A Skip is not undoable and moves the lift queue on: every Done / Skip / Tomorrow is confirmed first.
    await answer('Tap ✓ to confirm');
    await edit(swapRows(keyboard, suffix, [confirmRow(cb.date, cb.act, cb.ref)]));
    return;
  }
  if (cb.type === 'cancel') {
    await answer();
    // Restore the row; name the Session on every button if the compact labels clash with another row's.
    const others = new Set(keyboard.filter((row) => !targets(row, suffix)).flat().map((b) => b.text));
    const rows = sessionRows(cb.date, cb.ref);
    await edit(swapRows(keyboard, suffix, rows.flat().some((b) => others.has(b.text)) ? sessionRows(cb.date, cb.ref, { named: true }) : rows));
    return;
  }
  if (cb.type === 'reps') {
    const { events } = await performAction(db, { type: 'done', date: cb.date, ref: cb.ref, amrapReps: cb.reps });
    const r = cb.ref as Extract<SessionRef, { kind: 'lift' }>;
    const label = `${r.lift[0]!.toUpperCase()}${r.lift.slice(1)} ${WEEK_NAME[r.week as 1 | 2 | 3]}`;
    const reps = cb.reps === MAX_AMRAP_BUTTON ? `${cb.reps}+` : String(cb.reps);
    await answer([`${label} done — ${reps} reps on the + set`, ...events].join(' · '));
    await edit(markRows(keyboard, suffix, status(ACT_DONE_TEXT.done)));
    return;
  }
  const { events, benchmarkId } = await performAction(db, { type: cb.act, date: cb.date, ref: cb.ref });
  if (benchmarkId !== undefined && msg) {
    // Done on a Benchmark Session: the same message asks for the result (see ./benchmark).
    await answer([ACT_DONE_TEXT.done, ...events].join(' · '));
    await edit(await benchmarkPrompt(db, benchmarkId, suffix, keyboard, msg.message_id));
    return;
  }
  await answer([ACT_DONE_TEXT[cb.act], ...events].join(' · '));
  await edit(markRows(keyboard, suffix, status(ACT_DONE_TEXT[cb.act])));
}

/** ✓ Replace / ✕ Keep on a /test for a lift that already had a result: the same message becomes the outcome. */
async function onTestReplace(
  env: Env, cb: Extract<NonNullable<ReturnType<typeof decodeCallback>>, { type: 'test-correct' | 'test-keep' }>,
  answer: (text?: string) => Promise<void>, messageId: number | undefined,
): Promise<void> {
  const editText = (text: string) => (messageId === undefined ? Promise.resolve() : editMessageText(env, messageId, text, undefined, telegramFetch));
  if (cb.type === 'test-keep') {
    const r = (await loadPlannerState(env.DB)).testWeek?.results[cb.lift];
    await answer('Kept');
    await editText(r ? `Kept ${r.weight} × ${r.reps}` : 'Kept');
    return;
  }
  try {
    const { events } = await performAction(env.DB, { type: 'test-result', date: cb.date, lift: cb.lift, weight: cb.weight, reps: cb.reps, correct: true });
    await answer('Corrected');
    await editText(`🏋️ ${esc(events[0] ?? `${LIFT_LABEL[cb.lift]} corrected`)}`);
  } catch (err) {
    if (!(err instanceof Conflict || err instanceof NotPlanned || err instanceof BadRequest)) throw err;
    const text = `${err.message[0]!.toUpperCase()}${err.message.slice(1)}.`;
    await answer(text);
    await editText(esc(text));
  }
}

/** ✓ Save / ✕ Cancel on a first /test result: Save logs it and the same message becomes the result reply. */
async function onTestSave(
  env: Env, cb: Extract<NonNullable<ReturnType<typeof decodeCallback>>, { type: 'test-save' | 'test-cancel' }>,
  answer: (text?: string) => Promise<void>, messageId: number | undefined,
): Promise<void> {
  const editText = (text: string) => (messageId === undefined ? Promise.resolve() : editMessageText(env, messageId, text, undefined, telegramFetch));
  if (cb.type === 'test-cancel') {
    await answer('Cancelled');
    await editText(esc(`Cancelled: ${LIFT_LABEL[cb.lift]} ${cb.weight} kg × ${cb.reps} not saved`));
    return;
  }
  try {
    const { state: after, events } = await performAction(env.DB, { type: 'test-result', date: cb.date, lift: cb.lift, weight: cb.weight, reps: cb.reps });
    await answer('Saved');
    await editText(testResultReply(after, cb.lift, events));
  } catch (err) {
    if (!(err instanceof NotPlanned || err instanceof Conflict || err instanceof BadRequest)) throw err;
    // e.g. a second tap, or the result logged elsewhere meanwhile
    const r = (await loadPlannerState(env.DB)).testWeek?.results[cb.lift];
    const text = r ? `${LIFT_LABEL[cb.lift]} already has ${r.weight} × ${r.reps}: send /test again to replace it.` : 'No Test Week is active.';
    await answer(text);
    await editText(esc(text));
  }
}

/** "🏋️ Squat 110 × 5 → Training Max 115 kg (1 of 4 tested)" + the Cycle 1 line or "Still to test: …" (HTML). */
function testResultReply(after: PlannerState, lift: Lift, events: string[]): string {
  const lines = [`🏋️ ${esc(events[0] ?? `${lift} test logged`)}`, ...events.slice(1).map(esc)];
  if (after.testWeek) lines.push(`Still to test: ${LIFT_ORDER.filter((l) => !after.testWeek!.results[l]).join(', ')}`);
  return lines.join('\n');
}

// ───────────────────────── commands ─────────────────────────

const HELP = [
  '<b>Commands</b>',
  '/today — today\'s Sessions with buttons',
  '/week — the next 7 days',
  '/log 6h 900m 7 — log a hike: hours, metres climbed, effort 1–10',
  '/test squat 102.5 5 — log a TM Test result (top set weight in kg, reps 1–15; asks to confirm with the Training Max it sets); or tap ▶ Start on the test. Sent again for a tested lift, it asks to replace (correct) that result',
  '▶ Start on a lift or TM Test runs a Live Session: log each set with the buttons, or type 67.5x4, x4, 67.5, skip, rpe 8',
  '/amrap squat 8 — add AMRAP reps to a lift you marked done today without reps (weeks 1–2 only; for week 3 use the rep buttons shown after ✅ Done)',
  '/bench 10:42 — add a Benchmark Result: a 2.4 km / hill loop time, or /bench 6b 18 for auto-belay grade and minutes',
  '/help — this list',
].join('\n');

async function cmdLog(env: Env, args: string[]): Promise<string> {
  const usage = 'Usage: /log 6h 900m 7  (hours, metres climbed, effort 1–10)';
  if (args.length !== 3) return usage;
  const h = /^(\d+(?:[.,]\d+)?)h$/i.exec(args[0]!);
  const m = /^(\d+)m$/i.exec(args[1]!);
  const e = /^(\d+)$/.exec(args[2]!);
  if (!h || !m || !e) return usage;
  const hours = Number(h[1]!.replace(',', '.'));
  const vertM = Number(m[1]);
  const effort = Number(e[1]);
  if (!(hours > 0 && hours <= 48) || vertM > 20000 || effort < 1 || effort > 10) return usage;

  const date = todayFor(await loadPlannerState(env.DB));
  const load = effort * 10;
  const { before, state } = await performAction(env.DB, { type: 'activity', date, activity: { sport: 'hike', hours, vertM, load } });
  await insertActivity(env.DB, newLogActivityId(date), date, 'telegram', { name: 'Hike (/log)', sport: 'hike', hours, vertM, load });

  const counted = countedAs(before, state, date);
  return [
    `🥾 Logged hike: ${hours} h · ${vertM} m ↑ · effort ${effort} (load ${load})`,
    counted.length ? `Counted as: ${counted.join(' + ')}` : 'Counted as: nothing (below the thresholds, or already covered this week)',
  ].join('\n');
}

async function cmdAmrap(env: Env, args: string[]): Promise<string> {
  const usage = `Usage: /amrap &lt;lift&gt; &lt;reps&gt;, lift one of ${LIFT_ORDER.join(', ')}`;
  if (args.length !== 2) return usage;
  const lift = args[0]!.toLowerCase() as Lift;
  if (!LIFT_ORDER.includes(lift) || !/^\d+$/.test(args[1]!)) return usage;
  const reps = Number(args[1]);
  if (reps > 30) return usage;

  const db = env.DB;
  const state = await loadPlannerState(db);
  const date = todayFor(state);
  const done = (state.doneByDate[date] ?? []).filter((r): r is Extract<SessionRef, { kind: 'lift' }> => r.kind === 'lift' && r.lift === lift).at(-1);
  if (!done) return `No ${lift} marked done today. Tap ✅ Done first, then send /amrap again.`;

  const { week } = done;
  await logLift(db, date, lift, { date, lift, week, amrapReps: reps });
  await appendActionLog(db, { type: 'amrap', date, lift, week, amrapReps: reps });
  if (week === 1 || week === 2) {
    // amrapLog is written together with the state row (performAction), so this write takes part in the same
    // optimistic concurrency: it re-stamps the unchanged state and only lands if nothing changed in between.
    const had = await recordAmrapIfMissing(db, lift, week, reps);
    if (had === undefined) return `Logged ${lift} AMRAP: ${reps} reps (week ${week}).`;
    return `Logged ${lift} AMRAP: ${reps} reps. Week ${week} already had ${had} recorded for this Cycle, so that one stays.`;
  }
  if (week === 3) {
    return `Logged ${lift} AMRAP: ${reps} reps. Week 3 already closed the Cycle (TM ${state.tms[lift]} kg); adjust the Training Max in the app if it should have gone up.`;
  }
  return `Logged ${lift}: ${reps} reps (no AMRAP target this week).`;
}

async function cmdTest(env: Env, args: string[]): Promise<string | { text: string; keyboard: InlineKeyboard }> {
  const usage = `Usage: /test &lt;lift&gt; &lt;kg&gt; &lt;reps&gt;, e.g. /test squat 102.5 5 (lift one of ${LIFT_ORDER.join(', ')}; reps 1–15)`;
  if (args.length !== 3) return usage;
  const lift = args[0]!.toLowerCase() as Lift;
  if (!LIFT_ORDER.includes(lift) || !/^\d+(?:[.,]\d+)?$/.test(args[1]!) || !/^\d{1,2}$/.test(args[2]!)) return usage;
  const weight = Number(args[1]!.replace(',', '.'));
  const reps = Number(args[2]);
  if (!(weight > 0 && weight <= 500) || reps < 1 || reps > 15) return usage;

  const db = env.DB;
  const state = await loadPlannerState(db);
  if (!state.testWeek) return 'No Test Week is active. Start one in the app (More › Test Week), or enter results there directly.';
  const date = todayFor(state);
  const had = state.testWeek.results[lift];
  if (had) {
    // A correction is explicit: ask before replacing the result and its Training Max.
    const { tm, low } = testResultPreview(state, lift, weight, reps);
    const v = { date, lift, weight, reps };
    return {
      text: [
        esc(`${LIFT_LABEL[lift]} already has ${had.weight} × ${had.reps} (TM ${state.tms[lift]} kg). Replace with ${weight} × ${reps} → TM ${tm} kg?`),
        ...(low ? [`⚠️ ${esc(LOW_TM_WARNING)}`] : []),
      ].join('\n'),
      keyboard: [[
        { text: '✓ Replace', callback_data: encodeCallback({ type: 'test-correct', ...v }) },
        { text: '✕ Keep', callback_data: encodeCallback({ type: 'test-keep', ...v }) },
      ]],
    };
  }
  // A first result is confirmed too, with the Training Max it will set (and the low-result warning).
  const { tm, low } = testResultPreview(state, lift, weight, reps);
  const v = { date, lift, weight, reps };
  return {
    text: [esc(`${LIFT_LABEL[lift]} ${weight} kg × ${reps} → Training Max ${tm} kg. Save?`), ...(low ? [`⚠️ ${esc(LOW_TM_WARNING)}`] : [])].join('\n'),
    keyboard: [[
      { text: '✓ Save', callback_data: encodeCallback({ type: 'test-save', ...v }) },
      { text: '✕ Cancel', callback_data: encodeCallback({ type: 'test-cancel', ...v }) },
    ]],
  };
}

async function onCommand(env: Env, text: string): Promise<void> {
  const [head, ...args] = text.trim().split(/\s+/);
  const cmd = (head ?? '').split('@')[0]!.toLowerCase();
  const reply = async (t: string, kb?: InlineKeyboard) => {
    await sendMessage(env, t, kb, telegramFetch);
  };
  const db = env.DB;

  switch (cmd) {
    case '/today': {
      const state = await loadPlannerState(db);
      const date = todayFor(state);
      const { days, details } = await planWithDetails(db, state, date, 1);
      const m = morningMessage(days[0]!, details[date] ?? []);
      return reply(m.text, m.keyboard.length ? m.keyboard : undefined);
    }
    case '/week': {
      const state = await loadPlannerState(db);
      const { days, details } = await planWithDetails(db, state, todayFor(state), 7);
      return reply(previewMessage(days, details).text);
    }
    case '/log': return reply(await cmdLog(env, args));
    case '/amrap': return reply(await cmdAmrap(env, args));
    case '/test': {
      const r = await cmdTest(env, args);
      return typeof r === 'string' ? reply(r) : reply(r.text, r.keyboard);
    }
    case '/bench': return reply(await cmdBench(db, args));
    default: return reply(HELP);
  }
}

/**
 * Plain text, in order: a time (10:42) while a Benchmark prompt is pending is that Benchmark's result; otherwise,
 * while a Live Session runs, its reply keyboard and typed sets (the Durable Object is the conversation state).
 */
async function onText(env: Env, text: string): Promise<void> {
  if (await onBenchmarkReply(env, text, telegramFetch)) return;
  if (text.length > 100) return;
  const r = await liveStub(env).typed(text);
  if (r.reply) await sendMessageWithMarkup(env, r.reply, r.removeKeyboard ? REMOVE_KEYBOARD : undefined, telegramFetch);
}

// ───────────────────────── route ─────────────────────────

export const webhook = new Hono<{ Bindings: Env }>();

webhook.post('/telegram/webhook', async (c) => {
  const env = c.env;
  if (!(await secretMatches(c.req.header('X-Telegram-Bot-Api-Secret-Token'), env.TELEGRAM_WEBHOOK_SECRET))) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  // From here on always 200: a non-2xx makes Telegram redeliver the update over and over.
  try {
    const update = (await c.req.json()) as TgUpdate;
    const chatId = update.callback_query?.message?.chat.id ?? update.message?.chat.id;
    if (chatId === undefined || !env.TELEGRAM_CHAT_ID || String(chatId) !== env.TELEGRAM_CHAT_ID) return c.json({ ok: true });

    if (update.callback_query) await onCallback(env, update.callback_query);
    else if (update.message?.text?.startsWith('/')) await onCommand(env, update.message.text);
    else if (update.message?.text) await onText(env, update.message.text);
  } catch (err) {
    console.error('telegram webhook error:', safeError(env, err));
  }
  return c.json({ ok: true });
});
