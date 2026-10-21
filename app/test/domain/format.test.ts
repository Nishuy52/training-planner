import { describe, it, expect } from 'vitest';
import { morningMessage, mobilityMessage, previewMessage, encodeRef, decodeRef, encodeCallback, decodeCallback, repsKeyboard, sessionRow, confirmRow, esc, testHint, TELEGRAM_MAX_TEXT } from '../../src/telegram/format';
import { buildDetails } from '../../src/domain/details';
import type { DayPlan, SessionRef } from '../../src/domain/types';
import { baseState } from './fixtures';

const day = (sessions: DayPlan['sessions'], over: Partial<DayPlan> = {}): DayPlan => ({
  date: '2026-10-12', timezone: 'Europe/Berlin', gymProfileId: 'home-gym', mountain: false, noGym: false, sessions, ...over,
});
const none = () => null;

describe('refs', () => {
  const refs: SessionRef[] = [
    { kind: 'lift', lift: 'squat', week: 1 }, { kind: 'lift', lift: 'ohp', week: 4 }, { kind: 'lift', lift: 'bench', week: 'reentry' },
    { kind: 'travel-strength' },
    ...(['easy', 'quality-vert', 'quality-speed', 'long', 'ruck', 'benchmark-2k4', 'benchmark-hill'] as const).map((run) => ({ kind: 'run' as const, run })),
    { kind: 'climb', eventId: 'evt_123-abc' }, { kind: 'climb', fallback: true }, { kind: 'climb' },
  ];
  it('encodes compactly', () => {
    expect(encodeRef(refs[0]!)).toBe('L.squat.1');
    expect(encodeRef({ kind: 'lift', lift: 'bench', week: 'reentry' })).toBe('L.bench.r');
    expect(encodeRef({ kind: 'run', run: 'easy' })).toBe('R.easy');
    expect(encodeRef({ kind: 'climb', fallback: true })).toBe('C.fb');
    expect(encodeRef({ kind: 'travel-strength' })).toBe('T');
  });
  it('round-trips every variant', () => {
    for (const r of refs) expect(decodeRef(encodeRef(r))).toEqual(r);
  });
  it('rejects garbage', () => {
    for (const g of ['', 'X', 'L.squat', 'L.squat.5', 'L.curl.1', 'R.sprint', 'T.x', 'C.a b', 'C.a|b', 'L.squat.1.2', 'C.' + 'x'.repeat(37)])
      expect(decodeRef(g)).toBeNull();
  });
  it('encodeRef refuses unsafe event ids', () => {
    expect(() => encodeRef({ kind: 'climb', eventId: 'x'.repeat(37) })).toThrow();
    expect(() => encodeRef({ kind: 'climb', eventId: 'a|b' })).toThrow();
    expect(() => encodeRef({ kind: 'climb', eventId: 'fb' })).toThrow();
  });
});

describe('AMRAP rep callbacks', () => {
  const ref = { kind: 'lift' as const, lift: 'squat' as const, week: 3 as const };
  it('round-trips ask, cancel and reps', () => {
    for (const cb of [
      { type: 'reps-ask' as const, date: '2026-10-12', ref },
      { type: 'cancel' as const, date: '2026-10-12', ref },
      { type: 'reps' as const, date: '2026-10-12', ref, reps: 0 },
      { type: 'reps' as const, date: '2026-10-12', ref, reps: 13 },
    ]) expect(decodeCallback(encodeCallback(cb))).toEqual(cb);
    expect(encodeCallback({ type: 'reps', date: '2026-10-12', ref, reps: 8 })).toBe('a|r|2026-10-12|L.squat.3|8');
  });
  it('rejects bad reps, missing reps, and refs with no AMRAP', () => {
    for (const g of ['a|r|2026-10-12|L.squat.3', 'a|r|2026-10-12|L.squat.3|14', 'a|r|2026-10-12|L.squat.3|x', 'a|q|2026-10-12|L.squat.4',
      'a|q|2026-10-12|L.squat.r', 'a|q|2026-10-12|R.easy', 'a|q|2026-10-12|L.squat.3|5', 'a|x|nope|L.squat.3']) expect(decodeCallback(g)).toBeNull();
  });
  it('keyboard has 0-12 and 13+ in rows of 7, Cancel last, all within 64 bytes', () => {
    const kb = repsKeyboard('2026-10-12', ref);
    expect(kb.map((r) => r.length)).toEqual([7, 7, 1]);
    expect(kb[1]![6]!.text).toBe('13+');
    for (const r of kb) for (const b of r) expect(new TextEncoder().encode(b.callback_data).length).toBeLessThanOrEqual(64);
  });
  it('Done skips the rep picker for deload, re-entry and travel strength', () => {
    expect(sessionRow('2026-10-12', { kind: 'lift', lift: 'squat', week: 4 })[0]!.callback_data).toBe('a|d|2026-10-12|L.squat.4');
    expect(sessionRow('2026-10-12', { kind: 'lift', lift: 'squat', week: 'reentry' })[0]!.callback_data).toBe('a|d|2026-10-12|L.squat.r');
    expect(sessionRow('2026-10-12', { kind: 'travel-strength' })[0]!.callback_data).toBe('a|d|2026-10-12|T');
  });
});

