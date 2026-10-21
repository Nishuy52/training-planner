import { describe, expect, it } from 'vitest';
import { LOW_TM_WARNING, bigTmChange, focusStep, isLiveFor, liveTally, loggedLine, rxLine, setOfText, testResultConfirmText, testResultPreview, tmFromTest, topSetConfirmText } from '../../public/live.js';
import { LOW_TM_WARNING as LOW_TM_WARNING_TS, testResultPreview as previewTs } from '../../src/domain/actions';
import { tmFromTest as tmFromTestTs } from '../../src/domain/fivethreeone';
import { baseState } from '../domain/fixtures';

const set = (o: Record<string, unknown>) => ({ kind: 'set', group: 'main', exercise: 'Squat', unit: 'kg', status: null, ...o });
const live = (o: Record<string, unknown> = {}) => ({
  id: 'x', date: '2026-10-05', ref: { kind: 'lift', lift: 'squat', week: 1 }, title: 'Squat — Week 1 (5s)', current: 0, next: null,
  steps: [
    { kind: 'warmup', items: [], done: false },
    set({ n: 1, of: 3, rxLoad: 65, rxReps: 5 }),
    set({ n: 2, of: 3, rxLoad: 75, rxReps: 5 }),
    set({ n: 3, of: 3, rxLoad: 85, rxReps: 5, amrap: true }),
    set({ group: 'fsl', exercise: 'DB Bulgarian split squat', n: 1, rxLoad: 20, rxReps: 8 }),
    set({ group: 'fsl', exercise: 'DB Bulgarian split squat', n: 2, rxLoad: 20, rxReps: 8 }),
    set({ group: 'finisher', exercise: 'Cossack squat', n: 1, rxReps: 12, rxRepsMax: 15 }),
    set({ group: 'finisher', exercise: 'Plank', n: 1, dose: '2 x 30 s/side' }),
  ],
  ...o,
});

describe('isLiveFor', () => {
  const l = live();
  it('matches the date, kind, lift and Cycle week', () => {
    expect(isLiveFor(l, '2026-10-05', { kind: 'lift', lift: 'squat', week: 1 })).toBe(true);
    expect(isLiveFor(l, '2026-10-06', { kind: 'lift', lift: 'squat', week: 1 })).toBe(false);
    expect(isLiveFor(l, '2026-10-05', { kind: 'lift', lift: 'bench', week: 1 })).toBe(false);
    expect(isLiveFor(l, '2026-10-05', { kind: 'lift', lift: 'squat', week: 2 })).toBe(false);
    expect(isLiveFor(null, '2026-10-05', { kind: 'lift', lift: 'squat', week: 1 })).toBe(false);
  });
  it('matches a TM Test by lift', () => {
    const t = live({ ref: { kind: 'lift-test', lift: 'ohp' } });
    expect(isLiveFor(t, '2026-10-05', { kind: 'lift-test', lift: 'ohp' })).toBe(true);
    expect(isLiveFor(t, '2026-10-05', { kind: 'lift', lift: 'ohp', week: 1 })).toBe(false);
  });
});

describe('focusStep', () => {
  it('is the first set while the Warm-up is open, then the current step', () => {
    expect(focusStep(live())).toBe(1);
    expect(focusStep(live({ current: 3 }))).toBe(3);
    expect(focusStep(live({ current: 8 }))).toBe(8); // every set logged
  });
  it('is the next work-up set for a TM Test', () => {
    const steps = [{ kind: 'warmup', items: [], done: true }, set({ group: 'test', n: 1, load: 60, reps: 5, loggedAt: 't' })];
    expect(focusStep(live({ ref: { kind: 'lift-test', lift: 'ohp' }, steps, current: 0 }))).toBe(2);
    expect(focusStep(live({ ref: { kind: 'lift-test', lift: 'ohp' }, steps, current: 2 }))).toBe(2);
  });
});

describe('setOfText, rxLine, loggedLine', () => {
  const l = live();
  it('counts sets per exercise, from `of` or from the steps', () => {
    expect(setOfText(l, 2)).toBe('Set 2 of 3');
    expect(setOfText(l, 5)).toBe('Set 2 of 2');
    expect(setOfText(l, 0)).toBe('');
  });
  it('prints the Prescription', () => {
    expect(rxLine(l.steps[1])).toBe('65 kg × 5');
    expect(rxLine(l.steps[3])).toBe('85 kg × 5+');
    expect(rxLine(l.steps[6])).toBe('× 12–15');
    expect(rxLine(l.steps[7])).toBe('2 x 30 s/side');
  });
  it('prints what was logged', () => {
    expect(loggedLine(set({ load: 67.5, reps: 4, loggedAt: 't' }))).toBe('67.5 kg × 4');
    expect(loggedLine(set({ skipped: true, loggedAt: 't' }))).toBe('Skipped');
    expect(loggedLine(set({ dose: 'x', loggedAt: 't' }))).toBe('Done');
    expect(loggedLine(set({ load: 60 }))).toBe('');
  });
});

