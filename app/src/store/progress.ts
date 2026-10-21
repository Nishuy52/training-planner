// D1 access for progress tracking: Training Max history, Benchmark Results and the Check-ins Adherence counts.
import type { ISODate, Lift, SessionRef } from '../domain/types';
import { activityBenchmarkTime, type ActivityTiming, type BenchmarkEntry, type BenchmarkInput, type BenchmarkKind } from '../domain/benchmark';
import type { CheckIn } from '../domain/adherence';
import { refKey } from '../domain/planner';

// ───────────────────────── Training Max history ─────────────────────────

export type TmReason = 'cycle' | 'test' | 'manual';
export type TmSnapshot = { date: ISODate; lift: Lift; tm: number; reason: TmReason };

export async function insertTmSnapshots(db: D1Database, snaps: TmSnapshot[]): Promise<void> {
  if (!snaps.length) return;
  await db.batch(snaps.map((s) => db.prepare('INSERT INTO tm_history (date, lift, tm, reason) VALUES (?, ?, ?, ?)').bind(s.date, s.lift, s.tm, s.reason)));
}

/** Snapshots dated `from`..`to` (inclusive), oldest first. */
export async function listTmHistory(db: D1Database, from: ISODate, to: ISODate): Promise<TmSnapshot[]> {
  const { results } = await db.prepare('SELECT date, lift, tm, reason FROM tm_history WHERE date >= ? AND date <= ? ORDER BY date, id').bind(from, to).all<TmSnapshot>();
  return results;
}

// ───────────────────────── Benchmark Results ─────────────────────────

type BenchRow = { id: number; date: ISODate; kind: BenchmarkKind; event_id: string | null; time_s: number | null; grade: string | null; minutes: number | null; auto: number };

const toEntry = (r: BenchRow): BenchmarkEntry => {
  const e: BenchmarkEntry = { id: r.id, date: r.date, kind: r.kind };
  if (r.event_id !== null) e.eventId = r.event_id;
  if (r.time_s !== null) e.timeS = r.time_s;
  if (r.grade !== null) e.grade = r.grade;
  if (r.minutes !== null) e.minutes = r.minutes;
  if (r.auto) e.auto = true;
  return e;
};

const resultCols = (r: BenchmarkInput | undefined) =>
  !r ? [null, null, null] : 'timeS' in r ? [r.timeS, null, null] : [null, r.grade, r.minutes];

/** Records a Benchmark Session done, with its result when given (`auto`: taken from the synced Activity). Returns the new row id. */
export async function insertBenchmark(
  db: D1Database, date: ISODate, kind: BenchmarkKind, eventId: string | undefined, result?: BenchmarkInput, auto = false,
): Promise<number> {
  const row = await db.prepare('INSERT INTO benchmark_results (date, kind, event_id, time_s, grade, minutes, auto, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id')
    .bind(date, kind, eventId ?? null, ...resultCols(result), result && auto ? 1 : 0, new Date().toISOString()).first<{ id: number }>();
  return row!.id;
}

/** Sets a result given by hand; it replaces one taken from the watch. */
export async function setBenchmarkResult(db: D1Database, id: number, result: BenchmarkInput): Promise<void> {
  await db.prepare('UPDATE benchmark_results SET time_s = ?, grade = ?, minutes = ?, auto = 0, updated_at = ? WHERE id = ?')
    .bind(...resultCols(result), new Date().toISOString(), id).run();
}

export async function getBenchmark(db: D1Database, id: number): Promise<BenchmarkEntry | null> {
  const r = await db.prepare('SELECT * FROM benchmark_results WHERE id = ?').bind(id).first<BenchRow>();
  return r ? toEntry(r) : null;
}

/**
 * The most recent Benchmark Session of one of `kinds` done without a result (optionally on `date`). With `orAuto`,
 * one whose time was taken from the watch counts too, so a manual result corrects it.
 */
