// Benchmark Result prompt in Telegram. Done on a Benchmark Session records it done at once, then the same message
// asks for the result in place of the Session's row: a time (reply "10:42", or tap the watch's time) or, on the
// auto-belay, a grade and then minutes. [Later] leaves it without a result (/bench adds one later); the bot never asks again.
import type { Env } from '../index';
import type { ISODate } from '../domain/types';
import {
  GRADE_BUTTONS, MAX_MINUTES, MAX_TIME_S, MIN_TIME_S, formatTime, isTimeKind, parseGrade, parseTime, resultText,
  type BenchmarkEntry, type BenchmarkInput,
} from '../domain/benchmark';
import { getKV, setKV } from '../store/db';
import { benchmarkActivityTime, getBenchmark, latestPendingBenchmark, setBenchmarkResult } from '../store/progress';
import { appendActionLog } from '../store/db';
import { editMessageReplyMarkup, type InlineKeyboard } from './client';

const NOOP = 'noop';
const PROMPT_KEY = 'benchPrompt';
export const PROMPT_TTL_MS = 2 * 3600_000;
const MINUTE_BUTTONS = [5, 10, 15, 20, 25, 30] as const; // the last one reads "30+"

/** The pending time prompt: the next plain-text reply matching mm:ss is the result of entry `id`. */
type Prompt = { id: number; suffix: string; messageId: number; keyboard: InlineKeyboard; expiresAt: string };

type Button = InlineKeyboard[number][number];
const btn = (text: string, callback_data: string): Button => ({ text, callback_data });

/** Replace the rows whose buttons target `suffix` (`<date>|<ref>`) with `replacement` (as the webhook's swapRows). */
function swap(keyboard: InlineKeyboard, suffix: string, replacement: InlineKeyboard): InlineKeyboard {
  const targets = (row: InlineKeyboard[number]) =>
    row.some((b) => b.callback_data.startsWith('a|') && b.callback_data.split('|').slice(2, 4).join('|') === suffix);
  let done = false;
  return keyboard.flatMap((row) => {
    if (!targets(row)) return [row];
    if (done) return [];
    done = true;
    return replacement;
  });
}

const statusRows = (text: string): InlineKeyboard => [[btn(text, NOOP)]];

function timeRows(suffix: string, watchS: number | null): InlineKeyboard {
  const last: Button[] = [];
  if (watchS !== null) last.push(btn(`⌚ ${formatTime(watchS)} (watch)`, `a|bt|${suffix}|${watchS}`));
  last.push(btn('Later', `a|bl|${suffix}`));
  return [[btn('⏱ Time? Reply e.g. 10:42', `a|bn|${suffix}`)], last];
}

function gradeRows(suffix: string): InlineKeyboard {
  const grades = GRADE_BUTTONS.map((g) => btn(g, `a|bg|${suffix}|${g}`));
  return [[btn('🧗 Grade?', `a|bn|${suffix}`)], grades.slice(0, 6), grades.slice(6), [btn('Later', `a|bl|${suffix}`)]];
}

function minuteRows(suffix: string, grade: string): InlineKeyboard {
  const mins = MINUTE_BUTTONS.map((m, i) => btn(i === MINUTE_BUTTONS.length - 1 ? `${m}+` : String(m), `a|bm|${suffix}|${grade}|${m}`));
  return [[btn(`🧗 ${grade} — minutes?`, `a|bn|${suffix}`)], mins, [btn('Later', `a|bl|${suffix}`)]];
}

const doneStatus = (r: BenchmarkInput) => `✅ Done · ${'timeS' in r ? formatTime(r.timeS) : `${r.grade} · ${r.minutes} min`}`;

async function readPrompt(db: D1Database): Promise<Prompt | null> {
  const raw = await getKV(db, PROMPT_KEY);
  return raw ? (JSON.parse(raw) as Prompt) : null;
}
const clearPrompt = (db: D1Database) => db.prepare('DELETE FROM kv WHERE key = ?').bind(PROMPT_KEY).run();

/** Clears the pending prompt when it is for entry `id`. */
async function clearPromptFor(db: D1Database, id: number) {
  if ((await readPrompt(db))?.id === id) await clearPrompt(db);
}

async function saveResult(db: D1Database, e: BenchmarkEntry, r: BenchmarkInput, via: string) {
  await setBenchmarkResult(db, e.id, r);
  await appendActionLog(db, { type: 'benchmark-result', id: e.id, date: e.date, kind: e.kind, result: r, via });
  await clearPromptFor(db, e.id);
}

/**
 * The keyboard after Done on a Benchmark Session (entry `id`): the Session's rows become the result prompt. A time
 * prompt is remembered for {@link PROMPT_TTL_MS} so a plain-text reply can answer it.
 */
export async function benchmarkPrompt(db: D1Database, id: number, suffix: string, keyboard: InlineKeyboard, messageId: number, now = new Date()): Promise<InlineKeyboard> {
  const e = (await getBenchmark(db, id))!;
  if (!isTimeKind(e.kind)) return swap(keyboard, suffix, gradeRows(suffix));
  const kb = swap(keyboard, suffix, timeRows(suffix, await benchmarkActivityTime(db, e.date, e.kind)));
  const prompt: Prompt = { id, suffix, messageId, keyboard: kb, expiresAt: new Date(now.getTime() + PROMPT_TTL_MS).toISOString() };
  await setKV(db, PROMPT_KEY, JSON.stringify(prompt));
  return kb;
}