describe('callbacks', () => {
  it('round-trip and reject garbage', () => {
    const ref: SessionRef = { kind: 'lift', lift: 'squat', week: 1 };
    const cb = encodeCallback({ type: 'ask', act: 'tomorrow', date: '2026-10-12', ref });
    expect(cb).toBe('a|t|2026-10-12|L.squat.1');
    expect(decodeCallback(cb)).toEqual({ type: 'ask', act: 'tomorrow', date: '2026-10-12', ref });
    expect(encodeCallback({ type: 'mobility', status: 'done', date: '2026-10-12' })).toBe('m|d|2026-10-12');
    expect(decodeCallback('m|s|2026-10-12')).toEqual({ type: 'mobility', status: 'skipped', date: '2026-10-12' });
    for (const g of ['', 'a|x|2026-10-12|zzz', 'a|x|2026-10-12|T|1', 'a|d|nope|T', 'a|d|2026-10-12|zzz', 'm|x|2026-10-12', 'q|d|2026-10-12', 'a|d|2026-10-12'])
      expect(decodeCallback(g)).toBeNull();
  });
  it('Done / Skip / Tomorrow ask (d/s/t); the confirm codes D/S/T perform; Cancel (x) works for any Session', () => {
    const refs: SessionRef[] = [
      { kind: 'lift', lift: 'squat', week: 1 }, { kind: 'lift', lift: 'ohp', week: 'reentry' }, { kind: 'travel-strength' },
      { kind: 'run', run: 'benchmark-2k4' }, { kind: 'climb', eventId: 'x'.repeat(36) }, { kind: 'climb', fallback: true },
    ];
    const acts = ['done', 'skip', 'tomorrow'] as const;
    for (const ref of refs) {
      for (const act of acts) for (const type of ['ask', 'action'] as const) {
        const data = encodeCallback({ type, act, date: '2026-10-12', ref });
        expect(new TextEncoder().encode(data).length).toBeLessThanOrEqual(64);
        expect(decodeCallback(data)).toEqual({ type, act, date: '2026-10-12', ref });
      }
      expect(decodeCallback(encodeCallback({ type: 'cancel', date: '2026-10-12', ref }))).toEqual({ type: 'cancel', date: '2026-10-12', ref });
    }
    expect(encodeCallback({ type: 'action', act: 'skip', date: '2026-10-12', ref: refs[0]! })).toBe('a|S|2026-10-12|L.squat.1');
    expect(encodeCallback({ type: 'action', act: 'done', date: '2026-10-12', ref: refs[2]! })).toBe('a|D|2026-10-12|T');
    expect(encodeCallback({ type: 'action', act: 'tomorrow', date: '2026-10-12', ref: refs[3]! })).toBe('a|T|2026-10-12|R.benchmark-2k4');
    for (const g of ['a|S|2026-10-12', 'a|S|2026-10-12|L.squat.1|1', 'a|S|nope|T', 'a|S|2026-02-30|T', 'a|D|2026-10-12|zzz', 'a|Q|2026-10-12|T', 'a|ss|2026-10-12|T', 'A|S|2026-10-12|T'])
      expect(decodeCallback(g)).toBeNull();
  });
  it('confirmRow names the Session and the action', () => {
    const squat: SessionRef = { kind: 'lift', lift: 'squat', week: 1 };
    expect(confirmRow('2026-10-12', 'skip', squat)).toEqual([
      { text: '✓ Skip Squat 5s', callback_data: 'a|S|2026-10-12|L.squat.1' },
      { text: '↩︎ Cancel', callback_data: 'a|x|2026-10-12|L.squat.1' },
    ]);
    expect(confirmRow('2026-10-12', 'tomorrow', { kind: 'lift', lift: 'bench', week: 'reentry' })[0]!.text).toBe('✓ Move Bench re-entry to tomorrow');
    expect(confirmRow('2026-10-12', 'done', { kind: 'run', run: 'long' })[0]!.text).toBe('✓ Mark Long run done');
    expect(confirmRow('2026-10-12', 'skip', { kind: 'lift-test', lift: 'deadlift' })[0]!.text).toBe('✓ Skip Deadlift test');
  });
  it('rejects dates that are not real calendar dates', () => {
    for (const g of ['a|d|9999-99-99|T', 'a|s|2026-02-30|T', 'm|d|9999-99-99', 'm|s|2026-13-01', 'a|q|9999-99-99|L.squat.3',
      'a|x|2026-02-30|L.squat.3', 'a|r|9999-99-99|L.squat.3|5'])
      expect(decodeCallback(g)).toBeNull();
  });
});

