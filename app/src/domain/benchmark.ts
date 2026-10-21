// Benchmark Results (CONTEXT.md): a time for the 2.4 km or the hill loop, or a grade and continuous minutes on the auto-belay.
import type { ClubEvent, ISODate, SessionRef } from './types';

export type BenchmarkKind = '2k4' | 'hill' | 'autobelay';

/** A Benchmark Result as given: a time for the runs, grade + minutes for the auto-belay. */
export type BenchmarkInput = { timeS: number } | { grade: string; minutes: number };

/** One Benchmark Session done, with its result once given. */
export type BenchmarkEntry = {
  id: number; date: ISODate; kind: BenchmarkKind; eventId?: string;
  timeS?: number; grade?: string; minutes?: number;
  /** The time came from the synced Activity (watch); a manual result replaces it. */
  auto?: true;
};

export const MIN_TIME_S = 60;
export const MAX_TIME_S = 4 * 3600;
export const MAX_MINUTES = 240;
/** French grades offered as buttons on the auto-belay prompt. */
export const GRADE_BUTTONS = ['5c', '6a', '6a+', '6b', '6b+', '6c', '6c+', '7a', '7a+', '7b', '7b+', '7c'] as const;
/** Any French grade from 3a to 9c, with an optional +. */
export const GRADE_RE = /^[3-9][abc]\+?$/;

export const isTimeKind = (k: BenchmarkKind): k is '2k4' | 'hill' => k !== 'autobelay';

/**
 * The Benchmark a Session is, if any: the 2.4 km and hill-loop runs, and a climb at a Club Event of type
 * `endurance_benchmark` (the auto-belay Benchmark). `clubEvents` resolves the climb's event.
 */
export function benchmarkKind(ref: SessionRef, clubEvents: ClubEvent[]): BenchmarkKind | null {
  if (ref.kind === 'run') return ref.run === 'benchmark-2k4' ? '2k4' : ref.run === 'benchmark-hill' ? 'hill' : null;
  if (ref.kind === 'climb' && ref.eventId) {
    return clubEvents.find((e) => e.id === ref.eventId)?.type === 'endurance_benchmark' ? 'autobelay' : null;
  }
  return null;
}

/** `10:42` or `1:02:05` → seconds; null when malformed or out of range. */
export function parseTime(s: string): number | null {
  const m = /^(?:(\d{1,2}):)?(\d{1,3}):([0-5]\d)$/.exec(s.trim());
  if (!m) return null;
  if (m[1] !== undefined && Number(m[2]) > 59) return null;
  const t = Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  return t >= MIN_TIME_S && t <= MAX_TIME_S ? t : null;
}

/** Seconds → `10:42` (or `1:02:05` from an hour up). */
export function formatTime(t: number): string {
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = String(t % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/** Normalises a grade (`6A+` → `6a+`); null when it is not a French grade. */
export function parseGrade(s: string): string | null {
  const g = s.trim().toLowerCase();
  return GRADE_RE.test(g) ? g : null;
}

/** Does the result fit the Benchmark? Times for the runs, grade + minutes for the auto-belay. */
export const resultFits = (kind: BenchmarkKind, r: BenchmarkInput): boolean => ('timeS' in r) === isTimeKind(kind);

/** A 2.4 km Benchmark Activity is 2.2–2.8 km; any run fits the hill loop. */
const KM_2K4 = { min: 2.2, max: 2.8 };

/** What an Activity records, as far as a Benchmark time goes. */
export type ActivityTiming = { sport?: string; km?: number; hours?: number; movingS?: number; elapsedS?: number };

/**
 * The time a run Activity gives a run Benchmark, or null when it doesn't look like it: elapsed time first (a timed
 * effort counts its stops), then moving time, then hours.
 */
export function activityBenchmarkTime(kind: '2k4' | 'hill', a: ActivityTiming): number | null {
  if (a.sport !== 'run') return null;
  if (kind === '2k4' && (a.km === undefined || a.km < KM_2K4.min || a.km > KM_2K4.max)) return null;
  const t = a.elapsedS ?? a.movingS ?? (a.hours !== undefined ? Math.round(a.hours * 3600) : undefined);
  return t !== undefined && Number.isInteger(t) && t >= MIN_TIME_S && t <= MAX_TIME_S ? t : null;
}

export const BENCHMARK_LABEL: Record<BenchmarkKind, string> = { '2k4': '2.4 km', hill: 'Hill loop', autobelay: 'Auto-belay' };

/** `2.4 km 10:42` / `Auto-belay 6b · 18 min`. */
export function resultText(kind: BenchmarkKind, r: BenchmarkInput): string {
  return 'timeS' in r ? `${BENCHMARK_LABEL[kind]} ${formatTime(r.timeS)}` : `${BENCHMARK_LABEL[kind]} ${r.grade} · ${r.minutes} min`;
}
