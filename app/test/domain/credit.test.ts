import { describe, it, expect } from 'vitest';
import { applyAction, emptyAmrapLog, type Action } from '../../src/domain/actions';
import { countedAs } from '../../src/domain/credit';
import { baseState } from './fixtures';

const WALL_A = { id: 'v1', date: '2026-10-09', time: '18:00', title: 'Friday climbing', venue: 'Wall A', type: 'partner' as const };

function counted(activity: Extract<Action, { type: 'activity' }>['activity'], date = '2026-10-08', before = baseState()) {
  const after = applyAction(before, { type: 'activity', date, activity }, emptyAmrapLog()).state;
  return countedAs(before, after, date);
}

describe('countedAs', () => {
  it('a big hike is Hill Ruck credit + Long run', () => {
    expect(counted({ sport: 'hike', vertM: 600, hours: 3.5 })).toEqual(['Hill Ruck credit', 'Long run']);
  });

  it('a medium hike is an Easy run; a small one is nothing', () => {
    expect(counted({ sport: 'hike', load: 30, hours: 1 })).toEqual(['Easy run']);
    expect(counted({ sport: 'hike', load: 5, hours: 0.5 })).toEqual([]);
  });

  it('a run with no run Slot that day credits the next category', () => {
    const before = baseState({ runsThisWeek: { '2026-10-05': ['easy'] } });
    expect(counted({ sport: 'run', km: 6 }, '2026-10-08', before)).toEqual(['Quality run']);
  });

  it('a climb on a Club Event day is the climb Session; elsewhere a standalone climb', () => {
    expect(counted({ sport: 'climb' }, '2026-10-09', baseState({ clubEvents: [WALL_A] }))).toEqual(['Climb']);
    expect(counted({ sport: 'climb' }, '2026-10-08')).toEqual(['Standalone climb']);
  });

  it('a late Activity only names the clocks it moved', () => {
    const before = baseState({ ruck: { lastCredit: '2026-09-20', step: 0 }, lastClimbDate: '2026-09-30' });
    const run = (a: Action) => countedAs(before, applyAction(before, a, emptyAmrapLog()).state, '2026-10-06', { late: true });
    expect(run({ type: 'activity', date: '2026-10-06', today: '2026-10-08', activity: { sport: 'hike', vertM: 600 } })).toEqual(['Hill Ruck clock']);
    expect(run({ type: 'activity', date: '2026-10-06', today: '2026-10-08', activity: { sport: 'climb' } })).toEqual(['climb clock']);
    expect(run({ type: 'activity', date: '2026-10-06', today: '2026-10-08', activity: { sport: 'run', km: 5 } })).toEqual([]);
  });
});