describe('morningMessage', () => {
  const st = baseState({ clubEvents: [{ id: 'e1', date: '2026-10-12', time: '18:00', title: 'Wall A', venue: 'Wall A', type: 'partner' }] });
  it('lift day with FSL and finisher', () => {
    const d = day([{ kind: 'lift', lift: 'squat', week: 1, slot: 'am', status: 'planned' }]);
    const { text, keyboard } = morningMessage(d, buildDetails(st, d, () => 22.5));
    expect(text).toBe([
      '<b>☀️ Mon 12 Oct</b>',
      '',
      '🏋️ <b>Squat — Week 1 (5s)</b>',
      '3 sets up to 85 kg × 5+ · then FSL + finisher',
      '<blockquote expandable><b>Warm-up</b>',
      '• Ankle dorsiflexion (knee-to-wall) 2 x 10 each',
      '• Hip CARs 5/side',
      '• Short-lever Copenhagen 20 s/side',
      '• Banded clamshell 2 x 15',
      '• Deep squat hold 45 s',
      '• Banded tib-post inversion 2 x 15',
      '<b>Main sets</b>',
      '65% · 65 kg × 5',
      '75% · 75 kg × 5',
      '85% · 85 kg × 5+',
      '<b>FSL</b> · last 22.5 kg',
      '• DB Bulgarian split squat 4 x 8 per side, RPE 7-8',
      '<b>Finisher</b>',
      '• Cossack squat 2 x 12-15',
      '• Nordic / hamstring curl 2 x 12-15',
      '• Side plank with top-leg raise 2 x 30 s/side</blockquote>',
    ].join('\n'));
    expect(keyboard).toEqual([[{ text: '▶ Start Squat', callback_data: 'a|g|2026-10-12|L.squat.1' }], [
      { text: '🏋️ Squat: Done', callback_data: 'a|q|2026-10-12|L.squat.1' },
      { text: '🏋️ Skip', callback_data: 'a|s|2026-10-12|L.squat.1' },
      { text: '🏋️ Tomorrow', callback_data: 'a|t|2026-10-12|L.squat.1' },
    ]]);
  });
  it('lb sets are starred when capped; reentry labelled', () => {
    const travelGym = { id: 'travel-gym', name: 'Travel gym', plateStepKg: 2.5, machineLifts: ['bench' as const], machineStepLb: 10, machineMaxLb: 100, hasBands: false };
    const s2 = baseState({ gymProfiles: [travelGym], defaultGymProfileId: 'travel-gym' });
    const d = day([{ kind: 'lift', lift: 'bench', week: 3, slot: 'am', status: 'planned' }], { gymProfileId: 'travel-gym' });
    const { text } = morningMessage(d, buildDetails(s2, d, none));
    expect(text).toMatch(/\d+ lb\* × 1\+/);
    const d2 = day([{ kind: 'lift', lift: 'squat', week: 'reentry', slot: 'am', status: 'planned' }]);
    expect(morningMessage(d2, buildDetails(st, d2, none)).text).toContain('Re-entry');
  });
  it('run, ruck, climb, travel strength; Tomorrow only for lift/run', () => {
    const d = day([
      { kind: 'run', run: 'quality-vert', slot: 'am', status: 'planned' },
      { kind: 'run', run: 'ruck', slot: 'am', status: 'planned' },
      { kind: 'climb', eventId: 'e1', slot: 'pm', status: 'planned' },
      { kind: 'climb', fallback: true, slot: 'pm', status: 'planned' },
      { kind: 'travel-strength', slot: 'pm', status: 'planned' },
    ]);
    const { text, keyboard } = morningMessage(d, buildDetails(st, d, none));
    expect(text).toContain('🏃 <b>Quality run — Vert</b> · 4 km · 130 m↑\nHill repeats: climb hard 2–3 min, jog down');
    expect(text).toContain('🎒 <b>Hill Ruck</b> · 10 kg · 600 m↑ · 2–2.5 h');
    expect(text).toContain('🧗 <b>Wall A</b> · 18:00\nLast 30 min: endurance laps');
    expect(text).toContain('🧗 <b>Climb</b>\nBoulder session @ the bouldering gym');
    expect(text).toContain('🧳 <b>Travel Strength</b>\n6 bodyweight exercises\n<blockquote expandable>• Bulgarian split squat (bodyweight) 3 x 12/side');
    expect(keyboard.map((r) => r.length)).toEqual([3, 3, 2, 2, 2]);
    expect(keyboard[4]![0]!.callback_data).toBe('a|d|2026-10-12|T');
    // The second Climb shares the first one's name and icon: it is named and numbered on every button.
    expect(keyboard.map((r) => r.map((b) => b.text))).toEqual([
      ['🏃 Vert run: Done', '🏃 Skip', '🏃 Tomorrow'],
      ['🎒 Ruck: Done', '🎒 Skip', '🎒 Tomorrow'],
      ['🧗 Climb: Done', '🧗 Skip'],
      ['🧗 Climb 2: Done', '🧗 Skip Climb 2'],
      ['🧳 Travel: Done', '🧳 Skip'],
    ]);
  });
  it('mountain day and rest day', () => {
    const m = morningMessage(day([], { mountain: true }), []);
    expect(m.text).toContain('⛰ Mountain day — check in tonight with /log 6h 900m 7');
    expect(m.keyboard).toEqual([]);
    expect(morningMessage(day([]), []).text).toMatch(/Rest day/);
  });
  it('done sessions get no buttons', () => {
    const d = day([{ kind: 'run', run: 'easy', slot: 'am', status: 'done' }]);
    const { text, keyboard } = morningMessage(d, buildDetails(st, d, none));
    expect(keyboard).toEqual([]);
    expect(text).toContain('✔');
  });
  it('escapes HTML in dynamic text', () => {
    const s2 = baseState({ clubEvents: [{ id: 'e1', date: '2026-10-12', time: '18:00', title: 'A<b>&Co', venue: 'v', type: 'partner' }] });
    const d = day([{ kind: 'climb', eventId: 'e1', slot: 'pm', status: 'planned' }]);
    const { text } = morningMessage({ ...d, note: 'Trip <Riverton> & "co"', notes: ['Also: <Wall B> 20:00'] }, buildDetails(s2, d, none));
    expect(text).toContain('🧗 <b>A&lt;b&gt;&amp;Co</b> · 18:00');
    expect(text).toContain('📝 Trip &lt;Riverton&gt; &amp; "co"');
    expect(text).toContain('<b>☀️ Mon 12 Oct</b>\n<i>Also: &lt;Wall B&gt; 20:00</i>'); // italic, right under the header
    expect(text).not.toContain('<b>&');
  });
  it('every callback_data is <= 64 bytes, even with a 36-char event id', () => {
    const id = 'a'.repeat(36);
    const s2 = baseState({ clubEvents: [{ id, date: '2026-10-12', time: '18:00', title: 'T', venue: 'v', type: 'partner' }] });
    const d = day([{ kind: 'climb', eventId: id, slot: 'pm', status: 'planned' }, { kind: 'lift', lift: 'deadlift', week: 'reentry', slot: 'am', status: 'planned' }]);
    const { keyboard } = morningMessage(d, buildDetails(s2, d, none));
    for (const row of keyboard) for (const b of row) expect(new TextEncoder().encode(b.callback_data).length).toBeLessThanOrEqual(64);
  });
  it('a bad Club Event id omits only that session\'s buttons instead of throwing', () => {
    const bad = 'not a valid id!';
    const s2 = baseState({ clubEvents: [{ id: bad, date: '2026-10-12', time: '18:00', title: 'Wall A', venue: 'v', type: 'partner' }] });
    const d = day([{ kind: 'lift', lift: 'squat', week: 1, slot: 'am', status: 'planned' }, { kind: 'climb', eventId: bad, slot: 'pm', status: 'planned' }]);
    const { text, keyboard } = morningMessage(d, buildDetails(s2, d, none));
    expect(text).toContain('Wall A');
    expect(keyboard).toHaveLength(2);
    expect(keyboard[0]).toEqual([{ text: '▶ Start Squat', callback_data: 'a|g|2026-10-12|L.squat.1' }]);
    expect(keyboard[1]![0]!.text).toBe('🏋️ Squat: Done');
    expect(keyboard[1]![0]!.callback_data).toBe('a|q|2026-10-12|L.squat.1');
  });
});

