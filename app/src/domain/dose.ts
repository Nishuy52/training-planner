// "N x M" dose parsing for FSL and Finisher sets. A port of parseDose in public/sets.js (the app's copy);
// test/domain/live.test.ts checks the two agree on every dose in the content.

export type ParsedDose = { sets: number; reps: number; repsMax?: number; rest: string };

/**
 * Parse the leading "N x M" of a dose string ("4 x 8 per side, RPE 7-8", "2 × 12–15", "3 x 5").
 * M may be a range "12-15" (target = low end). Timed doses ("2 x 30 s/side") and anything else return null.
 */
export function parseDose(dose: unknown): ParsedDose | null {
  if (typeof dose !== 'string') return null;
  const m = /^\s*(\d+)(?!\d)\s*[x×]\s*(\d+)(?!\d)(?:\s*[-–]\s*(\d+)(?!\d))?(?!\s*(?:s|sec|secs|min|m)\b)(.*)$/i.exec(dose);
  if (!m) return null;
  const sets = Number(m[1]);
  const reps = Number(m[2]);
  const repsMax = m[3] !== undefined ? Number(m[3]) : undefined;
  if (!(sets >= 1 && sets <= 20) || reps > 100 || (repsMax !== undefined && (repsMax < reps || repsMax > 100))) return null;
  const out: ParsedDose = { sets, reps, rest: m[4]!.trim() };
  if (repsMax !== undefined && repsMax !== reps) out.repsMax = repsMax;
  return out;
}
