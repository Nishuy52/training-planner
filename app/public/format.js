// Small parsers and formatters shared by app.js, charts.js and the unit tests (test/static/format.test.ts).

/**
 * A typed time "m:ss", "mm:ss" or "h:mm:ss" (also with "." as the separator) to whole seconds.
 * Seconds (and minutes after an hour) must be 0–59. Blank or anything else: null.
 * @param {unknown} text
 * @returns {number | null}
 */
export function parseMmss(text) {
  const t = String(text ?? '').trim();
  const m = /^(?:(\d{1,2})[:.])?(\d{1,3})[:.](\d{2})$/.exec(t);
  if (!m) return null;
  const h = m[1] !== undefined ? Number(m[1]) : 0;
  const min = Number(m[2]);
  const s = Number(m[3]);
  if (s > 59 || (m[1] !== undefined && min > 59)) return null;
  return h * 3600 + min * 60 + s;
}

/**
 * Whole seconds as "m:ss", or "h:mm:ss" from an hour. Rounds to the nearest second; negative counts as 0.
 * @param {number} seconds
 * @returns {string}
 */
export function fmtMmss(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/** French grades offered for the auto-belay Benchmark: 5a … 8a, each with its + variant (8a+ excluded). */
export const GRADES = ['5', '6', '7'].flatMap((n) => ['a', 'b', 'c'].flatMap((l) => [`${n}${l}`, `${n}${l}+`])).concat(['8a']);

/**
 * Seconds left until an ISO instant (rounded up, never negative); null when there is no instant.
 * @param {string | null | undefined} iso
 * @param {number} now epoch ms
 * @returns {number | null}
 */
export function secondsUntil(iso, now) {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.ceil((t - now) / 1000));
}