describe('Route line (Plan 3 A4)', () => {
  const hillRep = { id: 'hill-rep', name: 'Hill repeats', area: 'Hometown', km: 6, vertM: 450, kind: 'repeat' as const, repeats: 3, suits: ['long' as const] };
  const at = (route: any, run: any = 'long') => {
    const d = day([{ kind: 'run', run, slot: 'am', status: 'planned' }]);
    return morningMessage(d, buildDetails(baseState(), d, none, { routes: [route], assignments: [{ date: d.date, runKind: 'long', routeId: route.id }] })).text;
  };
  it('names the Route with laps, km and climb', () => {
    expect(at(hillRep)).toMatch(/🏃 <b>Long run<\/b> · [\d.]+ km · \d+ m↑\nTrail long run — pick hilly trails\nRoute: Hill repeats ×3 \(6 km · 450 m↑\)/);
    expect(at({ ...hillRep, kind: 'loop', repeats: undefined, name: 'Lake', km: 3.3, vertM: 20 })).toContain('Route: Lake (3.3 km · 20 m↑)');
  });
  it('links the name when the Route has an https url, escaping it', () => {
    const t = at({ ...hillRep, url: 'https://example.com/routes/a?x=1&y="2"' });
    expect(t).toContain('Route: <a href="https://example.com/routes/a?x=1&amp;y=&quot;2&quot;">Hill repeats ×3</a> (6 km · 450 m↑)');
  });
  it('never links a non-https url and escapes the name', () => {
    const t = at({ ...hillRep, name: '<i>Hack</i> & co', url: 'javascript:alert(1)' });
    expect(t).not.toContain('<a ');
    expect(t).toContain('Route: &lt;i&gt;Hack&lt;/i&gt; &amp; co ×3');
  });
  it('a Hill Ruck shows its Route too', () => {
    expect(at(hillRep, 'ruck')).toContain('Route: Hill repeats ×3 (6 km · 450 m↑)');
  });
  it('the Sunday preview names each run\'s Route', () => {
    const d = day([{ kind: 'run', run: 'easy', slot: 'am', status: 'planned' }]);
    const det = buildDetails(baseState(), d, none, { routes: [{ ...hillRep, name: 'Lake <loop>' }], assignments: [{ date: d.date, runKind: 'easy', routeId: 'hill-rep' }] });
    expect(previewMessage([d], { [d.date]: det }).text).toContain('<b>Mon 12</b> · 🏃 Easy run (Lake &lt;loop&gt; ×3)');
  });
});

