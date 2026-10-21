// Per-set logging for lift Sessions: pure helpers shared by app.js and the unit tests (test/static/sets.test.ts).
// A "row" is one prescribed set; a SetLog (docs/api-contract.md) is a row plus what was actually done.

/**
 * Parse the leading "N x M" of a dose string ("4 x 8 per side, RPE 7-8", "2 × 12–15", "3 x 5").
 * M may be a range "12-15" (target = low end). Timed doses ("2 x 30 s/side") and anything else return null.
 * @param {unknown} dose
 * @returns {{ sets: number, reps: number, repsMax?: number, rest: string } | null}
 */
export function parseDose(dose) {
  if (typeof dose !== 'string') return null;
  const m = /^\s*(\d+)(?!\d)\s*[x×]\s*(\d+)(?!\d)(?:\s*[-–]\s*(\d+)(?!\d))?(?!\s*(?:s|sec|secs|min|m)\b)(.*)$/i.exec(dose);
  if (!m) return null;
  const sets = Number(m[1]);
  const reps = Number(m[2]);
  const repsMax = m[3] !== undefined ? Number(m[3]) : undefined;
  if (!(sets >= 1 && sets <= 20) || reps > 100 || (repsMax !== undefined && (repsMax < reps || repsMax > 100))) return null;
  const out = { sets, reps, rest: m[4].trim() };
  if (repsMax !== undefined && repsMax !== reps) out.repsMax = repsMax;
  return out;
}

const EPS = 0.01;

/**
 * Actual vs prescribed. Missed reps or a lighter load is "below"; otherwise more reps (past the top of a range,
 * or past the minimum of an AMRAP) or a heavier load is "above"; else "match". null when nothing was logged.
 * @param {{ rxLoad?: number, rxReps?: number, rxRepsMax?: number, load?: number, reps?: number }} s
 * @returns {'match' | 'above' | 'below' | null}
 */
export function setStatus(s) {
  const hasLoad = s.load != null && s.rxLoad != null;
  const hasReps = s.reps != null && s.rxReps != null;
  if (s.load == null && s.reps == null) return null;
  if ((hasReps && s.reps < s.rxReps) || (hasLoad && s.load < s.rxLoad - EPS)) return 'below';
  if ((hasReps && s.reps > (s.rxRepsMax ?? s.rxReps)) || (hasLoad && s.load > s.rxLoad + EPS)) return 'above';
  return 'match';
}

/**
 * The rows of a lift Session, grouped for display. Main: one row per SetRx. FSL and finisher: N rows per
 * exercise from its dose, or one row when the dose does not parse. The first FSL exercise is prescribed the
 * last FSL weight used (kg).
 * @param {any} det lift SessionDetail ({ mainSets, fsl, finisher, lastFslWeightKg })
 * @param {string} liftName e.g. 'Squat' (the `exercise` of main sets)
 */
export function liftRows(det, liftName) {
  const main = (det.mainSets || []).map((x, i) => ({
    id: `main:0:${i + 1}`, group: 'main', exercise: liftName, n: i + 1,
    rxLoad: x.load, rxReps: x.reps, unit: x.unit, amrap: !!x.amrap, capped: !!x.capped, pct: x.pct,
  }));
  const extra = (group, list) => (list || []).map((e, ei) => {
    const d = parseDose(e.dose);
    const rxLoad = group === 'fsl' && ei === 0 && det.lastFslWeightKg != null ? det.lastFslWeightKg : undefined;
    const base = { group, exercise: e.name, unit: 'kg', rxLoad, lastUsed: rxLoad !== undefined };
    const rows = d
      ? Array.from({ length: d.sets }, (_, k) => ({ ...base, id: `${group}:${ei}:${k + 1}`, n: k + 1, rxReps: d.reps, rxRepsMax: d.repsMax }))
      : [{ ...base, id: `${group}:${ei}:1`, n: 1, doseText: typeof e.dose === 'string' ? e.dose : '' }];
    return { name: e.name, cue: e.cue, dose: e.dose, rows };
  });
  return { main, fsl: extra('fsl', det.fsl), finisher: extra('finisher', det.finisher) };
}

/** Key that matches a set across Sessions of the same lift ("Last time"). */
export const setKey = (s) => `${s.group}|${s.exercise}|${s.n}`;

/**
 * "Last time" for each set of a lift Session on `date`, by setKey. Only lift_log entries for `lift` with sets,
 * strictly before `date`, count (entries in any order). Main sets come from the newest such entry in the same
 * Cycle `week` (1–4 or 'reentry'; when `week` is not given, the newest entry). FSL and Finisher sets come from
 * the newest entry, whatever its week.
 * @param {Array<any>} entries
 * @param {string} lift
 * @param {string} date
 * @param {number | string} [week]
 * @returns {Map<string, any>}
 */
export function lastSessionSets(entries, lift, date, week) {
  let newest = null;
  let sameWeek = null;
  for (const e of entries || []) {
    if (e.lift !== lift || !Array.isArray(e.sets) || !e.sets.length || !(e.date < date)) continue;
    if (!newest || e.date > newest.date) newest = e;
    if ((week == null || e.week === week) && (!sameWeek || e.date > sameWeek.date)) sameWeek = e;
  }
  const out = new Map();
  for (const s of (sameWeek && sameWeek.sets) || []) if (s.group === 'main') out.set(setKey(s), s);
  for (const s of (newest && newest.sets) || []) if (s.group !== 'main') out.set(setKey(s), s);
  return out;
}
