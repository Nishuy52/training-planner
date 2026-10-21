// The one Live Session (ADR 0004): a SQLite-backed Durable Object defined in the `training` Worker and bound
// from `training-bot` by script_name. It holds the current step and the rest timer; its alarm sends the
// "Rest over" ping and auto-finishes at local midnight. Logged Sets go to D1 lift_log as they are logged;
// finishing goes through performAction like Done, so a wrong or lost alarm never moves the Sequence otherwise.
import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../index';
import type { ISODate, PlannerState, SessionRef } from '../domain/types';
import { testResultPreview, type SetLog } from '../domain/actions';
import { addDays, zonedMidnight } from '../domain/dates';
import { isPlanned, refKey } from '../domain/planner';
import {
  DEFAULT_REST, REST_EXTEND_S, TEST_INPUT_EXAMPLE, adjust, currentSetIndex, currentStep, extendRest, liveView, logSet, loggedSetCount, newLiveState,
  pendingValues, restoreSets, setLastRpe, toSetLogs, topSet, type LiveError, type LiveRef, type LiveState, type LiveView, type LogInput, type RestSeconds,
} from '../domain/live';
import { deleteLiftLog, getKV, liftLogsFor, loadPlannerState, logLift, updateLiftLog } from '../store/db';
import { NotPlanned, amrapRepsFromSets, fslWeightFromSets, performAction, planWithDetails, recordAmrapIfMissing, todayFor } from '../http/api';
import { deleteMessage, editMessageText, sendMessageWithMarkup } from '../telegram/client';
import {
  INPUT_HINT, LIVE_REPLY_KEYBOARD, PAUSED_HINT, REMOVE_KEYBOARD, abandonConfirmKeyboard, liveMessage, outcomeLine, parseLiveInput, restPingText,
  shortId, summaryMessage, type LiveCallback, type LiveOutcome,
} from '../telegram/live';
import { esc } from '../telegram/format';
import { safeError, telegramFetch } from '../telegram/webhook';

export type LiveResult =
  | { ok: true; live: LiveView | null; events?: string[]; outcome?: LiveOutcome }
  | { ok: false; status: LiveError['status']; error: string; resumable?: true };

/** What the webhook does after a Telegram callback or typed message: a toast, a reply, or nothing. */
export type TelegramReply = { toast?: string; reply?: string; removeKeyboard?: boolean; clearKeyboard?: boolean; ignored?: boolean };

export type StartMode = 'resume' | 'fresh';

const KEY = 'live';
/** After a midnight auto-close: the outcome line, sent once on the next reply-keyboard press (which removes it). */
const NOTICE = 'closedNotice';
export const REST_KV = 'restSeconds';
/** kv key committed in the same batch as the finishing state write: a retry can tell it already counted. */
export const doneMarker = (id: string) => `liveDone:${id}`;
/** A second "✓ Set done" this soon after a set was logged is a double tap. */
export const DUPLICATE_MS = 3000;

export async function loadRestSeconds(db: D1Database): Promise<RestSeconds> {
  const raw = await getKV(db, REST_KV);
  return { ...DEFAULT_REST, ...(raw ? (JSON.parse(raw) as Partial<RestSeconds>) : {}) };
}

/** The one Live Session's stub (both Workers bind it as LIVE). */
export const liveStub = (env: Env) => env.LIVE.get(env.LIVE.idFromName('live'));

const fail = (e: LiveError): LiveResult => ({ ok: false, ...e });
const isErr = (x: unknown): x is LiveError => typeof x === 'object' && x !== null && 'error' in x && 'status' in x;
const paused = (s: LiveState): LiveError | null => (s.paused ? { status: 409, error: PAUSED_HINT } : null);

type Row = { id: number } & Record<string, unknown>;
const hasLoggedSet = (sets: unknown) => Array.isArray(sets) && (sets as SetLog[]).some((x) => !x.skipped);

export class LiveSessionObject extends DurableObject<Env> {
  private chain: Promise<unknown> = Promise.resolve();

