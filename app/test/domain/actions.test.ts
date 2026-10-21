import { describe, it, expect } from 'vitest';
import { applyAction, emptyAmrapLog, type Action, type AmrapLog } from '../../src/domain/actions';
import { isPlanned, planDays } from '../../src/domain/planner';
import type { PlannerState } from '../../src/domain/types';
import { baseState } from './fixtures';

const brief = (p: ReturnType<typeof planDays>) => p.map((d) => `${d.date}:${d.sessions.map((s) => `${s.kind === 'lift' ? `${s.lift}-${s.week}` : s.kind === 'run' ? s.run : s.kind === 'climb' ? (s.fallback ? 'boulder' : 'climb') : s.kind}${s.status === 'done' ? '(done)' : ''}`).join('+')}`);
const apply = (st: PlannerState, a: Action, log: AmrapLog = emptyAmrapLog()) => applyAction(st, a, log);
const WALL_A = { id: 'v1', date: '2026-10-09', time: '18:00', title: 'Friday climbing', venue: 'Wall A', type: 'partner' as const };

function deepFreeze<T>(o: T): T {
  if (o && typeof o === 'object') {
    Object.values(o).forEach(deepFreeze);
    Object.freeze(o);
  }
  return o;
}

describe('applyAction: lifts', () => {
  it('done lift records doneByDate + lastLiftDate and advances the pointer', () => {
    const { state } = apply(baseState(), { type: 'done', date: '2026-10-05', ref: { kind: 'lift', lift: 'squat', week: 1 } });
    expect(state.lift).toEqual({ week: 1, index: 1, phase: { kind: 'normal' } });
    expect(state.lastLiftDate).toBe('2026-10-05');
    expect(state.doneByDate['2026-10-05']).toEqual([{ kind: 'lift', lift: 'squat', week: 1 }]);
  });

  it('round trip: done lift stays done in its slot and the next head is not placed today', () => {
    const { state } = apply(baseState(), { type: 'done', date: '2026-10-05', ref: { kind: 'lift', lift: 'squat', week: 1 } });
    expect(brief(planDays(state, '2026-10-05', 7))).toEqual([
      '2026-10-05:squat-1(done)', '2026-10-06:easy+bench-1', '2026-10-07:quality-vert', '2026-10-08:ohp-1',
      '2026-10-09:deadlift-1+boulder', '2026-10-10:ruck', '2026-10-11:bench-2',
    ]);
  });

  it('done lift records the AMRAP for weeks 1-3 only', () => {
    const r1 = apply(baseState(), { type: 'done', date: '2026-10-05', ref: { kind: 'lift', lift: 'squat', week: 1 }, amrapReps: 8 });
    expect(r1.amrapLog.squat).toEqual({ 1: 8 });
    const st4 = baseState({ lift: { week: 4, index: 0, phase: { kind: 'normal' } } });
    const r4 = apply(st4, { type: 'done', date: '2026-10-05', ref: { kind: 'lift', lift: 'squat', week: 4 }, amrapReps: 8 });
    expect(r4.amrapLog.squat).toEqual({});
  });

  it('done lift wraps the pointer into the next cycle week', () => {
    const st = baseState({ lift: { week: 2, index: 3, phase: { kind: 'normal' } } });
    const { state } = apply(st, { type: 'done', date: '2026-10-05', ref: { kind: 'lift', lift: 'ohp', week: 2 } });
    expect(state.lift).toEqual({ week: 3, index: 0, phase: { kind: 'normal' } });
  });

  it('week-3 AMRAP success bumps the TM (+5 lower) and emits an event', () => {
    const st = baseState({ lift: { week: 3, index: 0, phase: { kind: 'normal' } } });
    const log = { ...emptyAmrapLog(), squat: { 1: 6, 2: 4 } };
    const r = apply(st, { type: 'done', date: '2026-10-05', ref: { kind: 'lift', lift: 'squat', week: 3 }, amrapReps: 2 }, log);
    expect(r.state.tms.squat).toBe(105);
    expect(r.events).toContain('TM squat 100→105');
    expect(r.amrapLog.squat).toEqual({});
  });

  it('week-3 AMRAP success bumps an upper lift by +2.5', () => {
    const st = baseState({ lift: { week: 3, index: 1, phase: { kind: 'normal' } } });
    const log = { ...emptyAmrapLog(), bench: { 1: 5, 2: 3 } };
    const r = apply(st, { type: 'done', date: '2026-10-08', ref: { kind: 'lift', lift: 'bench', week: 3 }, amrapReps: 1 }, log);
    expect(r.state.tms.bench).toBe(72.5);
    expect(r.events).toContain('TM bench 70→72.5');
  });

  it('week-3 with a missed AMRAP holds the TM and clears the log', () => {
    const st = baseState({ lift: { week: 3, index: 0, phase: { kind: 'normal' } } });
    const log = { ...emptyAmrapLog(), squat: { 1: 6, 2: 2 } };
    const r = apply(st, { type: 'done', date: '2026-10-05', ref: { kind: 'lift', lift: 'squat', week: 3 }, amrapReps: 3 }, log);
    expect(r.state.tms.squat).toBe(100);
    expect(r.amrapLog.squat).toEqual({});
    expect(r.events.some((e) => e.includes('squat') && e.includes('100'))).toBe(true);
  });

  it('done lift in reentry increments phase.done and returns to normal at 4 with the pointer unchanged', () => {
    const st = baseState({ lift: { week: 2, index: 2, phase: { kind: 'reentry', done: 1 } } });
    const r = apply(st, { type: 'done', date: '2026-10-05', ref: { kind: 'lift', lift: 'bench', week: 'reentry' }, amrapReps: 9 });
    expect(r.state.lift).toEqual({ week: 2, index: 2, phase: { kind: 'reentry', done: 2 } });
    expect(r.amrapLog.bench).toEqual({});
    const st3 = baseState({ lift: { week: 2, index: 2, phase: { kind: 'reentry', done: 3 } } });
    expect(apply(st3, { type: 'done', date: '2026-10-05', ref: { kind: 'lift', lift: 'ohp', week: 'reentry' } }).state.lift)
      .toEqual({ week: 2, index: 2, phase: { kind: 'normal' } });
  });

  it('done lift after a >= 7 day gap enters the Re-entry Week like the planner does', () => {
    const st = baseState({ lastLiftDate: '2026-10-09', lastClimbDate: '2026-10-18', lift: { week: 2, index: 2, phase: { kind: 'normal' } } });
    expect(brief(planDays(st, '2026-10-19', 1))).toEqual(['2026-10-19:squat-reentry']);
    const { state } = apply(st, { type: 'done', date: '2026-10-19', ref: { kind: 'lift', lift: 'squat', week: 'reentry' } });
    expect(state.lift).toEqual({ week: 2, index: 2, phase: { kind: 'reentry', done: 1 } });
    expect(brief(planDays(state, '2026-10-19', 4))).toEqual(['2026-10-19:squat-reentry(done)', '2026-10-20:easy+bench-reentry', '2026-10-21:quality-vert', '2026-10-22:ohp-reentry']);
  });

  it('skip lift advances the pointer but leaves lastLiftDate, doneByDate and the AMRAP log alone', () => {
    const r = apply(baseState(), { type: 'skip', date: '2026-10-05', ref: { kind: 'lift', lift: 'squat', week: 1 } });
    expect(r.state.lift).toEqual({ week: 1, index: 1, phase: { kind: 'normal' } });
    expect(r.state.lastLiftDate).toBe('2026-10-06');
    expect(r.state.doneByDate).toEqual({});
    expect(r.amrapLog.squat).toEqual({});
  });

  it('tomorrow lift: today no longer shows it, tomorrow does', () => {
    const st = baseState({
      defaultWeek: { ...baseState().defaultWeek, 1: { am: 'lift' } } as any,
      lift: { week: 1, index: 1, phase: { kind: 'normal' } },
    });
    expect(brief(planDays(st, '2026-10-05', 1))).toEqual(['2026-10-05:bench-1']);
    const { state } = apply(st, { type: 'tomorrow', date: '2026-10-05', ref: { kind: 'lift', lift: 'bench', week: 1 } });
    expect(state.lift.notBefore).toBe('2026-10-06');
    expect(state.lift.index).toBe(1);
    expect(brief(planDays(state, '2026-10-05', 1))).toEqual(['2026-10-05:']);
    expect(brief(planDays(state, '2026-10-06', 1))).toEqual(['2026-10-06:bench-1']);
  });

  describe('a swapped-in lift (legs blocked)', () => {
    const tueRunLift = { ...baseState().defaultWeek, 1: { am: 'run', pm: 'lift' } } as any;

    it('done on a lift ahead of the head records it in `ahead`; the head stays', () => {
      const st = baseState({ defaultWeek: tueRunLift, lastLiftDate: '2026-10-05', lift: { week: 1, index: 0, phase: { kind: 'normal' } } });
      expect(brief(planDays(st, '2026-10-06', 1))).toEqual(['2026-10-06:easy+bench-1']);
      const { state } = apply(st, { type: 'done', date: '2026-10-06', ref: { kind: 'lift', lift: 'bench', week: 1 }, amrapReps: 7 });
      expect(state.lift).toEqual({ week: 1, index: 0, phase: { kind: 'normal' }, ahead: ['bench'] });
      expect(state.lastLiftDate).toBe('2026-10-06');
      expect(brief(planDays(state, '2026-10-06', 1))).toEqual(['2026-10-06:easy+bench-1(done)']);
      // Then the squat (head): the pointer skips the bench already done, to the deadlift.
      const r2 = apply(state, { type: 'done', date: '2026-10-08', ref: { kind: 'lift', lift: 'squat', week: 1 } });
      expect(r2.state.lift).toEqual({ week: 1, index: 2, phase: { kind: 'normal' } });
    });

    it('skip on a lift ahead of the head records it too', () => {
      const st = baseState({ lift: { week: 1, index: 2, phase: { kind: 'normal' } } });
      const { state } = apply(st, { type: 'skip', date: '2026-10-06', ref: { kind: 'lift', lift: 'ohp', week: 1 } });
      expect(state.lift).toEqual({ week: 1, index: 2, phase: { kind: 'normal' }, ahead: ['ohp'] });
      expect(state.lastLiftDate).toBe(baseState().lastLiftDate);
    });

    it('the head past the round end wraps into the next Cycle week and clears `ahead`', () => {
      const st = baseState({ lift: { week: 2, index: 2, phase: { kind: 'normal' }, ahead: ['ohp'] } });
      const { state } = apply(st, { type: 'done', date: '2026-10-08', ref: { kind: 'lift', lift: 'deadlift', week: 2 } });
      expect(state.lift).toEqual({ week: 3, index: 0, phase: { kind: 'normal' } });
    });

    it('a swapped week-3 lift still closes its Cycle (TM bump keyed on the ref)', () => {
      const st = baseState({ lift: { week: 3, index: 0, phase: { kind: 'normal' } } });
      const log = { ...emptyAmrapLog(), bench: { 1: 5, 2: 3 } };
      const r = apply(st, { type: 'done', date: '2026-10-06', ref: { kind: 'lift', lift: 'bench', week: 3 }, amrapReps: 1 }, log);
      expect(r.state.tms.bench).toBe(72.5);
      expect(r.state.lift).toEqual({ week: 3, index: 0, phase: { kind: 'normal' }, ahead: ['bench'] });
    });

    it('in a Re-entry Week: the swapped lift is recorded, and the head then ends the Re-entry Week', () => {
      const st = baseState({ lift: { week: 2, index: 1, phase: { kind: 'reentry', done: 2 } } });
      const a = apply(st, { type: 'done', date: '2026-10-06', ref: { kind: 'lift', lift: 'ohp', week: 'reentry' } }).state;
      expect(a.lift).toEqual({ week: 2, index: 1, phase: { kind: 'reentry', done: 2, ahead: ['ohp'] } });
      const b = apply(a, { type: 'done', date: '2026-10-07', ref: { kind: 'lift', lift: 'deadlift', week: 'reentry' } }).state;
      expect(b.lift).toEqual({ week: 2, index: 1, phase: { kind: 'normal' } });
    });

    it('a Re-entry Week keeps the normal round\'s `ahead` for when the Cycle resumes', () => {
      const st = baseState({ lastLiftDate: '2026-09-20', lift: { week: 2, index: 0, phase: { kind: 'normal' }, ahead: ['bench'] } });
      const { state } = apply(st, { type: 'done', date: '2026-10-05', ref: { kind: 'lift', lift: 'squat', week: 'reentry' } });
      expect(state.lift).toEqual({ week: 2, index: 0, phase: { kind: 'reentry', done: 1 }, ahead: ['bench'] });
    });

    it('regression: a week-3 bench swapped in before a Re-entry Week is not planned or closed again afterwards', () => {
      const W = { 0: { am: 'lift' }, 1: { am: 'run', pm: 'lift' }, 2: { am: 'run' }, 3: { am: 'lift' }, 4: {}, 5: { am: 'run-long' }, 6: { am: 'lift' } } as any;
      let st = baseState({ defaultWeek: W, lift: { week: 3, index: 0, phase: { kind: 'normal' } }, lastLiftDate: '2026-10-11', lastClimbDate: '2026-12-31' });
      let log: AmrapLog = { ...emptyAmrapLog(), bench: { 1: 10, 2: 8 } };
      const act = (a: Action) => {
        if ('ref' in a) expect(isPlanned(st, a.date, a.ref)).toBe(true);
        const r = apply(st, a, log); st = r.state; log = r.amrapLog; return r;
      };
      act({ type: 'done', date: '2026-10-13', ref: { kind: 'run', run: 'easy' } });
      expect(act({ type: 'done', date: '2026-10-13', ref: { kind: 'lift', lift: 'bench', week: 3 }, amrapReps: 8 }).events).toContain('TM bench 70→72.5');
      expect(st.lift).toEqual({ week: 3, index: 0, phase: { kind: 'normal' }, ahead: ['bench'] });
      // 13 days without lifting: a Re-entry Week of all four, then the Cycle resumes at week 3 with bench still done.
      for (const [date, lift] of [['2026-10-26', 'squat'], ['2026-10-29', 'bench'], ['2026-11-01', 'deadlift'], ['2026-11-02', 'ohp']] as const) {
        act({ type: 'done', date, ref: { kind: 'lift', lift, week: 'reentry' } });
      }
      expect(st.lift).toEqual({ week: 3, index: 0, phase: { kind: 'normal' }, ahead: ['bench'] });
      const lifts = planDays(st, '2026-11-05', 14).flatMap((d) => d.sessions.filter((s) => s.kind === 'lift').map((s: any) => `${s.lift}-${s.week}`));
      expect(lifts).not.toContain('bench-3');
      act({ type: 'done', date: '2026-11-05', ref: { kind: 'lift', lift: 'squat', week: 3 } });
      expect(st.lift).toEqual({ week: 3, index: 2, phase: { kind: 'normal' } });
      expect(isPlanned(st, '2026-11-08', { kind: 'lift', lift: 'bench', week: 3 })).toBe(false);
      expect(st.tms.bench).toBe(72.5);
    });
  });

  it('done travel-strength sets lastLiftDate and doneByDate without moving the pointer', () => {
    const st = baseState({ constraints: [{ id: 'c', start: '2026-10-05', end: '2026-10-05', noGym: true }] });
    const { state } = apply(st, { type: 'done', date: '2026-10-05', ref: { kind: 'travel-strength' } });
    expect(state.lift).toEqual(st.lift);
    expect(state.lastLiftDate).toBe('2026-10-05');
    expect(brief(planDays(state, '2026-10-05', 1))).toEqual(['2026-10-05:travel-strength(done)']);
  });
});