describe('mobilityMessage', () => {
  it('nightly routine with buttons', () => {
    const { text, keyboard } = mobilityMessage(day([]));
    expect(text.split('\n').slice(0, 4)).toEqual([
      '🧘 <b>Nightly routine</b> · ~27 min',
      '15 exercises: standing at wall, kneeling at bed, floor',
      '<blockquote expandable><b>Standing at wall</b>',
      '• Short foot 10/side',
    ]);
    expect(text).toContain('<b>Floor</b>\n• 90/90 switches 10');
    expect(text.endsWith('• Hand-assisted hamstring 45 s/side</blockquote>')).toBe(true);
    expect(keyboard).toEqual([[{ text: '🧘 Routine: Done', callback_data: 'm|d|2026-10-12' }, { text: '🧘 Skip', callback_data: 'm|s|2026-10-12' }]]);
  });
  it('mountain day adds the /log hint', () => {
    expect(mobilityMessage(day([], { mountain: true })).text).toContain('</blockquote>\n⛰ How was today? /log 6h 900m 7');
  });
});

describe('previewMessage', () => {
  it('7 lines plus week target', () => {
    const st = baseState();
    const days = Array.from({ length: 7 }, (_, i) =>
      day(i === 0 ? [{ kind: 'lift', lift: 'squat', week: 3, slot: 'am', status: 'planned' }] : i === 1 ? [{ kind: 'run', run: 'easy', slot: 'am', status: 'planned' }] : [],
        { date: `2026-10-${12 + i}`, mountain: i === 5 }));
    const details = Object.fromEntries(days.map((d) => [d.date, buildDetails(st, d, none)]));
    const { text } = previewMessage(days, details);
    const lines = text.split('\n');
    expect(lines[0]).toBe('📅 <b>Next 7 days</b>');
    expect(lines).toContain('<b>Mon 12</b> · 🏋️ Squat 5/3/1');
    expect(lines).toContain('<b>Tue 13</b> · 🏃 Easy run');
    expect(lines).toContain('<b>Wed 14</b> · rest');
    expect(lines).toContain('<b>Sat 17</b> · ⛰ Mountain day');
    expect(lines.at(-1)).toBe('🎯 Week target: 16.5 km · 330 m↑');
    expect(lines.filter((l) => /^<b>(Mon|Tue|Wed|Thu|Fri|Sat|Sun) \d+<\/b> · /.test(l))).toHaveLength(7);
  });
});

