import type { ClubEvent, Constraint, ISODate, Lift, PlanComment, PlannerState } from '../domain/types';
import { addDays, mondayOf } from '../domain/dates';
import { DEFAULT_HOME_LOCATION } from '../domain/constraints';
import type { Route, RouteAssignment } from '../domain/routes';
import { healTestWeekTms } from '../domain/actions';

/** Persisted part of the planner state: constraints and clubEvents live in their own tables. */
type StoredState = Omit<PlannerState, 'constraints' | 'clubEvents'>;

/** The state row written on first load. Running starts the Monday of the current week (UTC), so a new install begins at week 0. */
export function defaultState(now: Date = new Date()): StoredState {
  return {
    tms: { squat: 0, bench: 0, deadlift: 0, ohp: 0 },
    lift: { week: 1, index: 0, phase: { kind: 'normal' } },
    run: { nextQuality: 'vert', nextBenchmark: '2k4', runStartMonday: mondayOf(now.toISOString().slice(0, 10)) },
    ruck: { step: 0 },
    rucksEnabled: false,
    runsThisWeek: {},
    doneByDate: {},
    defaultWeek: {
      0: { am: 'lift' }, 1: { am: 'run' }, 2: { am: 'run' }, 3: { am: 'lift' },
      4: {}, 5: { am: 'run-long' }, 6: { am: 'lift' },
    },
    gymProfiles: [
      { id: 'home-gym', name: 'Home Gym', plateStepKg: 2.5, machineLifts: [], hasBands: true },
      { id: 'travel-gym', name: 'Travel gym', plateStepKg: 2.5, machineLifts: ['bench', 'ohp'], machineStepLb: 10, machineMaxLb: 200, hasBands: false },
    ],
    defaultGymProfileId: 'home-gym',
    defaultTimezone: 'Europe/Berlin',
    homeLocation: DEFAULT_HOME_LOCATION,
  };
}

const parseRows = <T>(rows: { json: string }[]): T[] => rows.map((r) => JSON.parse(r.json) as T);

/** A fresh version stamp for the state row's `updated_at`: ISO time plus a random suffix, so two writes never share one. */
const newVersion = (): string => `${new Date().toISOString()}#${crypto.randomUUID().slice(0, 8)}`;

/** The planner state plus its version (`state.updated_at`), for an optimistic-concurrency write. */
export async function loadPlannerStateVersioned(db: D1Database): Promise<{ state: PlannerState; version: string }> {
  let row = await db.prepare('SELECT json, updated_at FROM state WHERE id = 1').first<{ json: string; updated_at: string }>();
  if (!row) {
    // INSERT OR IGNORE so concurrent first loads can't clobber each other.
    await db.prepare('INSERT OR IGNORE INTO state (id, json, updated_at) VALUES (1, ?, ?)')
      .bind(JSON.stringify(defaultState()), newVersion()).run();
    row = (await db.prepare('SELECT json, updated_at FROM state WHERE id = 1').first<{ json: string; updated_at: string }>())!;
  }
  const [cs, es] = await db.batch<{ json: string }>([
    db.prepare("SELECT json FROM constraints ORDER BY json_extract(json, '$.start'), id"),
    db.prepare('SELECT json FROM club_events ORDER BY date, id'),
  ]);
  const stored = JSON.parse(row.json) as Omit<StoredState, 'rucksEnabled' | 'homeLocation'> & { rucksEnabled?: boolean; homeLocation?: string };
  const state: PlannerState = {
    ...stored,
    rucksEnabled: stored.rucksEnabled ?? false, // absent in state stored before the setting existed
    homeLocation: stored.homeLocation ?? DEFAULT_HOME_LOCATION, // likewise
    constraints: parseRows<Constraint>(cs.results),
    clubEvents: parseRows<ClubEvent>(es.results),
  };
  return { state, version: row.updated_at };
}

/** The planner state, after `healStoredTestWeekTms` when a Test Week result is still missing its Training Max. */
export async function loadPlannerState(db: D1Database): Promise<PlannerState> {
  const { state } = await loadPlannerStateVersioned(db);
  const healed = structuredClone(state);
  if (!healTestWeekTms(healed).length) return state;
  try {
    return await healStoredTestWeekTms(db);
  } catch (err) {
    // A read must never fail because the one-time heal lost its write races: serve the healed view;
    // the next load or action persists it.
    console.error('test-week TM heal deferred:', err instanceof Error ? err.message : String(err));
    return healed;
  }
}