describe('applyAction: runs', () => {
  it('done run appends the base kind to runsThisWeek and doneByDate', () => {
    const { state } = apply(baseState(), { type: 'done', date: '2026-10-06', ref: { kind: 'run', run: 'easy' } });
    expect(state.runsThisWeek['2026-10-05']).toEqual(['easy']);
    expect(state.doneByDate['2026-10-06']).toEqual([{ kind: 'run', run: 'easy' }]);
  });

  it('round trip: done run stays done in its slot and is not placed again (the Easy-run day lift goes in pm)', () => {
    const { state } = apply(baseState(), { type: 'done', date: '2026-10-06', ref: { kind: 'run', run: 'easy' } });
    expect(brief(planDays(state, '2026-10-06', 5))).toEqual([
      '2026-10-06:easy(done)+bench-1', '2026-10-07:quality-vert', '2026-10-08:ohp-1', '2026-10-09:squat-1+boulder', '2026-10-10:ruck',
    ]);
  });

  it('done quality flips nextQuality; done benchmark flips nextBenchmark', () => {
    const q = apply(baseState(), { type: 'done', date: '2026-10-07', ref: { kind: 'run', run: 'quality-vert' } }).state;
    expect(q.run.nextQuality).toBe('speed');
    expect(q.runsThisWeek['2026-10-05']).toEqual(['quality']);
    const b = apply(baseState(), { type: 'done', date: '2026-10-28', ref: { kind: 'run', run: 'benchmark-2k4' } }).state;
    expect(b.run.nextBenchmark).toBe('hill');
    expect(b.run.nextQuality).toBe('vert');
    expect(b.runsThisWeek['2026-10-26']).toEqual(['quality']);
  });

  it('done ruck credits the ruck and advances its step', () => {
    const { state } = apply(baseState(), { type: 'done', date: '2026-10-10', ref: { kind: 'run', run: 'ruck' } });
    expect(state.ruck).toEqual({ lastCredit: '2026-10-10', step: 1 });
    expect(state.runsThisWeek['2026-10-05']).toEqual(['long']);
  });

  it('skip run records the base kind but does not flip, credit, or add doneByDate', () => {
    const q = apply(baseState(), { type: 'skip', date: '2026-10-07', ref: { kind: 'run', run: 'quality-vert' } }).state;
    expect(q.runsThisWeek['2026-10-05']).toEqual(['quality']);
    expect(q.run.nextQuality).toBe('vert');
    expect(q.doneByDate).toEqual({});
    const r = apply(baseState(), { type: 'skip', date: '2026-10-10', ref: { kind: 'run', run: 'ruck' } }).state;
    expect(r.ruck).toEqual({ lastCredit: '2026-09-15', step: 0 });
    expect(r.runsThisWeek['2026-10-05']).toEqual(['long']);
  });

  it('tomorrow run sets runNotBefore to the next day', () => {
    const { state } = apply(baseState(), { type: 'tomorrow', date: '2026-10-06', ref: { kind: 'run', run: 'easy' } });
    expect(state.runNotBefore).toBe('2026-10-07');
    expect(brief(planDays(state, '2026-10-06', 2))).toEqual(['2026-10-06:', '2026-10-07:easy+bench-1']);
  });
});