describe('liveTally', () => {
  it('counts statuses and reports the AMRAP reps', () => {
    const l = live();
    const st = l.steps as Array<Record<string, unknown>>;
    Object.assign(st[1]!, { loggedAt: 't', load: 65, reps: 5, status: 'met' });
    Object.assign(st[2]!, { loggedAt: 't', load: 75, reps: 4, status: 'under' });
    Object.assign(st[3]!, { loggedAt: 't', load: 85, reps: 9, status: 'amrap' });
    Object.assign(st[4]!, { loggedAt: 't', load: 22.5, reps: 8, status: 'over' });
    Object.assign(st[5]!, { loggedAt: 't', skipped: true, status: 'skipped' });
    Object.assign(st[7]!, { loggedAt: 't', status: 'done' });
    expect(liveTally(l)).toEqual({ logged: 5, met: 1, over: 1, under: 1, skipped: 1, done: 1, amrap: 9, top: null });
  });
  it('is all zero for nothing logged or no Live Session', () => {
    expect(liveTally(live())).toMatchObject({ logged: 0, skipped: 0, amrap: null });
    expect(liveTally(null)).toMatchObject({ logged: 0 });
  });
});

describe('TM Test top-set confirmation (app)', () => {
  // Production on 5 Oct: squat 110 × 5 (TM 115) and bench 70 × 6 (TM 75) tested; deadlift logged as the bar.
  const state = { tms: { squat: 115, bench: 75, deadlift: 0, ohp: 0 }, testWeek: { results: { squat: { weight: 110, reps: 5 }, bench: { weight: 70, reps: 6 } } } };

  it('shows the Training Max it will set, and warns when it is much lower than the other tested lifts', () => {
    expect(topSetConfirmText(state, 'deadlift', 20, 5, 2.5)).toBe(`Top set 20 kg × 5 → Training Max 20 kg. Save?\n\n${LOW_TM_WARNING}`);
    expect(topSetConfirmText(state, 'deadlift', 120, 5, 2.5)).toBe('Top set 120 kg × 5 → Training Max 125 kg. Save?');
    expect(topSetConfirmText({ tms: state.tms, testWeek: { results: {} } }, 'deadlift', 20, 5, 2.5)).toBe('Top set 20 kg × 5 → Training Max 20 kg. Save?');
  });

  it('agrees with the server (src/domain/actions.ts testResultPreview)', () => {
    expect(LOW_TM_WARNING).toBe(LOW_TM_WARNING_TS);
    const st = baseState({ tms: state.tms, testWeek: { dates: { squat: '2026-10-24', bench: '2026-10-25', deadlift: '2026-10-26', ohp: '2026-10-27' }, results: state.testWeek.results } });
    for (const [lift, w, r] of [['deadlift', 20, 5], ['deadlift', 120, 5], ['ohp', 40, 5], ['ohp', 45, 5], ['ohp', 50, 5], ['squat', 30, 3]] as const) {
      expect(testResultPreview(state, lift, w, r, 2.5), `${lift} ${w}×${r}`).toEqual(previewTs(st, lift, w, r));
      expect(tmFromTest(w, r, 2.5)).toBe(tmFromTestTs(w, r, 2.5));
    }
  });

  it("Today's Save result confirms with the Training Max and the low warning", () => {
    expect(testResultConfirmText(state, 'deadlift', 'Deadlift', 120, 5, 2.5)).toBe('Deadlift 120 kg × 5 → Training Max 125 kg. Save?');
    expect(testResultConfirmText(state, 'deadlift', 'Deadlift', 20, 5, 2.5)).toBe(`Deadlift 20 kg × 5 → Training Max 20 kg. Save?\n\n${LOW_TM_WARNING}`);
  });

  it('a Test Week correction asks first when the Training Max moves more than 20%', () => {
    expect(bigTmChange(20, 125)).toBe(true);
    expect(bigTmChange(125, 120)).toBe(false);
    expect(bigTmChange(100, 80)).toBe(false);
    expect(bigTmChange(100, 79.5)).toBe(true);
    expect(bigTmChange(0, 100)).toBe(false);
  });
});
