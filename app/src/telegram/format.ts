// Pure Telegram message formatting (HTML parse mode) and callback_data codec.
import type { DayPlan, ISODate, Lift, RunKind, SessionRef } from '../domain/types';
import { LIFT_ORDER } from '../domain/types';
import { DAILY_ROUTINE, type Exercise } from '../content/mobility';
import type { SessionDetail } from '../domain/details';
import type { RouteSummary } from '../domain/routes';
import { isRealIsoDate, weekday } from '../domain/dates';
import type { InlineKeyboard } from './client';

// ---------- escaping ----------
export const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
/** For a double-quoted HTML attribute value. */
const escAttr = (s: string): string => esc(s).replace(/"/g, '&quot;');

// ---------- refs and callback_data ----------
// Telegram caps callback_data at 64 bytes. The longest fixed prefix is `a|t|YYYY-MM-DD|C.` (17 bytes; the
// confirm codes `a|D|`/`a|S|`/`a|T|` and Cancel `a|x|` are the same length), so
// an event id up to 36 chars always fits (53 bytes). Event ids are client-generated: the Club Event
// endpoint must validate them against EVENT_ID_RE, and encodeRef throws on an id that doesn't match.
export const EVENT_ID_RE = /^[A-Za-z0-9_-]{1,36}$/;

const RUN_KINDS: RunKind[] = ['easy', 'quality-vert', 'quality-speed', 'long', 'ruck', 'benchmark-2k4', 'benchmark-hill'];

export function encodeRef(ref: SessionRef): string {
  switch (ref.kind) {
    case 'lift': return `L.${ref.lift}.${ref.week === 'reentry' ? 'r' : ref.week}`;
    case 'lift-test': return `X.${ref.lift}`;
    case 'travel-strength': return 'T';
    case 'run': return `R.${ref.run}`;
    case 'climb':
      if (ref.eventId !== undefined) {
        if (!EVENT_ID_RE.test(ref.eventId) || ref.eventId === 'fb') throw new Error(`Unsupported Club Event id for callback_data: ${ref.eventId}`);
        return `C.${ref.eventId}`;
      }
      return ref.fallback ? 'C.fb' : 'C';
  }
}

export function decodeRef(code: string): SessionRef | null {
  const parts = code.split('.');
  switch (parts[0]) {
    case 'L': {
      const [, lift, w] = parts;
      if (parts.length !== 3 || !LIFT_ORDER.includes(lift as Lift)) return null;
      if (w === 'r') return { kind: 'lift', lift: lift as Lift, week: 'reentry' };
      if (w === '1' || w === '2' || w === '3' || w === '4') return { kind: 'lift', lift: lift as Lift, week: Number(w) as 1 | 2 | 3 | 4 };
      return null;
    }
    case 'X': return parts.length === 2 && LIFT_ORDER.includes(parts[1] as Lift) ? { kind: 'lift-test', lift: parts[1] as Lift } : null;
    case 'T': return parts.length === 1 ? { kind: 'travel-strength' } : null;
    case 'R': return parts.length === 2 && RUN_KINDS.includes(parts[1] as RunKind) ? { kind: 'run', run: parts[1] as RunKind } : null;
    case 'C':
      if (parts.length === 1) return { kind: 'climb' };
      if (parts.length !== 2) return null;
      if (parts[1] === 'fb') return { kind: 'climb', fallback: true };
      return EVENT_ID_RE.test(parts[1]!) ? { kind: 'climb', eventId: parts[1]! } : null;
    default: return null;
  }
}

export type CallbackAct = 'done' | 'skip' | 'tomorrow';
export type Callback =
  /** Done / Skip / Tomorrow on a Session row (`a|d|`, `a|s|`, `a|t|`): asks to confirm, changes nothing. */
  | { type: 'ask'; act: CallbackAct; date: ISODate; ref: SessionRef }
  /** ✓ on the confirmation row (`a|D|`, `a|S|`, `a|T|`): performs the action. */
  | { type: 'action'; act: CallbackAct; date: ISODate; ref: SessionRef }
  | { type: 'reps-ask'; date: ISODate; ref: SessionRef }
  /** ↩︎ Cancel on the rep picker or a confirmation row: restores the Session's buttons. */
  | { type: 'cancel'; date: ISODate; ref: SessionRef }
  | { type: 'reps'; date: ISODate; ref: SessionRef; reps: number }
  | { type: 'test-hint'; date: ISODate; lift: Lift }
  | { type: 'start'; date: ISODate; ref: Extract<SessionRef, { kind: 'lift' | 'lift-test' }>; mode?: 'resume' | 'fresh' }
  | { type: 'mobility'; status: 'done' | 'skipped'; date: ISODate }
  /** /test for a lift that already has a result: ✓ Replace (correct it) or ✕ Keep. */
  | ({ type: 'test-correct' } & TestReplace)
  | ({ type: 'test-keep' } & TestReplace)
  /** /test for a lift without a result yet: ✓ Save or ✕ Cancel. */
  | ({ type: 'test-save' } & TestReplace)
  | ({ type: 'test-cancel' } & TestReplace);

type TestReplace = { date: ISODate; lift: Lift; weight: number; reps: number };

type TestCbType = 'test-correct' | 'test-keep' | 'test-save' | 'test-cancel';
const TEST_CODE: Record<TestCbType, string> = { 'test-correct': 'tc', 'test-keep': 'tk', 'test-save': 'ts', 'test-cancel': 'tx' };
const CODE_TEST: Record<string, TestCbType> = { tc: 'test-correct', tk: 'test-keep', ts: 'test-save', tx: 'test-cancel' };

const ACT_CODE: Record<CallbackAct, string> = { done: 'd', skip: 's', tomorrow: 't' };
const CODE_ACT: Record<string, CallbackAct> = { d: 'done', s: 'skip', t: 'tomorrow' };
const CONFIRM_CODE: Record<CallbackAct, string> = { done: 'D', skip: 'S', tomorrow: 'T' };
const CODE_CONFIRM: Record<string, CallbackAct> = { D: 'done', S: 'skip', T: 'tomorrow' };

export function encodeCallback(cb: Callback): string {
  switch (cb.type) {
    case 'ask': return `a|${ACT_CODE[cb.act]}|${cb.date}|${encodeRef(cb.ref)}`;
    case 'action': return `a|${CONFIRM_CODE[cb.act]}|${cb.date}|${encodeRef(cb.ref)}`;
    case 'reps-ask': return `a|q|${cb.date}|${encodeRef(cb.ref)}`;
    case 'cancel': return `a|x|${cb.date}|${encodeRef(cb.ref)}`;
    case 'reps': return `a|r|${cb.date}|${encodeRef(cb.ref)}|${cb.reps}`;
    case 'test-hint': return `a|h|${cb.date}|${encodeRef({ kind: 'lift-test', lift: cb.lift })}`;
    case 'start': return `a|${cb.mode === 'resume' ? 'gr' : cb.mode === 'fresh' ? 'gf' : 'g'}|${cb.date}|${encodeRef(cb.ref)}`;
    case 'mobility': return `m|${cb.status === 'done' ? 'd' : 's'}|${cb.date}`;
    // e.g. a|tc|2026-10-05|deadlift|102.5|15 (≤ 64 bytes)
    case 'test-correct': case 'test-keep': case 'test-save': case 'test-cancel':
      return `a|${TEST_CODE[cb.type]}|${cb.date}|${cb.lift}|${num(cb.weight)}|${cb.reps}`;
  }
}

/** Lift Sessions in weeks 1-3 end in an AMRAP "+" set, so Done asks for the reps first. */
export const asksReps = (ref: SessionRef): boolean => ref.kind === 'lift' && ref.week !== 'reentry' && ref.week !== 4;

export const MAX_AMRAP_BUTTON = 13; // the "13+" button records 13

export function decodeCallback(data: string): Callback | null {
  const p = data.split('|');
  if (p[0] === 'a' && p[1] === 'x') {
    const ref = decodeRef(p[3] ?? '');
    return p.length === 4 && isRealIsoDate(p[2]) && ref ? { type: 'cancel', date: p[2]!, ref } : null;
  }
  if (p[0] === 'a' && (p[1] === 'q' || p[1] === 'r')) {
    const ref = decodeRef(p[3] ?? '');
    if (!isRealIsoDate(p[2]) || !ref || !asksReps(ref)) return null;
    if (p[1] === 'r') {
      if (p.length !== 5 || !/^\d{1,2}$/.test(p[4]!) || Number(p[4]) > MAX_AMRAP_BUTTON) return null;
      return { type: 'reps', date: p[2]!, ref, reps: Number(p[4]) };
    }
    return p.length === 4 ? { type: 'reps-ask', date: p[2]!, ref } : null;
  }
  if (p[0] === 'a' && p[1] === 'h') {
    const ref = decodeRef(p[3] ?? '');
    return p.length === 4 && isRealIsoDate(p[2]) && ref?.kind === 'lift-test' ? { type: 'test-hint', date: p[2]!, lift: ref.lift } : null;
  }
  if (p[0] === 'a' && CODE_TEST[p[1]!] !== undefined) {
    if (p.length !== 6 || !isRealIsoDate(p[2]) || !LIFT_ORDER.includes(p[3] as Lift) || !/^\d{1,3}(?:\.\d{1,2})?$/.test(p[4]!) || !/^\d{1,2}$/.test(p[5]!)) return null;
    const weight = Number(p[4]);
    const reps = Number(p[5]);
    if (!(weight > 0 && weight <= 500) || reps < 1 || reps > 15) return null;
    const v: TestReplace = { date: p[2]!, lift: p[3] as Lift, weight, reps };
    return { type: CODE_TEST[p[1]!]!, ...v } as Callback;
  }
  if (p[0] === 'a' && (p[1] === 'g' || p[1] === 'gr' || p[1] === 'gf')) {
    const ref = decodeRef(p[3] ?? '');
    if (p.length !== 4 || !isRealIsoDate(p[2]) || (ref?.kind !== 'lift' && ref?.kind !== 'lift-test')) return null;
    const mode = p[1] === 'gr' ? 'resume' : p[1] === 'gf' ? 'fresh' : undefined;
    return { type: 'start', date: p[2]!, ref, ...(mode ? { mode } : {}) };
  }
  if (p[0] === 'a' && p.length === 4) {
    const ask = CODE_ACT[p[1]!];
    const act = ask ?? CODE_CONFIRM[p[1]!];
    const ref = decodeRef(p[3]!);
    // A TM Test is done by logging its result (/test), never by a bare Done.
    if (ref?.kind === 'lift-test' && act === 'done') return null;
    return act && isRealIsoDate(p[2]) && ref ? { type: ask ? 'ask' : 'action', act, date: p[2]!, ref } : null;
  }
  if (p[0] === 'm' && p.length === 3 && isRealIsoDate(p[2]) && (p[1] === 'd' || p[1] === 's'))
    return { type: 'mobility', status: p[1] === 'd' ? 'done' : 'skipped', date: p[2]! };
  return null;
}

// ---------- text helpers ----------
// Layout for a phone: each Session is a bold header line with its key numbers, a short visible summary,
// long detail inside a collapsed <blockquote expandable> (one item per line), then its logging hint.
const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dayNum = (d: ISODate) => String(Number(d.slice(8, 10)));
const cap = (s: string) => s[0]!.toUpperCase() + s.slice(1);
const num = (n: number) => String(Math.round(n * 100) / 100);
const MOUNTAIN_HINT = '/log 6h 900m 7';
/** Telegram's sendMessage text limit. */
export const TELEGRAM_MAX_TEXT = 4096;

function doseText(dose: Exercise['dose']): string {
  if (typeof dose === 'string') return dose;
  const side = dose.perSide ? '/side' : '';
  return dose.type === 'hold'
    ? `${dose.times ? dose.times + ' x ' : ''}${dose.seconds} s${side}`
    : `${dose.sets ? dose.sets + ' x ' : ''}${dose.reps}${side}`;
}
const exerciseText = (e: Exercise) => `${e.name} ${doseText(e.dose)}`;
const bullets = (items: string[]) => items.map((x) => `• ${esc(x)}`);
/** Collapsed-by-default quote for long detail. `lines` must already be HTML-safe. */
const expandable = (lines: string[]) => `<blockquote expandable>${lines.join('\n')}</blockquote>`;

const WEEK_LABEL: Record<string, string> = { 1: '5s', 2: '3s', 3: '5/3/1', 4: 'deload' };
const liftHeader = (lift: Lift, week: number | 'reentry') =>
  week === 'reentry' ? `${LIFT_LABEL[lift]} — Re-entry (deload)` : `${LIFT_LABEL[lift]} — Week ${week} (${WEEK_LABEL[week]})`;

const RUN_LABEL: Record<RunKind, string> = {
  easy: 'Easy run', 'quality-vert': 'Quality run — Vert', 'quality-speed': 'Quality run — Speed', long: 'Long run',
  ruck: 'Hill Ruck', 'benchmark-2k4': 'Benchmark — 2.4 km', 'benchmark-hill': 'Benchmark — Hill',
};
/** Short Session names for buttons and the week preview. */
const RUN_SHORT: Record<RunKind, string> = {
  easy: 'Easy run', 'quality-vert': 'Vert run', 'quality-speed': 'Speed run', long: 'Long run',
  ruck: 'Ruck', 'benchmark-2k4': '2.4 km test', 'benchmark-hill': 'Hill test',
};

const LIFT_LABEL: Record<Lift, string> = { squat: 'Squat', bench: 'Bench', deadlift: 'Deadlift', ohp: 'OHP' };

/** The /test command hint for one lift (plain text: escape it before sending as HTML). */
export const testHint = (lift: Lift) => `/test ${lift} <kg> <reps>`;

/** The icon that starts a Session's header and its buttons. */
function sessionIcon(s: SessionRef): string {
  switch (s.kind) {
    case 'lift': case 'lift-test': return '🏋️';
    case 'travel-strength': return '🧳';
    case 'run': return s.run === 'ruck' ? '🎒' : '🏃';
    case 'climb': return '🧗';
  }
}

/** A short name for buttons: "Squat", "Squat test", "Long run", "Climb". */
function shortName(s: SessionRef): string {
  switch (s.kind) {
    case 'lift': return LIFT_LABEL[s.lift];
    case 'lift-test': return `${LIFT_LABEL[s.lift]} test`;
    case 'travel-strength': return 'Travel';
    case 'run': return RUN_SHORT[s.run];
    case 'climb': return 'Climb';
  }
}

/** "🏋️ Squat": prefixes a status button after a Check-in, so it still says which Session it was. */
export const sessionTag = (s: SessionRef): string => `${sessionIcon(s)} ${shortName(s)}`;

function sessionName(s: SessionRef): string {
  switch (s.kind) {
    case 'lift': return LIFT_LABEL[s.lift];
    case 'lift-test': return `${LIFT_LABEL[s.lift]} test`;
    case 'travel-strength': return 'Travel Strength';
    case 'run': return RUN_LABEL[s.run];
    case 'climb': return 'Climb';
  }
}

const isHttps = (url: string): boolean => {
  try { return new URL(url).protocol === 'https:'; } catch { return false; }
};

const routeName = (r: RouteSummary) => `${r.name}${r.kind === 'repeat' && r.repeats ? ` ×${r.repeats}` : ''}`;

/** "Route: Hill repeats ×3 (6 km · 450 m↑)", the name linked when the Route has an https url. */
function routeLine(r: RouteSummary): string {
  const name = esc(routeName(r));
  const label = r.url && isHttps(r.url) ? `<a href="${escAttr(r.url)}">${name}</a>` : name;
  return `Route: ${label} (${num(r.km)} km · ${num(r.vertM)} m↑)`;
}

const setText = (x: { load: number; unit: string; capped: boolean; reps: number; amrap: boolean }) =>
  `${num(x.load)} ${x.unit}${x.capped ? '*' : ''} × ${x.reps}${x.amrap ? '+' : ''}`;

/** "Ramp: a, b, c. Then x. y." → "Ramp" with a bullet per item, "Then" with x, and other sentences as bullets. */
function protocolLines(protocol: string): string[] {
  const out: string[] = [];
  for (const sentence of protocol.split(/(?<=\.)\s+/)) {
    const m = /^([A-Z][a-z]+): (.+?)\.?$/.exec(sentence);
    if (m) out.push(`<b>${esc(m[1]!)}</b>`, ...bullets(m[2]!.split(', ')));
    else if (sentence.startsWith('Then ')) out.push('<b>Then</b>', ...bullets([cap(sentence.slice(5))]));
    else out.push(...bullets([sentence]));
  }
  return out;
}

function sessionBlock(s: SessionRef, d: SessionDetail | null): string {
  if (!d) return `✔ ${esc(sessionName(s))} — done`;
  const head = (title: string, extra: string[] = []) =>
    [`${sessionIcon(s)} <b>${esc(title)}</b>`, ...extra.map(esc)].join(' · ');
  switch (d.kind) {
    case 'lift': {
      const top = d.mainSets.at(-1);
      const sets = d.mainSets.map((x) => esc(`${num(x.pct)}% · ${setText(x)}`));
      if (d.mainSets.some((x) => x.capped)) sets.push('* capped at the machine maximum');
      const fslHead = `<b>FSL</b>${d.lastFslWeightKg != null ? ` · last ${num(d.lastFslWeightKg)} kg` : ''}`;
      return [
        head(liftHeader(d.lift, d.week)),
        esc(`${d.mainSets.length} sets${top ? ` up to ${setText(top)}` : ''} · then FSL + finisher`),
        expandable([
          '<b>Warm-up</b>', ...bullets(d.warmup.map(exerciseText)),
          '<b>Main sets</b>', ...sets,
          fslHead, ...bullets(d.fsl.map(exerciseText)),
          '<b>Finisher</b>', ...bullets(d.finisher.map(exerciseText)),
        ]),
      ].join('\n');
    }
    case 'lift-test':
      return [
        head(`${LIFT_LABEL[d.lift]} — 5-rep max test`),
        `Warm-up ${d.warmup.length} items · ramp to a hard 5RM`,
        expandable(['<b>Warm-up</b>', ...bullets(d.warmup.map(exerciseText)), ...protocolLines(d.protocol)]),
        `Log: <code>/test ${d.lift} 100 5</code> (top set kg, reps)`,
      ].join('\n');
    case 'travel-strength':
      return [
        head('Travel Strength'),
        `${d.exercises.length} bodyweight exercises`,
        expandable(bullets(d.exercises.map(exerciseText))),
      ].join('\n');
    case 'run': {
      const lines = d.run === 'ruck'
        ? [head(RUN_LABEL.ruck, [...(d.ruckLoad ? [`${num(d.ruckLoad.packKg)} kg`] : []), `${num(d.rx.vertM)} m↑`, '2–2.5 h'])]
        : [head(RUN_LABEL[d.run], [`${num(d.rx.km)} km`, ...(d.rx.vertM > 0 ? [`${num(d.rx.vertM)} m↑`] : [])])];
      if (d.run !== 'ruck' && d.rx.detail) lines.push(esc(d.rx.detail));
      if (d.route) lines.push(routeLine(d.route));
      return lines.join('\n');
    }
    case 'climb':
      return d.event
        ? `${head(d.event.title, [d.event.time])}\n${esc(d.finisher)}`
        : `${head('Climb')}\n${esc(d.finisher)}`;
  }
}

const dateLabel = (date: ISODate) => `${DOW[weekday(date)]} ${dayNum(date)}`;

/** Cut `s` so its escaped form fits in `room` characters, marking the cut with "…". */
function escFit(s: string, room: number): string {
  if (esc(s).length <= room) return esc(s);
  let t = s;
  while (t && esc(t).length + 1 > room) t = t.slice(0, -1);
  return `${esc(t)}…`;
}

// ---------- messages ----------
export function morningMessage(
  day: DayPlan,
  details: Array<SessionDetail | null>,
): { text: string; keyboard: InlineKeyboard } {
  // Day notes ("Also: Wall B 20:00", "Skipped: Wall A 18:00 (mountain day)") sit in italics right under the header.
  const header = [`<b>☀️ ${dateLabel(day.date)} ${MONTH[Number(day.date.slice(5, 7)) - 1]}</b>`, ...(day.notes ?? []).map((n) => `<i>${esc(n)}</i>`)].join('\n');
  const top: string[] = [header];
  if (day.mountain) top.push(`⛰ Mountain day — check in tonight with ${MOUNTAIN_HINT}`);
  if (day.sessions.length === 0 && !day.mountain) top.push('😴 Rest day — nothing planned. Do the mobility routine tonight.');
  const sessions = day.sessions.map((s, i) => sessionBlock(s, details[i] ?? null));

  // The day's note is the only free text of unbounded size: cut it to whatever room the 4096 limit leaves.
  const fixed = [...top, ...sessions].join('\n\n').length;
  const blocks = [...top];
  if (day.note) blocks.push(`📝 ${escFit(day.note, TELEGRAM_MAX_TEXT - fixed - 4)}`);
  blocks.push(...sessions);

  const keyboard: InlineKeyboard = [];
  const used = new Set<string>();
  day.sessions.forEach((s) => {
    if (s.status === 'done') return;
    try {
      // No two buttons on the message may look alike: when a label is taken (two Sessions with the same icon),
      // name the Session on every button, and number it if even that is taken (e.g. two Climbs).
      const taken = (rows: InlineKeyboard) => rows.some((r) => r.some((x) => used.has(x.text)));
      let rows = sessionRows(day.date, s);
      if (taken(rows)) rows = sessionRows(day.date, s, { named: true });
      for (let n = 2; taken(rows); n++) rows = sessionRows(day.date, s, { named: true, name: `${shortName(s)} ${n}` });
      rows.flat().forEach((b) => used.add(b.text));
      keyboard.push(...rows);
    } catch {
      // e.g. a Club Event id that can't go in callback_data: show the Session, just without buttons
    }
  });
  return { text: blocks.join('\n\n'), keyboard };
}

/**
 * The Check-in row for one Session. Every button starts with the Session's icon and the first names it
 * ("🏃 Long run: Done", "🏃 Skip", "🏃 Tomorrow"), so each row reads as belonging to its Session. With
 * `named`, the other buttons carry the name too ("🏋️ Skip Squat test"): morningMessage uses that when two
 * Sessions share an icon. Done asks for AMRAP reps first on weeks 1-3 lifts; every other tap asks to confirm
 * first (confirmRow). callback_data formats are
 * fixed: already-sent messages must keep working.
 */
/**
 * A Session's buttons: for a lift or TM Test, a full-width "▶ Start Squat" row (a Live Session) above its Check-in
 * row; for anything else just the Check-in row.
 */
export function sessionRows(date: ISODate, s: SessionRef, opts: { name?: string; named?: boolean } = {}): InlineKeyboard {
  const row = sessionRow(date, s, opts);
  if (s.kind !== 'lift' && s.kind !== 'lift-test') return [row];
  const name = opts.name ?? shortName(s);
  return [[{ text: `▶ Start ${name}`, callback_data: encodeCallback({ type: 'start', date, ref: s }) }], row];
}

export function sessionRow(date: ISODate, s: SessionRef, opts: { name?: string; named?: boolean } = {}): InlineKeyboard[number] {
  const ref = encodeRef(s);
  const icon = sessionIcon(s);
  const name = opts.name ?? shortName(s);
  const tail = opts.named ? ` ${name}` : '';
  const skip = { text: `${icon} Skip${tail}`, callback_data: `a|s|${date}|${ref}` };
  if (s.kind === 'lift-test') {
    // The result needs weight and reps, which buttons can't carry: the first button explains the /test command.
    return [{ text: `${icon} ${name}: Log`, callback_data: encodeCallback({ type: 'test-hint', date, lift: s.lift }) }, skip];
  }
  const row = [{ text: `${icon} ${name}: Done`, callback_data: `a|${asksReps(s) ? 'q' : 'd'}|${date}|${ref}` }, skip];
  if (s.kind === 'lift' || s.kind === 'run') row.push({ text: `${icon} Tomorrow${tail}`, callback_data: `a|t|${date}|${ref}` });
  return row;
}

/** The nudge sent when a watch strength Activity syncs while a lift Session or TM Test is still pending today. */
export function strengthNudge(date: ISODate, s: Extract<SessionRef, { kind: 'lift' | 'lift-test' }>): { text: string; keyboard?: InlineKeyboard } {
  const head = '⌚ Strength session synced — log your';
  if (s.kind === 'lift-test') return { text: esc(`${head} ${LIFT_LABEL[s.lift]} test? ${testHint(s.lift)}`) };
  return { text: `${head} ${cap(s.lift)} ${s.week === 'reentry' ? 're-entry' : `week ${s.week}`}?`, keyboard: [sessionRow(date, s)] };
}

/** "Squat 5s", "Squat re-entry", "Long run": names the Session on its confirmation button. */
function confirmName(s: SessionRef): string {
  if (s.kind !== 'lift') return shortName(s);
  return `${LIFT_LABEL[s.lift]} ${s.week === 'reentry' ? 're-entry' : WEEK_LABEL[s.week]}`;
}

/**
 * The confirmation row that replaces a Session's buttons after a Done / Skip / Tomorrow tap: ✓ performs the
 * action (`a|D|`, `a|S|`, `a|T|`), ↩︎ Cancel (`a|x|`) restores the Session's buttons.
 */
export function confirmRow(date: ISODate, act: CallbackAct, ref: SessionRef): InlineKeyboard[number] {
  const name = confirmName(ref);
  const text = act === 'done' ? `✓ Mark ${name} done` : act === 'skip' ? `✓ Skip ${name}` : `✓ Move ${name} to tomorrow`;
  return [
    { text, callback_data: encodeCallback({ type: 'action', act, date, ref }) },
    { text: '↩︎ Cancel', callback_data: encodeCallback({ type: 'cancel', date, ref }) },
  ];
}

/** Rep buttons 0..12 and 13+ in rows of 7, then Cancel. */
export function repsKeyboard(date: ISODate, ref: SessionRef): InlineKeyboard {
  const r = encodeRef(ref);
  const btns = Array.from({ length: MAX_AMRAP_BUTTON + 1 }, (_, n) => ({
    text: n === MAX_AMRAP_BUTTON ? `${n}+` : String(n),
    callback_data: `a|r|${date}|${r}|${n}`,
  }));
  return [btns.slice(0, 7), btns.slice(7), [{ text: '↩︎ Cancel', callback_data: `a|x|${date}|${r}` }]];
}

export function mobilityMessage(day: DayPlan): { text: string; keyboard: InlineKeyboard } {
  const groups: string[] = [];
  const quote: string[] = [];
  for (const e of DAILY_ROUTINE) {
    const g = e.group ?? 'Other';
    if (!groups.includes(g)) { groups.push(g); quote.push(`<b>${esc(g)}</b>`); }
    quote.push(...bullets([exerciseText(e)]));
  }
  const lines = [
    '🧘 <b>Nightly routine</b> · ~27 min',
    `${DAILY_ROUTINE.length} exercises: ${groups.map((g) => g.toLowerCase()).join(', ')}`,
    expandable(quote),
  ];
  if (day.mountain) lines.push(`⛰ How was today? ${MOUNTAIN_HINT}`);
  return {
    text: lines.join('\n'),
    keyboard: [[
      { text: '🧘 Routine: Done', callback_data: `m|d|${day.date}` },
      { text: '🧘 Skip', callback_data: `m|s|${day.date}` },
    ]],
  };
}

function previewSession(s: SessionRef): string {
  switch (s.kind) {
    case 'lift': return `🏋️ ${LIFT_LABEL[s.lift]} ${s.week === 'reentry' ? 're-entry' : WEEK_LABEL[s.week]}`;
    case 'lift-test': return `🏋️ ${LIFT_LABEL[s.lift]} test`;
    case 'travel-strength': return '🧳 Travel Strength';
    case 'run': return `${sessionIcon(s)} ${RUN_SHORT[s.run]}`;
    case 'climb': return '🧗 Climb';
  }
}

/** A heading, seven lines (one per day, runs with their Route), then the week's run target from the first run detail found. */
export function previewMessage(days: DayPlan[], detailsByDate: Record<ISODate, Array<SessionDetail | null>>): { text: string } {
  const lines = ['📅 <b>Next 7 days</b>'];
  for (const d of days.slice(0, 7)) {
    const parts = d.sessions.map((s, i) => {
      const det = detailsByDate[d.date]?.[i];
      return det?.kind === 'run' && det.route ? `${previewSession(s)} (${routeName(det.route)})` : previewSession(s);
    });
    if (d.mountain) parts.unshift('⛰ Mountain day');
    lines.push(`<b>${dateLabel(d.date)}</b> · ${esc(parts.length ? parts.join(', ') : 'rest')}`);
  }
  for (const d of days.slice(0, 7)) {
    const run = (detailsByDate[d.date] ?? []).find((x) => x?.kind === 'run');
    if (run?.kind === 'run') {
      lines.push('', `🎯 Week target: ${num(run.target.km)} km · ${num(run.target.vertM)} m↑${run.target.deload ? ' (deload)' : ''}`);
      break;
    }
  }
  return { text: lines.join('\n') };
}