describe('applyAction: climbs', () => {
  it('done climb sets lastClimbDate and doneByDate', () => {
    const st = baseState({ clubEvents: [WALL_A] });
    const { state } = apply(st, { type: 'done', date: '2026-10-09', ref: { kind: 'climb', eventId: 'v1' } });
    expect(state.lastClimbDate).toBe('2026-10-09');
    expect(state.doneByDate['2026-10-09']).toEqual([{ kind: 'climb', eventId: 'v1' }]);
  });

  it('round trip: a done Club Event climb shows once, as done, in pm', () => {
    const st = baseState({ clubEvents: [WALL_A] });
    const { state } = apply(st, { type: 'done', date: '2026-10-09', ref: { kind: 'climb', eventId: 'v1' } });
    const [fri] = planDays(state, '2026-10-09', 1);
    expect(fri.sessions.filter((s) => s.kind === 'climb')).toEqual([{ kind: 'climb', eventId: 'v1', slot: 'pm', status: 'done' }]);
  });

  it('round trip: a done Boulder Fallback is not re-placed', () => {
    const st = baseState({ lastClimbDate: '2026-09-30' });
    expect(brief(planDays(st, '2026-10-09', 1))).toEqual(['2026-10-09:squat-1+boulder']);
    const { state } = apply(st, { type: 'done', date: '2026-10-09', ref: { kind: 'climb', fallback: true } });
    expect(brief(planDays(state, '2026-10-09', 1))).toEqual(['2026-10-09:squat-1+boulder(done)']);
  });
});