/**
 * One-time self-heal for TM Test results logged before each result set its Training Max (spec §2): persists
 * `healTestWeekTms` through the normal state write, with a 'test' TM snapshot per healed lift in the same batch
 * (dated the day the TM Test was done). Idempotent: once healed (or when a concurrent heal won) it writes nothing.
 * Returns the current state.
 */
export async function healStoredTestWeekTms(db: D1Database): Promise<PlannerState> {
  return updateStateWithRetry(db, (current, version) => {
    const next = structuredClone(current);
    const lifts = healTestWeekTms(next);
    if (!lifts.length) return { result: current };
    const testDate = (lift: Lift): ISODate =>
      Object.keys(next.doneByDate).sort().find((d) => next.doneByDate[d]!.some((r) => r.kind === 'lift-test' && r.lift === lift))
      ?? next.testWeek!.dates[lift];
    const also = lifts.map((lift) => db.prepare(`INSERT INTO tm_history (date, lift, tm, reason) SELECT ?, ?, ?, 'test' WHERE ${IF_COMMITTED}`)
      .bind(testDate(lift), lift, next.tms[lift], version));
    return { state: next, also, result: next };
  });
}

const storedJson = (s: PlannerState): string => {
  const { constraints: _c, clubEvents: _e, ...rest } = s;
  return JSON.stringify(rest);
};

/** Unconditional write (seeding and tests). App code writes through `updateStateWithRetry`. */
export async function savePlannerState(db: D1Database, s: PlannerState): Promise<void> {
  await db.prepare(
    'INSERT INTO state (id, json, updated_at) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at',
  ).bind(storedJson(s), newVersion()).run();
}

export class StateConflict extends Error {
  constructor() { super('state write conflict: gave up after repeated concurrent updates'); }
}

const MAX_STATE_ATTEMPTS = 5;

/** SQL condition true only once the state write stamped with the bound version has committed. */
const IF_COMMITTED = '(SELECT updated_at FROM state WHERE id = 1) = ?';

/**
 * What one attempt of `updateStateWithRetry` decided. Without `state` nothing is written and `result` is returned.
 * `also` runs in the same batch (one transaction) after the state write; build each with an `...IfCommitted` helper
 * and this attempt's `version`, so it only takes effect when this attempt's state write did.
 */
export type StateUpdate<T> = { result: T; state?: PlannerState; also?: D1PreparedStatement[] };

/**
 * The one way app code changes the state row: optimistic concurrency on `updated_at`. Loads the state, lets `fn`
 * derive the next one, then writes it only if no one else wrote in between; on a conflict it reloads and calls `fn`
 * again (at most 5 attempts, then StateConflict). `fn` must not have side effects outside `also`: it may run again.
 * Errors thrown by `fn` propagate unchanged.
 */
export async function updateStateWithRetry<T>(
  db: D1Database,
  fn: (current: PlannerState, version: string) => StateUpdate<T> | Promise<StateUpdate<T>>,
): Promise<T> {
  for (let attempt = 0; attempt < MAX_STATE_ATTEMPTS; attempt++) {
    const { state: current, version: was } = await loadPlannerStateVersioned(db);
    const version = newVersion();
    const u = await fn(current, version);
    if (!u.state) return u.result;
    const [write] = await db.batch([
      db.prepare('UPDATE state SET json = ?, updated_at = ? WHERE id = 1 AND updated_at = ?').bind(storedJson(u.state), version, was),
      ...(u.also ?? []),
    ]);
    if (write!.meta.changes > 0) return u.result;
  }
  throw new StateConflict();
}

