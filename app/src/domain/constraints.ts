import type { Constraint, ISODate, PlannerState, TravelDay } from './types';

export type DayContext = {
  timezone: string;
  gymProfileId: string | null;
  noGym: boolean;
  mountain: boolean;
  note?: string;
  travel?: TravelDay;
  /** Where the athlete is: the latest-starting matching Constraint's `location`, else `homeLocation`. */
  location: string;
};

export const DEFAULT_HOME_LOCATION = 'Hometown';

/** Spec §1/§5: a trip (sets `timezone` or `noGym`) has Travel Days unless `travelDays: false`; anything else only with `travelDays: true`. */
const hasTravelDays = (c: Constraint) => c.travelDays ?? (c.timezone !== undefined || !!c.noGym);

/**
 * The effective Constraint on `date`. Matching Constraints are folded in order of `start`:
 * a later one overrides `timezone`, `gymProfileId` (including null), `note` and `location`;
 * `noGym` and `mountain` are ORed. `noGym` forces `gymProfileId: null`.
 *
 * `travel` is decided per day across all matching Constraints: the last day of any Constraint with
 * Travel Days makes it an Arrival Day, otherwise the first day makes it a Departure Day. So when one
 * trip ends on the day the next begins, that day is an Arrival Day (you are in transit), and a
 * one-day trip is an Arrival Day. A trip starting the day after another ends gets its own Departure
 * Day. Mountain days take precedence: a mountain day is never a Travel Day.
 */
export function dayContext(
  state: Pick<PlannerState, 'defaultTimezone' | 'defaultGymProfileId' | 'constraints'> & { homeLocation?: string },
  date: ISODate,
): DayContext {
  const ctx: DayContext = {
    timezone: state.defaultTimezone,
    gymProfileId: state.defaultGymProfileId,
    noGym: false,
    mountain: false,
    note: undefined,
    location: state.homeLocation ?? DEFAULT_HOME_LOCATION,
  };
  const matching = state.constraints
    .filter((c) => c.start <= date && date <= c.end)
    .sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
  for (const c of matching) {
    if (c.timezone !== undefined) ctx.timezone = c.timezone;
    if (c.gymProfileId !== undefined) ctx.gymProfileId = c.gymProfileId;
    if (c.note !== undefined) ctx.note = c.note;
    if (c.location !== undefined) ctx.location = c.location;
    ctx.noGym ||= !!c.noGym;
    ctx.mountain ||= !!c.mountain;
  }
  if (ctx.noGym) ctx.gymProfileId = null;
  if (!ctx.mountain) {
    const trips = matching.filter(hasTravelDays);
    if (trips.some((c) => c.end === date)) ctx.travel = 'arrival';
    else if (trips.some((c) => c.start === date)) ctx.travel = 'departure';
  }
  return ctx;
}