  /** One operation at a time: D1 and Telegram awaits would otherwise let a second tap interleave. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.chain.then(fn, fn);
    this.chain = p.catch(() => undefined);
    return p;
  }

  private get tgOn(): boolean {
    return !!(this.env.TELEGRAM_BOT_TOKEN && this.env.TELEGRAM_CHAT_ID);
  }

  private async tg<T>(what: string, fn: () => Promise<T>): Promise<T | undefined> {
    if (!this.tgOn) return undefined;
    try {
      return await fn();
    } catch (err) {
      // "message is not modified" and friends: the Live Session itself must never fail on Telegram.
      console.error(`live session telegram ${what}:`, safeError(this.env, err));
      return undefined;
    }
  }

  // ───────────────────────── storage, alarm, D1 ─────────────────────────

  /** The open Live Session; one past its local midnight is auto-finished first (a lost alarm is caught here). */
  private async load(now = Date.now()): Promise<LiveState | null> {
    const s = (await this.ctx.storage.get<LiveState>(KEY)) ?? null;
    if (s && now >= s.autoFinishAt) {
      await this.autoClose(s);
      return null;
    }
    return s;
  }

  private async save(s: LiveState): Promise<void> {
    await this.ctx.storage.put(KEY, s);
    const restDue = s.restEndsAt !== null && !s.restPinged ? s.restEndsAt : Infinity;
    await this.ctx.storage.setAlarm(Math.min(restDue, s.autoFinishAt));
  }

  private async clear(): Promise<void> {
    await this.ctx.storage.delete(KEY);
    await this.ctx.storage.deleteAlarm();
  }

  /** The lift_log row while the Live Session runs (rewritten per set). */
  private liveEntry(s: LiveState): Record<string, unknown> {
    const sets = toSetLogs(s);
    if (s.ref.kind === 'lift-test') return { date: s.date, lift: s.ref.lift, test: true, live: true, testSets: sets };
    const w = fslWeightFromSets(s.ref.lift, sets);
    return { date: s.date, lift: s.ref.lift, week: s.ref.week, live: true, sets, ...(w !== undefined ? { fslWeightKg: w } : {}) };
  }

  /** The finished row, as performAction's Done would write it (used when its follow-up writes were lost). */
  private finalEntry(s: LiveState, auto: boolean): Record<string, unknown> {
    const e: Record<string, unknown> = { ...this.liveEntry(s), live: undefined };
    if (s.ref.kind === 'lift-test') {
      const top = topSet(s);
      if (top) e.result = { weight: top.load, reps: top.reps };
    } else {
      const amrap = amrapRepsFromSets(toSetLogs(s));
      if (amrap !== undefined && amrap <= 30) e.amrapReps = amrap;
    }
    if (auto) e.autoFinished = true;
    return e;
  }

  private async writeLog(s: LiveState, entry = this.liveEntry(s)): Promise<void> {
    if (s.liftLogId === null) {
      if (!s.sets.some((x) => x.loggedAt !== undefined)) return;
      s.liftLogId = await logLift(this.env.DB, s.date, s.ref.lift, entry);
    } else {
      await updateLiftLog(this.env.DB, s.liftLogId, entry);
    }
  }

  // ───────────────────────── Telegram ─────────────────────────

  private async render(s: LiveState): Promise<void> {
    if (s.messageId === null) return;
    const m = liveMessage(s, Date.now());
    await this.tg('edit', () => editMessageText(this.env, s.messageId!, m.text, m.keyboard, telegramFetch));
  }

  private async dropPing(s: LiveState): Promise<void> {
    if (s.pingMessageId === null) return;
    const id = s.pingMessageId;
    s.pingMessageId = null;
    await this.tg('delete ping', () => deleteMessage(this.env, id, telegramFetch));
  }

  /** Ends the Live Session in Telegram: the message becomes the summary; `closeKeyboard` sends the reply-keyboard removal. */
  private async closeTelegram(s: LiveState, outcome: LiveOutcome, events: string[], closeKeyboard: boolean): Promise<void> {
    await this.dropPing(s);
    if (s.messageId !== null) {
      await this.tg('summary', () => editMessageText(this.env, s.messageId!, summaryMessage(s, outcome, events), undefined, telegramFetch));
    }
    if (closeKeyboard) {
      const text = outcome === 'abandoned' ? 'Live Session abandoned.' : 'Live Session finished.';
      await this.tg('close keyboard', () => sendMessageWithMarkup(this.env, text, REMOVE_KEYBOARD, telegramFetch));
    }
  }

  // ───────────────────────── finishing ─────────────────────────

