import { describe, it, expect } from 'vitest';
import { isPlanned, planDays } from '../../src/domain/planner';
import { LOW_TM_WARNING, applyAction, emptyAmrapLog, healTestWeekTms, testResultPreview, type Action } from '../../src/domain/actions';
import { buildDetails } from '../../src/domain/details';
import type { PlannerState, TestWeek } from '../../src/domain/types';
import { decodeCallback, encodeRef, decodeRef, morningMessage, sessionRow } from '../../src/telegram/format';
import { baseState } from './fixtures';

const DATES: TestWeek['dates'] = { squat: '2026-10-24', bench: '2026-10-25', deadlift: '2026-10-26', ohp: '2026-10-27' };
const tw = (results: TestWeek['results'] = {}, dates = DATES): TestWeek => ({ dates: { ...dates }, results });
// The fixture's own dates move with the Test Week (three weeks later than the fixture).
const SHIFTED = { run: { ...baseState().run, runStartMonday: '2026-10-26' }, ruck: { lastCredit: '2026-10-06', step: 0 }, lastClimbDate: '2026-10-23' };
const st = (over: Partial<PlannerState> = {}) => baseState({ ...SHIFTED, rucksEnabled: false, lastLiftDate: '2026-10-11', testWeek: tw(), ...over });

const brief = (p: ReturnType<typeof planDays>) =>
  p.map((d) => `${d.date}:${d.sessions.map((s) => `${s.kind === 'lift' ? `${s.lift}-${s.week}` : s.kind === 'lift-test' ? `test-${s.lift}` : s.kind === 'run' ? s.run : s.kind === 'climb' ? (s.fallback ? 'boulder' : 'climb') : s.kind}${s.kind === 'lift-test' ? `@${s.slot}` : ''}${s.status === 'done' ? '(done)' : ''}`).join('+')}`);
const tests = (p: ReturnType<typeof planDays>) => p.flatMap((d) => d.sessions.filter((s) => s.kind === 'lift-test').map((s: any) => `${d.date}:${s.lift}${s.status === 'done' ? '(done)' : ''}`));
const liftKinds = (p: ReturnType<typeof planDays>) => p.flatMap((d) => d.sessions.filter((s) => s.kind === 'lift' || s.kind === 'travel-strength').map((s) => `${d.date}:${s.kind}`));
const apply = (s: PlannerState, a: Action) => applyAction(s, a, emptyAmrapLog());
const result = (s: PlannerState, date: string, lift: 'squat' | 'bench' | 'deadlift' | 'ohp', weight: number, reps: number) =>
  apply(s, { type: 'test-result', date, lift, weight, reps });

describe('planDays: Test Week', () => {
  it('places one TM Test per lift on its date in the AM Slot and no regular lifts', () => {
    const p = planDays(st(), '2026-10-24', 10);
    expect(tests(p)).toEqual(['2026-10-24:squat', '2026-10-25:bench', '2026-10-26:deadlift', '2026-10-27:ohp']);
    expect(p.flatMap((d) => d.sessions.filter((s) => s.kind === 'lift-test').map((s) => s.slot))).toEqual(['am', 'am', 'am', 'am']);
    expect(liftKinds(p)).toEqual([]);
  });

  it('runs and climbs still plan; a run whose AM Slot holds a test moves to pm', () => {
    const p = planDays(st(), '2026-10-24', 4);
    const tue = p[3]!; // Tue 6 Oct: OHP test in am, the run moves to pm
    expect(tue.sessions.map((s) => `${s.kind}@${s.slot}`)).toEqual(['lift-test@am', 'run@pm']);
  });

  it('no Travel Strength on a no-gym day during a Test Week; the test rolls past it', () => {
    const p = planDays(st({ constraints: [{ id: 'c', start: '2026-10-25', end: '2026-10-25', noGym: true, travelDays: false }] }), '2026-10-24', 6);
    expect(tests(p)).toEqual(['2026-10-24:squat', '2026-10-26:bench', '2026-10-27:deadlift', '2026-10-28:ohp']);
    expect(liftKinds(p)).toEqual([]);
  });

  it('a pending test whose date has passed rolls forward, one per day in lift order', () => {
    expect(tests(planDays(st(), '2026-10-26', 6))).toEqual(['2026-10-26:squat', '2026-10-27:bench', '2026-10-28:deadlift', '2026-10-29:ohp']);
    // squat done on its day: the rest keep their dates
    const s2 = st({ testWeek: tw({ squat: { weight: 100, reps: 5 } }) });
    expect(tests(planDays(s2, '2026-10-25', 5))).toEqual(['2026-10-25:bench', '2026-10-26:deadlift', '2026-10-27:ohp']);
  });

  it('a done TM Test shows as done on its day and no other test lands there', () => {
    const { state } = result(st(), '2026-10-25', 'squat', 100, 5); // squat logged a day late
    expect(tests(planDays(state, '2026-10-24', 5))).toEqual(['2026-10-25:squat(done)', '2026-10-26:bench', '2026-10-27:deadlift', '2026-10-28:ohp']);
    expect(isPlanned(state, '2026-10-25', { kind: 'lift-test', lift: 'squat' })).toBe(false);
  });

  it('the test-week plan for 24–31 Oct (fresh state, rucks off)', () => {
    const p = planDays(st(), '2026-10-24', 8);
    expect(brief(p)).toEqual([
      '2026-10-24:test-squat@am+long', '2026-10-25:test-bench@am', '2026-10-26:test-deadlift@am',
      '2026-10-27:test-ohp@am+easy', '2026-10-28:quality-vert', '2026-10-29:', '2026-10-30:boulder', '2026-10-31:long',
    ]);
  });
});

