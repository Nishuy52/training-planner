// Live Session view helpers (docs/api-contract.md, LiveSession): pure functions shared by app.js and the
// unit tests (test/static/live.test.ts). Steps: steps[0] is the Warm-up, then one step per set.

const num = (n) => String(+(+n).toFixed(2));

/** True when `live` is the Live Session of planned Session `s` on `date`. */
export function isLiveFor(live, date, s) {
  if (!live || !s || live.date !== date || live.ref.kind !== s.kind || live.ref.lift !== s.lift) return false;
  return s.kind !== 'lift' || String(live.ref.week) === String(s.week);
}

/** The step to put in front of the athlete: the current one, or the first set while the Warm-up is still open. */
export function focusStep(live) {
  if (!live) return null;
  if (live.current > 0) return live.current;
  if (live.ref.kind === 'lift-test') return live.steps.length;
  return live.steps.length > 1 ? 1 : 0;
}

/** "Set 2 of 3" for a set step (the count comes from `of`, else from the steps of the same exercise). */
export function setOfText(live, k) {
  const st = live.steps[k];
  if (!st || st.kind !== 'set') return '';
  const of = st.of ?? live.steps.filter((x) => x.kind === 'set' && x.group === st.group && x.exercise === st.exercise).length;
  return st.group === 'test' ? `Work-up set ${st.n}` : `Set ${st.n} of ${of}`;
}

/** A set step's Prescription: "85 kg × 5+", "20 kg × 8–10", "× 12", or its dose text ("2 x 30 s/side"). */
export function rxLine(st) {
  if (!st || st.kind !== 'set') return '';
  if (st.dose) return st.dose;
  const reps = st.rxReps != null ? `× ${st.rxReps}${st.rxRepsMax ? `–${st.rxRepsMax}` : ''}${st.amrap ? '+' : ''}` : '';
  const load = st.rxLoad != null ? `${num(st.rxLoad)} ${st.unit}` : '';
  return [load, reps].filter(Boolean).join(' ') || '—';
}

/** What was logged on a set step: "75 kg × 5", "× 12", "Skipped", "Done". */
export function loggedLine(st) {
  if (!st || st.kind !== 'set' || !st.loggedAt) return '';
  if (st.skipped) return 'Skipped';
  const parts = [st.load != null ? `${num(st.load)} ${st.unit}` : '', st.reps != null ? `× ${st.reps}` : ''].filter(Boolean);
  return parts.join(' ') || 'Done';
}

/**
 * The Live Session so far against its Prescription: counts by status, and the AMRAP set's reps (main sets).
 * @returns {{ logged: number, met: number, over: number, under: number, skipped: number, done: number, amrap: number | null, top: any }}
 */
export function liveTally(live) {
  const out = { logged: 0, met: 0, over: 0, under: 0, skipped: 0, done: 0, amrap: null, top: null };
  for (const st of (live && live.steps) || []) {
    if (st.kind !== 'set' || !st.loggedAt) continue;
    if (st.status === 'skipped') { out.skipped++; continue; }
    out.logged++;
    if (st.status === 'met' || st.status === 'over' || st.status === 'under' || st.status === 'done') out[st.status]++;
    if (st.amrap && st.reps != null && out.amrap === null) out.amrap = st.reps;
    if (st.top) out.top = st;
  }
  return out;
}

// ───────────────────────── TM Test results (as src/domain/actions.ts) ─────────────────────────

export const LOW_TM_WARNING = "That's much lower than your other lifts — check the weight";

/** Training Max from a rep-max test: 90% of Epley e1RM, rounded down to the plate step. */
export const tmFromTest = (weight, reps, step) => Math.floor((0.9 * weight * (1 + reps / 30)) / step + 1e-9) * step;

/**
 * What a TM Test result would set: the Training Max, and `low` when that is under half the median Training Max of the
 * other lifts tested in the active Test Week (none tested: never low).
 */
export function testResultPreview(state, lift, weight, reps, step) {
  const tm = tmFromTest(weight, reps, step);
  const results = (state && state.testWeek && state.testWeek.results) || {};
  const others = Object.keys(results).filter((l) => l !== lift && state.tms[l] > 0).map((l) => state.tms[l]).sort((a, b) => a - b);
  if (!others.length) return { tm, low: false };
  const mid = others.length >> 1;
  const median = others.length % 2 ? others[mid] : (others[mid - 1] + others[mid]) / 2;
  return { tm, low: tm < 0.5 * median };
}

/** The Live Session top-set confirmation: "Top set 20 kg × 5 → Training Max 20 kg. Save?" (+ the low warning). */
export function topSetConfirmText(state, lift, weight, reps, step) {
  const { tm, low } = testResultPreview(state, lift, weight, reps, step);
  return `Top set ${num(weight)} kg × ${reps} → Training Max ${num(tm)} kg. Save?${low ? `\n\n${LOW_TM_WARNING}` : ''}`;
}

/** The Today card's Save result confirmation: "Deadlift 120 kg × 5 → Training Max 125 kg. Save?" (+ the low warning). */
export function testResultConfirmText(state, lift, name, weight, reps, step) {
  const { tm, low } = testResultPreview(state, lift, weight, reps, step);
  return `${name} ${num(weight)} kg × ${reps} → Training Max ${num(tm)} kg. Save?${low ? `\n\n${LOW_TM_WARNING}` : ''}`;
}

/** A Test Week correction changes the Training Max by more than 20%: ask first. */
export const bigTmChange = (from, to) => from > 0 && Math.abs(to - from) / from > 0.2;
