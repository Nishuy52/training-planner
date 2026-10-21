import type { ISODate, Weekday } from './types';

const toUTC = (d: ISODate) => new Date(d + 'T00:00:00Z');
const fmt = (t: Date): ISODate => t.toISOString().slice(0, 10);

export const addDays = (d: ISODate, n: number): ISODate => {
  const t = toUTC(d);
  t.setUTCDate(t.getUTCDate() + n);
  return fmt(t);
};
export const weekday = (d: ISODate): Weekday => ((toUTC(d).getUTCDay() + 6) % 7) as Weekday;
export const mondayOf = (d: ISODate): ISODate => addDays(d, -weekday(d));
export const daysBetween = (a: ISODate, b: ISODate) => Math.round((toUTC(b).getTime() - toUTC(a).getTime()) / 86400000);

export function localNow(instant: Date, timeZone: string): { date: ISODate; hhmm: string; weekday: Weekday } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(instant)
      .map((p) => [p.type, p.value]),
  );
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  return { date, hhmm: `${parts.hour}:${parts.minute}`, weekday: weekday(date) };
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** True only for a `YYYY-MM-DD` string naming a real calendar date (rejects 2026-02-30, 9999-99-99, ...). */
export function isRealIsoDate(v: unknown): v is ISODate {
  if (typeof v !== 'string' || !ISO_DATE_RE.test(v)) return false;
  const t = Date.parse(v + 'T00:00:00Z');
  return !Number.isNaN(t) && fmt(new Date(t)) === v;
}

/**
 * The instant (epoch ms) `date` starts in `timeZone`: the first minute whose local date is `date`. Usually local
 * 00:00, but where a DST change skips midnight (e.g. 00:00 → 01:00) it is the first local time that exists.
 * Found by bisection over the ±14 h window every UTC offset falls in.
 */
export function zonedMidnight(date: ISODate, timeZone: string): number {
  const MIN = 60_000;
  const utc = Date.parse(date + 'T00:00:00Z');
  let lo = (utc - 15 * 3_600_000) / MIN; // local date before `date` everywhere
  let hi = (utc + 15 * 3_600_000) / MIN; // local date `date` or later everywhere
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (localNow(new Date(mid * MIN), timeZone).date >= date) hi = mid;
    else lo = mid;
  }
  return hi * MIN;
}
