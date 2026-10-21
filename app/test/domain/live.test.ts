import { describe, expect, it } from 'vitest';
import { parseDose } from '../../src/domain/dose';
import { parseDose as parseDoseJs } from '../../public/sets.js';
import { FINISHERS, FSL } from '../../src/content/liftExtras';
import {
  DEFAULT_REST, adjust, currentStep, extendRest, liftSets, logSet, newLiveState, pendingValues, setLastRpe, verdict, type LiveSet,
} from '../../src/domain/live';
import { decodeLive, encodeLive, liveKeyboard, liveMessage, parseLiveInput, restPingText, summaryMessage } from '../../src/telegram/live';
import { decodeCallback, encodeCallback } from '../../src/telegram/format';
import { LOW_TM_WARNING } from '../../src/domain/actions';
import { localNow } from '../../src/domain/dates';
import { zonedMidnight } from '../../src/domain/dates';
import type { SessionDetail } from '../../src/domain/details';

const gym = { id: 'a', name: 'A', plateStepKg: 2.5, machineLifts: [], hasBands: true };
const squat = (lastFsl: number | null = null): Extract<SessionDetail, { kind: 'lift' }> => ({
  kind: 'lift', lift: 'squat', week: 1, tm: 100, gymProfileId: 'a',
  mainSets: [
    { pct: 65, reps: 5, amrap: false, load: 65, unit: 'kg', capped: false },
    { pct: 75, reps: 5, amrap: false, load: 75, unit: 'kg', capped: false },
    { pct: 85, reps: 5, amrap: true, load: 85, unit: 'kg', capped: false },
  ],
  warmup: [{ name: 'Hip CARs', dose: '5/side' }], fsl: FSL.squat, lastFslWeightKg: lastFsl, finisher: FINISHERS.lower[0]!,
});
const live = (det: SessionDetail = squat()) =>
  newLiveState({ id: 'abcdef0123456789', date: '2026-10-05', ref: { kind: 'lift', lift: 'squat', week: 1 }, tz: 'Europe/Berlin', detail: det, gym, rest: DEFAULT_REST, now: 0, autoFinishAt: 1e12 });

describe('parseDose (TS port)', () => {
  it('agrees with public/sets.js on the content and edge cases', () => {
    const doses = [...Object.values(FSL).flat(), ...FINISHERS.lower.flat(), ...FINISHERS.upper.flat()].map((e) => e.dose);
    for (const d of [...doses, '3 x 5', '2 × 12–15', '4 × 8/side', '2 x 30 s/side', '45 s', '0 x 5', '21 x 5', undefined, 7]) {
      expect(parseDose(d), String(d)).toEqual(parseDoseJs(d));
    }
  });
});