describe('applyAction: Training Max', () => {
  it('test-results sets TMs via tmFromTest and resets the pointer', () => {
    const st = baseState({ lift: { week: 3, index: 2, phase: { kind: 'reentry', done: 1 }, notBefore: '2026-10-07' } });
    const r = apply(st, { type: 'test-results', date: '2026-10-06', results: { squat: { weight: 120, reps: 5 }, ohp: { weight: 50, reps: 5 } }, plateStepKg: 2.5 }, { ...emptyAmrapLog(), squat: { 1: 7 } });
    // squat: 0.9 * 120 * (1 + 5/30) = 126 -> 125; ohp: 0.9 * 50 * 7/6 = 52.5
    expect(r.state.tms).toEqual({ squat: 125, bench: 70, deadlift: 130, ohp: 52.5 });
    expect(r.state.lift).toEqual({ week: 1, index: 0, phase: { kind: 'normal' }, notBefore: '2026-10-07' });
    expect(r.state.lastLiftDate).toBe('2026-10-06');
    expect(r.amrapLog).toEqual(emptyAmrapLog());
    expect(r.events).toContain('TM squat 100→125');
  });

  it('test-results: Cycle 1 starts at the first lift Slot after the test day, with no Re-entry', () => {
    const st = baseState({ lastLiftDate: '2026-09-20', lift: { week: 2, index: 3, phase: { kind: 'normal' } }, runsThisWeek: { '2026-10-05': ['quality'] } });
    const { state } = apply(st, { type: 'test-results', date: '2026-10-06', results: { ohp: { weight: 50, reps: 5 } }, plateStepKg: 2.5 });
    const plan = planDays(state, '2026-10-06', 6);
    expect(plan[0].sessions.some((s) => s.kind === 'lift')).toBe(false);
    expect(plan.flatMap((d) => d.sessions.filter((s) => s.kind === 'lift').map((s: any) => `${d.date}:${s.lift}-${s.week}`))[0]).toBe('2026-10-08:squat-1');
  });

  it('set-tm sets one TM', () => {
    const r = apply(baseState(), { type: 'set-tm', lift: 'deadlift', tm: 140 });
    expect(r.state.tms.deadlift).toBe(140);
    expect(r.events).toContain('TM deadlift 130→140');
  });
});