  /**
   * Finish through performAction, like Done: a lift with its Logged Sets (the AMRAP reps derive from them), a
   * TM Test with its top set as the result. The state write also commits doneMarker(id), so a retry after a
   * failed follow-up write knows it already counted. A Session checked in elsewhere meanwhile leaves the
   * Sequence alone and its Logged Sets join that Session's lift_log row.
   */
  private async complete(s: LiveState, auto: boolean): Promise<{ outcome: LiveOutcome; events: string[] }> {
    const db = this.env.DB;
    const marker = doneMarker(s.id);
    try {
      if (s.ref.kind === 'lift-test') {
        const top = topSet(s)!;
        const { events } = await performAction(db, { type: 'test-result', date: s.date, lift: s.ref.lift, weight: top.load!, reps: top.reps! }, { marker });
        await this.writeLog(s, this.finalEntry(s, auto));
        return { outcome: auto ? 'auto-finished' : 'finished', events };
      }
      const { events } = await performAction(
        db,
        { type: 'done', date: s.date, ref: s.ref, sets: toSetLogs(s), ...(auto ? { autoFinished: true as const } : {}) },
        { liftLogId: s.liftLogId ?? undefined, marker },
      );
      return { outcome: auto ? 'auto-finished' : 'finished', events };
    } catch (err) {
      if (!(err instanceof NotPlanned)) throw err;
      if ((await getKV(db, marker)) !== null) {
        // Our own earlier attempt counted; only its follow-up writes failed.
        await this.writeLog(s, this.finalEntry(s, auto));
        return { outcome: auto ? 'auto-finished' : 'finished', events: [] };
      }
      await this.mergeIntoElsewhere(s, auto);
      return { outcome: 'not-counted', events: [] };
    }
  }

  /**
   * The Session was checked in elsewhere (e.g. a Done tap) while this Live Session ran. Its lift_log row (if
   * it has none of its own sets) takes these Logged Sets and this row goes; with no such row this row becomes
   * the Session's; a row that already has sets is linked (`duplicateOf`) and this one is marked notCounted.
   */
  private async mergeIntoElsewhere(s: LiveState, auto: boolean): Promise<void> {
    const db = this.env.DB;
    const final = this.finalEntry(s, auto);
    const other = s.ref.kind === 'lift'
      ? (await liftLogsFor(db, s.date, s.ref.lift))
        .filter((r: Row) => r.id !== s.liftLogId && !r.live && !r.abandoned && !r.notCounted && !r.test && r.week === (s.ref as { week: unknown }).week)
        .at(-1)
      : undefined;
    if (other && !Array.isArray(other.sets)) {
      const { id, ...rest } = other;
      const merged: Record<string, unknown> = { ...rest, sets: final.sets };
      if (final.fslWeightKg !== undefined) merged.fslWeightKg = final.fslWeightKg;
      // That Done had no AMRAP reps: the Logged AMRAP set supplies them, for the row and the TM progression.
      const week = (s.ref as { week: unknown }).week;
      if (merged.amrapReps === undefined && typeof final.amrapReps === 'number') {
        merged.amrapReps = final.amrapReps;
        if (week === 1 || week === 2) await recordAmrapIfMissing(db, s.ref.lift, week, final.amrapReps);
      }
      await updateLiftLog(db, id, merged);
      if (s.liftLogId !== null) await deleteLiftLog(db, s.liftLogId);
      s.liftLogId = null;
      return;
    }
    if (other) await this.writeLog(s, { ...final, notCounted: true, duplicateOf: other.id });
    else if (s.ref.kind === 'lift-test') await this.writeLog(s, { ...final, notCounted: true });
    else {
      // No row: that Done had neither sets nor AMRAP reps, so the Logged AMRAP set supplies them.
      await this.writeLog(s, final);
      const week = s.ref.week;
      if ((week === 1 || week === 2) && typeof final.amrapReps === 'number') await recordAmrapIfMissing(db, s.ref.lift, week, final.amrapReps);
    }
  }

  /** Local midnight: finish as Done with ≥ 1 Logged Set, else discard (a TM Test without its top set is discarded). No message is sent. */
  private async autoClose(s: LiveState): Promise<void> {
    const canFinish = s.ref.kind === 'lift' ? loggedSetCount(s) > 0 : !!topSet(s);
    let outcome: LiveOutcome = 'discarded';
    let events: string[] = [];
    if (canFinish) ({ outcome, events } = await this.complete(s, true));
    else if (s.liftLogId !== null) await this.writeLog(s, { ...this.liveEntry(s), live: undefined, abandoned: true, autoFinished: true });
    await this.closeTelegram(s, outcome, events, false);
    // The reply keyboard is still up: its next press gets this line and the removal.
    if (s.messageId !== null) await this.ctx.storage.put(NOTICE, outcomeLine(s, outcome));
    await this.clear();
  }

