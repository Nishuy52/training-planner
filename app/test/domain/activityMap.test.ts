import { describe, it, expect } from 'vitest';
import { mapIcuActivity, type IcuActivity } from '../../src/domain/activityMap';

const base: IcuActivity = { id: 123, type: 'Hike', name: 'Ridge hike', start_date_local: '2026-10-11T10:00:00', distance: 8000, moving_time: 12600, total_elevation_gain: 600, icu_training_load: 80 };

describe('mapIcuActivity: sport', () => {
  it.each([
    ['Run', 'run'], ['TrailRun', 'run'], ['VirtualRun', 'run'], ['Treadmill', 'run'], ['TreadmillRun', 'run'],
    ['Hike', 'hike'], ['Snowshoe', 'hike'], ['BackcountrySki', 'hike'], ['Mountaineering', 'hike'],
    ['RockClimbing', 'climb'], ['Climbing', 'climb'], ['Bouldering', 'climb'], ['IndoorClimbing', 'climb'],
  ])('%s → %s', (type, sport) => {
    expect(mapIcuActivity({ ...base, type })?.activity.sport).toBe(sport);
  });

  it('matches case-insensitively and ignores spaces', () => {
    expect(mapIcuActivity({ ...base, type: 'trail run' })?.activity.sport).toBe('run');
    expect(mapIcuActivity({ ...base, type: 'ROCK CLIMBING' })?.activity.sport).toBe('climb');
  });

  it.each(['Ride', 'Swim', 'Yoga', '', undefined])('%s is not credited', (type) => {
    expect(mapIcuActivity({ ...base, type })).toBeNull();
  });
});

describe('mapIcuActivity: broader climb detection', () => {
  it.each(['Indoor Climbing', 'Bouldering', 'RockClimbing'])('%s -> climb', (type) => {
    expect(mapIcuActivity({ ...base, type })?.activity.sport).toBe('climb');
  });
  it('generic Workout with a climbing name -> climb', () => {
    expect(mapIcuActivity({ ...base, type: 'Workout', name: 'Crag session' })?.activity.sport).toBe('climb');
    expect(mapIcuActivity({ ...base, type: 'Other', name: 'Belay practice' })?.activity.sport).toBe('climb');
    expect(mapIcuActivity({ ...base, type: 'Workout', name: 'Climbing training' })?.activity.sport).toBe('climb');
  });
  it('climb name hints match word starts only', () => {
    expect(mapIcuActivity({ ...base, type: 'Workout', name: 'Carrying books' })).toBeNull();
    expect(mapIcuActivity({ ...base, type: 'Other', name: 'New socks run' })).toBeNull();
    expect(mapIcuActivity({ ...base, type: 'Workout', name: 'Scraggy hill walk' })).toBeNull();
  });
  it('generic Workout without a climbing name -> null', () => {
    expect(mapIcuActivity({ ...base, type: 'Workout', name: 'Gym' })).toBeNull();
  });
  it('WeightTraining stays strength (never climb) even with a climbing name', () => {
    expect(mapIcuActivity({ ...base, type: 'WeightTraining', name: 'Climbing strength' })?.activity.sport).toBe('strength');
  });
  it('Hike and Mountaineering stay hike', () => {
    expect(mapIcuActivity({ ...base, type: 'Hike' })?.activity.sport).toBe('hike');
    expect(mapIcuActivity({ ...base, type: 'Mountaineering' })?.activity.sport).toBe('hike');
  });
});

describe('mapIcuActivity: fields', () => {
  it('maps units, date, id and name', () => {
    expect(mapIcuActivity(base)).toEqual({
      externalId: 'icu:123',
      date: '2026-10-11',
      name: 'Ridge hike',
      activity: { sport: 'hike', km: 8, vertM: 600, hours: 3.5, load: 80 },
      timing: { movingS: 12600 },
    });
  });

  it('rounds hours to 0.01 and km to 0.1', () => {
    expect(mapIcuActivity({ ...base, type: 'Run', distance: 10050, moving_time: 3000 })?.activity).toMatchObject({ km: 10.1, hours: 0.83 });
  });

  it('keeps moving and elapsed time in whole seconds', () => {
    expect(mapIcuActivity({ ...base, type: 'Run', moving_time: 640.4, elapsed_time: 655 })?.timing).toEqual({ movingS: 640, elapsedS: 655 });
  });

  it('omits null or missing fields', () => {
    const m = mapIcuActivity({ id: 'i9', type: 'RockClimbing', start_date_local: '2026-10-09T18:00:00', distance: null, total_elevation_gain: null });
    expect(m).toEqual({ externalId: 'icu:i9', date: '2026-10-09', name: 'RockClimbing', activity: { sport: 'climb' }, timing: {} });
  });

  it.each([undefined, '', 'yesterday', '2026-13-40T10:00:00'])('date %s → null', (start_date_local) => {
    expect(mapIcuActivity({ ...base, start_date_local })).toBeNull();
  });
});

describe('mapIcuActivity: walks', () => {
  it('a short flat Walk is a commute, not a hike', () => {
    expect(mapIcuActivity({ ...base, type: 'Walk', total_elevation_gain: 60, moving_time: 1800 })).toBeNull();
    expect(mapIcuActivity({ ...base, type: 'Walk', total_elevation_gain: null, moving_time: null })).toBeNull();
  });

  it('a Walk with 150 m+ or 1.5 h+ counts as a hike', () => {
    expect(mapIcuActivity({ ...base, type: 'Walk', total_elevation_gain: 150, moving_time: 1800 })?.activity.sport).toBe('hike');
    expect(mapIcuActivity({ ...base, type: 'Walk', total_elevation_gain: 20, moving_time: 5400 })?.activity.sport).toBe('hike');
  });
});