describe('applyAction: set-history', () => {
  it('sets dates and ruck step; planner then places no fallback or ruck', () => {
    const r = apply(baseState(), { type: 'set-history', lastClimbDate: '2026-10-02', ruckLastCredit: '2026-09-24', lastLiftDate: '2026-09-30', ruckStep: 3 });
    expect(r.state.lastClimbDate).toBe('2026-10-02');
    expect(r.state.ruck).toEqual({ lastCredit: '2026-09-24', step: 3 });
    expect(r.state.lastLiftDate).toBe('2026-09-30');
    const kinds = planDays(r.state, '2026-10-02', 7).flatMap((d) => d.sessions.map((s) => (s.kind === 'climb' && s.fallback ? 'boulder' : s.kind === 'run' ? s.run : s.kind)));
    expect(kinds).not.toContain('boulder');
    expect(kinds).not.toContain('ruck');
  });

  it('null clears, undefined leaves unchanged, input is not mutated', () => {
    const st = deepFreeze(baseState({ lastClimbDate: '2026-10-01', lastLiftDate: '2026-09-29' }));
    const r = apply(st, { type: 'set-history', lastClimbDate: null, ruckLastCredit: null });
    expect(r.state.lastClimbDate).toBeUndefined();
    expect(r.state.ruck.lastCredit).toBeUndefined();
    expect(r.state.lastLiftDate).toBe('2026-09-29');
    expect(r.state.ruck.step).toBe(st.ruck.step);
  });
});

