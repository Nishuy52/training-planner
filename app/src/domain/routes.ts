// Routes and Route Assignments (Plan 3 A1/A4; CONTEXT.md Route, Route Assignment).
import type { ISODate, RunKind } from './types';

/** A named, repeatable run course. `km` / `vertM` are the whole session as run (approach plus all laps for a Repeat). */
export type Route = {
  id: string;                 // /^[A-Za-z0-9_-]{1,40}$/
  name: string;
  area: string;               // "Place, Region", as a Constraint `location`
  km: number;
  vertM: number;
  kind: 'loop' | 'repeat';
  repeats?: number;           // laps of the climb, for a Repeat
  url?: string;               // https only
  suits: RunKind[];
  benchmark?: 'hill' | '2k4';
  notes?: string;
};

/** The run kind an assignment is stored under: `long` and `ruck` share the long-run key. */
export type AssignmentKind = Exclude<RunKind, 'ruck'>;
export type RouteAssignment = { date: ISODate; runKind: AssignmentKind; routeId: string };

/** Everything the planner needs to attach Routes: the library and the assignments in the planned window. */
export type RouteBook = { routes: Route[]; assignments: RouteAssignment[] };

/** What a run Session's details carry about its Route. */
export type RouteSummary = Pick<Route, 'id' | 'name' | 'km' | 'vertM' | 'kind' | 'repeats' | 'url'>;

export const assignmentKey = (run: RunKind): AssignmentKind => (run === 'ruck' ? 'long' : run);

const BENCHMARK_OF: Partial<Record<RunKind, Route['benchmark']>> = { 'benchmark-hill': 'hill', 'benchmark-2k4': '2k4' };

/**
 * The Route for the run of kind `run` on `date`. A Benchmark run always takes the Route flagged as that Benchmark
 * when one exists (it must stay fixed); otherwise the assignment for (date, assignmentKey(run)) decides.
 */
export function routeFor(book: RouteBook, date: ISODate, run: RunKind): Route | null {
  const bm = BENCHMARK_OF[run];
  const flagged = bm ? book.routes.find((r) => r.benchmark === bm) : undefined;
  if (flagged) return flagged;
  const key = assignmentKey(run);
  const a = book.assignments.find((x) => x.date === date && x.runKind === key);
  return (a && book.routes.find((r) => r.id === a.routeId)) || null;
}

export function routeSummary(r: Route): RouteSummary {
  const out: RouteSummary = { id: r.id, name: r.name, km: r.km, vertM: r.vertM, kind: r.kind };
  if (r.repeats !== undefined) out.repeats = r.repeats;
  if (r.url !== undefined) out.url = r.url;
  return out;
}
