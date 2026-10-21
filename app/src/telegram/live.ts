// Live Session in Telegram: the one message edited in place, its buttons, the reply keyboard, the
// "Rest over" ping, the finish summary, and the typed-input parser. Pure.
import {
  TEST_INPUT_EXAMPLE, currentSetIndex, loggedSetCount, pendingValues, setAt, verdict, type LiveSet, type LiveState, type Verdict,
} from '../domain/live';
import { LOW_TM_WARNING } from '../domain/actions';
import type { InlineKeyboard, ReplyKeyboard } from './client';
import { esc } from './format';

// ───────────────────────── callback_data: l|<op>|<session id prefix>|<step> (≤ 22 bytes) ─────────────────────────

/**
 * cx = Cancel (nothing logged yet, no confirmation), rs = Resume a paused Live Session. TM Test: top asks to confirm
 * the top set, tpy saves it, tpn goes back.
 */
export type LiveOp = 'ok' | 'sk' | 'r-' | 'r+' | 'l-' | 'l+' | 'wu' | 'top' | 'tpy' | 'tpn' | 'fin' | 'ab' | 'aby' | 'rf' | 'cx' | 'rs';
const OPS: LiveOp[] = ['ok', 'sk', 'r-', 'r+', 'l-', 'l+', 'wu', 'top', 'tpy', 'tpn', 'fin', 'ab', 'aby', 'rf', 'cx', 'rs'];
export type LiveCallback = { op: LiveOp; sid: string; step: number };

export const shortId = (id: string) => id.slice(0, 8);
export const encodeLive = (op: LiveOp, s: Pick<LiveState, 'id'>, step: number) => `l|${op}|${shortId(s.id)}|${step}`;

export function decodeLive(data: string): LiveCallback | null {
  const p = data.split('|');
  if (p.length !== 4 || p[0] !== 'l' || !OPS.includes(p[1] as LiveOp) || !/^[0-9a-f]{8}$/.test(p[2]!) || !/^\d{1,3}$/.test(p[3]!)) return null;
  return { op: p[1] as LiveOp, sid: p[2]!, step: Number(p[3]) };
}

// ───────────────────────── reply keyboard (only while a Live Session runs) ─────────────────────────

export const KEY_SET_DONE = '✓ Set done';
export const KEY_REST = '+30 s rest';
export const KEY_PAUSE = 'Pause';
export const KEY_FINISH = 'Finish';
export const LIVE_REPLY_KEYBOARD: ReplyKeyboard = {
  keyboard: [[{ text: KEY_SET_DONE }, { text: KEY_REST }], [{ text: KEY_PAUSE }, { text: KEY_FINISH }]],
  resize_keyboard: true,
  is_persistent: true,
};
export const REMOVE_KEYBOARD: ReplyKeyboard = { remove_keyboard: true };

export const INPUT_HINT = 'Type 67.5x4 (load × reps), x4, 67.5, skip or rpe 8, or use the buttons.';
/** A TM Test set with no weight known yet (no Prescription, nothing logged): it is typed. */
export const TEST_WEIGHT_HINT = `Type the weight, e.g. ${TEST_INPUT_EXAMPLE}`;

// ───────────────────────── typed input ─────────────────────────

export type LiveInput =
  | { kind: 'set'; load?: number; reps?: number; rpe?: number; top?: boolean }
  | { kind: 'skip' }
  | { kind: 'rpe'; rpe: number }
  | { kind: 'key'; key: 'done' | 'rest' | 'pause' | 'finish' | 'resume' };

const KEYS: Record<string, Extract<LiveInput, { kind: 'key' }>['key']> = {
  [KEY_SET_DONE.toLowerCase()]: 'done', [KEY_REST.toLowerCase()]: 'rest', [KEY_PAUSE.toLowerCase()]: 'pause', [KEY_FINISH.toLowerCase()]: 'finish',
  resume: 'resume', '▶ resume': 'resume',
};

export const PAUSED_HINT = 'Paused — tap ▶ Resume (or send Resume) to log sets again.';

const validRpe = (n: number) => Number.isInteger(n) && n >= 1 && n <= 10;

/**
 * `67.5x4` (load × reps), `x4` (reps at the Prescription's load), `67.5` (load at the Prescription's reps),
 * `skip`, an optional ` rpe 8` suffix, or `rpe 8` alone (the last Logged Set). `top 102.5x5` logs a TM Test's
 * top set. The reply-keyboard texts come back as keys. Anything else is null.
 */