describe('applyAction: Test Week', () => {
  it('start-test-week sets the dates with no results', () => {
    const { state } = apply(baseState(), { type: 'start-test-week', dates: DATES });
    expect(state.testWeek).toEqual({ dates: DATES, results: {} });
  });

  it("each result sets that lift's TM straight away (0.9 × e1RM down to the plate step); untested lifts keep theirs", () => {
    let s = st();
    let r = result(s, '2026-10-24', 'squat', 110, 5); // 0.9 × 110 × 7/6 = 115.5 → 115
    expect(r.state.tms).toEqual({ ...baseState().tms, squat: 115 });
    expect(r.events).toEqual(['Squat 110 × 5 → Training Max 115 kg (1 of 4 tested)']);
    s = r.state;
    r = result(s, '2026-10-25', 'bench', 70, 6); // 0.9 × 70 × 1.2 = 75.6 → 75
    expect(r.state.tms).toEqual({ ...baseState().tms, squat: 115, bench: 75 });
    expect(r.events).toEqual(['Bench 70 × 6 → Training Max 75 kg (2 of 4 tested)']);
    expect(r.state.testWeek?.results).toEqual({ squat: { weight: 110, reps: 5 }, bench: { weight: 70, reps: 6 } });
    expect(r.state.doneByDate['2026-10-24']).toEqual([{ kind: 'lift-test', lift: 'squat' }]);
    // the Test Week and the pointer stay until the fourth
    expect(r.state.lift).toEqual(s.lift);
    expect(r.state.lastLiftDate).toBe('2026-10-11');
  });

  it("rounds to the default Gym Profile's plate step", () => {
    const s = st({ gymProfiles: [{ id: 'g', name: 'G', plateStepKg: 5, machineLifts: [], hasBands: false }], defaultGymProfileId: 'g' });
    expect(result(s, '2026-10-24', 'squat', 110, 5).state.tms.squat).toBe(115); // 115.5 → 115
    expect(result(s, '2026-10-24', 'bench', 70, 6).state.tms.bench).toBe(75); // 75.6 → 75
    expect(result(s, '2026-10-24', 'ohp', 50, 5).state.tms.ohp).toBe(50); // 52.5 → 50
  });

  it('the fourth result sets its TM, ends the Test Week, resets the pointer and starts Cycle 1 the day after', () => {
    let s = st({ tms: { squat: 0, bench: 0, deadlift: 0, ohp: 0 }, lift: { week: 3, index: 2, phase: { kind: 'reentry', done: 1 } } });
    s = result(s, '2026-10-24', 'squat', 100, 5).state;
    s = result(s, '2026-10-25', 'bench', 70, 5).state;
    s = result(s, '2026-10-26', 'deadlift', 140, 5).state;
    const r = result(s, '2026-10-27', 'ohp', 50, 5);
    // 0.9 × e1RM, down to 2.5: 100×5 → 105; 70×5 → 73.5 → 72.5; 140×5 → 147 → 145; 50×5 → 52.5
    expect(r.state.tms).toEqual({ squat: 105, bench: 72.5, deadlift: 145, ohp: 52.5 });
    expect(r.state.lift).toEqual({ week: 1, index: 0, phase: { kind: 'normal' }, notBefore: '2026-10-28' });
    expect(r.state.lastLiftDate).toBe('2026-10-27');
    expect(r.state.testWeek).toBeUndefined();
    expect(r.events).toEqual(['OHP 50 × 5 → Training Max 52.5 kg (4 of 4 tested)', 'All four tested: Cycle 1 starts at the next lift Slot']);
    // Cycle 1 week 1 at the first lift Slot after 7 Oct (Thu 8 Oct), no Re-entry. Thu follows Wed's Quality, so
    // bench swaps in and the squat stays the head.
    const lifts = planDays(r.state, '2026-10-27', 7).flatMap((d) => d.sessions.filter((x) => x.kind === 'lift').map((x: any) => `${d.date}:${x.lift}-${x.week}`));
    expect(lifts[0]).toBe('2026-10-29:bench-1');
    expect(r.state.lift.index).toBe(0);
    expect(tests(planDays(r.state, '2026-10-27', 1))).toEqual(['2026-10-27:ohp(done)']);
  });

  it('skip (or tomorrow) on a TM Test moves it to the next day, rolling the others; no TM changes', () => {
    const { state } = apply(st(), { type: 'skip', date: '2026-10-24', ref: { kind: 'lift-test', lift: 'squat' } });
    expect(state.tms).toEqual(st().tms);
    expect(state.testWeek?.dates.squat).toBe('2026-10-25');
    expect(tests(planDays(state, '2026-10-24', 6))).toEqual(['2026-10-25:squat', '2026-10-26:bench', '2026-10-27:deadlift', '2026-10-28:ohp']);
    const t = apply(st(), { type: 'tomorrow', date: '2026-10-24', ref: { kind: 'lift-test', lift: 'squat' } });
    expect(t.state.testWeek?.dates.squat).toBe('2026-10-25');
  });

  it('healTestWeekTms: a result whose TM is still 0 gets it, once; lifts without a result are never touched', () => {
    const s = st({ tms: { squat: 0, bench: 0, deadlift: 140, ohp: 0 }, testWeek: tw({ squat: { weight: 110, reps: 5 } }) });
    expect(healTestWeekTms(s)).toEqual(['squat']);
    expect(s.tms).toEqual({ squat: 115, bench: 0, deadlift: 140, ohp: 0 });
    expect(healTestWeekTms(s)).toEqual([]);
    expect(s.tms).toEqual({ squat: 115, bench: 0, deadlift: 140, ohp: 0 });
    // a TM already set (e.g. by hand after the test) is left alone; no Test Week, nothing to heal
    const manual = st({ tms: { ...baseState().tms, squat: 100 }, testWeek: tw({ squat: { weight: 110, reps: 5 } }) });
    expect(healTestWeekTms(manual)).toEqual([]);
    expect(manual.tms.squat).toBe(100);
    expect(healTestWeekTms(baseState({ tms: { squat: 0, bench: 0, deadlift: 0, ohp: 0 } }))).toEqual([]);
  });

  it('entering test-results directly ends the Test Week', () => {
    const { state } = apply(st(), { type: 'test-results', date: '2026-10-24', results: { squat: { weight: 100, reps: 5 } }, plateStepKg: 2.5 });
    expect(state.testWeek).toBeUndefined();
    expect(state.tms.squat).toBe(105);
  });
});