describe('Live Session steps', () => {
  it('expands main, FSL and Finisher; the first FSL exercise carries the last FSL weight', () => {
    const sets = liftSets(squat(20), gym, DEFAULT_REST);
    expect(sets.map((s) => s.group)).toEqual(['main', 'main', 'main', 'fsl', 'fsl', 'fsl', 'fsl', 'finisher', 'finisher', 'finisher', 'finisher', 'finisher']);
    expect(sets[3]).toMatchObject({ rxLoad: 20, rxReps: 8, restS: 90 });
    expect(sets[7]).toMatchObject({ rxReps: 12, rxRepsMax: 15, restS: 60 });
    expect(sets[11]).toMatchObject({ dose: '2 x 30 s/side', of: 1 });
  });

  it('machine lifts step by the machine lb step', () => {
    const det = { ...squat(), mainSets: squat().mainSets.map((x) => ({ ...x, unit: 'lb' as const })) };
    expect(liftSets(det, { ...gym, machineStepLb: 10 }, DEFAULT_REST)[0]!.loadStep).toBe(10);
  });

  it('logs, adjusts and starts rest; corrections do not restart it', () => {
    const s = live();
    expect(currentStep(s)).toBe(0);
    expect(logSet(s, { step: 1 }, 1000)).toEqual({ index: 0, newly: true });
    expect(s.warmupDone).toBe(true);
    expect(s.restEndsAt).toBe(1000 + 180_000);
    expect(adjust(s, 'load', 1)).toBeNull();
    expect(adjust(s, 'reps', -1)).toBeNull();
    expect(pendingValues(s)).toEqual({ load: 77.5, reps: 4 });
    logSet(s, { step: 2 }, 2000);
    expect(s.sets[1]).toMatchObject({ load: 77.5, reps: 4 });
    expect(s.draft).toBeNull();
    logSet(s, { step: 1, reps: 6 }, 3000);
    expect(s.sets[0]).toMatchObject({ load: 65, reps: 6 });
    expect(s.restEndsAt).toBe(2000 + 180_000);
    expect(currentStep(s)).toBe(3);
    expect(setLastRpe(s, 8)).toBeNull();
    expect(s.sets[1]!.rpe).toBe(8); // the last set logged, not the one corrected last
  });

  it('rest +30 s extends a running rest or starts one', () => {
    const s = live();
    extendRest(s, 30, 0);
    expect(s.restEndsAt).toBe(30_000);
    extendRest(s, 30, 10_000);
    expect(s.restEndsAt).toBe(60_000);
    extendRest(s, 30, 100_000);
    expect(s.restEndsAt).toBe(130_000);
  });

  it('verdict: under if load or reps short, met if equal, over if at least and one above; AMRAP and ranges', () => {
    const x = (o: Partial<LiveSet>): LiveSet => ({ group: 'main', exercise: 'Squat', n: 1, unit: 'kg', loadStep: 2.5, restS: 1, rxLoad: 65, rxReps: 5, loggedAt: 1, ...o });
    expect(verdict(x({ load: 65, reps: 5 }))).toBe('met');
    expect(verdict(x({ load: 62.5, reps: 6 }))).toBe('under');
    expect(verdict(x({ load: 65, reps: 4 }))).toBe('under');
    expect(verdict(x({ load: 67.5, reps: 5 }))).toBe('over');
    expect(verdict(x({ load: 65, reps: 6 }))).toBe('over');
    expect(verdict(x({ load: 65, reps: 9, amrap: true }))).toBe('amrap');
    expect(verdict(x({ load: 60, reps: 9, amrap: true }))).toBe('under');
    expect(verdict(x({ rxLoad: undefined, rxReps: 12, rxRepsMax: 15, reps: 14 }))).toBe('met');
    expect(verdict(x({ rxLoad: undefined, rxReps: 12, rxRepsMax: 15, reps: 16 }))).toBe('over');
    expect(verdict(x({ skipped: true }))).toBe('skipped');
    expect(verdict(x({ loggedAt: undefined }))).toBeNull();
  });

  it('ping and summary text', () => {
    const s = live();
    logSet(s, { step: 1 }, 1);
    expect(restPingText(s)).toBe('⏰ Rest over — Set 2: 75 kg × 5');
    logSet(s, { step: 2 }, 2);
    expect(restPingText(s)).toBe('⏰ Rest over — Set 3: 85 kg × 5+');
    logSet(s, { step: 3, reps: 10 }, 3);
    expect(restPingText(s)).toBe('⏰ Rest over — DB Bulgarian split squat set 1: × 8');
    expect(summaryMessage(s, 'finished', ['TM squat held at 100'])).toBe([
      '<b>✅ Squat — Week 1 (5s)</b> — done', '✓ Squat 1: 65 kg × 5', '✓ Squat 2: 75 kg × 5', '✓ Squat 3: 85 kg × 10 — AMRAP 10 reps', '', 'TM squat held at 100',
    ].join('\n'));
  });
});

describe('typed input', () => {
  it('parses load × reps, reps, load, skip and rpe', () => {
    expect(parseLiveInput('67.5x4')).toEqual({ kind: 'set', load: 67.5, reps: 4 });
    expect(parseLiveInput(' 67,5 × 4 ')).toEqual({ kind: 'set', load: 67.5, reps: 4 });
    expect(parseLiveInput('67.5 kg x 4')).toEqual({ kind: 'set', load: 67.5, reps: 4 });
    expect(parseLiveInput('x4')).toEqual({ kind: 'set', reps: 4 });
    expect(parseLiveInput('67.5')).toEqual({ kind: 'set', load: 67.5 });
    expect(parseLiveInput('67.5x4 rpe 8')).toEqual({ kind: 'set', load: 67.5, reps: 4, rpe: 8 });
    expect(parseLiveInput('x4 RPE8')).toEqual({ kind: 'set', reps: 4, rpe: 8 });
    expect(parseLiveInput('top 102.5x5')).toEqual({ kind: 'set', load: 102.5, reps: 5, top: true });
    expect(parseLiveInput('Skip')).toEqual({ kind: 'skip' });
    expect(parseLiveInput('rpe 8')).toEqual({ kind: 'rpe', rpe: 8 });
    expect(parseLiveInput('✓ Set done')).toEqual({ kind: 'key', key: 'done' });
    expect(parseLiveInput('+30 s rest')).toEqual({ kind: 'key', key: 'rest' });
    expect(parseLiveInput('pause')).toEqual({ kind: 'key', key: 'pause' });
    expect(parseLiveInput('Finish')).toEqual({ kind: 'key', key: 'finish' });
  });
  it('rejects anything else', () => {
    for (const t of ['', 'x', 'hello', 'rpe 11', 'rpe 0', '67.5x4 rpe 12', '2000', 'x200', '67.5x', '5 sets', 'rpe']) {
      expect(parseLiveInput(t), t).toBeNull();
    }
  });
});