export function parseLiveInput(raw: string): LiveInput | null {
  const text = raw.trim().replace(/\s+/g, ' ').toLowerCase();
  if (KEYS[text]) return { kind: 'key', key: KEYS[text]! };
  if (text === 'skip') return { kind: 'skip' };
  const lone = /^rpe ?(\d{1,2})$/.exec(text);
  if (lone) return validRpe(Number(lone[1])) ? { kind: 'rpe', rpe: Number(lone[1]) } : null;

  let body = text;
  let rpe: number | undefined;
  const suffix = / rpe ?(\d{1,2})$/.exec(body);
  if (suffix) {
    rpe = Number(suffix[1]);
    if (!validRpe(rpe)) return null;
    body = body.slice(0, suffix.index);
  }
  let top = false;
  if (body.startsWith('top ')) {
    top = true;
    body = body.slice(4);
  }
  const m = /^(\d{1,4}(?:[.,]\d{1,2})?)? ?(?:kg|lb)? ?(?:[x×*] ?(\d{1,3}))?$/.exec(body);
  if (!m || (m[1] === undefined && m[2] === undefined)) return null;
  const out: Extract<LiveInput, { kind: 'set' }> = { kind: 'set' };
  if (m[1] !== undefined) {
    out.load = Number(m[1].replace(',', '.'));
    if (out.load > 1000) return null;
  }
  if (m[2] !== undefined) {
    out.reps = Number(m[2]);
    if (out.reps > 100) return null;
  }
  if (rpe !== undefined) out.rpe = rpe;
  if (top) out.top = true;
  return out;
}

// ───────────────────────── text ─────────────────────────

const num = (n: number) => String(Math.round(n * 100) / 100);

function clock(t: number, tz: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(new Date(t));
}

/** "65 kg × 5", "70 kg × 5+", "× 12–15", "2 x 30 s/side". */
export function rxText(x: Pick<LiveSet, 'unit' | 'amrap' | 'rxRepsMax' | 'dose'>, v: { load?: number; reps?: number }): string {
  if (x.dose !== undefined) return x.dose;
  const reps = v.reps === undefined ? '' : `${v.reps}${x.rxRepsMax !== undefined && v.reps < x.rxRepsMax ? `–${x.rxRepsMax}` : ''}${x.amrap ? '+' : ''}`;
  const load = v.load === undefined ? '' : `${num(v.load)} ${x.unit}`;
  if (!load) return reps ? `× ${reps}` : '—';
  return reps ? `${load} × ${reps}` : load;
}

const loggedText = (x: LiveSet) => [x.load === undefined ? '' : `${num(x.load)} ${x.unit}`, x.reps === undefined ? '' : String(x.reps)].filter(Boolean).join(' × ') || 'done';

const MARK: Record<Verdict, string> = { met: '✓', over: '↑', under: '↓', amrap: '✓', skipped: '–', done: '✓' };

function loggedLine(x: LiveSet): string {
  const v = verdict(x)!;
  const name = `${x.exercise} ${x.n}${x.top ? ' (top set)' : ''}`;
  if (v === 'skipped') return `– ${esc(name)}: skipped`;
  let line = `${MARK[v]} ${esc(name)}: ${esc(loggedText(x))}`;
  if (v === 'amrap') line += ` — AMRAP ${x.reps ?? 0} reps`;
  if (v === 'under' || v === 'over') line += ` (rx ${esc(rxText(x, { load: x.rxLoad, reps: x.rxReps }))})`;
  if (x.rpe !== undefined) line += ` · RPE ${x.rpe}`;
  return line;
}

/** "Squat · Set 2 of 3 — 65 kg × 5" for the current set. */
export function currentSetLabel(s: LiveState): string | null {
  const i = currentSetIndex(s);
  const x = setAt(s, i);
  const v = pendingValues(s);
  if (!x || !v) return null;
  if (x.group === 'test') return `${x.exercise} · Work-up set ${x.n} — ${v.load === undefined ? TEST_WEIGHT_HINT : rxText(x, v)}`;
  const rx = rxText(x, { load: x.rxLoad ?? v.load, reps: x.rxReps });
  const changed = s.draft && rxText(x, v) !== rx ? ` → ${rxText(x, v)}` : '';
  return `${x.exercise} · Set ${x.n} of ${x.of ?? x.n} — ${rx}${changed}`;
}

export function liveMessage(s: LiveState, now: number): { text: string; keyboard: InlineKeyboard } {
  const lines = [`🏋️ <b>${esc(s.title)}</b> · ${s.paused ? '⏸ Paused' : 'Live'}`];
  if (!s.warmupDone) {
    lines.push('', '<b>Warm-up</b>', ...s.warmup.map((w) => `• ${esc(w)}`));
  } else {
    lines.push('✓ Warm-up');
    for (const x of s.sets) if (x.loggedAt !== undefined) lines.push(loggedLine(x));
    const cur = currentSetLabel(s);
    lines.push('', cur ? `▶ <b>${esc(cur)}</b>` : 'All sets logged — tap 🏁 Finish.');
  }
  if (s.pendingTop && !s.paused) lines.push('', ...topConfirmLines(s.pendingTop).map((l, i) => (i ? `⚠️ ${esc(l)}` : `🏁 <b>${esc(l)}</b>`)));
  if (s.paused) lines.push('', '⏸ Paused — tap ▶ Resume to carry on.');
  else if (s.restEndsAt !== null) lines.push(s.restEndsAt > now ? `⏱ Rest until ${clock(s.restEndsAt, s.tz)}` : '⏱ Rest over');
  return { text: lines.join('\n'), keyboard: liveKeyboard(s) };
}

