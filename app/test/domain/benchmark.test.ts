import { describe, expect, it } from 'vitest';
import { benchmarkKind, formatTime, parseGrade, parseTime, resultFits } from '../../src/domain/benchmark';
import type { ClubEvent } from '../../src/domain/types';

const ev = (type: ClubEvent['type']): ClubEvent => ({ id: 'e1', date: '2026-10-28', time: '18:00', title: 'Wall C', venue: 'Wall C', type });

describe('benchmarkKind', () => {
  it('the two run Benchmarks and an endurance_benchmark Club Event', () => {
    expect(benchmarkKind({ kind: 'run', run: 'benchmark-2k4' }, [])).toBe('2k4');
    expect(benchmarkKind({ kind: 'run', run: 'benchmark-hill' }, [])).toBe('hill');
    expect(benchmarkKind({ kind: 'climb', eventId: 'e1' }, [ev('endurance_benchmark')])).toBe('autobelay');
  });
  it('anything else is not a Benchmark', () => {
    expect(benchmarkKind({ kind: 'run', run: 'quality-speed' }, [])).toBeNull();
    expect(benchmarkKind({ kind: 'climb', eventId: 'e1' }, [ev('partner')])).toBeNull();
    expect(benchmarkKind({ kind: 'climb', fallback: true }, [])).toBeNull();
    expect(benchmarkKind({ kind: 'travel-strength' }, [])).toBeNull();
  });
});

describe('times and grades', () => {
  it('parses mm:ss and h:mm:ss within 1 min – 4 h', () => {
    expect(parseTime('10:42')).toBe(642);
    expect(parseTime(' 1:02:05 ')).toBe(3725);
    expect(parseTime('75:00')).toBe(4500);
    for (const bad of ['10:60', '0:59', '5:00:00', '1:60:00', '10.42', '1042', '', 'ten']) expect(parseTime(bad)).toBeNull();
  });
  it('formats seconds back', () => {
    expect(formatTime(642)).toBe('10:42');
    expect(formatTime(605)).toBe('10:05');
    expect(formatTime(3725)).toBe('1:02:05');
  });
  it('normalises French grades', () => {
    expect(parseGrade('6A+')).toBe('6a+');
    expect(parseGrade('7c')).toBe('7c');
    for (const bad of ['6d', '10a', 'V5', '6a++', '']) expect(parseGrade(bad)).toBeNull();
  });
  it('a result fits its kind', () => {
    expect(resultFits('2k4', { timeS: 600 })).toBe(true);
    expect(resultFits('hill', { grade: '6a', minutes: 10 })).toBe(false);
    expect(resultFits('autobelay', { grade: '6a', minutes: 10 })).toBe(true);
    expect(resultFits('autobelay', { timeS: 600 })).toBe(false);
  });
});