/** `setKV`, applied only if the state write stamped `version` committed (for `StateUpdate.also`). */
export function setKVIfCommitted(db: D1Database, key: string, value: string, version: string): D1PreparedStatement {
  return db.prepare(`INSERT INTO kv (key, value) SELECT ?, ? WHERE ${IF_COMMITTED} ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
    .bind(key, value, version);
}

export async function upsertConstraint(db: D1Database, c: Constraint): Promise<void> {
  await db.prepare('INSERT INTO constraints (id, json) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json')
    .bind(c.id, JSON.stringify(c)).run();
}
export async function deleteConstraint(db: D1Database, id: string): Promise<void> {
  await db.prepare('DELETE FROM constraints WHERE id = ?').bind(id).run();
}
export async function upsertClubEvent(db: D1Database, e: ClubEvent): Promise<void> {
  await db.prepare('INSERT INTO club_events (id, date, json) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET date = excluded.date, json = excluded.json')
    .bind(e.id, e.date, JSON.stringify(e)).run();
}
export async function deleteClubEvent(db: D1Database, id: string): Promise<void> {
  await db.prepare('DELETE FROM club_events WHERE id = ?').bind(id).run();
}

export async function listRoutes(db: D1Database): Promise<Route[]> {
  const { results } = await db.prepare("SELECT json FROM routes ORDER BY json_extract(json, '$.name'), id").all<{ json: string }>();
  return parseRows<Route>(results);
}
export async function upsertRoute(db: D1Database, r: Route): Promise<void> {
  await db.prepare('INSERT INTO routes (id, json) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json')
    .bind(r.id, JSON.stringify(r)).run();
}
/** Removes the Route and every assignment to it, in one transaction. */
export async function deleteRoute(db: D1Database, id: string): Promise<void> {
  await db.batch([
    db.prepare('DELETE FROM route_assignments WHERE route_id = ?').bind(id),
    db.prepare('DELETE FROM routes WHERE id = ?').bind(id),
  ]);
}

/** Route Assignments dated `from`..`to` inclusive, by date. */
export async function listRouteAssignments(db: D1Database, from: ISODate, to: ISODate): Promise<RouteAssignment[]> {
  const { results } = await db.prepare(
    'SELECT date, run_kind AS runKind, route_id AS routeId FROM route_assignments WHERE date >= ? AND date <= ? ORDER BY date, run_kind',
  ).bind(from, to).all<RouteAssignment>();
  return results;
}

/** Sets (routeId) or clears (null) each (date, runKind) assignment, in one transaction. */
export async function putRouteAssignments(db: D1Database, list: Array<Omit<RouteAssignment, 'routeId'> & { routeId: string | null }>): Promise<void> {
  if (list.length === 0) return;
  await db.batch(list.map((a) => (a.routeId === null
    ? db.prepare('DELETE FROM route_assignments WHERE date = ? AND run_kind = ?').bind(a.date, a.runKind)
    : db.prepare('INSERT INTO route_assignments (date, run_kind, route_id) VALUES (?, ?, ?) ON CONFLICT(date, run_kind) DO UPDATE SET route_id = excluded.route_id')
      .bind(a.date, a.runKind, a.routeId))));
}

export type CommentFilter = { from?: ISODate; to?: ISODate; status?: PlanComment['status'] };

/** Comments by date then createdAt, filtered by an inclusive date range and status. */
export async function listComments(db: D1Database, f: CommentFilter = {}, limit = 500): Promise<PlanComment[]> {
  const where: string[] = [];
  const args: unknown[] = [];
  if (f.from !== undefined) { where.push('date >= ?'); args.push(f.from); }
  if (f.to !== undefined) { where.push('date <= ?'); args.push(f.to); }
  if (f.status !== undefined) { where.push("json_extract(json, '$.status') = ?"); args.push(f.status); }
  const sql = `SELECT json FROM comments${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY date, json_extract(json, '$.createdAt'), id LIMIT ?`;
  const { results } = await db.prepare(sql).bind(...args, limit).all<{ json: string }>();
  return parseRows<PlanComment>(results);
}
export async function getComment(db: D1Database, id: string): Promise<PlanComment | null> {
  const row = await db.prepare('SELECT json FROM comments WHERE id = ?').bind(id).first<{ json: string }>();
  return row ? (JSON.parse(row.json) as PlanComment) : null;
}
export async function upsertComment(db: D1Database, c: PlanComment): Promise<void> {
  await db.prepare('INSERT INTO comments (id, date, json) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET date = excluded.date, json = excluded.json')
    .bind(c.id, c.date, JSON.stringify(c)).run();
}
export async function deleteComment(db: D1Database, id: string): Promise<void> {
  await db.prepare('DELETE FROM comments WHERE id = ?').bind(id).run();
}

export type ActivitySource = 'intervals' | 'telegram';

/** Records an Activity once. Returns true only if this call newly inserted it (the dedupe claim). */
export async function insertActivity(db: D1Database, id: string, date: ISODate, source: ActivitySource, data: Record<string, unknown>): Promise<boolean> {
  const r = await db.prepare('INSERT OR IGNORE INTO activities (id, date, source, json) VALUES (?, ?, ?, ?)')
    .bind(id, date, source, JSON.stringify(data)).run();
  return r.meta.changes > 0;
}

/**
 * Activity rows claimed by the sync but not yet credited (`credited: false`), oldest first, so the next sync can
 * finish them. Rows without the flag (Telegram `/log`, or synced before it existed) are never returned.
 */
export async function listUncreditedActivities(db: D1Database, limit = 100): Promise<Array<{ id: string; date: ISODate; data: Record<string, unknown> }>> {
  const { results } = await db.prepare(
    "SELECT id, date, json FROM activities WHERE json_extract(json, '$.credited') = 0 ORDER BY date, rowid LIMIT ?",
  ).bind(limit).all<{ id: string; date: ISODate; json: string }>();
  return results.map((r) => ({ id: r.id, date: r.date, data: JSON.parse(r.json) as Record<string, unknown> }));
}

/** True when the Activity row is still waiting to be credited (`credited: false`). */
export async function isActivityUncredited(db: D1Database, id: string): Promise<boolean> {
  const row = await db.prepare("SELECT json_extract(json, '$.credited') AS c FROM activities WHERE id = ?").bind(id).first<{ c: number | null }>();
  return row?.c === 0;
}

/** Sets `credited: true` on the Activity row, only if the state write stamped `version` committed (for `StateUpdate.also`). */
export function markActivityCreditedIfCommitted(db: D1Database, id: string, version: string): D1PreparedStatement {
  return db.prepare(`UPDATE activities SET json = json_set(json, '$.credited', json('true')) WHERE id = ? AND ${IF_COMMITTED}`)
    .bind(id, version);
}

/** A new `/log` Activity id, `log:<date>:<random>`: unique without reading the table, so two logs never collide. */
export function newLogActivityId(date: ISODate): string {
  return `log:${date}:${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

export type ActivityEntry = { date: ISODate; source: ActivitySource; name: string; sport: string; km?: number; vertM?: number; hours?: number; load?: number };

/**
 * Activities on or after `from`, newest first. A `/log` hike on a day that also has a synced intervals.icu hike is
 * the same hike logged twice, so it is left out (the weekly totals count the watch-recorded one).
 */
export async function listActivities(db: D1Database, from: ISODate, limit = 500): Promise<ActivityEntry[]> {
  const { results } = await db.prepare(
    `SELECT a.date, a.source, a.json FROM activities a
     WHERE a.date >= ?
       AND NOT (a.source = 'telegram' AND json_extract(a.json, '$.sport') = 'hike' AND EXISTS (
         SELECT 1 FROM activities i WHERE i.date = a.date AND i.source = 'intervals' AND json_extract(i.json, '$.sport') = 'hike'))
     ORDER BY a.date DESC, a.rowid DESC LIMIT ?`,
  ).bind(from, limit).all<{ date: ISODate; source: ActivitySource; json: string }>();
  return results.map((r) => {
    const { credited: _c, ...data } = JSON.parse(r.json) as Omit<ActivityEntry, 'date' | 'source'> & { credited?: boolean };
    return { ...data, date: r.date, source: r.source };
  });
}

export async function appendActionLog(db: D1Database, action: unknown): Promise<void> {
  await db.prepare('INSERT INTO action_log (at, json) VALUES (?, ?)').bind(new Date().toISOString(), JSON.stringify(action)).run();
}

/** Inserts a lift_log row; resolves to its id. */
export async function logLift(db: D1Database, date: ISODate, lift: Lift, data: Record<string, unknown>): Promise<number> {
  const r = await db.prepare('INSERT INTO lift_log (date, lift, json) VALUES (?, ?, ?)').bind(date, lift, JSON.stringify(data)).run();
  return r.meta.last_row_id;
}

export async function getLiftLog(db: D1Database, id: number): Promise<Record<string, unknown> | null> {
  const row = await db.prepare('SELECT json FROM lift_log WHERE id = ?').bind(id).first<{ json: string }>();
  return row ? (JSON.parse(row.json) as Record<string, unknown>) : null;
}

/** lift_log rows for one date and lift, oldest first. */
export async function liftLogsFor(db: D1Database, date: ISODate, lift: Lift): Promise<Array<{ id: number } & Record<string, unknown>>> {
  const { results } = await db.prepare('SELECT id, json FROM lift_log WHERE date = ? AND lift = ? ORDER BY id').bind(date, lift).all<{ id: number; json: string }>();
  return results.map((r) => ({ ...(JSON.parse(r.json) as Record<string, unknown>), id: r.id }));
}

export async function deleteLiftLog(db: D1Database, id: number): Promise<void> {
  await db.prepare('DELETE FROM lift_log WHERE id = ?').bind(id).run();
}

/** Replaces a lift_log row's json (a Live Session's row is rewritten as each set is logged). */
export async function updateLiftLog(db: D1Database, id: number, data: Record<string, unknown>): Promise<void> {
  await db.prepare('UPDATE lift_log SET json = ? WHERE id = ?').bind(JSON.stringify(data), id).run();
}

/** Most recent logged FSL weight (kg) for the lift, or null if none. */
export async function lastFslWeight(db: D1Database, lift: Lift): Promise<number | null> {
  const row = await db.prepare(
    "SELECT json_extract(json, '$.fslWeightKg') AS w FROM lift_log WHERE lift = ? AND json_extract(json, '$.fslWeightKg') IS NOT NULL" +
      // In-progress, abandoned and not-counted Live Session rows never set the next FSL Prescription.
      " AND json_extract(json, '$.live') IS NOT 1 AND json_extract(json, '$.abandoned') IS NOT 1 AND json_extract(json, '$.notCounted') IS NOT 1" +
      ' ORDER BY date DESC, id DESC LIMIT 1',
  ).bind(lift).first<{ w: number }>();
  return row ? row.w : null;
}

export async function markMobility(db: D1Database, date: ISODate, status: 'done' | 'skipped'): Promise<void> {
  await db.prepare('INSERT INTO mobility_log (date, status) VALUES (?, ?) ON CONFLICT(date) DO UPDATE SET status = excluded.status')
    .bind(date, status).run();
}

/**
 * Consecutive 'done' nights ending at upToDate. If upToDate has no entry yet
 * (tonight's routine not logged), counting starts from the day before.
 */
export async function mobilityStreak(db: D1Database, upToDate: ISODate): Promise<number> {
  const { results } = await db.prepare('SELECT date, status FROM mobility_log WHERE date <= ? ORDER BY date DESC LIMIT 400')
    .bind(upToDate).all<{ date: ISODate; status: string }>();
  const byDate = new Map(results.map((r) => [r.date, r.status]));
  let d = byDate.has(upToDate) ? upToDate : addDays(upToDate, -1);
  let n = 0;
  while (byDate.get(d) === 'done') { n++; d = addDays(d, -1); }
  return n;
}

export async function wasSent(db: D1Database, kind: string, localDate: ISODate): Promise<boolean> {
  return (await db.prepare('SELECT 1 AS x FROM sent_reminders WHERE kind = ? AND local_date = ?').bind(kind, localDate).first()) !== null;
}

/** Returns true only if this call newly recorded the reminder. */
export async function markSent(db: D1Database, kind: string, localDate: ISODate): Promise<boolean> {
  const r = await db.prepare('INSERT OR IGNORE INTO sent_reminders (kind, local_date) VALUES (?, ?)').bind(kind, localDate).run();
  return r.meta.changes > 0;
}

/** Undo markSent after a failed send, so the next cron tick retries. */
export async function unmarkSent(db: D1Database, kind: string, localDate: ISODate): Promise<void> {
  await db.prepare('DELETE FROM sent_reminders WHERE kind = ? AND local_date = ?').bind(kind, localDate).run();
}

export async function getKV(db: D1Database, key: string): Promise<string | null> {
  const row = await db.prepare('SELECT value FROM kv WHERE key = ?').bind(key).first<{ value: string }>();
  return row ? row.value : null;
}
export async function setKV(db: D1Database, key: string, value: string): Promise<void> {
  await db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind(key, value).run();
}