export function liveKeyboard(s: LiveState): InlineKeyboard {
  const step = s.warmupDone ? 1 + currentSetIndex(s) : 0;
  const b = (text: string, op: LiveOp) => ({ text, callback_data: encodeLive(op, s, step) });
  // Nothing logged yet: an accidental start is undone with Cancel (no trace, no confirmation).
  const abandon = [loggedSetCount(s) === 0 ? b('✕ Cancel', 'cx') : b('✖ Abandon', 'ab')];
  if (s.paused) return [[b('▶ Resume', 'rs')], abandon];
  if (!s.warmupDone) return [[b('✓ Warm-up done', 'wu')], abandon];
  const x = setAt(s, currentSetIndex(s));
  const v = pendingValues(s);
  if (!x || !v) return [[b('🏁 Finish', 'fin')], abandon];
  if (s.pendingTop) return [[b('✓ Save top set', 'tpy'), b('↩︎ Back', 'tpn')]];
  const adjust = [b('Reps −', 'r-'), b('Reps +', 'r+'), b('Load −', 'l-'), b('Load +', 'l+')];
  if (x.group === 'test') {
    // No weight known yet (first work-up set): it is typed, never a button with a made-up load.
    if (v.load === undefined) return [abandon];
    return [[b(`✓ Work-up ${rxText(x, v)}`, 'ok'), b(`🏁 Top set`, 'top')], adjust, abandon];
  }
  const rx = rxText(x, { load: x.rxLoad ?? v.load, reps: x.rxReps });
  const ok = b(s.draft && rxText(x, v) !== rx ? `✓ ${rxText(x, v)}` : '✓ As prescribed', 'ok');
  return [[ok], ...(x.dose === undefined ? [adjust] : []), [b('⏭ Skip set', 'sk'), b('🏁 Finish', 'fin')], abandon];
}

/** "Top set 20 kg × 5 → Training Max 20 kg. Save?", plus the low-result warning when it applies (plain text). */
export function topConfirmLines(p: NonNullable<LiveState['pendingTop']>): string[] {
  return [`Top set ${num(p.load)} kg × ${p.reps} → Training Max ${num(p.tm)} kg. Save?`, ...(p.low ? [LOW_TM_WARNING] : [])];
}

/** The Abandon confirmation in place of the Live Session buttons. */
export function abandonConfirmKeyboard(s: LiveState, step: number): InlineKeyboard {
  return [[{ text: '✖ Yes, abandon', callback_data: encodeLive('aby', s, step) }, { text: '↩︎ Keep going', callback_data: encodeLive('rf', s, step) }]];
}

/** "⏰ Rest over — Set 3: 70 kg × 5+" (a new message, so it buzzes). */
export function restPingText(s: LiveState): string {
  const x = setAt(s, currentSetIndex(s));
  const v = pendingValues(s);
  if (!x || !v) return '⏰ Rest over — all sets logged, tap Finish';
  if (x.group === 'test') return `⏰ Rest over — work-up set ${x.n}`;
  const label = x.group === 'main' ? `Set ${x.n}` : `${esc(x.exercise)} set ${x.n}`;
  return `⏰ Rest over — ${label}: ${esc(rxText(x, v))}`;
}

export type LiveOutcome = 'finished' | 'auto-finished' | 'abandoned' | 'discarded' | 'not-counted' | 'cancelled';
const OUTCOME_HEAD: Record<LiveOutcome, string> = {
  finished: '✅', 'auto-finished': '✅', abandoned: '✖', discarded: '✖', 'not-counted': '✔', cancelled: '✕',
};
const OUTCOME_TAIL: Record<LiveOutcome, string> = {
  finished: 'done',
  'auto-finished': 'auto-finished at midnight',
  abandoned: 'abandoned',
  discarded: 'closed at midnight without a result',
  'not-counted': 'sets saved (the Session was already checked in)',
  cancelled: 'cancelled',
};

/** "✅ Squat — Week 1 (5s) — auto-finished at midnight" (HTML). */
export const outcomeLine = (s: Pick<LiveState, 'title'>, outcome: LiveOutcome): string =>
  `<b>${OUTCOME_HEAD[outcome]} ${esc(s.title)}</b> — ${OUTCOME_TAIL[outcome]}`;

/** The Live Session message once it is over: Logged Sets against their Prescriptions. */
export function summaryMessage(s: LiveState, outcome: LiveOutcome, events: string[] = []): string {
  const lines = [outcomeLine(s, outcome)];
  const logged = s.sets.filter((x) => x.loggedAt !== undefined);
  if (logged.length) lines.push(...logged.map(loggedLine));
  if (events.length) lines.push('', ...events.map(esc));
  return lines.join('\n');
}