  // ───────────────────────── operations ─────────────────────────

  /** Load, apply `fn`, persist (D1 row when the Logged Sets changed, storage, alarm), re-render. */
  private mutate(fn: (s: LiveState, now: number) => Promise<LiveError | null | void> | LiveError | null | void): Promise<LiveResult> {
    return this.serial(async () => {
      const now = Date.now();
      const s = await this.load(now);
      if (!s) return fail({ status: 404, error: 'no Live Session is running' });
      const loggedBefore = JSON.stringify(toSetLogs(s));
      delete s.pendingTop; // a top set waiting for its confirmation is dropped by any other change
      const e = await fn(s, now);
      if (e) return fail(e);
      if (JSON.stringify(toSetLogs(s)) !== loggedBefore) await this.writeLog(s);
      await this.save(s);
      await this.render(s);
      return { ok: true, live: liveView(s) };
    });
  }

  async view(): Promise<LiveResult> {
    return this.serial(async () => {
      const s = await this.load();
      return { ok: true, live: s ? liveView(s) : null };
    });
  }

  /** An attempt at this Session abandoned earlier the same day that has Logged Sets. */
  private async resumable(date: ISODate, ref: LiveRef): Promise<Row | undefined> {
    const rows = await liftLogsFor(this.env.DB, date, ref.lift);
    return rows
      .filter((r) => r.abandoned === true && (ref.kind === 'lift-test' ? r.test === true : !r.test && r.week === ref.week))
      .filter((r) => hasLoggedSet(ref.kind === 'lift-test' ? r.testSets : r.sets))
      .at(-1);
  }

  /**
   * Start today's lift Session or TM Test, and open it in Telegram. When an attempt was abandoned earlier today with
   * Logged Sets, `mode` must say whether to resume it (same row, un-abandoned) or start fresh (that row stays abandoned).
   */
  async start(date: ISODate, ref: SessionRef, mode?: StartMode): Promise<LiveResult> {
    return this.serial(async () => {
      const now = Date.now();
      const open = await this.load(now);
      if (open) return fail({ status: 409, error: `a Live Session is already running: ${open.title}` });
      if (ref.kind !== 'lift' && ref.kind !== 'lift-test') return fail({ status: 400, error: 'only a lift Session or a TM Test can be started' });
      const db = this.env.DB;
      const state = await loadPlannerState(db);
      if (date !== todayFor(state, new Date(now))) return fail({ status: 409, error: "only today's Sessions can be started" });
      if (!isPlanned(state, date, ref)) return fail({ status: 409, error: new NotPlanned().message });
      const { days, details } = await planWithDetails(db, state, date, 1);
      const day = days[0]!;
      const i = day.sessions.findIndex((x) => x.status === 'planned' && refKey(x) === refKey(ref));
      const detail = details[date]?.[i];
      if (!detail) return fail({ status: 409, error: new NotPlanned().message });
      const prior = await this.resumable(date, ref);
      const s = newLiveState({
        id: crypto.randomUUID().replace(/-/g, ''), date, ref, tz: day.timezone, detail,
        gym: gymFor(state, detail.kind === 'lift' ? detail.gymProfileId : state.defaultGymProfileId),
        rest: await loadRestSeconds(db), now, autoFinishAt: zonedMidnight(addDays(date, 1), day.timezone),
      });
      if (prior && !mode) {
        const n = ((ref.kind === 'lift-test' ? prior.testSets : prior.sets) as SetLog[]).filter((x) => !x.skipped).length;
        return { ok: false, status: 409, resumable: true, error: `${s.title} was abandoned earlier today with ${n} Logged Set${n === 1 ? '' : 's'}: resume it or start fresh` };
      }
      if (mode === 'resume') {
        if (!prior) return fail({ status: 409, error: 'there is no abandoned attempt today to resume' });
        restoreSets(s, (ref.kind === 'lift-test' ? prior.testSets : prior.sets) as SetLog[], now);
        s.liftLogId = prior.id;
        await this.writeLog(s);
      }
      await this.ctx.storage.delete(NOTICE);
      await this.save(s);
      s.keyboardMessageId = (await this.tg('start keyboard', () =>
        sendMessageWithMarkup(this.env, `▶ <b>${esc(s.title)}</b> ${mode === 'resume' ? 'resumed' : 'started'}. ${esc(INPUT_HINT)}`, LIVE_REPLY_KEYBOARD, telegramFetch))) ?? null;
      const m = liveMessage(s, now);
      s.messageId = (await this.tg('start', () => sendMessageWithMarkup(this.env, m.text, { inline_keyboard: m.keyboard }, telegramFetch))) ?? null;
      await this.save(s);
      return { ok: true, live: liveView(s) };
    });
  }