describe('applyAction: activities (spec §5)', () => {
  const act = (activity: Extract<Action, { type: 'activity' }>['activity'], date = '2026-10-08') =>
    apply(baseState(), { type: 'activity', date, activity }).state;

  it('climb sets lastClimbDate and never touches lifts', () => {
    const s = act({ sport: 'climb', hours: 2 });
    expect(s.lastClimbDate).toBe('2026-10-08');
    expect(s.lift).toEqual(baseState().lift);
    expect(s.lastLiftDate).toBe(baseState().lastLiftDate);
    expect(s.tms).toEqual(baseState().tms);
  });

  it('climb on a Club Event day counts as that climb Session', () => {
    const st = baseState({ clubEvents: [WALL_A] });
    const { state } = apply(st, { type: 'activity', date: '2026-10-09', activity: { sport: 'climb' } });
    expect(brief(planDays(state, '2026-10-09', 1))).toEqual(['2026-10-09:squat-1+climb(done)']);
  });

  it('hike >= 600 m credits a Hill Ruck and the long run; step only moves with packKg', () => {
    const a = act({ sport: 'hike', vertM: 650, hours: 4 });
    expect(a.ruck).toEqual({ lastCredit: '2026-10-08', step: 0 });
    expect(a.runsThisWeek['2026-10-05']).toEqual(['long']);
    const b = act({ sport: 'hike', vertM: 900, packKg: 12 });
    expect(b.ruck).toEqual({ lastCredit: '2026-10-08', step: 1 });
    expect(b.lift).toEqual(baseState().lift);
    expect(b.lastLiftDate).toBe(baseState().lastLiftDate);
  });

  it('hike with load >= 60 or >= 2 h (under 600 m) counts as the long run', () => {
    expect(act({ sport: 'hike', vertM: 300, load: 60 }).runsThisWeek['2026-10-05']).toEqual(['long']);
    expect(act({ sport: 'hike', vertM: 300, hours: 2 }).runsThisWeek['2026-10-05']).toEqual(['long']);
    expect(act({ sport: 'hike', vertM: 300, hours: 2 }).ruck).toEqual(baseState().ruck);
  });

  it('hike with load 25-60 counts as an easy run; smaller hikes count as nothing', () => {
    expect(act({ sport: 'hike', load: 25, hours: 1 }).runsThisWeek['2026-10-05']).toEqual(['easy']);
    expect(act({ sport: 'hike', load: 59, hours: 1 }).runsThisWeek['2026-10-05']).toEqual(['easy']);
    expect(act({ sport: 'hike', load: 24, hours: 1 }).runsThisWeek).toEqual({});
  });

  it('run on a day with a planned run counts as that run Session', () => {
    const s = act({ sport: 'run', km: 7 }, '2026-10-07');
    expect(s.runsThisWeek['2026-10-05']).toEqual(['easy']);
    expect(brief(planDays(s, '2026-10-07', 1))).toEqual(['2026-10-07:easy(done)+bench-1']);
  });

  it('run on a day without a run Slot credits the first remaining of easy -> quality -> long', () => {
    const st = baseState({ runsThisWeek: { '2026-10-05': ['easy'] } });
    const s = apply(st, { type: 'activity', date: '2026-10-08', activity: { sport: 'run', km: 6 } }).state;
    expect(s.runsThisWeek['2026-10-05']).toEqual(['easy', 'quality']);
    expect(s.doneByDate).toEqual({});
    expect(s.lift).toEqual(st.lift);
  });

  it('run on a day whose run Session is already done (tapped Done) credits nothing more', () => {
    const tapped = apply(baseState(), { type: 'done', date: '2026-10-07', ref: { kind: 'run', run: 'easy' } }).state;
    const s = apply(tapped, { type: 'activity', date: '2026-10-07', activity: { sport: 'run', km: 7 } }).state;
    expect(s.runsThisWeek).toEqual(tapped.runsThisWeek);
    expect(s.doneByDate).toEqual(tapped.doneByDate);
  });
});