describe('phone layout (hotfix: unreadable 07:00 reminder)', () => {
  const labels = (kb: { text: string }[][]) => kb.flat().map((b) => b.text);
  it('TM Test + Long run: bold headers, warm-up and protocol in a collapsed quote, visible Log line, one named row per Session', () => {
    const d = day([
      { kind: 'lift-test', lift: 'squat', slot: 'am', status: 'planned' },
      { kind: 'run', run: 'long', slot: 'pm', status: 'planned' },
    ], { date: '2026-10-24' });
    const { text, keyboard } = morningMessage(d, buildDetails(baseState({ run: { ...baseState().run, runStartMonday: '2026-10-26' } }), d, none));
    expect(text).toBe([
      '<b>☀️ Sat 24 Oct</b>',
      '',
      '🏋️ <b>Squat — 5-rep max test</b>',
      'Warm-up 6 items · ramp to a hard 5RM',
      '<blockquote expandable><b>Warm-up</b>',
      '• Ankle dorsiflexion (knee-to-wall) 2 x 10 each',
      '• Hip CARs 5/side',
      '• Short-lever Copenhagen 20 s/side',
      '• Banded clamshell 2 x 15',
      '• Deep squat hold 45 s',
      '• Banded tib-post inversion 2 x 15',
      '<b>Ramp</b>',
      '• bar × 10',
      '• ~40% × 5',
      '• ~60% × 3',
      '• ~75% × 2',
      '<b>Then</b>',
      '• Sets of 5 in 2.5–5 kg jumps to a hard 5-rep max (1 rep in reserve, at most 3 heavy sets).',
      '• 4–8 reps on the top set is fine: log its weight and reps.</blockquote>',
      'Log: <code>/test squat 100 5</code> (top set kg, reps)',
      '',
      '🏃 <b>Long run</b> · 7 km · 180 m↑',
      'Trail long run — pick hilly trails',
    ].join('\n'));
    expect(keyboard).toEqual([
      [{ text: '▶ Start Squat test', callback_data: 'a|g|2026-10-24|X.squat' }],
      [
        { text: '🏋️ Squat test: Log', callback_data: 'a|h|2026-10-24|X.squat' },
        { text: '🏋️ Skip', callback_data: 'a|s|2026-10-24|X.squat' },
      ],
      [
        { text: '🏃 Long run: Done', callback_data: 'a|d|2026-10-24|R.long' },
        { text: '🏃 Skip', callback_data: 'a|s|2026-10-24|R.long' },
        { text: '🏃 Tomorrow', callback_data: 'a|t|2026-10-24|R.long' },
      ],
    ]);
  });

  it('no two buttons look alike, even when two Sessions share an icon', () => {
    const d = day([
      { kind: 'lift-test', lift: 'bench', slot: 'am', status: 'planned' },
      { kind: 'lift', lift: 'squat', week: 2, slot: 'am', status: 'planned' },
      { kind: 'run', run: 'easy', slot: 'pm', status: 'planned' },
      { kind: 'run', run: 'quality-speed', slot: 'pm', status: 'planned' },
    ]);
    const { keyboard } = morningMessage(d, buildDetails(baseState(), d, none));
    expect(keyboard.map((r) => r.map((b) => b.text))).toEqual([
      ['▶ Start Bench test'],
      ['🏋️ Bench test: Log', '🏋️ Skip'],
      ['▶ Start Squat'],
      ['🏋️ Squat: Done', '🏋️ Skip Squat', '🏋️ Tomorrow Squat'],
      ['🏃 Easy run: Done', '🏃 Skip', '🏃 Tomorrow'],
      ['🏃 Speed run: Done', '🏃 Skip Speed run', '🏃 Tomorrow Speed run'],
    ]);
    const all = labels(keyboard);
    expect(new Set(all).size).toBe(all.length);
    // Every row's first button names its Session; every button starts with the Session's icon.
    for (const row of keyboard) expect(new Set(row.map((b) => [...b.text][0])).size).toBe(1);
  });

  it('long detail is quoted; short run detail stays visible', () => {
    const d = day([{ kind: 'lift', lift: 'bench', week: 3, slot: 'am', status: 'planned' }, { kind: 'run', run: 'quality-speed', slot: 'pm', status: 'planned' }]);
    const { text } = morningMessage(d, buildDetails(baseState(), d, none));
    expect(text.match(/<blockquote expandable>/g)).toHaveLength(1);
    expect(text).toMatch(/<b>Main sets<\/b>\n75% · [\d.]+ kg × 5\n85% · [\d.]+ kg × 3\n95% · [\d.]+ kg × 1\+\n/);
    expect(text).toMatch(/🏃 <b>Quality run — Speed<\/b> · [\d.]+ km\n\d × \d+ m @ 2\.4 km pace, 90 s jog$/);
    expect(text).not.toMatch(/ · .* · .* · .* · /); // no more ·-joined walls
  });

  it('the TM Test hint never sends a raw <kg> placeholder', () => {
    const d = day([{ kind: 'lift-test', lift: 'ohp', slot: 'am', status: 'planned' }]);
    const { text } = morningMessage(d, buildDetails(baseState(), d, none));
    expect(text).not.toMatch(/<(kg|reps)>/);
    expect(esc(testHint('ohp'))).toBe('/test ohp &lt;kg&gt; &lt;reps&gt;');
  });

  it('worst case (trip day: two Sessions, Route, max-length note, extra notes) stays under 4096; a huge note is cut', () => {
    const route = { id: 'r', name: 'R'.repeat(120), area: 'a', km: 12, vertM: 900, kind: 'loop' as const, suits: ['quality-speed' as const], url: 'https://example.com/' + 'x'.repeat(200) };
    const d = day([
      { kind: 'lift', lift: 'ohp', week: 3, slot: 'am', status: 'planned' },
      { kind: 'run', run: 'quality-speed', slot: 'pm', status: 'planned' },
    ], { note: 'In Riverton, hotel gym only & no barbell. '.repeat(13).slice(0, 500), notes: ['Also: Wall B 20:00', 'Also: Wall A 18:30'] });
    const det = buildDetails(baseState(), d, none, { routes: [route], assignments: [{ date: d.date, runKind: 'quality-speed', routeId: 'r' }] });
    const m = morningMessage(d, det);
    expect(m.text.length).toBeLessThanOrEqual(TELEGRAM_MAX_TEXT);
    expect(m.text).toContain('<i>Also: Wall A 18:30</i>');
    expect(m.text).not.toContain('…');

    const huge = morningMessage({ ...d, note: '&'.repeat(5000) }, det);
    expect(huge.text.length).toBeLessThanOrEqual(TELEGRAM_MAX_TEXT);
    expect(huge.text).toMatch(/📝 (&amp;)+…\n/);
    expect(huge.text).toContain('</blockquote>'); // the Sessions are never cut
  });
});
