// intervals.icu Activity sync (spec §5): credits watch-recorded runs, hikes and climbs at most hourly from the cron,
// or on demand from POST /api/sync. Each Activity is credited once (deduped by its id in the activities table).
import type { Env } from './index';
import type { ISODate } from './domain/types';
import { addDays } from './domain/dates';
import { mapIcuActivity, type MappedActivity } from './domain/activityMap';
import { countedAs } from './domain/credit';
import { BENCHMARK_LABEL, formatTime } from './domain/benchmark';
import { fetchActivities, intervalsFetch } from './integrations/intervals';
import { getKV, insertActivity, listUncreditedActivities, loadPlannerState, setKV } from './store/db';
import { creditActivity, todayFor } from './http/api';
import { sendMessage } from './telegram/client';
import { esc, strengthNudge } from './telegram/format';
import { planDays } from './domain/planner';
import { safeError, telegramFetch } from './telegram/webhook';

const LAST_SYNC_KEY = 'intervalsLastSyncAt';
const MIN_INTERVAL_MS = 55 * 60_000;
/** Every sync looks back this far, so Activities uploaded days late (after a trip) are still found; dedupe skips repeats. */
const LOOKBACK_DAYS = 14;

export type SyncResult = { synced: number; notices: string[]; skipped?: 'off' | 'recent'; error?: string };

type Mapped = NonNullable<MappedActivity>;
type Pending = { id: string; date: ISODate; name: string; activity: Omit<Mapped['activity'], 'sport'> & { sport: Exclude<Mapped['activity']['sport'], 'strength'> } };

/** Activity names longer than this are cut in the notice. */
const MAX_NAME = 60;
/** Telegram caps a message at 4096 characters; keep the batch notice well under it. */
const MAX_MESSAGE = 3500;

const shortName = (name: string) => (name.length > MAX_NAME ? `${name.slice(0, MAX_NAME - 1)}…` : name);

/** `⌚ Synced: "Ridge hike" (8 km · 600 m ↑) → Hill Ruck credit + Long run` (HTML-escaped for Telegram). */
function notice(p: Pending, counted: string[], late: boolean): string {
  const { km, vertM, hours } = p.activity;
  const parts = [km !== undefined ? `${km} km` : '', vertM !== undefined ? `${vertM} m ↑` : ''].filter(Boolean);
  if (!parts.length && hours !== undefined) parts.push(`${hours} h`);
  const what = parts.length ? ` (${parts.join(' · ')})` : '';
  const outcome = counted.length ? counted.join(' + ') : 'logged';
  return `⌚ Synced: "${esc(shortName(p.name))}"${what} → ${outcome}${late ? ' (late)' : ''}`;
}

/** One Telegram message for the batch: as many notices as fit under MAX_MESSAGE, then `+N more`. */
function batchMessage(notices: string[]): string {
  const reserve = `\n+${notices.length} more`.length;
  const out: string[] = [];
  let len = 0;
  for (const [i, n] of notices.entries()) {
    const add = (out.length ? 1 : 0) + n.length;
    if (len + add + (i === notices.length - 1 ? 0 : reserve) > MAX_MESSAGE) break;
    out.push(n);
    len += add;
  }
  const rest = notices.length - out.length;
  return [...out, ...(rest ? [`+${rest} more`] : [])].join('\n');
}

/** A claimed row back into the activity payload (the row stores `{ name, ...activity, movingS?, elapsedS?, credited }`). */
function fromRow(r: { id: string; date: ISODate; data: Record<string, unknown> }): Pending {
  const { name, credited: _c, movingS: _m, elapsedS: _e, ...activity } = r.data;
  return { id: r.id, date: r.date, name: String(name ?? 'Activity'), activity: activity as Pending['activity'] };
}