describe('acceptance: a calendar with a crag trip', () => {
  const st0 = baseState({
    lift: { week: 3, index: 2, phase: { kind: 'normal' } }, lastLiftDate: '2026-10-11',
    // The fixture's own dates, moved by the same three weeks as the trip.
    run: { ...baseState().run, runStartMonday: '2026-10-26' }, ruck: { lastCredit: '2026-10-06', step: 0 }, lastClimbDate: '2026-10-23',
    clubEvents: [{ ...WALL_A, date: '2026-10-30' }],
    constraints: [
      { id: 'crag-trip', start: '2026-10-31', end: '2026-11-05', timezone: 'Europe/Rome', noGym: true, note: 'Crag trip' },
      { id: 'crag', start: '2026-11-01', end: '2026-11-03', mountain: true },
    ],
  });
  const { state } = apply(st0, { type: 'test-results', date: '2026-10-27', results: { squat: { weight: 100, reps: 5 }, bench: { weight: 70, reps: 5 }, deadlift: { weight: 120, reps: 5 }, ohp: { weight: 45, reps: 5 } }, plateStepKg: 2.5 });
  const plan = planDays(state, '2026-10-28', 21);

  it('lays out the three weeks around the trip', () => {
    expect(brief(plan)).toEqual([
      '2026-10-28:easy+bench-1', '2026-10-29:squat-1', '2026-10-30:deadlift-1+climb', // a lift after the Easy run and before the Club Event
      '2026-10-31:long', // Departure Day: Long allowed, the due ruck waits
      '2026-11-01:', '2026-11-02:', '2026-11-03:', // mountain days
      '2026-11-04:easy+travel-strength', // no gym on the trip: Travel Strength holds the Cycle (and the Re-entry clock)
      '2026-11-05:', // Arrival Day
      '2026-11-06:', // the Default Week's empty Friday
      '2026-11-07:ruck', // the ruck that waited
      '2026-11-08:ohp-1', // the Cycle resumes at OHP (the deadlift went on 30 Oct); no Re-entry Week, Travel Strength was 4 Nov
      '2026-11-09:squat-2', '2026-11-10:easy+boulder', // 7 days without a climb since the mountain days: Boulder Fallback
      '2026-11-11:quality-vert', '2026-11-12:bench-2', '2026-11-13:',
      '2026-11-14:long', '2026-11-15:ohp-2', '2026-11-16:deadlift-2', '2026-11-17:easy+boulder',
    ]);
  });

  it('marks the Travel Days and places no Boulder Fallback during the trip', () => {
    const byDate = Object.fromEntries(plan.map((d) => [d.date, d]));
    expect(byDate['2026-10-31'].travel).toBe('departure');
    expect(byDate['2026-11-05'].travel).toBe('arrival');
    expect(plan.filter((d) => d.date >= '2026-10-31' && d.date <= '2026-11-05').flatMap((d) => d.sessions).some((s) => s.kind === 'climb' && s.fallback)).toBe(false);
  });
});

describe('applyAction: hike credit never moves the Hill Ruck clock backwards (D4)', () => {
  it('a hike dated before the stored ruck credit keeps the later date', () => {
    const st = baseState({ ruck: { lastCredit: '2026-10-10', step: 2 } });
    const s = apply(st, { type: 'activity', date: '2026-10-08', activity: { sport: 'hike', vertM: 600 } }).state;
    expect(s.ruck.lastCredit).toBe('2026-10-10');
  });
});