  /** Log, skip or correct a set. A TM Test's top set (`top`) logs the result and finishes. */
  async log(input: LogInput): Promise<LiveResult> {
    if (!input.top) return this.mutate(async (s, now) => {
      const p = paused(s);
      if (p) return p;
      const cur = currentSetIndex(s);
      const r = logSet(s, input, now);
      if (isErr(r)) return r;
      // The "Rest over" ping goes once the next set is logged (not on a correction or an RPE).
      if (r.newly && r.index === cur) await this.dropPing(s);
    });
    return this.serial(async () => {
      const now = Date.now();
      const s = await this.load(now);
      if (!s) return fail({ status: 404, error: 'no Live Session is running' });
      const p = paused(s);
      if (p) return fail(p);
      const r = logSet(s, input, now);
      if (isErr(r)) return fail(r);
      const { outcome, events } = await this.complete(s, false);
      await this.closeTelegram(s, outcome, events, true);
      await this.clear();
      return { ok: true, live: null, events, outcome };
    });
  }

  /**
   * Telegram, TM Test: put the top set up for confirmation on the Live Session message ("Top set 120 kg × 5 →
   * Training Max 125 kg. Save?", with a warning when it is much lower than the other tested lifts). The values are
   * the current set's pending ones unless typed (`top 120x5`); ✓ Save logs exactly these (confirmTop).
   */
  async askTop(input: { step: number; load?: number; reps?: number; rpe?: number }): Promise<LiveResult> {
    const state = await loadPlannerState(this.env.DB);
    return this.mutate((s) => {
      const p = paused(s);
      if (p) return p;
      if (s.ref.kind !== 'lift-test') return { status: 400, error: 'top only applies to a TM Test' };
      if (input.step !== 1 + currentSetIndex(s)) return { status: 409, error: 'that set is not the current one' };
      const pend = pendingValues(s) ?? {};
      const load = input.load ?? pend.load;
      const reps = input.reps ?? pend.reps;
      if (load === undefined) return { status: 400, error: `type the top set, e.g. top ${TEST_INPUT_EXAMPLE}` };
      if (!(load > 0 && load <= 500) || reps === undefined || !(reps >= 1 && reps <= 15)) return { status: 400, error: 'the top set needs a load of 0–500 kg and 1–15 reps' };
      const { tm, low } = testResultPreview(state, s.ref.lift, load, reps);
      s.pendingTop = { load, reps, ...(input.rpe !== undefined ? { rpe: input.rpe } : {}), tm, low };
      s.warmupDone = true;
    });
  }

  /** ✓ Save on the top-set confirmation: logs the confirmed values as the top set (the result) and finishes. */
  async confirmTop(): Promise<LiveResult> {
    const s = await this.serial(() => this.load());
    if (!s?.pendingTop) return fail({ status: 409, error: 'That confirmation is out of date.' });
    const { load, reps, rpe } = s.pendingTop;
    return this.log({ step: 1 + currentSetIndex(s), load, reps, top: true, ...(rpe !== undefined ? { rpe } : {}) });
  }

  /** ↩︎ Back on the top-set confirmation. */
  async cancelTop(): Promise<LiveResult> {
    return this.mutate(() => undefined);
  }

  async adjust(step: number, field: 'load' | 'reps', dir: 1 | -1): Promise<LiveResult> {
    return this.mutate((s) => paused(s) ?? (step !== 1 + currentSetIndex(s) ? { status: 409, error: 'that set is not the current one' } : adjust(s, field, dir)));
  }

  async warmupDone(): Promise<LiveResult> {
    return this.mutate((s) => {
      const p = paused(s);
      if (p) return p;
      s.warmupDone = true;
    });
  }

