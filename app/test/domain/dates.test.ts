import { describe, it, expect } from 'vitest';
import { addDays, weekday, mondayOf, daysBetween, localNow, isRealIsoDate } from '../../src/domain/dates';

describe('dates', () => {
  it('addDays crosses months', () => expect(addDays('2026-10-31', 1)).toBe('2026-11-01'));
  it('weekday is Monday=0', () => {
    expect(weekday('2026-10-05')).toBe(0); // Monday
    expect(weekday('2026-10-04')).toBe(6); // Sunday
  });
  it('mondayOf', () => expect(mondayOf('2026-10-08')).toBe('2026-10-05'));
  it('daysBetween', () => expect(daysBetween('2026-10-01', '2026-10-08')).toBe(7));
  it('localNow converts UTC instant to zone date/time', () => {
    // 2026-10-05T05:00Z is 07:00 in Berlin (CEST, UTC+2)
    expect(localNow(new Date('2026-10-05T05:00:00Z'), 'Europe/Berlin')).toEqual({ date: '2026-10-05', hhmm: '07:00', weekday: 0 });
    // after DST ends (2026-10-25), Berlin is UTC+1
    expect(localNow(new Date('2026-10-26T06:00:00Z'), 'Europe/Berlin').hhmm).toBe('07:00');
    expect(localNow(new Date('2026-10-05T23:30:00Z'), 'Asia/Shanghai')).toEqual({ date: '2026-10-06', hhmm: '07:30', weekday: 1 });
  });
  it('isRealIsoDate accepts only real calendar dates in YYYY-MM-DD form', () => {
    for (const d of ['2026-10-05', '2028-02-29', '2026-12-31']) expect(isRealIsoDate(d)).toBe(true);
    for (const d of ['9999-99-99', '2026-02-30', '2026-13-01', '2027-02-29', '2026-10-5', ' 2026-10-05', '2026-10-05T00:00', '', 20261005, null, undefined])
      expect(isRealIsoDate(d)).toBe(false);
  });
});