describe('applyAction: late Activities (spec §5)', () => {
  const late = (st: PlannerState, date: string, activity: Extract<Action, { type: 'activity' }>['activity'], today = '2026-10-08') =>
    apply(st, { type: 'activity', date, today, activity }).state;

  it('a late run never credits a run Session, the run queue or doneByDate', () => {
    const st = baseState();
    const s = late(st, '2026-10-07', { sport: 'run', km: 7 });
    expect(s.runsThisWeek).toEqual(st.runsThisWeek);
    expect(s.doneByDate).toEqual(st.doneByDate);
    expect(s.run).toEqual(st.run);
    expect(brief(planDays(s, '2026-10-07', 1))).toEqual(brief(planDays(st, '2026-10-07', 1)));
  });

  it('a late 600 m hike moves the Hill Ruck clock forward only, with no Long run credit or step', () => {
    const st = baseState({ ruck: { lastCredit: '2026-09-20', step: 1 } });
    const s = late(st, '2026-10-05', { sport: 'hike', vertM: 600, hours: 3.5, packKg: 10 });
    expect(s.ruck).toEqual({ lastCredit: '2026-10-05', step: 1 });
    expect(s.runsThisWeek).toEqual(st.runsThisWeek);
    const newer = baseState({ ruck: { lastCredit: '2026-10-06', step: 1 } });
    expect(late(newer, '2026-10-05', { sport: 'hike', vertM: 600 }).ruck).toEqual({ lastCredit: '2026-10-06', step: 1 });
  });

  it('a late climb moves the climb clock forward only and marks no Session done', () => {
    const st = baseState({ clubEvents: [{ ...WALL_A, date: '2026-10-07' }], lastClimbDate: '2026-10-01' });
    const s = late(st, '2026-10-07', { sport: 'climb' }, '2026-10-09');
    expect(s.lastClimbDate).toBe('2026-10-07');
    expect(s.doneByDate).toEqual(st.doneByDate);
    expect(late(baseState({ lastClimbDate: '2026-10-08' }), '2026-10-07', { sport: 'climb' }).lastClimbDate).toBe('2026-10-08');
  });

  it("today's Activities still credit as before", () => {
    const s = late(baseState(), '2026-10-08', { sport: 'hike', vertM: 600 });
    expect(s.ruck.lastCredit).toBe('2026-10-08');
    expect(s.runsThisWeek['2026-10-05']).toEqual(['long']);
    const r = late(baseState(), '2026-10-07', { sport: 'run', km: 7 }, '2026-10-07');
    expect(brief(planDays(r, '2026-10-07', 1))).toEqual(['2026-10-07:easy(done)+bench-1']);
  });
});

describe('applyAction: housekeeping', () => {
  it('prunes doneByDate to the last 14 days', () => {
    const st = baseState({ doneByDate: {
      '2026-09-21': [{ kind: 'run', run: 'easy' }],
      '2026-09-22': [{ kind: 'run', run: 'easy' }],
      '2026-10-01': [{ kind: 'run', run: 'easy' }],
    } });
    const { state } = apply(st, { type: 'done', date: '2026-10-06', ref: { kind: 'run', run: 'easy' } });
    expect(Object.keys(state.doneByDate).sort()).toEqual(['2026-09-22', '2026-10-01', '2026-10-06']);
  });

  it('never mutates the input state or AMRAP log', () => {
    const st = deepFreeze(baseState({ clubEvents: [WALL_A], doneByDate: { '2026-10-05': [{ kind: 'lift', lift: 'squat', week: 3 }] }, lift: { week: 3, index: 1, phase: { kind: 'normal' } } }));
    const log = deepFreeze({ ...emptyAmrapLog(), bench: { 1: 5, 2: 3 } });
    const before = JSON.stringify([st, log]);
    const actions: Action[] = [
      { type: 'done', date: '2026-10-05', ref: { kind: 'lift', lift: 'bench', week: 3 }, amrapReps: 2 },
      { type: 'skip', date: '2026-10-05', ref: { kind: 'lift', lift: 'bench', week: 3 } },
      { type: 'tomorrow', date: '2026-10-05', ref: { kind: 'lift', lift: 'bench', week: 3 } },
      { type: 'done', date: '2026-10-10', ref: { kind: 'run', run: 'ruck' } },
      { type: 'done', date: '2026-10-07', ref: { kind: 'run', run: 'quality-vert' } },
      { type: 'done', date: '2026-10-09', ref: { kind: 'climb', eventId: 'v1' } },
      { type: 'test-results', date: '2026-10-06', results: { squat: { weight: 100, reps: 5 } }, plateStepKg: 2.5 },
      { type: 'set-tm', lift: 'ohp', tm: 50 },
      { type: 'activity', date: '2026-10-07', activity: { sport: 'run' } },
      { type: 'activity', date: '2026-10-09', activity: { sport: 'climb' } },
      { type: 'activity', date: '2026-10-08', activity: { sport: 'hike', vertM: 800, packKg: 12 } },
    ];
    for (const a of actions) applyAction(st, a, log);
    expect(JSON.stringify([st, log])).toBe(before);
  });
});
