import type { ISODate, PlannerState } from './types';
import { mondayOf } from './dates';

/**
 * What an `activity` action counted as (spec §5), from the state before and after it: Hill Ruck credit,
 * Long / Easy / Quality run, Climb or Standalone climb. Empty = nothing (it only feeds the weekly totals).
 * Shared by the Telegram `/log` reply and the intervals.icu sync notice. A late Activity names the clocks it moved.
 */

const CATEGORY_LABEL = { easy: 'Easy run', quality: 'Quality run', long: 'Long run' } as const;

export function countedAs(before: PlannerState, after: PlannerState, date: ISODate, opts: { late?: boolean } = {}): string[] {
  const out: string[] = [];
  if (opts.late) {
    // A late Activity only moves clocks (spec §5); it never credits a Session.
    if (after.ruck.lastCredit !== before.ruck.lastCredit) out.push('Hill Ruck clock');
    if (after.lastClimbDate !== before.lastClimbDate) out.push('climb clock');
    return out;
  }
  if (after.ruck.lastCredit !== before.ruck.lastCredit) out.push('Hill Ruck credit');
  const wk = mondayOf(date);
  for (const c of (after.runsThisWeek[wk] ?? []).slice((before.runsThisWeek[wk] ?? []).length)) out.push(CATEGORY_LABEL[c]);
  const climbs = (s: PlannerState) => (s.doneByDate[date] ?? []).filter((r) => r.kind === 'climb').length;
  if (climbs(after) > climbs(before)) out.push('Climb');
  else if (after.lastClimbDate !== before.lastClimbDate) out.push('Standalone climb');
  return out;
}