describe('details + Telegram format: TM Test', () => {
  it('detail carries the warm-up and protocol; the message and buttons fit Telegram', () => {
    const s = st();
    const [day] = planDays(s, '2026-10-24', 1);
    const details = buildDetails(s, day!, () => null);
    const det = details[0]!;
    expect(det.kind).toBe('lift-test');
    if (det.kind !== 'lift-test') return;
    expect(det.warmup.length).toBeGreaterThan(0);
    expect(det.protocol).toMatch(/5-rep max/);
    const m = morningMessage(day!, details);
    expect(m.text).toContain('🏋️ <b>Squat — 5-rep max test</b>');
    expect(m.text).toContain('Log: <code>/test squat 100 5</code>');
    expect(m.text).not.toMatch(/<(kg|reps)>/);
    const row = sessionRow('2026-10-24', { kind: 'lift-test', lift: 'deadlift' });
    expect(row.map((b) => b.text)).toEqual(['🏋️ Deadlift test: Log', '🏋️ Skip']);
    for (const b of row) expect(new TextEncoder().encode(b.callback_data).length).toBeLessThanOrEqual(64);
    expect(decodeCallback(row[0]!.callback_data)).toEqual({ type: 'test-hint', date: '2026-10-24', lift: 'deadlift' });
    expect(decodeCallback(row[1]!.callback_data)).toEqual({ type: 'ask', act: 'skip', date: '2026-10-24', ref: { kind: 'lift-test', lift: 'deadlift' } });
  });

  it('ref codec round-trips and rejects junk; a bare Done on a test is refused', () => {
    expect(encodeRef({ kind: 'lift-test', lift: 'ohp' })).toBe('X.ohp');
    expect(decodeRef('X.ohp')).toEqual({ kind: 'lift-test', lift: 'ohp' });
    expect(decodeRef('X.curl')).toBeNull();
    expect(decodeRef('X')).toBeNull();
    expect(decodeCallback('a|d|2026-10-24|X.squat')).toBeNull();
    expect(decodeCallback('a|D|2026-10-24|X.squat')).toBeNull();
    expect(decodeCallback('a|h|2026-10-24|R.easy')).toBeNull();
  });
});