describe('callback codec', () => {
  it('round-trips and stays far under 64 bytes', () => {
    const data = encodeLive('aby', { id: 'abcdef0123456789' }, 123);
    expect(data).toBe('l|aby|abcdef01|123');
    expect(new TextEncoder().encode(data).length).toBeLessThanOrEqual(64);
    expect(decodeLive(data)).toEqual({ op: 'aby', sid: 'abcdef01', step: 123 });
    for (const bad of ['l|zz|abcdef01|1', 'l|ok|ABCDEF01|1', 'l|ok|abcdef01|x', 'l|ok|abcdef01', 'a|ok|abcdef01|1']) expect(decodeLive(bad)).toBeNull();
  });
});

describe('zonedMidnight', () => {
  it('is local midnight, across DST', () => {
    expect(new Date(zonedMidnight('2026-10-06', 'Europe/Berlin')).toISOString()).toBe('2026-10-05T22:00:00.000Z');
    expect(new Date(zonedMidnight('2026-10-26', 'Europe/Berlin')).toISOString()).toBe('2026-10-25T23:00:00.000Z');
    expect(new Date(zonedMidnight('2026-10-06', 'Asia/Shanghai')).toISOString()).toBe('2026-10-05T16:00:00.000Z');
  });
});

describe('zonedMidnight where DST changes at midnight', () => {
  // Santiago skips 00:00 → 01:00 on Sun 6 Sep 2026 and repeats 23:00 on Sat 4 Apr 2026; Havana skips midnight on 8 Mar 2026.
  for (const [date, tz] of [['2026-09-06', 'America/Santiago'], ['2026-04-05', 'America/Santiago'], ['2026-03-08', 'America/Havana'], ['2026-10-25', 'Europe/Berlin']] as const) {
    it(`${tz} ${date}: the first minute of the local day`, () => {
      const t = zonedMidnight(date, tz);
      expect(localNow(new Date(t), tz).date).toBe(date);
      expect(localNow(new Date(t - 60_000), tz).date < date).toBe(true);
    });
  }
  it('Santiago spring-forward day starts at 01:00 local (04:00 UTC)', () => {
    expect(new Date(zonedMidnight('2026-09-06', 'America/Santiago')).toISOString()).toBe('2026-09-06T04:00:00.000Z');
  });
});

describe('Live Session buttons', () => {
  it('✕ Cancel until a set is logged, then ✖ Abandon; paused shows ▶ Resume', () => {
    const s = live();
    expect(liveKeyboard(s).at(-1)![0]!.text).toBe('✕ Cancel');
    logSet(s, { step: 1, skip: true }, 1);
    expect(liveKeyboard(s).at(-1)![0]!.text).toBe('✕ Cancel'); // a skip is not a Logged Set
    logSet(s, { step: 2 }, 2);
    expect(liveKeyboard(s).at(-1)![0]!.text).toBe('✖ Abandon');
    s.paused = true;
    expect(liveKeyboard(s)[0]![0]!.text).toBe('▶ Resume');
    expect(liveMessage(s, 0).text).toContain('⏸ Paused');
  });

  it('pause / resume keys and Resume text parse', () => {
    expect(parseLiveInput('Resume')).toEqual({ kind: 'key', key: 'resume' });
    expect(parseLiveInput('Pause')).toEqual({ kind: 'key', key: 'pause' });
  });

  it('Start callbacks carry resume / fresh', () => {
    const ref = { kind: 'lift', lift: 'squat', week: 1 } as const;
    for (const mode of [undefined, 'resume', 'fresh'] as const) {
      const data = encodeCallback({ type: 'start', date: '2026-10-05', ref, ...(mode ? { mode } : {}) });
      expect(decodeCallback(data)).toEqual({ type: 'start', date: '2026-10-05', ref, ...(mode ? { mode } : {}) });
    }
    expect(encodeCallback({ type: 'start', date: '2026-10-05', ref, mode: 'resume' })).toBe('a|gr|2026-10-05|L.squat.1');
    expect(decodeCallback('a|gx|2026-10-05|L.squat.1')).toBeNull();
  });
});

