import { describe, expect, it } from 'vitest';
import { lastSessionSets, liftRows, parseDose, setStatus } from '../../public/sets.js';
import { FINISHERS, FSL } from '../../src/content/liftExtras';

describe('parseDose', () => {
  it('reads N x M with x or ×, ranges with - or –, and keeps the rest', () => {
    expect(parseDose('4 x 8 per side, RPE 7-8')).toEqual({ sets: 4, reps: 8, rest: 'per side, RPE 7-8' });
    expect(parseDose('3 x 5')).toEqual({ sets: 3, reps: 5, rest: '' });
    expect(parseDose('2 x 12-15')).toEqual({ sets: 2, reps: 12, repsMax: 15, rest: '' });
    expect(parseDose('2 × 12–15')).toEqual({ sets: 2, reps: 12, repsMax: 15, rest: '' });
    expect(parseDose('4 × 8/side')).toEqual({ sets: 4, reps: 8, rest: '/side' });
  });
  it('does not parse timed holds, free text or absurd counts', () => {
    expect(parseDose('2 x 30 s/side')).toBeNull();
    expect(parseDose('2 x 20 s/side (short lever if needed)')).toBeNull();
    expect(parseDose('45 s')).toBeNull();
    expect(parseDose('5/side')).toBeNull();
    expect(parseDose('0 x 5')).toBeNull();
    expect(parseDose('21 x 5')).toBeNull();
    expect(parseDose(undefined)).toBeNull();
    expect(parseDose({ type: 'hold' })).toBeNull();
  });
  it('parses every FSL and finisher rep dose in the content', () => {
    for (const e of [...Object.values(FSL).flat(), ...FINISHERS.lower.flat(), ...FINISHERS.upper.flat()]) {
      const dose = String(e.dose);
      if (!/\bs\b|s\//.test(dose)) expect(parseDose(dose), dose).not.toBeNull();
    }
  });
});

describe('setStatus', () => {
  it('under if load or reps is lower; met if equal; over if both >= and one greater', () => {
    expect(setStatus({ rxLoad: 60, rxReps: 5 })).toBeNull();
    expect(setStatus({ rxLoad: 60, rxReps: 5, load: 60, reps: 5 })).toBe('match');
    expect(setStatus({ rxLoad: 60, rxReps: 5, load: 60, reps: 7 })).toBe('above');
    expect(setStatus({ rxLoad: 60, rxReps: 5, load: 62.5, reps: 5 })).toBe('above');
    expect(setStatus({ rxLoad: 60, rxReps: 5, load: 57.5, reps: 5 })).toBe('below');
    expect(setStatus({ rxLoad: 60, rxReps: 5, load: 65, reps: 4 })).toBe('below');
  });
  it('a rep range is met anywhere inside it; no load Prescription compares reps only', () => {
    expect(setStatus({ rxReps: 12, rxRepsMax: 15, reps: 14 })).toBe('match');
    expect(setStatus({ rxReps: 12, rxRepsMax: 15, reps: 16 })).toBe('above');
    expect(setStatus({ rxReps: 12, rxRepsMax: 15, reps: 11, load: 10 })).toBe('below');
  });
});

describe('liftRows', () => {
  const det = {
    mainSets: [{ pct: 65, reps: 5, amrap: false, load: 65, unit: 'kg', capped: false }, { pct: 85, reps: 5, amrap: true, load: 85, unit: 'kg', capped: false }],
    fsl: [{ name: '1-arm DB bench press', dose: '4 x 8 per side, RPE 7-8' }, { name: 'Weighted chin-up', dose: '3 x 5' }],
    finisher: [{ name: 'Curl', dose: '2 x 12-15' }, { name: 'Plank', dose: '2 x 30 s/side' }],
    lastFslWeightKg: 16,
  };
  it('one row per set; FSL weight only on the first FSL exercise; unparsed dose gives one row', () => {
    const r = liftRows(det, 'Bench');
    expect(r.main.map((x: any) => [x.id, x.exercise, x.rxLoad, x.rxReps, x.amrap])).toEqual([['main:0:1', 'Bench', 65, 5, false], ['main:0:2', 'Bench', 85, 5, true]]);
    expect(r.fsl[0]!.rows).toHaveLength(4);
    expect(r.fsl[0]!.rows[3]).toMatchObject({ id: 'fsl:0:4', n: 4, rxLoad: 16, rxReps: 8, unit: 'kg', lastUsed: true });
    expect(r.fsl[1]!.rows).toHaveLength(3);
    expect(r.fsl[1]!.rows[0]!.rxLoad).toBeUndefined();
    expect(r.finisher[0]!.rows[1]).toMatchObject({ id: 'finisher:0:2', rxReps: 12, rxRepsMax: 15 });
    expect(r.finisher[1]!.rows).toEqual([expect.objectContaining({ id: 'finisher:1:1', n: 1, doseText: '2 x 30 s/side' })]);
  });
});

describe('lastSessionSets', () => {
  const main = (load: number) => ({ group: 'main', exercise: 'Squat', n: 1, load, reps: 5, unit: 'kg' });
  const fsl = (load: number) => ({ group: 'fsl', exercise: 'DB Bulgarian split squat', n: 1, load, reps: 8, unit: 'kg' });
  const fin = (reps: number) => ({ group: 'finisher', exercise: 'Cossack squat', n: 1, reps, unit: 'kg' });

  it('without a week: newest entry with sets for the lift before the date', () => {
    const s = (load: number) => [main(load)];
    const entries = [
      { date: '2026-10-10', lift: 'squat', sets: s(70) },
      { date: '2026-09-20', lift: 'squat', sets: s(60) },
      { date: '2026-10-01', lift: 'squat', sets: s(65) },
      { date: '2026-10-03', lift: 'squat', amrapReps: 5 },
      { date: '2026-10-02', lift: 'bench', sets: s(50) },
    ];
    expect(lastSessionSets(entries, 'squat', '2026-10-05').get('main|Squat|1')!.load).toBe(65);
    expect(lastSessionSets(entries, 'deadlift', '2026-10-05').size).toBe(0);
  });

  it('main sets from the newest Session in the same Cycle week; FSL and Finisher from the newest Session', () => {
    const entries = [
      { date: '2026-08-01', lift: 'squat', week: 2, sets: [main(80), fsl(16), fin(12)] },
      { date: '2026-09-01', lift: 'squat', week: 2, sets: [main(85), fsl(18), fin(13)] },
      { date: '2026-09-20', lift: 'squat', week: 1, sets: [main(75), fsl(20), fin(15)] },
      { date: '2026-09-25', lift: 'squat', week: 2, sets: [main(99)] }, // on/after the date: ignored
      { date: '2026-09-22', lift: 'bench', week: 2, sets: [main(50)] },
    ];
    const m = lastSessionSets(entries, 'squat', '2026-09-25', 2);
    expect(m.get('main|Squat|1')!.load).toBe(85);
    expect(m.get('fsl|DB Bulgarian split squat|1')!.load).toBe(20);
    expect(m.get('finisher|Cossack squat|1')!.reps).toBe(15);
    expect(lastSessionSets(entries, 'squat', '2026-09-25', 1).get('main|Squat|1')!.load).toBe(75);
  });

  it('no Session in that week: no main hint, FSL and Finisher still come from the newest Session', () => {
    const entries = [{ date: '2026-09-20', lift: 'squat', week: 1, sets: [main(75), fsl(20)] }];
    const m = lastSessionSets(entries, 'squat', '2026-10-01', 3);
    expect(m.has('main|Squat|1')).toBe(false);
    expect(m.get('fsl|DB Bulgarian split squat|1')!.load).toBe(20);
    expect(lastSessionSets([{ date: '2026-09-20', lift: 'squat', week: 'reentry', sets: [main(60)] }], 'squat', '2026-10-01', 'reentry').get('main|Squat|1')!.load).toBe(60);
  });
});
