import { describe, expect, it } from 'vitest';
import { GRADES, fmtMmss, parseMmss, secondsUntil } from '../../public/format.js';

describe('parseMmss', () => {
  it('reads m:ss, mm:ss and h:mm:ss, with : or .', () => {
    expect(parseMmss('10:42')).toBe(642);
    expect(parseMmss('9:05')).toBe(545);
    expect(parseMmss(' 25.30 ')).toBe(1530);
    expect(parseMmss('1:02:03')).toBe(3723);
    expect(parseMmss('0:59')).toBe(59);
    expect(parseMmss('120:00')).toBe(7200);
  });
  it('rejects blanks, bare numbers and out-of-range parts', () => {
    for (const bad of ['', '   ', '642', '10:4', '10:60', '1:60:00', 'ab:cd', '10:42:', '-1:00', undefined, null]) {
      expect(parseMmss(bad), String(bad)).toBeNull();
    }
  });
});

describe('fmtMmss', () => {
  it('formats m:ss under an hour and h:mm:ss from an hour', () => {
    expect(fmtMmss(642)).toBe('10:42');
    expect(fmtMmss(59)).toBe('0:59');
    expect(fmtMmss(3723)).toBe('1:02:03');
    expect(fmtMmss(0)).toBe('0:00');
  });
  it('rounds and never goes negative', () => {
    expect(fmtMmss(61.6)).toBe('1:02');
    expect(fmtMmss(-5)).toBe('0:00');
  });
  it('round-trips through parseMmss', () => {
    for (const s of [60, 545, 642, 1530, 3599, 3723, 14400]) expect(parseMmss(fmtMmss(s))).toBe(s);
  });
});

describe('GRADES', () => {
  it('runs 5a to 8a with + variants, all valid for the API', () => {
    expect(GRADES[0]).toBe('5a');
    expect(GRADES[1]).toBe('5a+');
    expect(GRADES.at(-1)).toBe('8a');
    expect(GRADES).toHaveLength(19);
    for (const g of GRADES) expect(g).toMatch(/^[3-9][abc]\+?$/);
  });
});

describe('secondsUntil', () => {
  const now = Date.parse('2026-10-05T10:00:00Z');
  it('rounds up and stops at 0', () => {
    expect(secondsUntil('2026-10-05T10:01:30Z', now)).toBe(90);
    expect(secondsUntil('2026-10-05T10:00:00.200Z', now)).toBe(1);
    expect(secondsUntil('2026-10-05T09:59:00Z', now)).toBe(0);
  });
  it('is null without an instant', () => {
    expect(secondsUntil(null, now)).toBeNull();
    expect(secondsUntil('not a date', now)).toBeNull();
  });
});