describe('TM Test: no bar default, top-set confirmation', () => {
  const test = (): ReturnType<typeof live> =>
    newLiveState({
      id: 'abcdef0123456789', date: '2026-10-05', ref: { kind: 'lift-test', lift: 'deadlift' }, tz: 'Europe/Berlin',
      detail: { kind: 'lift-test', lift: 'deadlift', warmup: [{ name: 'Hip CARs', dose: '5/side' }] } as unknown as SessionDetail,
      gym, rest: DEFAULT_REST, now: 0, autoFinishAt: 1e12,
    });

  it('the first work-up set has no weight: typed, never the bar; later sets carry the previous one over', () => {
    const s = test();
    s.warmupDone = true;
    expect(pendingValues(s)).toEqual({ reps: 5 });
    expect(logSet(s, { step: 1 }, 1)).toEqual({ status: 400, error: 'type the weight, e.g. 100x5' });
    expect(logSet(s, { step: 1, reps: 5 }, 1)).toMatchObject({ status: 400 });
    expect(liveMessage(s, 0).text).toContain('Work-up set 1 — Type the weight, e.g. 100x5');
    expect(liveKeyboard(s).flat().map((b) => b.text)).toEqual(['✕ Cancel']); // no "✓ Work-up 20 kg × 5", no 🏁 Top set
    logSet(s, { step: 1, load: 60, reps: 5 }, 2);
    expect(pendingValues(s)).toEqual({ load: 60, reps: 5 });
    expect(liveKeyboard(s)[0]!.map((b) => b.text)).toEqual(['✓ Work-up 60 kg × 5', '🏁 Top set']);
  });

  it('a pending top set shows the Training Max it sets (and the low warning) with Save / Back only', () => {
    const s = test();
    logSet(s, { step: 1, load: 20, reps: 5 }, 1);
    s.pendingTop = { load: 20, reps: 5, tm: 20, low: true };
    const text = liveMessage(s, 0).text;
    expect(text).toContain('🏁 <b>Top set 20 kg × 5 → Training Max 20 kg. Save?</b>');
    expect(text).toContain(`⚠️ ${LOW_TM_WARNING}`);
    expect(liveKeyboard(s)).toEqual([[
      { text: '✓ Save top set', callback_data: 'l|tpy|abcdef01|2' }, { text: '↩︎ Back', callback_data: 'l|tpn|abcdef01|2' },
    ]]);
    s.pendingTop = { load: 120, reps: 5, tm: 125, low: false };
    expect(liveMessage(s, 0).text).not.toContain('⚠️');
    expect(decodeLive('l|tpy|abcdef01|2')).toEqual({ op: 'tpy', sid: 'abcdef01', step: 2 });
  });
});

describe('/test replace callbacks', () => {
  it('round-trip within 64 bytes and reject bad values', () => {
    const v = { date: '2026-10-05', lift: 'deadlift', weight: 102.5, reps: 15 } as const;
    const data = encodeCallback({ type: 'test-correct', ...v });
    expect(data).toBe('a|tc|2026-10-05|deadlift|102.5|15');
    expect(new TextEncoder().encode(data).length).toBeLessThanOrEqual(64);
    expect(decodeCallback(data)).toEqual({ type: 'test-correct', ...v });
    expect(decodeCallback('a|tk|2026-10-05|deadlift|120|5')).toEqual({ type: 'test-keep', date: '2026-10-05', lift: 'deadlift', weight: 120, reps: 5 });
    for (const type of ['test-save', 'test-cancel'] as const) expect(decodeCallback(encodeCallback({ type, ...v }))).toEqual({ type, ...v });
    expect(encodeCallback({ type: 'test-save', ...v })).toBe('a|ts|2026-10-05|deadlift|102.5|15');
    expect(decodeCallback('a|tz|2026-10-05|deadlift|120|5')).toBeNull();
    for (const bad of ['a|tc|2026-10-05|curl|120|5', 'a|tc|2026-10-05|deadlift|0|5', 'a|tc|2026-10-05|deadlift|501|5', 'a|tc|2026-10-05|deadlift|120|16', 'a|tc|2026-10-05|deadlift|120', 'a|tc|2026-13-05|deadlift|120|5']) {
      expect(decodeCallback(bad)).toBeNull();
    }
  });
});
