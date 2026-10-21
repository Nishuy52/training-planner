import { describe, it, expect } from 'vitest';
import { planDays } from '../../src/domain/planner';
import { baseState } from './fixtures';
import { defaultState } from '../../src/store/db';
const brief = (p: ReturnType<typeof planDays>) => p.map((d) => `${d.date}:${d.sessions.map((s) => s.kind === 'lift' ? `${s.lift}-${s.week}` : s.kind === 'run' ? s.run : s.kind === 'climb' ? (s.fallback ? 'boulder' : 'climb') : s.kind).join('+')}`);
const liftsOnly = (p: ReturnType<typeof planDays>) => p.flatMap((d) => d.sessions.filter((s) => s.kind === 'lift').map((s: any) => `${d.date}:${s.lift}-${s.week}`));

describe('planDays', () => {
  it('lays out a normal home week from the Default Week', () => {
    const st = baseState({ clubEvents: [{ id: 'v1', date: '2026-10-09', time: '18:00', title: 'Friday climbing', venue: 'Wall A', type: 'partner' }] });
    expect(brief(planDays(st, '2026-10-05', 7))).toEqual([
      '2026-10-05:squat-1', '2026-10-06:easy+bench-1', '2026-10-07:quality-vert', '2026-10-08:ohp-1',
      '2026-10-09:deadlift-1+climb', '2026-10-10:ruck', '2026-10-11:bench-2',
    ]);
  });

  it('rolling: a lift not done today shows up at the next lift slot (state unchanged = still pending)', () => {
    const st = baseState();
    // Monday passes with nothing done; plan from Tuesday. Tue pm follows the Easy run (bench swaps in), Thu follows
    // Wed's Quality (OHP swaps in); Fri's Boulder Fallback brings an am lift, and the squat lands there.
    expect(liftsOnly(planDays(st, '2026-10-06', 6))).toEqual(['2026-10-06:bench-1', '2026-10-08:ohp-1', '2026-10-09:squat-1']);
  });

  it('done sessions stay on their day and do not re-place the next head', () => {
    const st = baseState({ lift: { week: 1, index: 1, phase: { kind: 'normal' } }, lastLiftDate: '2026-10-05', doneByDate: { '2026-10-05': [{ kind: 'lift', lift: 'squat', week: 1 }] } });
    const [mon] = planDays(st, '2026-10-05', 1);
    expect(mon.sessions).toEqual([{ kind: 'lift', lift: 'squat', week: 1, slot: 'am', status: 'done' }]);
  });

  it('week rollover: after 4 lifts the cycle week advances', () => {
    const st = baseState({ lift: { week: 1, index: 3, phase: { kind: 'normal' } } });
    // Tue pm follows the Easy run: the week-2 squat yields to bench, still week 2; Thu follows Wed's Quality: OHP.
    expect(liftsOnly(planDays(st, '2026-10-05', 4))).toEqual(['2026-10-05:ohp-1', '2026-10-06:bench-2', '2026-10-08:ohp-2']);
  });

  it('re-entry week after >= 7 days without lifting, then resumes the pointer', () => {
    const st = baseState({ lastLiftDate: '2026-10-09', lift: { week: 2, index: 2, phase: { kind: 'normal' } } });
    // Tue 20 after the Easy run: bench swaps in; Thu 22 after the Quality: OHP; Sun 25 after the Hill Ruck with no upper
    // lift left: empty; Mon 26 the deadlift ends the Re-entry Week; Tue 27 after the Easy run: the week-2 OHP swaps in.
    expect(liftsOnly(planDays(st, '2026-10-19', 14)).slice(0, 5)).toEqual(['2026-10-19:squat-reentry', '2026-10-20:bench-reentry', '2026-10-22:ohp-reentry', '2026-10-26:deadlift-reentry', '2026-10-27:ohp-2']);
  });

  it('no_gym constraint turns lift slots into travel strength without moving the pointer', () => {
    const st = baseState({ constraints: [{ id: 'c', start: '2026-10-05', end: '2026-10-08', noGym: true, travelDays: false }] });
    expect(brief(planDays(st, '2026-10-05', 7)).filter((s) => /travel|squat-/.test(s))).toEqual(['2026-10-05:travel-strength', '2026-10-06:easy+travel-strength', '2026-10-08:travel-strength', '2026-10-09:squat-1+boulder']);
  });

  it('mountain days place no runs, lifts or climbs; a Club Event there is a Skipped note', () => {
    const st = baseState({
      constraints: [{ id: 'm', start: '2026-11-01', end: '2026-11-03', mountain: true }],
      clubEvents: [{ id: 'wall-a', date: '2026-11-03', time: '18:00', title: 'Tuesday climbing', venue: 'Wall A', type: 'partner' }],
    });
    const plan = planDays(st, '2026-11-01', 3);
    expect(plan.every((d) => d.mountain && d.sessions.length === 0)).toBe(true);
    expect(plan[2]!.notes).toEqual(['Skipped: Wall A 18:00 (mountain day)']);
    expect(plan.slice(0, 2).every((d) => d.notes === undefined)).toBe(true);
  });

  it('runs roll within the week; long stays on the run-long slot', () => {
    const st = baseState({ runsThisWeek: {}, ruck: { lastCredit: '2026-10-01', step: 0 } });
    // Tuesday missed -> plan from Wednesday: easy Wed, quality has no Tue/Wed slot left -> dropped, long Sat
    expect(brief(planDays(st, '2026-10-07', 4)).filter((s) => /easy|quality|long/.test(s))).toEqual(['2026-10-07:easy+bench-1', '2026-10-10:long']);
  });

  it('rucks disabled: a due ruck becomes a plain long; enabled: ruck', () => {
    const longs = (st: ReturnType<typeof baseState>) => brief(planDays(st, '2026-10-10', 1)).map((s) => s.split('+')[0]).filter((s) => /long|ruck/.test(s!));
    expect(longs(baseState({ rucksEnabled: false }))).toEqual(['2026-10-10:long']);
    expect(longs(baseState({ rucksEnabled: true }))).toEqual(['2026-10-10:ruck']);
  });

  it('quality alternates vert/speed across weeks', () => {
    const st = baseState({ ruck: { lastCredit: '2026-10-01', step: 0 } });
    const q = brief(planDays(st, '2026-10-05', 14)).filter((s) => s.includes('quality'));
    expect(q).toEqual(['2026-10-07:quality-vert', '2026-10-14:quality-speed']);
  });

  it('deload run week (4th week) swaps quality for an alternating benchmark', () => {
    const st = baseState({ ruck: { lastCredit: '2026-10-25', step: 0 } });
    expect(brief(planDays(st, '2026-10-26', 7)).find((s) => s.includes('benchmark'))).toBe('2026-10-28:benchmark-2k4');
  });

  it('boulder fallback after 7 climb-free days with no club event in the next 2 days', () => {
    const st = baseState({ lastClimbDate: '2026-09-30', runsThisWeek: { '2026-10-05': ['easy'] } });
    expect(brief(planDays(st, '2026-10-07', 1))).toEqual(['2026-10-07:quality-vert+boulder']);
  });

  it('legs are fine the day before a hard run', () => {
    const st = baseState({ defaultWeek: { ...baseState().defaultWeek, 1: { am: 'lift' }, 2: { am: 'run' } } as any, runsThisWeek: { '2026-10-05': ['easy'] }, lift: { week: 1, index: 0, phase: { kind: 'normal' } } });
    // Tue lift slot, Wed quality: the squat goes Tuesday
    expect(brief(planDays(st, '2026-10-06', 2))).toEqual(['2026-10-06:squat-1', '2026-10-07:quality-vert']);
  });
});