/** Telegram nudge for a strength Activity synced today while a lift Session or TM Test is still planned. Never throws. */
async function nudgeLift(env: Env, today: ISODate): Promise<void> {
  try {
    const s = planDays(await loadPlannerState(env.DB), today, 1)[0]!.sessions.find((x) => x.status === 'planned' && (x.kind === 'lift' || x.kind === 'lift-test'));
    if (!s || (s.kind !== 'lift' && s.kind !== 'lift-test')) return;
    const n = strengthNudge(today, s);
    await sendMessage(env, n.text, n.keyboard, telegramFetch);
  } catch (err) {
    console.error('intervals sync nudge failed:', safeError(env, err));
  }
}

/**
 * Fetch recent intervals.icu Activities and credit the new ones. Never throws: failures are logged (without
 * secrets) and returned as `error`, so the cron's reminders are unaffected. `force` skips the 55-minute gate.
 *
 * Crediting is two steps: claim (insert the row with `credited: false`; only one caller wins), then credit (the state
 * change and `credited: true` in one write). A failure in between leaves the row claimed but uncredited; every sync
 * first finishes those, oldest first.
 */
export async function runIntervalsSync(env: Env, now: Date, opts: { force?: boolean } = {}): Promise<SyncResult> {
  const result: SyncResult = { synced: 0, notices: [] };
  if (!env.INTERVALS_API_KEY) return { ...result, skipped: 'off' };
  const db = env.DB;
  try {
    const last = await getKV(db, LAST_SYNC_KEY);
    if (!opts.force && last && now.getTime() - Date.parse(last) < MIN_INTERVAL_MS) return { ...result, skipped: 'recent' };

    const today = todayFor(await loadPlannerState(db), now);
    const credit = async (p: Pending) => {
      const late = p.date < today;
      const out = await creditActivity(db, p.id, { type: 'activity', date: p.date, today, activity: p.activity });
      if (!out) return; // already credited (a concurrent sync got there first)
      result.synced++;
      const bench = out.benchmarkAuto
        ? ` · ${BENCHMARK_LABEL[out.benchmarkAuto.kind]} Benchmark: ${formatTime(out.benchmarkAuto.timeS)} (from watch) · /bench mm:ss to correct`
        : '';
      result.notices.push(notice(p, countedAs(out.before, out.state, p.date, { late }), late) + bench);
    };

    for (const row of await listUncreditedActivities(db)) await credit(fromRow(row));

    const raw = await fetchActivities(env, addDays(today, -LOOKBACK_DAYS), today, intervalsFetch);
    const mapped = raw
      .map((a) => {
        const m = mapIcuActivity(a);
        if (!m) console.log(`intervals sync: ignored activity type=${a.type ?? ''} name=${(a.name ?? '').slice(0, 40)}`);
        return { start: a.start_date_local ?? '', m };
      })
      .filter((x): x is { start: string; m: Mapped } => x.m !== null)
      .sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));

    for (const { m } of mapped) {
      if (m.activity.sport === 'strength') {
        // Never credits a lift: stored as already credited (listed, never retried); one nudge per newly claimed Activity.
        if (await insertActivity(db, m.externalId, m.date, 'intervals', { name: m.name, ...m.activity, ...m.timing, credited: true }) && m.date === today) await nudgeLift(env, today);
        continue;
      }
      // Claim first: only the call that newly records the id credits it, so overlapping runs can't double-credit.
      if (!(await insertActivity(db, m.externalId, m.date, 'intervals', { name: m.name, ...m.activity, ...m.timing, credited: false }))) continue;
      await credit({ id: m.externalId, date: m.date, name: m.name, activity: m.activity as Pending['activity'] });
    }
    await setKV(db, LAST_SYNC_KEY, now.toISOString());
  } catch (err) {
    result.error = safeError(env, err);
    console.error('intervals sync failed:', result.error);
  }

  // Report whatever was credited, even if a later step failed.
  if (result.notices.length) {
    try {
      await sendMessage(env, batchMessage(result.notices), undefined, telegramFetch);
    } catch (err) {
      console.error('intervals sync notice failed:', safeError(env, err));
    }
  }
  return result;
}
