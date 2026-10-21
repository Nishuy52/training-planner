// Reminder cron (every 5 min): sends each due reminder once per local date (spec §7).
import type { Env } from './index';
import type { PlannerState } from './domain/types';
import { addDays, localNow } from './domain/dates';
import { dayContext } from './domain/constraints';
import { dueReminders, type ReminderKind } from './domain/reminders';
import { loadPlannerState, markSent, unmarkSent, wasSent } from './store/db';
import { planWithDetails } from './http/api';
import { sendMessage, type InlineKeyboard } from './telegram/client';
import { mobilityMessage, morningMessage, previewMessage } from './telegram/format';
import { safeError, telegramFetch } from './telegram/webhook';

const KINDS: ReminderKind[] = ['morning', 'preview', 'mobility'];

async function buildMessage(db: D1Database, state: PlannerState, kind: ReminderKind, date: string): Promise<{ text: string; keyboard?: InlineKeyboard }> {
  switch (kind) {
    case 'morning': {
      const { days, details } = await planWithDetails(db, state, date, 1);
      const m = morningMessage(days[0]!, details[date] ?? []);
      return { text: m.text, keyboard: m.keyboard.length ? m.keyboard : undefined };
    }
    case 'preview': {
      // Sunday evening: the coming week, Monday onwards.
      const { days, details } = await planWithDetails(db, state, addDays(date, 1), 7);
      return previewMessage(days, details);
    }
    case 'mobility': {
      const { days } = await planWithDetails(db, state, date, 1);
      return mobilityMessage(days[0]!);
    }
  }
}

export async function runReminders(env: Env, instant: Date): Promise<ReminderKind[]> {
  const db = env.DB;
  const state = await loadPlannerState(db);
  const tz = dayContext(state, localNow(instant, state.defaultTimezone).date).timezone;
  const now = localNow(instant, tz);

  // dueReminders takes a sync checker, so fetch what has been sent today first.
  const sentFlags = await Promise.all(KINDS.map((k) => wasSent(db, k, now.date)));
  const sent = new Set(KINDS.filter((_, i) => sentFlags[i]));

  const delivered: ReminderKind[] = [];
  for (const kind of dueReminders(now, (k) => sent.has(k))) {
    // Claim first: only the tick that newly records the row sends, so overlapping crons can't double-send.
    if (!(await markSent(db, kind, now.date))) continue;
    try {
      const m = await buildMessage(db, state, kind, now.date);
      await sendMessage(env, m.text, m.keyboard, telegramFetch);
      delivered.push(kind);
    } catch (err) {
      await unmarkSent(db, kind, now.date); // let the next tick retry
      console.error(`reminder ${kind} for ${now.date} failed:`, safeError(env, err));
    }
  }
  return delivered;
}