describe('planDays edge cases', () => {
  const runsOnly = (p: ReturnType<typeof planDays>) => brief(p).filter((s) => /easy|quality|long|ruck|benchmark/.test(s));
  const wallA = (date: string) => ({ id: `v-${date}`, date, time: '18:00', title: 'Climbing', venue: 'Wall A', type: 'partner' as const });

  it('does not mutate state', () => {
    const st = baseState({ clubEvents: [wallA('2026-10-09')], lastLiftDate: '2026-09-20' });
    const before = JSON.stringify(st);
    planDays(st, '2026-10-05', 21);
    expect(JSON.stringify(st)).toBe(before);
  });

  it('Tomorrow on a lift (lift.notBefore) holds the head until the next lift Slot on/after that date', () => {
    const st = baseState({ lift: { week: 1, index: 0, phase: { kind: 'normal' }, notBefore: '2026-10-06' } });
    // Nothing Mon; Tue pm after the Easy run (bench swaps in), Thu after Wed's Quality (OHP); the squat takes Fri's am
    // before the Boulder Fallback.
    expect(liftsOnly(planDays(st, '2026-10-05', 7))).toEqual(['2026-10-06:bench-1', '2026-10-08:ohp-1', '2026-10-09:squat-1']);
  });

  it('Tomorrow on a run (runNotBefore) holds all runs until that date', () => {
    const st = baseState({ runNotBefore: '2026-10-07' });
    expect(runsOnly(planDays(st, '2026-10-06', 5))).toEqual(['2026-10-07:easy+bench-1', '2026-10-10:ruck']);
  });

  it('a Club Event on the day or within 2 days suppresses the Boulder Fallback', () => {
    const st = baseState({ lastClimbDate: '2026-09-28', clubEvents: [wallA('2026-10-07')] });
    const climbs = brief(planDays(st, '2026-10-05', 3)).filter((s) => /climb|boulder/.test(s));
    expect(climbs).toEqual(['2026-10-07:quality-vert+climb']);
  });

  it('a Club Event resets the climb clock for later Boulder Fallbacks', () => {
    const st = baseState({ lastClimbDate: '2026-09-01', clubEvents: [wallA('2026-10-09')] });
    const climbs = brief(planDays(st, '2026-10-09', 10)).filter((s) => /climb|boulder/.test(s));
    expect(climbs).toEqual(['2026-10-09:squat-1+climb', '2026-10-16:squat-2+boulder']);
  });

  it('runsThisWeek only counts for its own ISO week; a fresh week gets all three runs', () => {
    const st = baseState({ runsThisWeek: { '2026-10-05': ['easy', 'quality', 'long'] }, ruck: { lastCredit: '2026-10-01', step: 0 } });
    expect(runsOnly(planDays(st, '2026-10-05', 14))).toEqual(['2026-10-13:easy+bench-2', '2026-10-14:quality-vert', '2026-10-17:long']);
  });

  it('long goes in a run Slot when the week has no usable run-long Slot left (mountain Saturday)', () => {
    const st = baseState({
      runsThisWeek: { '2026-10-05': ['easy'] }, ruck: { lastCredit: '2026-10-01', step: 0 },
      constraints: [{ id: 'm', start: '2026-10-10', end: '2026-10-10', mountain: true }],
    });
    expect(runsOnly(planDays(st, '2026-10-06', 6))).toEqual(['2026-10-06:quality-vert', '2026-10-07:long']);
  });

  it('done runs stay on their day and are not placed again', () => {
    const st = baseState({ runsThisWeek: { '2026-10-05': ['easy'] }, doneByDate: { '2026-10-06': [{ kind: 'run', run: 'easy' }] } });
    const [tue, wed] = planDays(st, '2026-10-06', 2);
    expect(tue.sessions).toEqual([
      { kind: 'run', run: 'easy', slot: 'am', status: 'done' },
      { kind: 'lift', lift: 'bench', week: 1, slot: 'pm', status: 'planned' },
    ]);
    expect(wed.sessions.map((s: any) => s.run)).toEqual(['quality-vert']);
  });

  it('Travel Strength resets the Re-entry clock (no re-entry after a no_gym stretch)', () => {
    const st = baseState({ lastLiftDate: '2026-09-20', constraints: [{ id: 'c', start: '2026-10-05', end: '2026-10-08', noGym: true, travelDays: false }] });
    expect(brief(planDays(st, '2026-10-05', 7)).filter((s) => /travel|squat|bench/.test(s))).toEqual(['2026-10-05:travel-strength', '2026-10-06:easy+travel-strength', '2026-10-08:travel-strength', '2026-10-09:squat-1+boulder', '2026-10-11:bench-1']);
  });

  it('a no_gym day in the middle of a Re-entry Week keeps the re-entry position', () => {
    const st = baseState({ lastLiftDate: '2026-10-01', lastClimbDate: '2026-10-14', constraints: [{ id: 'c', start: '2026-10-15', end: '2026-10-15', noGym: true, travelDays: false }] });
    expect(brief(planDays(st, '2026-10-12', 7)).filter((s) => /travel|(squat|bench|deadlift|ohp)-/.test(s))).toEqual(['2026-10-12:squat-reentry', '2026-10-13:easy+bench-reentry', '2026-10-15:travel-strength', '2026-10-18:ohp-reentry']);
  });

  it('day context fields are carried onto the DayPlan', () => {
    const st = baseState({ constraints: [{ id: 's', start: '2026-10-31', end: '2026-11-05', timezone: 'Europe/Rome', noGym: true, note: 'Crag trip' }] });
    expect(planDays(st, '2026-10-31', 1)[0]).toMatchObject({ date: '2026-10-31', timezone: 'Europe/Rome', gymProfileId: null, noGym: true, mountain: false, note: 'Crag trip' });
  });
});