/** Callback data of the prompt's buttons: `a|b<n|t|l|g|m>|<date>|<ref>[|…]`. */
export const isBenchmarkCallback = (data: string): boolean => /^a\|b[ntlgm]\|/.test(data);

/** Handles a tap on the prompt. `answer` toasts, `edit` replaces the message's keyboard. */
export async function onBenchmarkCallback(
  db: D1Database, data: string, keyboard: InlineKeyboard,
  answer: (text?: string) => Promise<void>, edit: (kb: InlineKeyboard) => Promise<void>,
): Promise<void> {
  const p = data.split('|');
  const code = p[1]!;
  const date = p[2] as ISODate;
  const suffix = p.slice(2, 4).join('|');
  const kinds = p[3]?.startsWith('R.') ? (['2k4', 'hill'] as const) : (['autobelay'] as const);
  const e = await latestPendingBenchmark(db, [...kinds], date);
  if (!e) {
    await answer('Already saved.');
    return edit(swap(keyboard, suffix, statusRows('✅ Done')));
  }
  switch (code) {
    case 'bn':
      return answer(isTimeKind(e.kind) ? 'Reply with the time, e.g. 10:42' : 'Pick the grade, then the minutes');
    case 'bl':
      await clearPromptFor(db, e.id);
      await answer('Done, no result. Add one later with /bench');
      return edit(swap(keyboard, suffix, statusRows('✅ Done')));
    case 'bt': {
      const t = Number(p[4]);
      if (p.length !== 5 || !isTimeKind(e.kind) || !Number.isInteger(t) || t < MIN_TIME_S || t > MAX_TIME_S) return answer('This button is no longer valid.');
      await saveResult(db, e, { timeS: t }, 'telegram-watch');
      await answer(`✅ ${resultText(e.kind, { timeS: t })}`);
      return edit(swap(keyboard, suffix, statusRows(doneStatus({ timeS: t }))));
    }
    case 'bg': {
      const grade = parseGrade(p[4] ?? '');
      if (p.length !== 5 || e.kind !== 'autobelay' || !grade) return answer('This button is no longer valid.');
      await answer();
      return edit(swap(keyboard, suffix, minuteRows(suffix, grade)));
    }
    case 'bm': {
      const grade = parseGrade(p[4] ?? '');
      const minutes = Number(p[5]);
      if (p.length !== 6 || e.kind !== 'autobelay' || !grade || !Number.isInteger(minutes) || minutes < 1 || minutes > MAX_MINUTES) {
        return answer('This button is no longer valid.');
      }
      await saveResult(db, e, { grade, minutes }, 'telegram');
      await answer(`✅ ${resultText(e.kind, { grade, minutes })}`);
      return edit(swap(keyboard, suffix, statusRows(doneStatus({ grade, minutes }))));
    }
  }
}

/**
 * A plain-text message: when a time prompt is pending (and not expired) and the text is a time like 10:42, it is that
 * Benchmark's result and the prompt message shows it. Returns false when the text was not taken as a result.
 */
export async function onBenchmarkReply(env: Env, text: string, fetchImpl: typeof fetch, now = new Date()): Promise<boolean> {
  const db = env.DB;
  const prompt = await readPrompt(db);
  if (!prompt) return false;
  if (Date.parse(prompt.expiresAt) <= now.getTime()) {
    await clearPrompt(db);
    return false;
  }
  const t = parseTime(text);
  if (t === null) return false;
  const e = await getBenchmark(db, prompt.id);
  if (!e || e.timeS !== undefined || e.grade !== undefined || !isTimeKind(e.kind)) {
    await clearPrompt(db);
    return false;
  }
  await saveResult(db, e, { timeS: t }, 'telegram-reply');
  await editMessageReplyMarkup(env, prompt.messageId, swap(prompt.keyboard, prompt.suffix, statusRows(doneStatus({ timeS: t }))), fetchImpl);
  return true;
}

/**
 * `/bench 10:42` or `/bench 6b 18`: the result of the most recent Benchmark Session done without one, or whose time
 * was taken from the watch (the manual result corrects it).
 */
export async function cmdBench(db: D1Database, args: string[]): Promise<string> {
  const usage = 'Usage: /bench 10:42 (2.4 km or hill loop time) or /bench 6b 18 (auto-belay grade and minutes)';
  let r: BenchmarkInput;
  if (args.length === 1) {
    const t = parseTime(args[0]!);
    if (t === null) return usage;
    r = { timeS: t };
  } else if (args.length === 2) {
    const grade = parseGrade(args[0]!);
    const minutes = /^\d{1,3}$/.test(args[1]!) ? Number(args[1]) : 0;
    if (!grade || minutes < 1 || minutes > MAX_MINUTES) return usage;
    r = { grade, minutes };
  } else return usage;
  const e = await latestPendingBenchmark(db, 'timeS' in r ? ['2k4', 'hill'] : ['autobelay'], undefined, { orAuto: true });
  if (!e) return `No ${'timeS' in r ? 'run' : 'auto-belay'} Benchmark Session is waiting for a result.`;
  await saveResult(db, e, r, 'telegram-command');
  return `✅ ${resultText(e.kind, r)} saved for ${e.date}.`;
}