  async rest(addSeconds: number): Promise<LiveResult> {
    return this.mutate(async (s, now) => {
      const p = paused(s);
      if (p) return p;
      extendRest(s, addSeconds, now);
      await this.dropPing(s);
    });
  }

  /** Stop the rest timer (no "Rest over" ping). */
  async stopRest(): Promise<LiveResult> {
    return this.mutate(async (s) => {
      s.restEndsAt = null;
      s.restPinged = false;
      await this.dropPing(s);
    });
  }

  /** Pause the whole Live Session: the rest timer stops and set input is refused until resumed. Midnight still applies. */
  async pause(): Promise<LiveResult> {
    return this.mutate(async (s) => {
      s.paused = true;
      s.restEndsAt = null;
      s.restPinged = false;
      await this.dropPing(s);
    });
  }

  async resume(): Promise<LiveResult> {
    return this.mutate((s) => {
      s.paused = false;
    });
  }

  async rpe(rpe: number): Promise<LiveResult> {
    return this.mutate((s) => paused(s) ?? setLastRpe(s, rpe));
  }

  async finish(): Promise<LiveResult> {
    return this.serial(async () => {
      const s = await this.load();
      if (!s) return fail({ status: 404, error: 'no Live Session is running' });
      if (s.ref.kind === 'lift-test') return fail({ status: 409, error: 'a TM Test finishes with its top set (log it with top: true)' });
      if (loggedSetCount(s) === 0) return fail({ status: 409, error: 'nothing logged yet: log a set, or cancel' });
      const { outcome, events } = await this.complete(s, false);
      await this.closeTelegram(s, outcome, events, true);
      await this.clear();
      return { ok: true, live: null, events, outcome };
    });
  }

  /** Abandon: the Sequence is untouched; Logged Sets stay in lift_log marked abandoned (Start can resume them today). */
  async abandon(): Promise<LiveResult> {
    return this.serial(async () => {
      const s = await this.load();
      if (!s) return fail({ status: 404, error: 'no Live Session is running' });
      if (s.liftLogId !== null) await this.writeLog(s, { ...this.liveEntry(s), live: undefined, abandoned: true });
      await this.closeTelegram(s, 'abandoned', [], true);
      await this.clear();
      return { ok: true, live: null, outcome: 'abandoned' };
    });
  }

  /** Cancel an accidental start (nothing logged yet): no trace in lift_log or the action log; the messages go too. */
  async cancel(): Promise<LiveResult> {
    return this.serial(async () => {
      const s = await this.load();
      if (!s) return fail({ status: 404, error: 'no Live Session is running' });
      if (loggedSetCount(s) > 0) return fail({ status: 409, error: 'sets are logged: abandon instead' });
      if (s.liftLogId !== null) await deleteLiftLog(this.env.DB, s.liftLogId);
      await this.dropPing(s);
      for (const id of [s.messageId, s.keyboardMessageId ?? null]) {
        if (id !== null) await this.tg('delete', () => deleteMessage(this.env, id, telegramFetch));
      }
      await this.tg('close keyboard', () => sendMessageWithMarkup(this.env, 'Live Session cancelled.', REMOVE_KEYBOARD, telegramFetch));
      await this.clear();
      return { ok: true, live: null, outcome: 'cancelled' };
    });
  }

  // ───────────────────────── Telegram input (from the webhook) ─────────────────────────