describe('planDays: spec §1/§4 rule changes', () => {
  const ev = (id: string, date: string, time: string, venue: string) => ({ id, date, time, title: 'Climbing', venue, type: 'partner' as const });

  describe('Club Events always go in PM', () => {
    it('a second Club Event the same day becomes a note, never the AM Slot', () => {
      const st = baseState({ clubEvents: [ev('a', '2026-10-11', '16:00', 'Wall B'), ev('b', '2026-10-11', '20:00', 'Wall B')], defaultWeek: { ...baseState().defaultWeek, 6: {} } as any });
      const [sun] = planDays(st, '2026-10-11', 1);
      expect(sun.sessions.filter((s) => s.slot === 'pm')).toEqual([{ kind: 'climb', eventId: 'a', slot: 'pm', status: 'planned' }]);
      expect(sun.notes).toEqual(['Also: Wall B 20:00']);
    });

    it('a climb already done in PM turns the Club Event into a note', () => {
      const st = baseState({ clubEvents: [ev('v', '2026-10-09', '18:00', 'Wall A')], doneByDate: { '2026-10-09': [{ kind: 'climb', fallback: true }] } });
      const [fri] = planDays(st, '2026-10-09', 1);
      expect(fri.sessions.filter((s) => s.slot === 'pm')).toEqual([{ kind: 'climb', fallback: true, slot: 'pm', status: 'done' }]);
      expect(fri.notes).toEqual(['Also: Wall A 18:00']);
    });

    it('a day without extra events has no notes', () => {
      const st = baseState({ clubEvents: [ev('v', '2026-10-09', '18:00', 'Wall A')] });
      expect(planDays(st, '2026-10-09', 1)[0].notes).toBeUndefined();
    });
  });

  describe('legs after runs (spec §1)', () => {
    const W = (over: Record<number, object>) => ({ 0: {}, 1: {}, 2: {}, 3: {}, 4: {}, 5: {}, 6: {}, ...over }) as any;
    const quiet = { lastClimbDate: '2026-12-31', lastLiftDate: '2026-10-04' };

    it('no legs in a Slot after a run that day: the next upper lift swaps in, the leg lift stays the head', () => {
      // Tue am run / pm lift, Thu am lift
      const st = baseState({ ...quiet, defaultWeek: W({ 1: { am: 'run', pm: 'lift' }, 3: { am: 'lift' } }) });
      const plan = planDays(st, '2026-10-06', 3);
      expect(plan[0]!.sessions).toEqual([
        { kind: 'run', run: 'easy', slot: 'am', status: 'planned' },
        { kind: 'lift', lift: 'bench', week: 1, slot: 'pm', status: 'planned' },
      ]);
      expect(liftsOnly(plan)).toEqual(['2026-10-06:bench-1', '2026-10-08:squat-1']);
    });

    it('a done run in am blocks legs in pm too', () => {
      const st = baseState({ ...quiet, defaultWeek: W({ 1: { am: 'run', pm: 'lift' } }), doneByDate: { '2026-10-06': [{ kind: 'run', run: 'easy' }] } });
      expect(liftsOnly(planDays(st, '2026-10-06', 1))).toEqual(['2026-10-06:bench-1']);
    });

    it('legs before a run the same day are fine', () => {
      const st = baseState({ ...quiet, defaultWeek: W({ 0: { am: 'lift', pm: 'run' } }) });
      expect(brief(planDays(st, '2026-10-05', 1))).toEqual(['2026-10-05:squat-1+easy']);
    });

    it('no legs the day after a planned hard run; the day after an Easy run is fine', () => {
      const st = baseState({ ...quiet, runsThisWeek: { '2026-10-05': ['easy'] }, defaultWeek: W({ 1: { am: 'run' }, 2: { am: 'lift' } }) });
      expect(brief(planDays(st, '2026-10-06', 2))).toEqual(['2026-10-06:quality-vert', '2026-10-07:bench-1']);
      const easy = baseState({ ...quiet, defaultWeek: W({ 1: { am: 'run' }, 2: { am: 'lift' } }) });
      expect(brief(planDays(easy, '2026-10-06', 2))).toEqual(['2026-10-06:easy+bench-1', '2026-10-07:squat-1']);
    });

    it('no legs the day after a done hard run (planning from the next day)', () => {
      const st = baseState({ ...quiet, defaultWeek: W({ 2: { am: 'lift' } }), doneByDate: { '2026-10-06': [{ kind: 'run', run: 'long' }] } });
      expect(brief(planDays(st, '2026-10-07', 1))).toEqual(['2026-10-07:bench-1']);
      const easy = baseState({ ...quiet, defaultWeek: W({ 2: { am: 'lift' } }), doneByDate: { '2026-10-06': [{ kind: 'run', run: 'easy' }] } });
      expect(brief(planDays(easy, '2026-10-07', 1))).toEqual(['2026-10-07:squat-1']);
    });

    it('after a swap the leg lift lands in the next allowed Slot and the pointer skips the lift done ahead', () => {
      // Tue pm after a run: bench; Wed squat; Thu deadlift (bench is already done this round); Fri ohp
      const st = baseState({ ...quiet, defaultWeek: W({ 1: { am: 'run', pm: 'lift' }, 2: { am: 'lift' }, 3: { am: 'lift' }, 4: { am: 'lift' }, 5: { am: 'lift' } }) });
      expect(liftsOnly(planDays(st, '2026-10-06', 5))).toEqual(['2026-10-06:bench-1', '2026-10-07:squat-1', '2026-10-08:deadlift-1', '2026-10-09:ohp-1', '2026-10-10:squat-2']);
    });

    it('the swap takes OHP when bench is already done ahead', () => {
      const st = baseState({ ...quiet, lift: { week: 1, index: 0, phase: { kind: 'normal' }, ahead: ['bench'] }, defaultWeek: W({ 1: { am: 'run', pm: 'lift' } }) });
      expect(liftsOnly(planDays(st, '2026-10-06', 1))).toEqual(['2026-10-06:ohp-1']);
    });

    it('no upper lift left in the round after a hard run: the Slot stays empty (never the next round)', () => {
      const wk = W({ 2: { am: 'lift' } });
      const hard = { '2026-10-06': [{ kind: 'run' as const, run: 'quality-vert' as const }] };
      const dl = baseState({ ...quiet, lift: { week: 1, index: 2, phase: { kind: 'normal' }, ahead: ['ohp'] }, defaultWeek: wk, doneByDate: hard });
      expect(brief(planDays(dl, '2026-10-07', 1))).toEqual(['2026-10-07:']);
      const sq = baseState({ ...quiet, lift: { week: 1, index: 0, phase: { kind: 'normal' }, ahead: ['bench', 'ohp'] }, defaultWeek: wk, doneByDate: hard });
      expect(brief(planDays(sq, '2026-10-07', 1))).toEqual(['2026-10-07:']);
    });

    it('stuck (no upper lift left): legs may follow an Easy run the same day', () => {
      const wk = W({ 1: { am: 'run', pm: 'lift' } });
      const dl = baseState({ ...quiet, lift: { week: 1, index: 2, phase: { kind: 'normal' }, ahead: ['ohp'] }, defaultWeek: wk });
      expect(brief(planDays(dl, '2026-10-06', 1))).toEqual(['2026-10-06:easy+deadlift-1']);
    });

    it('stuck: never after a hard run the same day, nor on an Easy-run day that follows a hard run', () => {
      const lift = { week: 1 as const, index: 2, phase: { kind: 'normal' as const }, ahead: ['ohp' as const] };
      const sameDay = baseState({ ...quiet, lift, runsThisWeek: { '2026-10-05': ['easy'] }, defaultWeek: W({ 1: { am: 'run', pm: 'lift' } }) });
      expect(brief(planDays(sameDay, '2026-10-06', 1))).toEqual(['2026-10-06:quality-vert']);
      const dayAfter = baseState({ ...quiet, lift, defaultWeek: W({ 1: { am: 'run', pm: 'lift' } }), doneByDate: { '2026-10-05': [{ kind: 'run', run: 'long' }] } });
      expect(brief(planDays(dayAfter, '2026-10-06', 1))).toEqual(['2026-10-06:easy']);
    });

    it('in a Re-entry Week the swap stays within the Re-entry round', () => {
      const st = baseState({ lastClimbDate: '2026-12-31', lastLiftDate: '2026-09-20', lift: { week: 2, index: 1, phase: { kind: 'normal' } }, defaultWeek: W({ 1: { am: 'run', pm: 'lift' } }) });
      expect(liftsOnly(planDays(st, '2026-10-06', 1))).toEqual(['2026-10-06:bench-reentry']);
    });
  });

  describe('a lift before a climb (spec §1)', () => {
    const W = (over: Record<number, object>) => ({ 0: {}, 1: {}, 2: {}, 3: {}, 4: {}, 5: {}, 6: {}, ...over }) as any;
    const fri = ev('v', '2026-10-09', '18:00', 'Wall A');

    it('a Club Event day gets a lift in am', () => {
      const st = baseState({ lastClimbDate: '2026-10-08', defaultWeek: W({}), clubEvents: [fri] });
      expect(planDays(st, '2026-10-09', 1)[0]!.sessions).toEqual([
        { kind: 'lift', lift: 'squat', week: 1, slot: 'am', status: 'planned' },
        { kind: 'climb', eventId: 'v', slot: 'pm', status: 'planned' },
      ]);
    });

    it('a Boulder Fallback day gets a lift in am, and a done climb counts too', () => {
      const st = baseState({ lastClimbDate: '2026-09-01', defaultWeek: W({}) });
      expect(brief(planDays(st, '2026-10-09', 1))).toEqual(['2026-10-09:squat-1+boulder']);
      const done = baseState({ lastClimbDate: '2026-10-09', defaultWeek: W({}), doneByDate: { '2026-10-09': [{ kind: 'climb', fallback: true }] } });
      expect(brief(planDays(done, '2026-10-09', 1))).toEqual(['2026-10-09:squat-1+boulder']);
    });

    it('in addition to the Default Week lift Slots', () => {
      // Home week: Thu and Sun lift Slots too (Sun follows Saturday's Hill Ruck: no deadlift, OHP swaps in)
      const st = baseState({ lastClimbDate: '2026-10-08', clubEvents: [fri] });
      expect(liftsOnly(planDays(st, '2026-10-08', 4))).toEqual(['2026-10-08:squat-1', '2026-10-09:bench-1', '2026-10-11:ohp-1']);
    });

    it('a Default Week lift Slot taken by a climb moves the lift to am', () => {
      const st = baseState({ lastClimbDate: '2026-10-08', defaultWeek: W({ 4: { pm: 'lift' } }), clubEvents: [fri] });
      expect(planDays(st, '2026-10-09', 1)[0]!.sessions.map((s) => `${s.kind}:${s.slot}`)).toEqual(['lift:am', 'climb:pm']);
    });

    it('not when am is taken by a run', () => {
      const st = baseState({ lastClimbDate: '2026-10-08', defaultWeek: W({ 4: { am: 'run' } }), clubEvents: [fri] });
      expect(brief(planDays(st, '2026-10-09', 1))).toEqual(['2026-10-09:easy+climb']);
    });

    it('the usual gates: Travel Strength on no-gym days; nothing on mountain or Travel Days, in a Test Week or before notBefore', () => {
      const base = { lastClimbDate: '2026-10-08', defaultWeek: W({}), clubEvents: [fri] };
      const noGym = baseState({ ...base, constraints: [{ id: 'c', start: '2026-10-09', end: '2026-10-09', noGym: true, travelDays: false }] });
      expect(brief(planDays(noGym, '2026-10-09', 1))).toEqual(['2026-10-09:travel-strength+climb']);
      const mtn = baseState({ ...base, constraints: [{ id: 'm', start: '2026-10-09', end: '2026-10-09', mountain: true }] });
      expect(brief(planDays(mtn, '2026-10-09', 1))).toEqual(['2026-10-09:']);
      const travel = baseState({ ...base, constraints: [{ id: 't', start: '2026-10-09', end: '2026-10-12', timezone: 'Europe/Rome' }] });
      expect(brief(planDays(travel, '2026-10-09', 1))).toEqual(['2026-10-09:climb']);
      const tw = baseState({ ...base, testWeek: { dates: { squat: '2026-10-20', bench: '2026-10-20', deadlift: '2026-10-20', ohp: '2026-10-20' }, results: {} } });
      expect(brief(planDays(tw, '2026-10-09', 1))).toEqual(['2026-10-09:climb']);
      const later = baseState({ ...base, lift: { week: 1, index: 0, phase: { kind: 'normal' }, notBefore: '2026-10-10' } });
      expect(brief(planDays(later, '2026-10-09', 1))).toEqual(['2026-10-09:climb']);
    });
  });

  describe('a lift on the Easy-run day (spec §1)', () => {
    const W = (over: Record<number, object>) => ({ 0: {}, 1: {}, 2: {}, 3: {}, 4: {}, 5: {}, 6: {}, ...over }) as any;
    const quiet = { lastClimbDate: '2026-12-31', lastLiftDate: '2026-10-04' };
    const runWeek = W({ 1: { am: 'run' }, 2: { am: 'run' }, 3: { am: 'lift' }, 5: { am: 'run-long' } });

    it('an Easy run in am gets a lift in pm; legs are blocked after it, so the next upper lift goes in', () => {
      const st = baseState({ ...quiet, defaultWeek: runWeek });
      const plan = planDays(st, '2026-10-06', 3);
      expect(plan[0]!.sessions).toEqual([
        { kind: 'run', run: 'easy', slot: 'am', status: 'planned' },
        { kind: 'lift', lift: 'bench', week: 1, slot: 'pm', status: 'planned' },
      ]);
      // Wed's Quality gets no lift; Thu follows it (no legs): OHP.
      expect(brief(plan)).toEqual(['2026-10-06:easy+bench-1', '2026-10-07:quality-vert', '2026-10-08:ohp-1']);
    });

    it('the lift follows the Easy run when it rolls to Wednesday', () => {
      // Quality done on Tue: Wed's run Slot holds the Easy run, and the lift goes there, not on Tue.
      const st = baseState({ ...quiet, defaultWeek: runWeek, runsThisWeek: { '2026-10-05': ['quality'] }, doneByDate: { '2026-10-06': [{ kind: 'run', run: 'quality-vert' }] } });
      expect(brief(planDays(st, '2026-10-06', 2))).toEqual(['2026-10-06:quality-vert', '2026-10-07:easy+bench-1']);
      // Tue missed, planning from Wed: the Easy run and its lift move to Wed.
      const missed = baseState({ ...quiet, defaultWeek: runWeek });
      expect(brief(planDays(missed, '2026-10-07', 1))).toEqual(['2026-10-07:easy+bench-1']);
    });

    it('no lift after a Quality, Long, Hill Ruck or Benchmark', () => {
      // Easy credited Mon (an Activity): Tue holds the Quality and gets no lift; Wed has no run left (Long waits for Sat).
      const st = baseState({ ...quiet, defaultWeek: runWeek, runsThisWeek: { '2026-10-05': ['easy'] }, ruck: { lastCredit: '2026-10-01', step: 0 } });
      expect(brief(planDays(st, '2026-10-06', 5))).toEqual(['2026-10-06:quality-vert', '2026-10-07:', '2026-10-08:squat-1', '2026-10-09:', '2026-10-10:long']);
      const ruck = baseState({ ...quiet, defaultWeek: runWeek, runsThisWeek: { '2026-10-05': ['easy', 'quality'] } });
      expect(brief(planDays(ruck, '2026-10-10', 1))).toEqual(['2026-10-10:ruck']);
      const deload = baseState({ ...quiet, lastLiftDate: '2026-10-25', defaultWeek: runWeek, runsThisWeek: { '2026-10-26': ['easy'] } });
      expect(brief(planDays(deload, '2026-10-27', 1))).toEqual(['2026-10-27:benchmark-2k4']);
    });

    it('an Easy run in pm gets a lift in am, and legs are fine before it', () => {
      const st = baseState({ ...quiet, defaultWeek: W({ 1: { pm: 'run' } }) });
      expect(planDays(st, '2026-10-06', 1)[0]!.sessions).toEqual([
        { kind: 'lift', lift: 'squat', week: 1, slot: 'am', status: 'planned' },
        { kind: 'run', run: 'easy', slot: 'pm', status: 'planned' },
      ]);
    });

    it('a done Easy run counts, also on a day without a run Slot', () => {
      const st = baseState({ ...quiet, defaultWeek: W({}), runsThisWeek: { '2026-10-05': ['easy'] }, doneByDate: { '2026-10-08': [{ kind: 'run', run: 'easy' }] } });
      expect(planDays(st, '2026-10-08', 1)[0]!.sessions).toEqual([
        { kind: 'run', run: 'easy', slot: 'am', status: 'done' },
        { kind: 'lift', lift: 'bench', week: 1, slot: 'pm', status: 'planned' },
      ]);
    });

    it('stuck (no upper lift left): the leg lift goes in pm after the Easy run', () => {
      const st = baseState({ ...quiet, lift: { week: 1, index: 2, phase: { kind: 'normal' }, ahead: ['ohp'] }, defaultWeek: runWeek });
      expect(brief(planDays(st, '2026-10-06', 1))).toEqual(['2026-10-06:easy+deadlift-1']);
    });

    it('the usual gates: Travel Strength on no-gym days; nothing on a Travel Day, in a Test Week, before notBefore, or on a day with a lift already', () => {
      const base = { ...quiet, defaultWeek: runWeek };
      const noGym = baseState({ ...base, constraints: [{ id: 'c', start: '2026-10-06', end: '2026-10-06', noGym: true, travelDays: false }] });
      expect(brief(planDays(noGym, '2026-10-06', 1))).toEqual(['2026-10-06:easy+travel-strength']);
      const departure = baseState({ ...base, constraints: [{ id: 't', start: '2026-10-06', end: '2026-10-09', timezone: 'Europe/Rome' }] });
      expect(brief(planDays(departure, '2026-10-06', 1))).toEqual(['2026-10-06:easy']);
      const tw = baseState({ ...base, testWeek: { dates: { squat: '2026-10-20', bench: '2026-10-20', deadlift: '2026-10-20', ohp: '2026-10-20' }, results: {} } });
      expect(brief(planDays(tw, '2026-10-06', 1))).toEqual(['2026-10-06:easy']);
      const later = baseState({ ...base, lift: { week: 1, index: 0, phase: { kind: 'normal' }, notBefore: '2026-10-07' } });
      expect(brief(planDays(later, '2026-10-06', 1))).toEqual(['2026-10-06:easy']);
      // A lift done in am moves the Easy run to pm; no second lift.
      const lifted = baseState({ ...base, lift: { week: 1, index: 1, phase: { kind: 'normal' } }, doneByDate: { '2026-10-06': [{ kind: 'lift', lift: 'squat', week: 1 }] } });
      expect(brief(planDays(lifted, '2026-10-06', 1))).toEqual(['2026-10-06:squat-1+easy']);
    });
  });

  describe('the seed Default Week', () => {
    it('without climbs, over 5 weeks: no Re-entry, no legs the day after a hard run, legs after a run only when stuck', () => {
      const st = baseState({ defaultWeek: defaultState().defaultWeek, lastLiftDate: '2026-10-11', lastClimbDate: '2026-12-31' });
      const plan = planDays(st, '2026-10-12', 35);
      const lifts = plan.flatMap((d, i) => d.sessions.filter((s) => s.kind === 'lift').map((s: any) => ({ d, i, s })));
      expect(lifts.some(({ s }) => s.week === 'reentry')).toBe(false);
      expect(lifts.length).toBe(18); // 3 + 3 + 4 + 4 + 4
      for (const { d, i, s } of lifts) {
        if (!['squat', 'deadlift'].includes(s.lift)) continue;
        const prev = plan[i - 1]?.sessions ?? [];
        expect(prev.some((x) => x.kind === 'run' && x.run !== 'easy'), `${d.date} ${s.lift}`).toBe(false);
        const am = d.sessions.find((x) => x.slot === 'am');
        if (s.slot === 'pm' && am?.kind === 'run') {
          expect(am.run, d.date).toBe('easy');
          // stuck: both upper lifts of this round (Cycle week) were already placed ahead of it
          const upper = lifts.filter((l) => l.i < i && l.s.week === s.week && !['squat', 'deadlift'].includes(l.s.lift)).map((l) => l.s.lift).sort();
          expect(upper, d.date).toEqual(['bench', 'ohp']);
        }
      }
    });

    it('with Club Events Mon and Fri: five lifts a week, legs only where allowed', () => {
      const st = baseState({
        defaultWeek: defaultState().defaultWeek, lastLiftDate: '2026-10-11', lastClimbDate: '2026-10-09',
        clubEvents: [ev('g', '2026-10-12', '18:00', 'Wall C'), ev('v', '2026-10-16', '18:00', 'Wall A')],
      });
      const plan = planDays(st, '2026-10-12', 7);
      expect(brief(plan)).toEqual([
        '2026-10-12:squat-1+climb', '2026-10-13:easy+bench-1', '2026-10-14:quality-vert', '2026-10-15:ohp-1',
        '2026-10-16:deadlift-1+climb', '2026-10-17:ruck', '2026-10-18:bench-2',
      ]);
      expect(liftsOnly(plan)).toHaveLength(5);
    });
  });

  describe('slot choice for runs', () => {
    it('a done Session in the run\'s Default Slot moves the run to the other Slot', () => {
      const st = baseState({ doneByDate: { '2026-10-06': [{ kind: 'lift', lift: 'squat', week: 1 }] }, lastClimbDate: '2026-10-05' });
      const [tue] = planDays(st, '2026-10-06', 1);
      expect(tue.sessions).toEqual([
        { kind: 'lift', lift: 'squat', week: 1, slot: 'am', status: 'done' },
        { kind: 'run', run: 'easy', slot: 'pm', status: 'planned' },
      ]);
    });
  });

  describe('Boulder Fallback only at home', () => {
    const boulders = (p: ReturnType<typeof planDays>) => brief(p).filter((s) => s.includes('boulder')).map((s) => s.slice(0, 10));

    it('not on no_gym days or when abroad', () => {
      const noGym = baseState({ lastClimbDate: '2026-09-01', constraints: [{ id: 'c', start: '2026-10-05', end: '2026-10-08', noGym: true, travelDays: false }] });
      expect(boulders(planDays(noGym, '2026-10-05', 5))).toEqual(['2026-10-09']);
      const abroad = baseState({ lastClimbDate: '2026-09-01', constraints: [{ id: 'c', start: '2026-10-05', end: '2026-10-08', timezone: 'Europe/Rome', travelDays: false }] });
      expect(boulders(planDays(abroad, '2026-10-05', 5))).toEqual(['2026-10-09']);
    });

    it('not on mountain days, and mountain days reset the climb clock', () => {
      const st = baseState({ lastClimbDate: '2026-09-01', constraints: [{ id: 'm', start: '2026-10-05', end: '2026-10-06', mountain: true }] });
      expect(boulders(planDays(st, '2026-10-05', 14))).toEqual(['2026-10-13']);
    });

    it('a Club Event on a coming mountain day does not hold the fallback back', () => {
      const ev = { id: 'wall-b', date: '2026-10-06', time: '16:00', title: 'Wall B', venue: 'Wall B', type: 'partner' as const };
      const mtn = baseState({ lastClimbDate: '2026-09-01', clubEvents: [ev], constraints: [{ id: 'm', start: '2026-10-06', end: '2026-10-06', mountain: true }] });
      expect(boulders(planDays(mtn, '2026-10-05', 1))).toEqual(['2026-10-05']);
      const home = baseState({ lastClimbDate: '2026-09-01', clubEvents: [ev] });
      expect(boulders(planDays(home, '2026-10-05', 1))).toEqual([]);
    });

    it('after a mountain trip the 7-day rule counts from its last day', () => {
      const st = baseState({ lastClimbDate: '2026-09-01', constraints: [{ id: 'm', start: '2026-10-05', end: '2026-10-09', mountain: true }] });
      const plan = planDays(st, '2026-10-05', 14);
      expect(boulders(plan)).toEqual(['2026-10-16']);
      expect(plan.slice(0, 5).flatMap((d) => d.sessions)).toEqual([]);
    });

    it('not on Travel Days', () => {
      const st = baseState({ lastClimbDate: '2026-09-01', constraints: [{ id: 'd', start: '2026-10-07', end: '2026-10-08', note: 'Drive', travelDays: true }] });
      expect(boulders(planDays(st, '2026-10-07', 3))).toEqual(['2026-10-09']);
    });
  });

  describe('Travel Days', () => {
    const trip = { id: 't', start: '2026-10-08', end: '2026-10-13', noGym: true };

    it('Departure Day: no lift and no Travel Strength; the lift waits', () => {
      const st = baseState({ constraints: [trip], lastClimbDate: '2026-12-31' });
      const plan = planDays(st, '2026-10-08', 4);
      expect(plan[0]).toMatchObject({ travel: 'departure', sessions: [] });
      expect(brief(plan).at(-1)).toBe('2026-10-11:travel-strength');
    });

    it('Departure Day: runs as normal; a due Hill Ruck becomes a plain Long and stays due', () => {
      const st = baseState({ constraints: [{ id: 't', start: '2026-10-10', end: '2026-10-12', timezone: 'Europe/Rome' }], lastClimbDate: '2026-12-31' });
      expect(brief(planDays(st, '2026-10-10', 8)).filter((s) => /long|ruck/.test(s))).toEqual(['2026-10-10:long', '2026-10-17:ruck']);
    });

    it('Arrival Day: no Sessions except Club Events', () => {
      const st = baseState({ constraints: [trip], lastClimbDate: '2026-09-01', clubEvents: [ev('g', '2026-10-13', '19:00', 'Wall C')] });
      const [tue] = planDays(st, '2026-10-13', 1);
      expect(tue).toMatchObject({ travel: 'arrival', sessions: [{ kind: 'climb', eventId: 'g', slot: 'pm', status: 'planned' }] });
      const quiet = baseState({ constraints: [trip], lastClimbDate: '2026-09-01' });
      expect(planDays(quiet, '2026-10-13', 1)[0].sessions).toEqual([]);
    });

    it('an Arrival Day\'s run-long Slot is not a usable one for the week', () => {
      const st = baseState({ runsThisWeek: { '2026-10-05': ['easy', 'quality'] }, ruck: { lastCredit: '2026-10-01', step: 0 }, constraints: [{ id: 't', start: '2026-10-03', end: '2026-10-10', noGym: true }] });
      expect(brief(planDays(st, '2026-10-07', 4)).filter((s) => /long/.test(s))).toEqual(['2026-10-07:long']);
    });
  });
});