export async function latestPendingBenchmark(db: D1Database, kinds: BenchmarkKind[], date?: ISODate, opts: { orAuto?: boolean } = {}): Promise<BenchmarkEntry | null> {
  const open = `((time_s IS NULL AND grade IS NULL)${opts.orAuto ? ' OR auto = 1' : ''})`;
  const r = await db.prepare(
    `SELECT * FROM benchmark_results WHERE ${open} AND kind IN (${kinds.map(() => '?').join(',')})${date ? ' AND date = ?' : ''} ORDER BY date DESC, id DESC LIMIT 1`,
  ).bind(...kinds, ...(date ? [date] : [])).first<BenchRow>();
  return r ? toEntry(r) : null;
}

/** Benchmark Sessions dated `from`..`to` (inclusive), newest first; `withResult` leaves out the ones still without a result. */
export async function listBenchmarks(db: D1Database, from: ISODate, to: ISODate, opts: { withResult?: boolean } = {}, limit = 500): Promise<BenchmarkEntry[]> {
  const { results } = await db.prepare(
    `SELECT * FROM benchmark_results WHERE date >= ? AND date <= ?${opts.withResult ? ' AND (time_s IS NOT NULL OR grade IS NOT NULL)' : ''} ORDER BY date DESC, id DESC LIMIT ?`,
  ).bind(from, to, limit).all<BenchRow>();
  return results.map(toEntry);
}

// ───────────────────────── Check-ins (for Adherence) ─────────────────────────

/**
 * Done and skipped Sessions dated `from`..`to` from the action log: Done, TM Test results and Sessions an Activity
 * completed (`activity-credit`), plus Skips. `recentDone` (the state's `doneByDate`) fills in what the log misses;
 * duplicates (same date and Session) count once.
 */
export async function listCheckIns(db: D1Database, from: ISODate, to: ISODate, recentDone: Record<ISODate, SessionRef[]>): Promise<CheckIn[]> {
  const { results } = await db.prepare(
    "SELECT json FROM action_log WHERE json_extract(json, '$.type') IN ('done', 'skip', 'test-result', 'activity-credit') AND json_extract(json, '$.date') BETWEEN ? AND ? ORDER BY id",
  ).bind(from, to).all<{ json: string }>();
  const out: CheckIn[] = [];
  const seen = new Set<string>();
  const add = (date: ISODate, ref: SessionRef, status: CheckIn['status']) => {
    const k = `${status}|${date}|${refKey(ref)}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push({ date, ref, status });
  };
  for (const { json } of results) {
    const a = JSON.parse(json) as { type: string; date: ISODate; ref?: SessionRef; refs?: SessionRef[]; lift?: Lift; correct?: boolean };
    if (a.type === 'done' && a.ref) add(a.date, a.ref, 'done');
    else if (a.type === 'skip' && a.ref) add(a.date, a.ref, 'skipped');
    else if (a.type === 'test-result' && a.lift && !a.correct) add(a.date, { kind: 'lift-test', lift: a.lift }, 'done');
    else if (a.type === 'activity-credit') for (const r of a.refs ?? []) add(a.date, r, 'done');
  }
  for (const [date, refs] of Object.entries(recentDone)) {
    if (date < from || date > to) continue;
    for (const r of refs) add(date, r, 'done');
  }
  return out;
}

// ───────────────────────── Activity time for a run Benchmark ─────────────────────────

/** The time of a synced run on `date` that looks like this Benchmark (newest first); see `activityBenchmarkTime`. */
export async function benchmarkActivityTime(db: D1Database, date: ISODate, kind: '2k4' | 'hill'): Promise<number | null> {
  const { results } = await db.prepare("SELECT json FROM activities WHERE date = ? AND source = 'intervals' ORDER BY rowid DESC").bind(date).all<{ json: string }>();
  for (const { json } of results) {
    const t = activityBenchmarkTime(kind, JSON.parse(json) as ActivityTiming);
    if (t !== null) return t;
  }
  return null;
}

/** A stored Activity row's data (sport, km, hours, movingS, elapsedS, ...), or null. */
export async function activityData(db: D1Database, id: string): Promise<ActivityTiming | null> {
  const row = await db.prepare('SELECT json FROM activities WHERE id = ?').bind(id).first<{ json: string }>();
  return row ? (JSON.parse(row.json) as ActivityTiming) : null;
}