  async callback(cb: LiveCallback): Promise<TelegramReply> {
    const s = await this.serial(() => this.load());
    if (!s || shortId(s.id) !== cb.sid) return { toast: 'This Live Session is over.', clearKeyboard: true };
    const toast = (r: LiveResult, ok?: string): TelegramReply => (r.ok ? { toast: ok } : { toast: r.error });
    const stale = cb.step !== currentStep(s) && !['fin', 'ab', 'aby', 'rf', 'cx', 'rs'].includes(cb.op);
    if (stale) {
      await this.serial(async () => {
        const cur = await this.load();
        if (cur) await this.render(cur);
      });
      return { toast: 'That button was out of date — updated.' };
    }
    switch (cb.op) {
      case 'ok': return toast(await this.log({ step: cb.step === 0 ? 1 : cb.step }), 'Logged');
      case 'sk': return toast(await this.log({ step: cb.step, skip: true }), 'Skipped');
      case 'top': return toast(await this.askTop({ step: cb.step }), 'Save this top set?');
      case 'tpy': {
        const r = await this.confirmTop();
        return r.ok ? { toast: ['Top set logged', ...(r.events ?? [])].join(' · ') } : { toast: r.error };
      }
      case 'tpn': return toast(await this.cancelTop());
      case 'r-': case 'r+': return toast(await this.adjust(cb.step, 'reps', cb.op === 'r+' ? 1 : -1));
      case 'l-': case 'l+': return toast(await this.adjust(cb.step, 'load', cb.op === 'l+' ? 1 : -1));
      case 'wu': return toast(await this.warmupDone(), 'Warm-up done');
      case 'fin': {
        const r = await this.finish();
        return r.ok ? { toast: ['Finished', ...(r.events ?? [])].join(' · ') } : { toast: r.error };
      }
      case 'ab':
        await this.serial(async () => {
          const cur = await this.load();
          if (cur?.messageId != null) {
            await this.tg('confirm', () => editMessageText(this.env, cur.messageId!, liveMessage(cur, Date.now()).text, abandonConfirmKeyboard(cur, cb.step), telegramFetch));
          }
        });
        return { toast: 'Abandon this Live Session?' };
      case 'aby': return toast(await this.abandon(), 'Abandoned');
      case 'cx': return toast(await this.cancel(), 'Cancelled');
      case 'rs': return toast(await this.resume(), 'Resumed');
      case 'rf':
        await this.serial(async () => {
          const cur = await this.load();
          if (cur) await this.render(cur);
        });
        return {};
    }
  }

  /** A typed message (not a command): reply-keyboard texts and set input while a Live Session runs. */
  async typed(text: string): Promise<TelegramReply> {
    const input = parseLiveInput(text);
    const s = await this.serial(() => this.load());
    if (!s) {
      if (input?.kind !== 'key') return { ignored: true };
      const notice = await this.serial(async () => {
        const n = (await this.ctx.storage.get<string>(NOTICE)) ?? null;
        if (n !== null) await this.ctx.storage.delete(NOTICE);
        return n;
      });
      return { reply: notice ?? 'No Live Session is running.', removeKeyboard: true };
    }
    if (!input) return { reply: s.paused ? PAUSED_HINT : INPUT_HINT };
    const setStep = 1 + currentSetIndex(s);
    const reply = (r: LiveResult): TelegramReply => (r.ok ? {} : { reply: esc(r.error) });
    switch (input.kind) {
      case 'key':
        switch (input.key) {
          case 'done': {
            // The reply keyboard carries no step: a second press right after a log is a double tap.
            const last = Math.max(0, ...s.sets.map((x) => x.loggedAt ?? 0));
            if (Date.now() - last < DUPLICATE_MS) return {};
            return reply(await this.log({ step: setStep }));
          }
          case 'rest': return reply(await this.rest(REST_EXTEND_S));
          case 'pause': return reply(await (s.paused ? this.resume() : this.pause()));
          case 'resume': return reply(await this.resume());
          case 'finish': return reply(await this.finish());
        }
        break;
      case 'skip': return reply(await this.log({ step: setStep, skip: true }));
      case 'rpe': return reply(await this.rpe(input.rpe));
      case 'set': {
        const { kind: _k, top, ...rest } = input;
        if (top) {
          // `top 120x5` is confirmed on the Live Session message, like the 🏁 Top set button.
          const r = await this.askTop({ step: setStep, ...rest });
          return r.ok ? { reply: 'Confirm the top set on the Live Session message above.' } : reply(r);
        }
        return reply(await this.log({ step: setStep, ...rest }));
      }
    }
    return {};
  }

  // ───────────────────────── alarm ─────────────────────────

  async alarm(): Promise<void> {
    await this.serial(async () => {
      const now = Date.now();
      const s = await this.load(now); // auto-finishes past local midnight
      if (!s) return;
      if (s.restEndsAt !== null && !s.restPinged && now >= s.restEndsAt && !s.paused) {
        s.restPinged = true;
        await this.dropPing(s);
        s.pingMessageId = (await this.tg('ping', () => sendMessageWithMarkup(this.env, restPingText(s), undefined, telegramFetch))) ?? null;
        await this.render(s);
      }
      await this.save(s);
    });
  }
}

function gymFor(state: PlannerState, id: string | null) {
  return state.gymProfiles.find((g) => g.id === id) ?? state.gymProfiles.find((g) => g.id === state.defaultGymProfileId) ?? state.gymProfiles[0];
}
