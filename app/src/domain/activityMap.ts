import type { ISODate } from './types';
import { isRealIsoDate } from './dates';

/**
 * Maps an intervals.icu Activity to the `activity` action's payload (spec §5). Pure: the fetch lives in
 * src/integrations/intervals.ts. Returns null for anything that is never credited (strength, rides, …).
 */

export type IcuActivity = {
  id: string | number; type?: string; name?: string; start_date_local?: string;
  distance?: number | null; moving_time?: number | null; elapsed_time?: number | null; total_elevation_gain?: number | null; icu_training_load?: number | null;
};

export type MappedActivity = {
  externalId: string; date: ISODate; name: string;
  activity: { sport: 'climb' | 'run' | 'hike' | 'strength'; km?: number; vertM?: number; hours?: number; load?: number };
  /** Whole seconds as recorded, kept with the Activity (not credited): a run Benchmark's time can be taken from them. */
  timing: { movingS?: number; elapsedS?: number };
} | null;

type Sport = NonNullable<MappedActivity>['activity']['sport'];

/** intervals.icu `type`, lowercased with spaces removed. */
const SPORTS: Record<string, Sport> = {
  run: 'run', trailrun: 'run', virtualrun: 'run',
  weighttraining: 'strength', strengthtraining: 'strength',
  hike: 'hike', walk: 'hike', snowshoe: 'hike', backcountryski: 'hike', mountaineering: 'hike',
};

/** Generic intervals.icu types that count as climbing only when the activity name says so. */
const GENERIC_TYPES = new Set(['workout', 'other']);
const CLIMB_NAME_HINTS = ['climb', 'boulder', 'crag', 'belay'];

/** A Walk below both of these is a commute, not a hike. */
const WALK_MIN_VERT_M = 150;
const WALK_MIN_HOURS = 1.5;

const has = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v);
const round = (v: number, step: number) => Math.round(v / step) * step;
const round1 = (v: number) => Number(round(v, 0.1).toFixed(1));
const round2 = (v: number) => Number(round(v, 0.01).toFixed(2));

export function mapIcuActivity(a: IcuActivity): MappedActivity {
  const type = (a.type ?? '').toLowerCase().replace(/[\s_]+/g, '');
  let sport: Sport | undefined = type.startsWith('treadmill') ? 'run' : SPORTS[type];
  if (!sport && (type.includes('climb') || type.includes('boulder'))) sport = 'climb';
  if (!sport && GENERIC_TYPES.has(type)) {
    const name = (a.name ?? '').toLowerCase();
    // Hints are word prefixes ("climb" matches "climbing"), so "crag" never matches "scraggy".
    if (CLIMB_NAME_HINTS.some((h) => new RegExp(`(^|[^a-z])${h}`).test(name))) sport = 'climb';
  }
  if (!sport) return null;

  const date = (a.start_date_local ?? '').slice(0, 10);
  if (!isRealIsoDate(date)) return null;

  const activity: NonNullable<MappedActivity>['activity'] = { sport };
  if (has(a.distance)) activity.km = round1(a.distance / 1000);
  if (has(a.total_elevation_gain)) activity.vertM = Math.round(a.total_elevation_gain);
  if (has(a.moving_time)) activity.hours = round2(a.moving_time / 3600);
  if (has(a.icu_training_load)) activity.load = a.icu_training_load;

  if (type === 'walk' && (activity.vertM ?? 0) < WALK_MIN_VERT_M && (activity.hours ?? 0) < WALK_MIN_HOURS) return null;

  const timing: NonNullable<MappedActivity>['timing'] = {};
  if (has(a.moving_time)) timing.movingS = Math.round(a.moving_time);
  if (has(a.elapsed_time)) timing.elapsedS = Math.round(a.elapsed_time);
  return { externalId: `icu:${a.id}`, date, name: a.name?.trim() || a.type || 'Activity', activity, timing };
}