describe('applyAction: TM Test correction', () => {
  const three = () => {
    let s = st({ tms: { squat: 0, bench: 0, deadlift: 0, ohp: 0 } });
    s = result(s, '2026-10-24', 'squat', 110, 5).state; // TM 115
    s = result(s, '2026-10-25', 'bench', 70, 6).state; // TM 75
    return result(s, '2026-10-26', 'deadlift', 20, 5).state; // the bar by mistake: TM 20
  };

  it('replaces the result and its Training Max; the tested count, Done entries and the Test Week stay', () => {
    const s = three();
    const r = apply(s, { type: 'test-result', date: '2026-10-26', lift: 'deadlift', weight: 120, reps: 5, correct: true });
    expect(r.state.testWeek?.results.deadlift).toEqual({ weight: 120, reps: 5 });
    expect(r.state.tms.deadlift).toBe(125); // 0.9 x 120 x 7/6 = 126 -> 125
    expect(r.events).toEqual(['Deadlift corrected: 20 × 5 → 120 × 5 · Training Max 20 → 125 kg']);
    expect(Object.keys(r.state.testWeek!.results)).toHaveLength(3);
    expect(r.state.doneByDate).toEqual(s.doneByDate);
    expect(r.state.lift).toEqual(s.lift);
    // the fourth real result still ends the Test Week afterwards
    const last = result(r.state, '2026-10-27', 'ohp', 50, 5);
    expect(last.events.at(-1)).toBe('All four tested: Cycle 1 starts at the next lift Slot');
    expect(last.state.tms.deadlift).toBe(125);
  });

  it('a correction never ends the Test Week, even when all four have results', () => {
    const s = three();
    s.testWeek!.results.ohp = { weight: 50, reps: 5 }; // as if all four were in and the week still ran
    const r = apply(s, { type: 'test-result', date: '2026-10-27', lift: 'ohp', weight: 55, reps: 5, correct: true });
    expect(r.state.testWeek).toBeDefined();
    expect(r.events).toHaveLength(1);
  });

  it('is a no-op without a Test Week or without a result for the lift', () => {
    const none = apply(baseState(), { type: 'test-result', date: '2026-10-26', lift: 'deadlift', weight: 120, reps: 5, correct: true });
    expect(none.state.tms).toEqual(baseState().tms);
    const s = st();
    const r = apply(s, { type: 'test-result', date: '2026-10-26', lift: 'deadlift', weight: 120, reps: 5, correct: true });
    expect(r.state.testWeek?.results).toEqual({});
    expect(r.state.tms).toEqual(s.tms);
  });
});

describe('testResultPreview (sanity guard)', () => {
  it('gives the Training Max, and low when under half the median of the other tested lifts', () => {
    let s = st({ tms: { squat: 0, bench: 0, deadlift: 0, ohp: 0 } });
    expect(testResultPreview(s, 'deadlift', 20, 5)).toEqual({ tm: 20, low: false }); // nothing tested yet
    s = result(s, '2026-10-24', 'squat', 110, 5).state; // 115
    expect(testResultPreview(s, 'deadlift', 20, 5)).toEqual({ tm: 20, low: true }); // 20 < 57.5
    expect(testResultPreview(s, 'deadlift', 120, 5)).toEqual({ tm: 125, low: false });
    s = result(s, '2026-10-25', 'bench', 70, 6).state; // 75: median of 75 and 115 = 95
    expect(testResultPreview(s, 'ohp', 40, 5).low).toBe(true); // 42.5 < 47.5 (half of 95)
    expect(testResultPreview(s, 'ohp', 45, 5).low).toBe(true); // 45 < 47.5
    expect(testResultPreview(s, 'ohp', 50, 5)).toEqual({ tm: 52.5, low: false });
    // the lift's own result never counts (a correction compares against the others)
    expect(testResultPreview(s, 'squat', 110, 5).low).toBe(false);
    expect(LOW_TM_WARNING).toBe("That's much lower than your other lifts — check the weight");
  });
});
